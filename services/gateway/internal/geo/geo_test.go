// SPDX-License-Identifier: Apache-2.0

package geo

import (
	"net/netip"
	"os"
	"testing"
)

func TestTruncate(t *testing.T) {
	cases := map[string]string{
		"203.0.113.77":               "203.0.113.0",
		"::ffff:198.51.100.9":        "198.51.100.0",
		"2001:db8:aaaa:bbbb:cccc::1": "2001:db8:aaaa::",
	}
	for in, want := range cases {
		if got := Truncate(netip.MustParseAddr(in)).String(); got != want {
			t.Errorf("Truncate(%s) = %s, want %s", in, got, want)
		}
	}
}

func TestNone(t *testing.T) {
	if (None{}).Country(netip.MustParseAddr("8.8.8.8")) != "XX" {
		t.Fatal("None must answer XX")
	}
}

// TestDBIPLite runs against the real DB-IP Lite file when SCF_GEO_DB points at it (the gateway image bakes it in;
// the Dockerfile pins its SHA-256). Spike S-12 used the same file.
func TestDBIPLite(t *testing.T) {
	path := os.Getenv("SCF_GEO_DB")
	if path == "" {
		t.Skip("SCF_GEO_DB not set")
	}
	db, err := Open(path, os.Getenv("SCF_GEO_SHA256"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for ip, want := range map[string]string{
		"8.8.8.8":          "US",
		"193.99.144.80":    "DE", // heise.de
		"127.0.0.1":        "XX",
		"10.1.2.3":         "XX",
		"2a00:1450:4001::": "", // any two letters
	} {
		got := db.Country(netip.MustParseAddr(ip))
		if want == "" {
			if len(got) != 2 {
				t.Errorf("%s: %q", ip, got)
			}
			continue
		}
		if got != want {
			t.Errorf("Country(%s) = %s, want %s", ip, got, want)
		}
	}
	if _, err := Open(path, "00"); err == nil {
		t.Fatal("pin mismatch accepted")
	}
}
