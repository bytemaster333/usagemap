// SPDX-License-Identifier: Apache-2.0

package netclass

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	dir := t.TempDir()
	write := func(c, body string) { _ = os.WriteFile(filepath.Join(dir, c+".txt"), []byte(body), 0o644) }
	write("datacenter", "# aws\n3.0.0.0/9\n2600:1f00::/24\n198.51.100.0/24\n")
	write("tor", "198.51.100.7\n")
	write("relay", "172.224.0.0/12 ; apple\n")
	c := New(dir)
	cases := map[string]string{
		"3.5.6.7":               "datacenter",
		"3.128.0.1":             "unknown",
		"2600:1f00:1::1":        "datacenter",
		"198.51.100.7":          "tor", // tor wins over datacenter
		"198.51.100.8":          "datacenter",
		"::ffff:198.51.100.200": "datacenter",
		"172.230.1.1":           "relay",
		"8.8.8.8":               "unknown",
	}
	for ip, want := range cases {
		if got := c.Class(netip.MustParseAddr(ip)); got != want {
			t.Errorf("Class(%s) = %s, want %s", ip, got, want)
		}
	}
	// Reload on change.
	time.Sleep(10 * time.Millisecond)
	write("datacenter", "8.8.8.0/24\n")
	future := time.Now().Add(time.Second)
	_ = os.Chtimes(filepath.Join(dir, "datacenter.txt"), future, future)
	if err := c.Reload(); err != nil {
		t.Fatal(err)
	}
	if c.Class(netip.MustParseAddr("8.8.8.8")) != "datacenter" || c.Class(netip.MustParseAddr("3.5.6.7")) != "unknown" {
		t.Fatal("reload did not apply")
	}
}

func TestEmptyDir(t *testing.T) {
	c := New(filepath.Join(t.TempDir(), "missing"))
	if c.Class(netip.MustParseAddr("1.2.3.4")) != Unknown {
		t.Fatal("no lists → unknown")
	}
}

func TestMergeAdjacent(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "vpn.txt"), []byte("10.0.0.0/25\n10.0.0.128/25\n10.0.1.0/24\n"), 0o644)
	c := New(dir)
	if got := len(c.cur.Load().byClass["vpn"]); got != 1 {
		t.Fatalf("adjacent ranges not merged: %d", got)
	}
	if c.Class(netip.MustParseAddr("10.0.1.255")) != "vpn" || c.Class(netip.MustParseAddr("10.0.2.0")) != Unknown {
		t.Fatal("merged bounds wrong")
	}
}

func TestParseLine(t *testing.T) {
	for in, ok := range map[string]bool{"1.2.3.0/24": true, "2001:db8::/32": true, "1.2.3.4": true, "# c": false, "": false, "nonsense": false, "::ffff:1.2.3.0/120": true} {
		if _, got := ParseLine(in); got != ok {
			t.Errorf("ParseLine(%q) ok=%v", in, got)
		}
	}
	p, _ := ParseLine("::ffff:1.2.3.0/120")
	if p.String() != "1.2.3.0/24" {
		t.Fatalf("mapped prefix: %s", p)
	}
}
