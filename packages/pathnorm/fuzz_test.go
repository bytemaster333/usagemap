// SPDX-License-Identifier: Apache-2.0
package pathnorm

import (
	"math/rand/v2"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

// Leak detectors applied to every output (ADR-0012 CI assertions plus the
// JWT shape).
var (
	leakSeed  = regexp.MustCompile(`(?i)S[A-D][A-Z2-7]{54}`)
	leakJWT   = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.`)
	leakEmail = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`)
)

var fuzzModes = []Options{
	{Input: InputPath},
	{Input: InputRoute},
	{Input: InputWebPage, Folding: FoldingFull},
	{Input: InputWebPage, Folding: FoldingRelaxed},
}

// checkOutput asserts the invariants every output must satisfy.
func checkOutput(t testing.TB, in string, o Options, r Result) {
	t.Helper()
	out := r.Route
	fail := func(why string) {
		t.Helper()
		t.Fatalf("%s: Normalize(%q, %v/%v) = %q", why, in, o.Input, o.Folding, out)
	}
	if out != "*" && !strings.HasPrefix(out, "/") {
		fail("route does not start with /")
	}
	if len(out) > MaxOutputBytes {
		fail("route over the output cap")
	}
	if !utf8.ValidString(out) || hasControl(out) {
		fail("route has invalid UTF-8 or control characters")
	}
	if strings.ContainsAny(out, "?#@ ") {
		fail("route contains ?, #, @ or a space")
	}
	if strings.Contains(strings.ToLower(out), "%40") {
		fail("route contains an encoded @")
	}
	if leakSeed.MatchString(out) {
		fail("seed-shaped value in route")
	}
	if leakJWT.MatchString(out) {
		fail("JWT-shaped value in route")
	}
	if leakEmail.MatchString(out) || leakEmail.MatchString(percentDecode(out)) {
		fail("e-mail-shaped value in route")
	}
	if strings.Contains(out, PhUnknown) || strings.Contains(out, PhOverflow) {
		fail("{unknown}/{overflow} produced")
	}
	if n := strings.Count(out, "/"); n > MaxDepth+1 {
		fail("route deeper than the cap")
	}
	if again := Normalize(out, o); again.Route != out {
		t.Fatalf("not idempotent: Normalize(%q, %v/%v) = %q, again %q", in, o.Input, o.Folding, out, again.Route)
	}
}

// FuzzNormalize: never panics, never leaks a seed-, JWT- or e-mail-shaped
// value, always idempotent and deterministic, in every mode.
func FuzzNormalize(f *testing.F) {
	for _, v := range loadVectors(f, "testdata/vectors.json") {
		f.Add(v.Input, uint8(0))
		f.Add(v.Input, uint8(1))
	}
	for _, v := range loadVectors(f, "testdata/vectors_extra.json") {
		f.Add(v.Input, uint8(3))
	}
	s := testSeed("pathnorm-fuzz-seed")
	f.Add("/a/"+strings.ToLower(s[:30])+"%2F"+s[30:], uint8(0))
	f.Add("/a/x"+s+"y/b?c="+s, uint8(2))
	f.Add("/a/"+s[:20]+"/"+s[20:], uint8(1))
	f.Fuzz(func(t *testing.T, in string, mode uint8) {
		o := fuzzModes[int(mode)%len(fuzzModes)]
		r := Normalize(in, o)
		checkOutput(t, in, o, r)
		if r2 := Normalize(in, o); r2.Route != r.Route || len(r2.Rules) != len(r.Rules) || r2.Redactions != r.Redactions {
			t.Fatalf("non-deterministic for %q", in)
		}
	})
}

// TestRandomRecombination is the 50,000-path recombination check of the
// research (§6.9) on the Go implementation: paths built from corpus
// segments, with a freshly generated seed (and e-mail / JWT / API key) in
// about 20 % of them, in every mode. Deterministic (fixed PRNG seed).
func TestRandomRecombination(t *testing.T) {
	n := 50000
	if testing.Short() {
		n = 5000
	}
	var segs []string
	for _, v := range loadVectors(t, "testdata/vectors.json") {
		in := v.Input
		if i := strings.IndexAny(in, "?#"); i >= 0 {
			in = in[:i]
		}
		for s := range strings.SplitSeq(in, "/") {
			if s != "" && len(s) < 300 {
				segs = append(segs, s)
			}
		}
	}
	rng := rand.New(rand.NewPCG(20261112, 6))
	freshSeed := func() string {
		var p [32]byte
		for i := range p {
			p[i] = byte(rng.Uint32())
		}
		return encodeStrKey(StrKeySeed, p[:])
	}
	injected := 0
	for i := range n {
		depth := 1 + rng.IntN(8)
		parts := make([]string, 0, depth+1)
		for range depth {
			parts = append(parts, segs[rng.IntN(len(segs))])
		}
		if rng.IntN(5) == 0 {
			injected++
			seed := freshSeed()
			var secret string
			switch rng.IntN(9) {
			case 0:
				secret = seed
			case 1:
				secret = strings.ToLower(seed)
			case 2:
				secret = "%53" + seed[1:]
			case 3:
				secret = "seed-" + seed + ".json"
			case 4:
				secret = "x" + strings.ToLower(seed) + "y"
			case 5:
				secret = "user" + seed[:6] + "@example.com"
			case 6:
				secret = "eyJ" + seed[:10] + "." + seed[10:30] + "." + seed[30:]
			case 7:
				secret = "{" + seed + "}"
			case 8:
				secret = ":" + seed
			}
			parts = append(parts[:rng.IntN(len(parts)+1)], append([]string{secret}, parts[rng.IntN(len(parts)+1):]...)...)
		}
		in := "/" + strings.Join(parts, "/")
		if rng.IntN(10) == 0 {
			in += "?q=" + freshSeed()
		}
		o := fuzzModes[i%len(fuzzModes)]
		checkOutput(t, in, o, Normalize(in, o))
	}
	t.Logf("%d recombined paths (%d with an injected secret): no leak, idempotent", n, injected)
}
