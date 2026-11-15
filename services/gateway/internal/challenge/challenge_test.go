// SPDX-License-Identifier: Apache-2.0

package challenge

import (
	"bytes"
	"encoding/hex"
	"net/netip"
	"testing"
	"time"
)

var (
	key  = bytes.Repeat([]byte{7}, 32)
	now  = time.Date(2026, 11, 12, 10, 30, 0, 0, time.UTC)
	site = "Q4mZ8bS1pTn0aR7cLx2VwE"
	net4 = Net(netip.MustParseAddr("203.0.113.77"))
)

func keys(e uint32) []byte {
	if e == Epoch(now) {
		return key
	}
	return nil
}

func issue(t *testing.T, max int) Issued {
	t.Helper()
	is, err := Issue(IssueParams{Key: key, Now: now, SiteKey: site, Net: net4, UAClass: "chrome/131/windows", Cost: 16, Max: max})
	if err != nil {
		t.Fatal(err)
	}
	if len(is.Token) != 123 || len(is.Pfx) != 8 || is.TTL != 1800 {
		t.Fatalf("bad issued %+v", is)
	}
	return is
}

func TestDKVector(t *testing.T) {
	// Cross-checked with Python hashlib.pbkdf2_hmac (the tracker's WebCrypto and node:crypto compute the same).
	n := make([]byte, 16)
	for i := range n {
		n[i] = byte(i)
	}
	if got := hex.EncodeToString(DK(n, 7, 512)); got != "99cf71e7944f1fe40b9faef6c8b6a7943c17717815716667b4f44f6bdda61377" {
		t.Fatalf("DK vector mismatch: %s", got)
	}
}

func TestRoundTripVerified(t *testing.T) {
	is := issue(t, 64)
	c, ok := Solve(is.Token, is.Cost, is.Max, is.Pfx)
	if !ok {
		t.Fatal("no solution")
	}
	o := Verify(VerifyParams{Token: is.Token, Counter: &c, SiteKey: site, Net: net4, UAClass: "chrome/131/windows", Now: now.Add(time.Second), Keys: keys})
	if o.Reject != "" || o.Unverifiable || o.CtxMoved || o.ProofMissing || !o.ProofOK {
		t.Fatalf("unexpected outcome %+v", o)
	}
	if o.Token.IssuedMs != now.UnixMilli() || o.Token.Max != 64 || o.Token.Cost != 16 {
		t.Fatalf("decoded token %+v", o.Token)
	}
}

