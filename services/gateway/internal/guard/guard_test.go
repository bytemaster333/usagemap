// SPDX-License-Identifier: Apache-2.0

package guard

import (
	"strings"
	"testing"
)

const account = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"

func TestPath(t *testing.T) {
	cases := []struct {
		in, folding, want string
		redacted          bool
	}{
		{"/pricing", "full", "/pricing", false},
		{"/pricing?utm_source=x&email=a@b.co#top", "full", "/pricing", false},
		{"/accounts/" + account + "/payments", "full", "/accounts/{account}/payments", false},
		{"/accounts/" + account + "/payments", "relaxed", "/accounts/{account}/payments", false},
		{"/u/alice@example.org", "full", "/u/{redacted}", true},
		{"/t/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "full", "/t/{redacted}", true},
		{"/blog/2026/11/12/my-post-12345", "relaxed", "/blog/2026/11/12/my-post-12345", false},
		{"/blog/2026/11/12/my-post-12345", "full", "/blog/{int}/{int}/{int}/{id}", false},
	}
	for _, c := range cases {
		got, red := Path(c.in, c.folding)
		if got != c.want || red != c.redacted {
			t.Errorf("Path(%q, %s) = %q,%v want %q,%v", c.in, c.folding, got, red, c.want, c.redacted)
		}
		if strings.ContainsAny(got, "?#") {
			t.Errorf("query in %q", got)
		}
	}
	// A seed in a page path never survives (C-52).
	seed := "S" + strings.Repeat("A", 55)
	if got, red := Path("/x/"+seed, "relaxed"); strings.Contains(got, seed) || !red {
		t.Fatalf("seed leaked: %q", got)
	}
}

func TestUnsafe(t *testing.T) {
	bad := []string{
		"alice@example.org", "alice%40example.org", account, "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZAAAAAAAAAAAAAE2LP",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", strings.Repeat("ab12", 8), "sk_live_abcdefghijkl", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"S" + strings.Repeat("A", 55),
	}
	for _, v := range bad {
		if !Unsafe(v) {
			t.Errorf("Unsafe(%q) = false", v)
		}
	}
	for _, v := range []string{"free", "pro-plan", "42", "signup", "wallet_connected", "Hello world", strings.Repeat("a", 31)} {
		if Unsafe(v) {
			t.Errorf("Unsafe(%q) = true", v)
		}
	}
}

// IP literals, phone numbers and federation addresses — whole or inside free text — are unsafe;
// times, versions, prices and ordinary words are not.
func TestUnsafePersonalIdentifiers(t *testing.T) {
	bad := []string{
		"203.0.113.5", "2001:db8:1:2::77", "::1", "fe80::1", "+4915112345678", "+49 151 1234 5678", "+1 (555) 123-4567",
		"alice*example.com", "from 198.51.100.7 today", "host=203.0.113.5:8443", "[2001:db8::1]:443", "call +49 151 1234567 now",
		"fed alice*stellar.org.", "ip:10.0.0.1", "203.0.113.0/24",
	}
	for _, v := range bad {
		if !Unsafe(v) {
			t.Errorf("Unsafe(%q) = false", v)
		}
	}
	good := []string{"1.2.3", "v1.2.3", "10:30", "price +100.00", "3*4", "a.b.c.d", "plan-2026", "rating 4.5/5", "free", "+12"}
	for _, v := range good {
		if Unsafe(v) {
			t.Errorf("Unsafe(%q) = true", v)
		}
	}
}
