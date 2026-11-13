// SPDX-License-Identifier: Apache-2.0
package pathnorm

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

type vector struct {
	ID       int            `json:"id"`
	Mode     string         `json:"mode"`
	Input    string         `json:"input"`
	Expected string         `json:"expected"`
	Rules    []string       `json:"rules"`
	Counters map[string]int `json:"counters"`
	Source   string         `json:"source"`
	Note     string         `json:"note"`
}

type vectorFile struct {
	Count         int               `json:"count"`
	RuleSet       string            `json:"rule_set"`
	DerivedTokens map[string]string `json:"derived_tokens"`
	Vectors       []vector          `json:"vectors"`
}

// testSeed derives a TEST-ONLY seed from a public label, exactly as the
// corpus legend prescribes: strkey_encode("S", sha256(label)). Never fund,
// never reuse; it exists only in memory during the test run.
func testSeed(label string) string {
	sum := sha256.Sum256([]byte(label))
	return encodeStrKey(StrKeySeed, sum[:])
}

func derivedTokens(t testing.TB) map[string]string {
	s1 := testSeed("scf-vector-S1-test-only")
	s2 := testSeed("scf-vector-S2-test-only")
	if !strings.HasPrefix(s1, "SC5") || !strings.HasPrefix(s2, "SCT") {
		t.Fatalf("seed derivation does not match the corpus legend (prefixes %q, %q)", s1[:3], s2[:3])
	}
	return map[string]string{
		"«S1»":    s1,
		"«S2»":    s2,
		"«S1lc»":  strings.ToLower(s1),
		"«S1enc»": "%53" + s1[1:],
	}
}

func loadVectors(t testing.TB, path string) []vector {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f vectorFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	tokens := derivedTokens(t)
	for tok := range f.DerivedTokens {
		if _, ok := tokens[tok]; !ok {
			t.Fatalf("%s: derived token %s has no derivation in the test", path, tok)
		}
	}
	for i := range f.Vectors {
		v := &f.Vectors[i]
		for tok, val := range tokens {
			v.Input = strings.ReplaceAll(v.Input, tok, val)
			v.Expected = strings.ReplaceAll(v.Expected, tok, val)
		}
		if strings.Contains(v.Input, "«") || strings.Contains(v.Expected, "«") {
			t.Fatalf("%s: vector %d has an unresolved token", path, v.ID)
		}
	}
	if f.Count != len(f.Vectors) {
		t.Fatalf("%s: count %d but %d vectors", path, f.Count, len(f.Vectors))
	}
	return f.Vectors
}

func modeOptions(t testing.TB, mode string) Options {
	switch mode {
	case "path":
		return Options{Input: InputPath}
	case "route":
		return Options{Input: InputRoute}
	case "web_full":
		return Options{Input: InputWebPage, Folding: FoldingFull}
	case "web_relaxed":
		return Options{Input: InputWebPage, Folding: FoldingRelaxed}
	}
	t.Fatalf("unknown mode %q", mode)
	return Options{}
}

// counterNames renders Redactions in the corpus notation:
// <class>.<kind>[_in_query].
func counterNames(r Redactions) map[string]int {
	m := map[string]int{}
	r.Each(func(k Kind, l Location, n int) {
		name := k.Class() + "." + k.String()
		if l == LocQuery {
			name += "_in_query"
		}
		m[name] += n
	})
	return m
}

func ruleNames(rs []Rule) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = string(r)
	}
	return out
}

