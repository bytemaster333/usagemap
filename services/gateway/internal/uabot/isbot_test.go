// SPDX-License-Identifier: Apache-2.0

package uabot

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/bytemaster333/usagemap/services/gateway/internal/uaclass"
)

type expected struct {
	PatternSHA256 string               `json:"pattern_sha256"`
	Results       [][2]json.RawMessage `json:"results"`
}

func loadExpected(t *testing.T, path string) (string, map[string]bool, []string) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var e expected
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	m := map[string]bool{}
	var order []string
	for _, r := range e.Results {
		var ua string
		var bot bool
		if err := json.Unmarshal(r[0], &ua); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(r[1], &bot); err != nil {
			t.Fatal(err)
		}
		m[ua] = bot
		order = append(order, ua)
	}
	return e.PatternSHA256, m, order
}

// TestParityWithUmami compares IsBot with the verdicts Umami's own bundled isbot function gave for the same corpus
// (testdata/umami-isbot-expected.json, produced by testdata/gen-parity.sh inside our Umami image). C-36.
func TestParityWithUmami(t *testing.T) {
	_, want, order := loadExpected(t, filepath.Join("testdata", "umami-isbot-expected.json"))
	var corpus []string
	b, _ := os.ReadFile(filepath.Join("testdata", "corpus.json"))
	if err := json.Unmarshal(b, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus) != len(order) {
		t.Fatalf("expectations are stale: corpus has %d entries, expectations %d (run testdata/gen-parity.sh)", len(corpus), len(order))
	}
	bots := 0
	for _, ua := range corpus {
		w, ok := want[ua]
		if !ok {
			t.Fatalf("expectations are stale: %q missing (run testdata/gen-parity.sh)", ua)
		}
		if w {
			bots++
		}
		if got := IsBot(ua); got != w {
			t.Errorf("IsBot(%q) = %v, Umami says %v", ua, got, w)
		}
	}
	if bots < 50 || len(corpus)-bots < 50 {
		t.Fatalf("corpus is unbalanced: %d bots of %d", bots, len(corpus))
	}
}

// TestParityLive re-runs Umami's function inside the image when Docker and the image are available
// (SCF_UMAMI_PARITY=1), so a changed Umami pin cannot silently diverge from the committed expectations.
func TestParityLive(t *testing.T) {
	if os.Getenv("SCF_UMAMI_PARITY") != "1" {
		t.Skip("set SCF_UMAMI_PARITY=1 to run Umami's isbot in the image")
	}
	out := filepath.Join(t.TempDir(), "live.json")
	cmd := exec.Command("bash", filepath.Join("testdata", "gen-parity.sh"))
	cmd.Env = append(os.Environ(), "OUT="+out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gen-parity: %v\n%s", err, b)
	}
	shaLive, live, _ := loadExpected(t, out)
	shaCommitted, committed, _ := loadExpected(t, filepath.Join("testdata", "umami-isbot-expected.json"))
	if shaLive != shaCommitted {
		t.Fatalf("Umami's isbot pattern changed (%s → %s): update isbot.go and the expectations", shaCommitted, shaLive)
	}
	for ua, w := range live {
		if committed[ua] != w {
			t.Errorf("committed expectation differs for %q", ua)
		}
		if IsBot(ua) != w {
			t.Errorf("IsBot(%q) != Umami (%v)", ua, w)
		}
	}
}

func TestHeadlessMarkers(t *testing.T) {
	for ua, want := range map[string]bool{
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36":   true,
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36": false,
		"Mozilla/5.0 PhantomJS/2.1":      true,
		"Mozilla/5.0 (X11) jsdom/24.0.0": true,
	} {
		if got := HasHeadlessMarker(ua); got != want {
			t.Errorf("HasHeadlessMarker(%q) = %v", ua, got)
		}
	}
}

func TestEmptyIsNotBot(t *testing.T) {
	if IsBot("") {
		t.Fatal("empty UA must not be a bot (Umami's function)")
	}
}

// TestTemplatesAreNotBots: no synthetic template (wire-formats §c.3) may be a bot for isbot — the templates are also
// in the corpus, so Umami's own verdict is checked by TestParityWithUmami.
func TestTemplatesAreNotBots(t *testing.T) {
	for _, m := range []int{18, 131} {
		for _, tpl := range uaclass.Templates(m) {
			if IsBot(tpl.UA) {
				t.Errorf("template %q is a bot", tpl.UA)
			}
		}
	}
	var corpus []string
	b, _ := os.ReadFile(filepath.Join("testdata", "corpus.json"))
	_ = json.Unmarshal(b, &corpus)
	in := map[string]bool{}
	for _, c := range corpus {
		in[c] = true
	}
	for _, tpl := range uaclass.Templates(131) {
		if !in[tpl.UA] {
			t.Errorf("template missing from the parity corpus: %q", tpl.UA)
		}
	}
}