func TestFailures(t *testing.T) {
	is := issue(t, 64)
	c, _ := Solve(is.Token, is.Cost, is.Max, is.Pfx)
	wrong := (c + 1) % 64
	big := uint32(64)
	tampered := []byte(is.Token)
	// Change one character in the middle (the nonce) to another valid base64url character: flipping a bit could
	// produce a character outside the alphabet ('A'^1 = '@'), which is a malformed token (challenge_missing), not
	// a tampered one — the random nonce made that a 1-in-16 flake.
	if tampered[40] == 'A' {
		tampered[40] = 'B'
	} else {
		tampered[40] = 'A'
	}
	base := VerifyParams{Token: is.Token, Counter: &c, SiteKey: site, Net: net4, UAClass: "chrome/131/windows", Now: now, Keys: keys}
	cases := map[string]struct {
		mod  func(p *VerifyParams)
		want func(o Outcome) bool
	}{
		"missing":       {func(p *VerifyParams) { p.Token = "" }, func(o Outcome) bool { return o.Reject == "challenge_missing" }},
		"garbage":       {func(p *VerifyParams) { p.Token = "not-a-token" }, func(o Outcome) bool { return o.Reject == "challenge_missing" }},
		"tampered":      {func(p *VerifyParams) { p.Token = string(tampered) }, func(o Outcome) bool { return o.Reject == "challenge_invalid" }},
		"other site":    {func(p *VerifyParams) { p.SiteKey = "AAAAAAAAAAAAAAAAAAAAAA" }, func(o Outcome) bool { return o.Reject == "challenge_invalid" }},
		"expired":       {func(p *VerifyParams) { p.Now = now.Add(1801 * time.Second) }, func(o Outcome) bool { return o.Reject == "challenge_expired" }},
		"from future":   {func(p *VerifyParams) { p.Now = now.Add(-61 * time.Second) }, func(o Outcome) bool { return o.Reject == "challenge_expired" }},
		"wrong proof":   {func(p *VerifyParams) { p.Counter = &wrong }, func(o Outcome) bool { return o.Reject == "proof_invalid" }},
		"counter ≥ max": {func(p *VerifyParams) { p.Counter = &big }, func(o Outcome) bool { return o.Reject == "proof_invalid" }},
		"no proof":      {func(p *VerifyParams) { p.Counter = nil }, func(o Outcome) bool { return o.Reject == "" && o.ProofMissing && !o.ProofOK }},
		"ctx moved net": {func(p *VerifyParams) { p.Net = Net(netip.MustParseAddr("198.51.100.1")) }, func(o Outcome) bool { return o.Reject == "" && o.CtxMoved && o.ProofOK }},
		"ctx moved ua":  {func(p *VerifyParams) { p.UAClass = "firefox/133/windows" }, func(o Outcome) bool { return o.Reject == "" && o.CtxMoved }},
		"unknown epoch": {func(p *VerifyParams) { p.Keys = func(uint32) []byte { return nil } }, func(o Outcome) bool { return o.Reject == "" && o.Unverifiable && !o.ProofOK }},
		"same /24 ok":   {func(p *VerifyParams) { p.Net = Net(netip.MustParseAddr("203.0.113.200")) }, func(o Outcome) bool { return o.Reject == "" && !o.CtxMoved }},
	}
	for name, tc := range cases {
		p := base
		tc.mod(&p)
		if o := Verify(p); !tc.want(o) {
			t.Errorf("%s: unexpected outcome %+v", name, o)
		}
	}
}

func TestNetTruncation(t *testing.T) {
	if got := Net(netip.MustParseAddr("::ffff:203.0.113.77")); !bytes.Equal(got, []byte{203, 0, 113, 0}) {
		t.Fatalf("mapped v4: %v", got)
	}
	got := Net(netip.MustParseAddr("2001:db8:aaaa:bbbb:cccc::1"))
	want := netip.MustParseAddr("2001:db8:aaaa::").As16()
	if !bytes.Equal(got, want[:]) {
		t.Fatalf("v6 /48: %v", got)
	}
}

func TestIssueDistinctNonces(t *testing.T) {
	a, b := issue(t, 8), issue(t, 8)
	if a.Token == b.Token {
		t.Fatal("tokens must differ")
	}
}

func TestIssueRejectsBadParams(t *testing.T) {
	if _, err := Issue(IssueParams{Key: key, Now: now, SiteKey: site, Net: net4, Cost: 0, Max: 1}); err == nil {
		t.Fatal("cost 0 accepted")
	}
	if _, err := Issue(IssueParams{Key: key, Now: now, SiteKey: site, Net: net4, Cost: 1, Max: 70000}); err == nil {
		t.Fatal("max > 65535 accepted")
	}
}

