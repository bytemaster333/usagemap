// SPDX-License-Identifier: Apache-2.0

package transport

import "testing"

func hello(grease bool, alpn []string, exts ...uint16) *Hello {
	return &Hello{Grease: grease, ALPN: alpn, Extensions: exts}
}

func TestClaimed(t *testing.T) {
	for _, c := range []struct{ fam, os, want string }{
		{"chrome", "windows", Chromium}, {"edge", "macos", Chromium}, {"opera", "linux", Chromium}, {"samsung", "android", Chromium},
		{"firefox", "android", Gecko}, {"firefox", "linux", Gecko},
		{"safari", "macos", Apple}, {"safari", "ios", Apple}, {"chrome", "ios", Apple}, {"firefox", "ios", Apple}, {"edge", "ios", Apple},
		{"safari", "linux", None}, {"other", "windows", None}, {"other", "ios", None},
	} {
		if got := Claimed(c.fam, c.os); got != c.want {
			t.Errorf("Claimed(%s,%s) = %s, want %s", c.fam, c.os, got, c.want)
		}
	}
}

func TestObservedAndCheck(t *testing.T) {
	h2 := []string{"h2", "http/1.1"}
	chromium := hello(true, h2, 0x0000, 0x001b, extALPSNew)
	chromiumOld := hello(true, h2, 0x0000, 0x001b, extALPSDraft)
	apple := hello(true, h2, 0x0000, 0x001b)
	gecko := hello(false, h2, 0x0000, extRecordSizeLimit)
	lib := hello(false, h2, 0x0000, 0x000a)
	for _, c := range []struct {
		name     string
		h        *Hello
		h2       *H2
		fam, os  string
		observed string
		result   string
		why      string
	}{
		{"chrome ok", chromium, &H2{Pseudo: "masp"}, "chrome", "windows", Chromium, Match, ""},
		{"chrome draft ALPS ok", chromiumOld, nil, "edge", "windows", Chromium, Match, ""},
		{"chrome h2 order of curl", chromium, &H2{Pseudo: "mspa"}, "chrome", "windows", Chromium, Mismatch, "h2_order"},
		{"chrome h2 order unknown → no signal", chromium, &H2{Pseudo: ""}, "chrome", "windows", Chromium, Match, ""},
		{"chrome without h2 in ALPN", hello(true, []string{"http/1.1"}, extALPSNew), nil, "chrome", "windows", Chromium, Mismatch, "alpn"},
		{"library claiming chrome", lib, nil, "chrome", "windows", Library, Mismatch, "tls_family"},
		{"library claiming firefox", lib, nil, "firefox", "linux", Library, Mismatch, "tls_family"},
		{"library claiming safari", lib, nil, "safari", "macos", Library, Mismatch, "tls_family"},
		{"firefox ok", gecko, &H2{Pseudo: "mpas"}, "firefox", "windows", Gecko, Match, ""},
		{"firefox UA on chromium stack", chromium, nil, "firefox", "windows", Chromium, Mismatch, "tls_family"},
		{"safari ok (both orders)", apple, &H2{Pseudo: "msap"}, "safari", "macos", Apple, Match, ""},
		{"safari ok older order", apple, &H2{Pseudo: "mspa"}, "chrome", "ios", Apple, Match, ""},
		{"chrome UA on apple stack outside iOS", apple, nil, "chrome", "macos", Apple, Mismatch, "tls_family"},
		{"safari on linux is not checked", lib, nil, "safari", "linux", Library, Unchecked, ""},
		{"unknown family not checked", lib, nil, "other", "windows", Library, Unchecked, ""},
		{"no TLS (plaintext listener)", nil, nil, "chrome", "windows", None, Unchecked, ""},
	} {
		v := Check(c.fam, c.os, Snapshot{Hello: c.h, H2: c.h2, ALPN: "h2"})
		if v.Observed != c.observed || v.Result != c.result || v.Why != c.why {
			t.Errorf("%s: got %+v, want observed=%s result=%s why=%s", c.name, v, c.observed, c.result, c.why)
		}
	}
}
