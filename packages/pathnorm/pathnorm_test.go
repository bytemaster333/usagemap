// SPDX-License-Identifier: Apache-2.0
package pathnorm

import (
	"strings"
	"testing"
)

func TestRuleSetVersion(t *testing.T) {
	if RuleSetVersion != "scf-path-rules/1.1.0" {
		t.Fatalf("RuleSetVersion = %q", RuleSetVersion)
	}
	if got := Normalize("/x", Options{}).RulesVersion(); got != RuleSetVersion {
		t.Fatalf("Result.RulesVersion() = %q", got)
	}
}

func TestVocabularyClosed(t *testing.T) {
	if len(Vocabulary) != 24 {
		t.Fatalf("vocabulary has %d placeholders, ADR-0012/C-16 fixes 24", len(Vocabulary))
	}
	seen := map[string]bool{}
	for _, p := range Vocabulary {
		if seen[p] {
			t.Errorf("duplicate %s", p)
		}
		seen[p] = true
	}
}

// {unknown} is assigned only when neither a route nor a path exists (C-16, C-89).
func TestNormalizeSpanPrecedence(t *testing.T) {
	g1 := sep23Valid[0].key
	cases := []struct {
		name string
		in   SpanInputs
		want string
	}{
		{"nothing", SpanInputs{}, PhUnknown},
		{"route wins", SpanInputs{Route: "/users/:id", URLPath: "/users/42", Target: "/x"}, "/users/{id}"},
		{"url.path", SpanInputs{URLPath: "/accounts/" + g1, Target: "/x"}, "/accounts/{account}"},
		{"http.target", SpanInputs{Target: "/ledgers/123?x=1"}, "/ledgers/{int}"},
		{"url.full", SpanInputs{URL: "https://h.example/offers/104078276?a=b"}, "/offers/{int}"},
		// The same route whichever source fed it (old and new SDKs aggregate together).
		{"same output", SpanInputs{Target: "/accounts/" + g1 + "/"}, "/accounts/{account}"},
	}
	for _, c := range cases {
		if got := NormalizeSpan(c.in).Route; got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestNeverUnknownOrOverflow(t *testing.T) {
	for _, in := range []string{"", "/", "{unknown}", "/{overflow}", "/a/{unknown}/{overflow}", "*"} {
		for _, o := range []Options{{Input: InputPath}, {Input: InputRoute}, {Input: InputWebPage, Folding: FoldingRelaxed}} {
			r := Normalize(in, o).Route
			if strings.Contains(r, PhUnknown) || strings.Contains(r, PhOverflow) {
				t.Errorf("Normalize(%q, %v) = %q", in, o.Input, r)
			}
		}
	}
}

func TestParseFolding(t *testing.T) {
	for in, want := range map[string]Folding{"full": FoldingFull, "": FoldingFull, "relaxed": FoldingRelaxed} {
		got, err := ParseFolding(in)
		if err != nil || got != want {
			t.Errorf("ParseFolding(%q) = %v, %v", in, got, err)
		}
	}
	// There is no value that keeps StrKeys or hashes (C-89).
	for _, in := range []string{"off", "none", "keep_strkeys", "FULL"} {
		if _, err := ParseFolding(in); err == nil {
			t.Errorf("ParseFolding(%q) accepted", in)
		}
	}
}

func TestNormalizeWebPage(t *testing.T) {
	r := NormalizeWebPage("/p/2026/11?utm_source=x", FoldingRelaxed)
	if r.Route != "/p/2026/11" || !r.Flags.Has(FlagQueryStripped) {
		t.Fatalf("got %q flags %b", r.Route, r.Flags)
	}
	if r := NormalizeWebPage("/p/2026/11", FoldingFull); r.Route != "/p/{int}/{int}" {
		t.Fatalf("full: got %q", r.Route)
	}
}

func TestOverlongInputCountsSecrets(t *testing.T) {
	seed := testSeed("pathnorm-unit-overlong")
	in := "/" + strings.Repeat("a/", 4100) + "k/" + seed
	r := Normalize(in, Options{})
	if r.Route != "/{long}" || !r.Flags.Has(FlagTooLong) {
		t.Fatalf("got %q", r.Route)
	}
	if r.Redactions.Count(KindStellarSeed, LocPath) != 1 {
		t.Fatalf("seed in an over-long input not counted: %+v", r.Redactions)
	}
}

func TestOutputCap(t *testing.T) {
	seg := strings.Repeat("é", 64) // literal, 384 bytes encoded
	in := "/" + strings.Repeat(seg+"/", 12)
	r := Normalize(in, Options{})
	if len(r.Route) > MaxOutputBytes {
		t.Fatalf("output %d bytes > %d", len(r.Route), MaxOutputBytes)
	}
	if !strings.HasSuffix(r.Route, "/"+PhRest) || !r.Fired(RuleOutputCap) || !r.Flags.Has(FlagTruncated) {
		t.Fatalf("output cap not applied: %q %v", r.Route, r.Rules)
	}
	if strings.Count(r.Route, "/") != 3 {
		t.Fatalf("expected two segments + {rest}, got %q", r.Route)
	}
	if again := Normalize(r.Route, Options{}).Route; again != r.Route {
		t.Fatalf("not idempotent after output cap: %q", again)
	}
}

func TestDepthCap(t *testing.T) {
	in := "/" + strings.Repeat("x/", 40)
	r := Normalize(in, Options{})
	if r.Route != strings.Repeat("/x", MaxDepth)+"/"+PhRest {
		t.Fatalf("got %q", r.Route)
	}
}

func TestRedactionCountersNeverCarryValues(t *testing.T) {
	seed := testSeed("pathnorm-unit-counters")
	r := Normalize("/a/"+seed+"/b/alice@example.com?t="+seed, Options{})
	if r.Route != "/a/{redacted}/b/{redacted}" {
		t.Fatalf("route %q", r.Route)
	}
	if r.Redactions.ByKind(KindStellarSeed) != 2 || r.Redactions.ByKind(KindEmail) != 1 || r.Redactions.Total() != 3 {
		t.Fatalf("counters %+v", r.Redactions)
	}
	if r.Redactions.Count(KindStellarSeed, LocQuery) != 1 || r.Redactions.Count(KindStellarSeed, LocPath) != 1 {
		t.Fatalf("locations %+v", r.Redactions)
	}
	if !r.Flags.Has(FlagRedacted | FlagQueryStripped) {
		t.Fatalf("flags %b", r.Flags)
	}
	for _, rule := range r.Rules {
		if strings.Contains(string(rule), seed[:8]) {
			t.Fatal("rule ID carries part of the value")
		}
	}
	if KindStellarSeed.Class() != "secret" || KindEmail.Class() != "pii" || KindAPIKey.String() != "api_key" {
		t.Fatal("kind names")
	}
}

func TestRouteSecretInParameterName(t *testing.T) {
	seed := testSeed("pathnorm-unit-route")
	r := Normalize("/w/:"+seed, Options{Input: InputRoute})
	if r.Route != "/w/{redacted}" || r.Redactions.Count(KindStellarSeed, LocRoute) != 1 {
		t.Fatalf("got %q %+v", r.Route, r.Redactions)
	}
}

func TestDeterministic(t *testing.T) {
	in := "/explorer/public/asset/USDC-" + sep23Valid[0].key + "-1/holders?x=1"
	a := Normalize(in, Options{})
	for range 100 {
		b := Normalize(in, Options{})
		if a.Route != b.Route || strings.Join(ruleNames(a.Rules), " ") != strings.Join(ruleNames(b.Rules), " ") {
			t.Fatal("non-deterministic")
		}
	}
}