// C-124: after a single node restarts it regenerates the hour's K_chal under the same epoch id. A token issued
// before that (claimed issue time < key generation) fails the MAC but is `challenge_unverifiable` (suspect), not
// rejected; a token claiming a later issue time with a bad MAC is still `challenge_invalid`; the age bound applies.
func TestRegeneratedEpochKeyIsUnverifiable(t *testing.T) {
	is := issue(t, 64) // issued at `now` under `key`
	c, _ := Solve(is.Token, is.Cost, is.Max, is.Pfx)
	newKey := bytes.Repeat([]byte{9}, 32)
	keys2 := func(e uint32) []byte {
		if e == Epoch(now) {
			return newKey
		}
		return nil
	}
	p := VerifyParams{Token: is.Token, Counter: &c, SiteKey: site, Net: net4, UAClass: "chrome/131/windows", Now: now.Add(2 * time.Minute), Keys: keys2}
	if o := Verify(p); o.Reject != "challenge_invalid" {
		t.Fatalf("without KeySince: %+v", o)
	}
	p.KeySince = func(uint32) time.Time { return now.Add(time.Minute) } // regenerated after the token was issued
	if o := Verify(p); o.Reject != "" || !o.Unverifiable || o.Token == nil || o.ProofOK {
		t.Fatalf("token from before the regeneration: %+v", o)
	}
	p.KeySince = func(uint32) time.Time { return now.Add(-time.Minute) } // key existed before the token: forged
	if o := Verify(p); o.Reject != "challenge_invalid" {
		t.Fatalf("token after the regeneration: %+v", o)
	}
	p.KeySince = func(uint32) time.Time { return now.Add(time.Minute) }
	p.Now = now.Add(31 * time.Minute)
	if o := Verify(p); o.Reject != "challenge_expired" {
		t.Fatalf("age bound: %+v", o)
	}
}

// forge builds a well-formed token with a junk MAC, as a script that never called /v1/c would.
func forge(epoch uint32, issued time.Time) string {
	t := Token{Epoch: epoch, SiteRef: SiteRef(site), IssuedMs: issued.UnixMilli(), Cost: 16, Max: 64}
	t.Nonce[0] = 1
	raw := append(t.body(), bytes.Repeat([]byte{0xab}, 32)...)
	return b64.EncodeToString(raw)
}

// A token is `challenge_unverifiable` only when its epoch is one a genuine token could carry now
// (the current hour, the previous one, or the next within the future skew) and its issue time lies in that epoch.
// A made-up epoch, or an issue time outside the claimed epoch, is `challenge_invalid`.
func TestForgedEpochIsInvalid(t *testing.T) {
	none := func(uint32) []byte { return nil }
	cur := Epoch(now)
	cases := []struct {
		name   string
		epoch  uint32
		issued time.Time
		want   string // "" = unverifiable
	}{
		{"far past epoch", 7, now, "challenge_invalid"},
		{"far future epoch", cur + 1000, now, "challenge_invalid"},
		{"epoch two hours ago", cur - 2, now, "challenge_invalid"},
		{"issued outside the epoch", cur, now.Add(-2 * time.Hour), "challenge_invalid"},
		{"issued in previous hour, current epoch", cur, now.Add(-31 * time.Minute), "challenge_invalid"},
		{"current epoch", cur, now.Add(-time.Minute), ""},
		{"previous epoch within TTL", cur - 1, now.Add(-31 * time.Minute), ""}, // checked at now-2min below
	}
	for _, tc := range cases {
		at := now
		if tc.name == "previous epoch within TTL" {
			at = now.Add(-2 * time.Minute)
		}
		o := Verify(VerifyParams{Token: forge(tc.epoch, tc.issued), SiteKey: site, Net: net4, UAClass: "chrome/131/windows", Now: at, Keys: none})
		if tc.want == "" {
			if o.Reject != "" || !o.Unverifiable {
				t.Errorf("%s: want unverifiable, got %+v", tc.name, o)
			}
			continue
		}
		if o.Reject != tc.want || o.Unverifiable {
			t.Errorf("%s: want %s, got %+v", tc.name, tc.want, o)
		}
	}
	// The regenerated-key path (C-124) gets the same epoch bound.
	other := func(e uint32) []byte { return bytes.Repeat([]byte{9}, 32) }
	since := func(uint32) time.Time { return now.Add(time.Hour * 1000) }
	if o := Verify(VerifyParams{Token: forge(7, now), SiteKey: site, Net: net4, Now: now, Keys: other, KeySince: since}); o.Reject != "challenge_invalid" {
		t.Errorf("regenerated-key path, far epoch: %+v", o)
	}
}