func checkVectors(t *testing.T, vs []vector) (pass int) {
	for _, v := range vs {
		got := Normalize(v.Input, modeOptions(t, v.Mode))
		ok := true
		if got.Route != v.Expected {
			t.Errorf("vector %d (%s): route %q, want %q", v.ID, v.Mode, got.Route, v.Expected)
			ok = false
		}
		if g := ruleNames(got.Rules); !slices.Equal(g, v.Rules) {
			t.Errorf("vector %d (%s): rules %v, want %v", v.ID, v.Mode, g, v.Rules)
			ok = false
		}
		gc := counterNames(got.Redactions)
		if len(gc) != len(v.Counters) {
			ok = false
		}
		for k, n := range v.Counters {
			if gc[k] != n {
				ok = false
			}
		}
		if !ok && len(gc)+len(v.Counters) > 0 {
			t.Errorf("vector %d (%s): counters %v, want %v", v.ID, v.Mode, gc, v.Counters)
		}
		if ok {
			pass++
		}
	}
	return pass
}

func TestCorpusVectors(t *testing.T) {
	vs := loadVectors(t, "testdata/vectors.json")
	if len(vs) != 451 {
		t.Fatalf("corpus has %d vectors, want 451", len(vs))
	}
	paths, routes := 0, 0
	for _, v := range vs {
		switch v.Mode {
		case "path":
			paths++
		case "route":
			routes++
		}
	}
	if paths != 432 || routes != 19 {
		t.Fatalf("corpus has %d path and %d route vectors, want 432 and 19", paths, routes)
	}
	pass := checkVectors(t, vs)
	t.Logf("corpus vectors passing: %d/%d", pass, len(vs))
}

// TestExtraVectors covers what the research corpus does not: relaxed and
// full page-path folding (C-52, C-70, C-89), reserved route-level
// placeholders, and hardening added during the build.
func TestExtraVectors(t *testing.T) {
	vs := loadVectors(t, "testdata/vectors_extra.json")
	pass := checkVectors(t, vs)
	t.Logf("extra vectors passing: %d/%d", pass, len(vs))
}

// TestCorpusIdempotence: Normalize(Normalize(x)) == Normalize(x), and every
// expected output is a fixed point in both path and route mode (ADR-0012).
func TestCorpusIdempotence(t *testing.T) {
	vs := loadVectors(t, "testdata/vectors.json")
	vs = append(vs, loadVectors(t, "testdata/vectors_extra.json")...)
	modes := []Options{{Input: InputPath}, {Input: InputRoute}, {Input: InputWebPage}, {Input: InputWebPage, Folding: FoldingRelaxed}}
	for _, v := range vs {
		for _, o := range modes {
			once := Normalize(v.Input, o).Route
			if twice := Normalize(once, o).Route; twice != once {
				t.Errorf("vector %d %v/%v: not idempotent: %q → %q → %q", v.ID, o.Input, o.Folding, v.Input, once, twice)
			}
		}
		fixed := []Options{modeOptions(t, v.Mode)}
		if v.Mode != "web_relaxed" {
			fixed = append(fixed, modes[:2]...) // ADR-0012: both modes
		}
		for _, o := range fixed {
			if got := Normalize(v.Expected, o).Route; got != v.Expected {
				t.Errorf("vector %d: expected %q is not a fixed point in %v mode (got %q)", v.ID, v.Expected, o.Input, got)
			}
		}
	}
}

// TestCorpusVocabulary: every placeholder in the expected outputs is in the
// closed vocabulary (C-16), or a lower-cased tenant parameter name in route
// mode.
func TestCorpusVocabulary(t *testing.T) {
	vocab := map[string]bool{}
	for _, p := range Vocabulary {
		vocab[p] = true
	}
	for _, v := range loadVectors(t, "testdata/vectors.json") {
		for seg := range strings.SplitSeq(strings.TrimPrefix(v.Expected, "/"), "/") {
			if !strings.HasPrefix(seg, "{") {
				continue
			}
			if strings.HasPrefix(seg, "{static}.") {
				seg = PhStatic
			}
			if !vocab[seg] && v.Mode != "route" {
				t.Errorf("vector %d: placeholder %q outside the closed vocabulary", v.ID, seg)
			}
			if seg == PhOverflow || seg == PhUnknown {
				t.Errorf("vector %d: %s must never be produced by Normalize", v.ID, seg)
			}
		}
	}
}
