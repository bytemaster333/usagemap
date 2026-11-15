// SPDX-License-Identifier: Apache-2.0

package uaclass

import (
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	cases := []struct {
		ua   string
		want Class
	}{
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", Class{"chrome", 131, "windows", "desktop"}},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0", Class{"edge", 142, "windows", "desktop"}},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", Class{"safari", 18, "ios", "mobile"}},
		{"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", Class{"safari", 17, "ios", "tablet"}},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", Class{"safari", 18, "macos", "desktop"}},
		{"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0", Class{"firefox", 128, "linux", "desktop"}},
		{"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", Class{"chrome", 131, "android", "mobile"}},
		{"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", Class{"chrome", 131, "android", "tablet"}},
		{"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", Class{"samsung", 25, "android", "mobile"}},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1", Class{"chrome", 124, "ios", "mobile"}},
		{"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", Class{"chrome", 131, "chromeos", "desktop"}},
		{"curl/8.5.0", Class{"other", 0, "other", "desktop"}},
		{"", Class{"other", 0, "other", "desktop"}},
		{"Mozilla/5.0 Chrome/99999.0", Class{"other", 0, "other", "desktop"}},
	}
	for _, c := range cases {
		if got := Parse(c.ua); got != c.want {
			t.Errorf("Parse(%q) = %+v, want %+v", c.ua, got, c.want)
		}
	}
}

func TestSyntheticNeverEchoesRawInput(t *testing.T) {
	raw := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Safari/537.36 secret-extension-token/42"
	s := Synthetic(Parse(raw))
	if strings.Contains(s, "secret") || strings.Contains(s, "6778") {
		t.Fatalf("synthetic UA leaks raw details: %q", s)
	}
	if s != "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" {
		t.Fatalf("unexpected template %q", s)
	}
}

func TestSyntheticFallsBackToUnknown(t *testing.T) {
	for _, c := range []Class{{"other", 0, "other", "desktop"}, {"chrome", 0, "windows", "desktop"}, {"edge", 120, "ios", "mobile"}} {
		if got := Synthetic(c); got != Unknown {
			t.Errorf("Synthetic(%+v) = %q, want Unknown", c, got)
		}
	}
}

func TestSyntheticRoundTrips(t *testing.T) {
	// Every template parses back to its own class (so the reduction is stable through Umami's view).
	for _, tpl := range Templates(131) {
		if tpl.Family == "other" {
			continue
		}
		got := Parse(tpl.UA)
		if got.Family != tpl.Family || got.OS != tpl.OS || got.Device != tpl.Device {
			t.Errorf("template %s/%s/%s parses as %+v", tpl.Family, tpl.OS, tpl.Device, got)
		}
		if len(tpl.UA) > 200 {
			t.Errorf("template longer than the spool's 200-character limit: %q", tpl.UA)
		}
	}
}

func TestClassString(t *testing.T) {
	if s := (Class{"chrome", 131, "windows", "desktop"}).String(); s != "chrome/131/windows" {
		t.Fatal(s)
	}
}
