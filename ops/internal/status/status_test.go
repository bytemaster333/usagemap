// SPDX-License-Identifier: Apache-2.0

package status

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/store"
)

func write(t *testing.T, dir string, now time.Time, badLast int) {
	t.Helper()
	for _, src := range []string{"mon-c", "probe-d", "edge-a1"} {
		w := &store.Writer{Dir: dir, Source: src}
		var rows []store.Row
		for i := 0; i < 2*60*24; i++ { // the last 24 h
			ts := now.Truncate(30 * time.Second).Add(-time.Duration(i) * 30 * time.Second)
			o := store.Good
			if i < badLast && src != "edge-a1" {
				o = store.Bad
			}
			rows = append(rows,
				store.Row{RoundStart: ts, Source: src, Kind: store.KindRound, Target: "ingest", Outcome: o, Status: 202},
				store.Row{RoundStart: ts, Source: src, Kind: store.KindNode, Target: "edge-b2", Outcome: store.Good, Status: 202})
			if i%2 == 0 {
				rows = append(rows, store.Row{RoundStart: ts, Source: src, Kind: store.KindJourney, Target: "dashboard", Outcome: store.Good, Status: 200})
			}
		}
		if err := w.Append(rows...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPageStates(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 10, 0, time.UTC)
	for name, c := range map[string]struct {
		bad  int
		want string
		page string
	}{"operational": {0, "operational", "All checks passing"}, "outage": {4, "outage", "Service down"}} {
		dir := t.TempDir()
		write(t, dir, now, c.bad)
		p, err := Build(dir, now)
		if err != nil {
			t.Fatal(err)
		}
		if p.Overall != c.want || p.Components[0].State != c.want || p.Banner != c.want {
			t.Errorf("%s: overall %s, headline %s, banner %s", name, p.Overall, p.Components[0].State, p.Banner)
		}
		if len(p.Components[0].Days) != Days {
			t.Errorf("days %d", len(p.Components[0].Days))
		}
		out := t.TempDir()
		if err := p.Render(out); err != nil {
			t.Fatal(err)
		}
		html, _ := os.ReadFile(filepath.Join(out, "index.html"))
		for _, s := range []string{c.page, "Web tracking", "Dashboard &amp; API", "Checks run every minute", "Report a problem",
			"service-problem.yml", "https://app.usagemap.dev", "https://docs.usagemap.dev/"} {
			if !strings.Contains(string(html), s) {
				t.Errorf("%s: page lacks %q", name, s)
			}
		}
		assertNoThirdParty(t, string(html))
		for _, f := range []string{"status.js", "favicon.svg", "status.json"} {
			if _, err := os.Stat(filepath.Join(out, f)); err != nil {
				t.Error(err)
			}
		}
	}
}

// assertNoThirdParty: the page loads nothing from another origin (links to our own sites are fine; resources are not).
func assertNoThirdParty(t *testing.T, html string) {
	t.Helper()
	for _, bad := range []string{`src="http`, `src="//`, `rel="stylesheet"`, "@import", "url(http", "fonts.googleapis", "fonts.gstatic", "cdn."} {
		if strings.Contains(html, bad) {
			t.Errorf("page loads a third-party resource (%q)", bad)
		}
	}
	if strings.Count(html, "<script") != 1 || !strings.Contains(html, `<script src="status.js" defer></script>`) {
		t.Error("the only script is the same-origin status.js")
	}
}

func TestHeartbeat(t *testing.T) {
	out := t.TempDir()
	h := &Heartbeat{Token: "hb", Out: out}
	srv := httptest.NewServer(h)
	defer srv.Close()
	post := func(token, body string) int {
		req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	wd := `{"alerts":[{"status":"firing","labels":{"alertname":"Watchdog"}}]}`
	if post("nope", wd) != 401 || post("hb", `{"alerts":[{"status":"firing","labels":{"alertname":"Other"}}]}`) != 400 {
		t.Fatal("bad heartbeats accepted")
	}
	if post("hb", wd) != 204 || h.Last().IsZero() {
		t.Fatal("heartbeat not taken")
	}
	if b, err := os.ReadFile(filepath.Join(out, "heartbeat.json")); err != nil || !strings.Contains(string(b), "last_heartbeat") {
		t.Fatal("heartbeat.json")
	}
}

// The v1 host has one probe source: with the default 2-of-3 rule nothing would ever be judged ("No data" next to a
// 100 % month). With MinVoters 1 the source judges alone, the page names it, the month reads
// "not measured" below 95 % coverage, and the footer carries the deployment's own objective and placement.
func TestSingleSourcePageIsHonest(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 10, 0, time.UTC) // 18.5 days into the month, 1 day measured
	dir := t.TempDir()
	w := &store.Writer{Dir: dir, Source: "vm-1"}
	var rows []store.Row
	for i := 0; i < 2*60*24; i++ {
		ts := now.Truncate(30 * time.Second).Add(-time.Duration(i) * 30 * time.Second)
		rows = append(rows, store.Row{RoundStart: ts, Source: "vm-1", Kind: store.KindRound, Target: "ingest", Outcome: store.Good, Status: 202})
	}
	if err := w.Append(rows...); err != nil {
		t.Fatal(err)
	}
	if p, _ := Build(dir, now); p.Components[0].State != "unknown" || p.Components[0].MonthToDay != -1 {
		t.Fatalf("default 2-of-3 with one source must be unknown and not measured: %+v", p.Components[0].State)
	}
	opt := DefaultOptions()
	opt.MinVoters = 1
	opt.Objectives = "Objective for v1 (one VM): 99.5 %, not a guarantee."
	opt.Objective, opt.ObjectiveOf = "99.5%", "per month for tracking and the dashboard. A target, not a guarantee."
	opt.ServiceWindow = v1ServiceWindow
	opt.Placement = "This page runs on the same VM as the service."
	p, err := BuildWith(dir, now, opt)
	if err != nil {
		t.Fatal(err)
	}
	c := p.Components[0]
	if c.State != "operational" || c.MonthToDay != -1 || c.Coverage <= 0 || c.Coverage >= 0.95 {
		t.Fatalf("v1 headline: state %s month %v coverage %v", c.State, c.MonthToDay, c.Coverage)
	}
	out := t.TempDir()
	if err := p.Render(out); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(out, "index.html"))
	html := string(b)
	for _, want := range []string{"Not measured yet", "covered so far: ", "99.5%", "A target, not a guarantee", "All checks passing",
		"No incidents since measuring began", "Not measured before 18 Nov"} {
		if !strings.Contains(html, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if p.Month.Availability != -1 {
		t.Error("no month-to-date percentage without 95 % coverage")
	}
	// The objective card says how the host's 99.5 % relates to the service-window commitment (C-180), next to it.
	if !strings.Contains(html, "A target, not a guarantee. "+v1ServiceWindow+"</span>") {
		t.Error("objective card lacks the service-window sentence right after the objective")
	}
	// 99.99 appears only inside that sentence: never as a figure this host claims.
	if strings.Count(html, "99.99") != 1 {
		t.Errorf("99.99 appears %d times; only the service-window sentence may name it", strings.Count(html, "99.99"))
	}
	for _, never := range []string{"three probe sources", "outside the infrastructure", "Example data"} {
		if strings.Contains(html, never) {
			t.Errorf("page must not claim %q", never)
		}
	}
}
