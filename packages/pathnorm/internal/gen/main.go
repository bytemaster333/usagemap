// SPDX-License-Identifier: Apache-2.0
// Command gen converts the research test-vector corpus
// (references/stellar-path-normalization-test-vectors-2026-11-12.md, §4
// legend and §5 table) into testdata/vectors.json, once. After that the JSON
// file is owned by the pathnorm workstream; re-running the generator must
// reproduce it byte for byte (go generate, then git diff).
//
// Secret-seed tokens («S1», «S2», «S1lc», «S1enc») are deliberately not
// substituted: the corpus prints no seed values, and the tests derive them at
// run time from the published formula, so no seed-shaped string is stored.
//
// Usage: go run ./internal/gen -in <corpus.md> -out testdata/vectors.json
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Vector is one corpus entry as stored in vectors.json.
type Vector struct {
	ID       int            `json:"id"`
	Mode     string         `json:"mode"` // "path" | "route"
	Input    string         `json:"input"`
	Expected string         `json:"expected"`
	Rules    []string       `json:"rules"`
	Counters map[string]int `json:"counters"`
	Source   string         `json:"source"`
	Note     string         `json:"note,omitempty"`
}

// File is the layout of vectors.json.
type File struct {
	Comment       string            `json:"comment"`
	Corpus        string            `json:"corpus"`
	CorpusRuleSet string            `json:"corpus_rule_set"`
	RuleSet       string            `json:"rule_set"`
	Count         int               `json:"count"`
	Legend        map[string]string `json:"legend"`
	DerivedTokens map[string]string `json:"derived_tokens"`
	Vectors       []Vector          `json:"vectors"`
}

// derivedTokens are the seed tokens the tests derive at run time.
var derivedTokens = map[string]string{
	"«S1»":    `strkey_encode("S", sha256("scf-vector-S1-test-only"))`,
	"«S2»":    `strkey_encode("S", sha256("scf-vector-S2-test-only"))`,
	"«S1lc»":  `lowercase(«S1»)`,
	"«S1enc»": `"%53" + «S1»[1:]`,
}

// abbreviated are the inputs the corpus prints as "prefix… (len N)"; the
// generators are those of corpus §3.
var abbreviated = map[int]string{
	393: "/a/" + strings.Repeat("x", 300),
	396: "/" + strings.Repeat("a/", 5000),
}

// overrides apply where a later decision wins over the corpus (C-16
// vocabulary, C-70/C-89 folding, rule-set versions). Each carries a note and
// the rules that fire under the current rule set.
//
// scf-path-rules/1.1.0 (numeric IDs are removed, pathnorm.numeric-ids):
// every all-digit segment folds to {int}, single digits included;
// the research corpus kept single digits literal.
var overrides = map[int]struct {
	Expected, Note string
	Rules          []string
}{
	29:  {"/ledgers/{int}", singleDigitNote, []string{"S6.int"}},
	30:  {"/ledgers/{int}", singleDigitNote, []string{"S6.int"}},
	282: {"/api/{int}/users", singleDigitNote, []string{"S6.int"}},
	284: {"/users/{int}", singleDigitNote, []string{"S6.int"}},
	427: {"/page/{int}", singleDigitNote, []string{"S6.int"}},
}

const singleDigitNote = "1.1.0: single-digit numeric ids fold to {int} (pathnorm.numeric-ids); the 1.0.0 corpus kept them literal"

var (
	rowRE    = regexp.MustCompile(`^\| (\d+) \|`)
	legendRE = regexp.MustCompile("^\\| `(«[A-Za-z0-9]+»)` \\| (\\d+) \\| (.*) \\|$")
	tokenRE  = regexp.MustCompile(`«[A-Za-z0-9]+»`)
	abbrRE   = regexp.MustCompile(`… \(len (\d+)\)$`)
)

func main() {
	in := flag.String("in", "", "corpus markdown file")
	out := flag.String("out", "testdata/vectors.json", "output JSON file")
	flag.Parse()
	if *in == "" {
		fail("missing -in")
	}
	f, err := os.Open(*in)
	if err != nil {
		fail("%v", err)
	}
	defer f.Close()

	legend := map[string]string{}
	var vectors []Vector
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	section := ""
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "## ") {
			section = line
			continue
		}
		switch {
		case strings.HasPrefix(section, "## 4.") && legendRE.MatchString(line):
			m := legendRE.FindStringSubmatch(line)
			tok, n, val := m[1], atoi(m[2]), strings.TrimSpace(m[3])
			if _, derived := derivedTokens[tok]; derived {
				continue
			}
			v, ok := unquote(val)
			if !ok {
				fail("legend %s: value not in backticks", tok)
			}
			if len(v) != n {
				fail("legend %s: length %d, table says %d", tok, len(v), n)
			}
			legend[tok] = v
		case strings.HasPrefix(section, "## 5.") && rowRE.MatchString(line):
			vectors = append(vectors, parseRow(line))
		}
	}
	if err := sc.Err(); err != nil {
		fail("%v", err)
	}
	for tok := range derivedTokens {
		if _, ok := legend[tok]; ok {
			fail("derived token %s must not be in the legend", tok)
		}
	}

	paths, routes := 0, 0
	for i := range vectors {
		v := &vectors[i]
		if v.ID != i+1 {
			fail("vector %d out of order (position %d)", v.ID, i+1)
		}
		v.Input = substitute(v.ID, v.Input, legend)
		v.Expected = substitute(v.ID, v.Expected, legend)
		if o, ok := overrides[v.ID]; ok {
			v.Expected, v.Note = o.Expected, o.Note
			if o.Rules != nil {
				v.Rules = o.Rules
			}
		}
		if v.Mode == "path" {
			paths++
		} else {
			routes++
		}
	}
	if len(vectors) != 451 || paths != 432 || routes != 19 {
		fail("corpus has %d vectors (%d path, %d route); want 451 (432, 19)", len(vectors), paths, routes)
	}

	file := File{
		Comment: "Generated by internal/gen from the research corpus. " +
			"Tokens in derived_tokens are seeds derived at test time (never stored). " +
			"A note field marks an expected value changed because a later decision wins.",
		Corpus:        "references/stellar-path-normalization-test-vectors-2026-11-12.md",
		CorpusRuleSet: "scf-path-rules/1.0.0-draft",
		RuleSet:       "scf-path-rules/1.1.0",
		Count:         len(vectors),
		Legend:        legend,
		DerivedTokens: derivedTokens,
		Vectors:       vectors,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(file); err != nil {
		fail("%v", err)
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
		fail("%v", err)
	}
	fmt.Printf("wrote %s: %d vectors (%d path, %d route), %d legend tokens, %d derived\n",
		*out, len(vectors), paths, routes, len(legend), len(derivedTokens))
}

func parseRow(line string) Vector {
	cells := splitRow(line)
	if len(cells) != 7 {
		fail("row %q: %d cells, want 7", line, len(cells))
	}
	v := Vector{ID: atoi(cells[0]), Source: cells[6], Counters: map[string]int{}, Rules: []string{}}
	switch cells[1] {
	case "p":
		v.Mode = "path"
	case "r":
		v.Mode = "route"
	default:
		fail("vector %d: mode %q", v.ID, cells[1])
	}
	var ok bool
	if v.Input, ok = unquote(cells[2]); !ok {
		fail("vector %d: input not in backticks", v.ID)
	}
	if v.Expected, ok = unquote(cells[3]); !ok {
		fail("vector %d: expected not in backticks", v.ID)
	}
	if m := abbrRE.FindStringSubmatch(v.Input); m != nil {
		full, ok := abbreviated[v.ID]
		prefix := strings.TrimSuffix(v.Input, m[0])
		if !ok || len(full) != atoi(m[1]) || !strings.HasPrefix(full, prefix) {
			fail("vector %d: no matching expansion for abbreviated input", v.ID)
		}
		v.Input = full
	}
	if cells[4] != "—" {
		v.Rules = strings.Fields(cells[4])
	}
	if cells[5] != "—" {
		for _, c := range strings.Fields(cells[5]) {
			name, n, found := strings.Cut(c, "+")
			if !found {
				fail("vector %d: counter %q", v.ID, c)
			}
			v.Counters[name] += atoi(n)
		}
	}
	return v
}

// splitRow splits a Markdown table row on unescaped pipes; "\|" is a literal pipe.
func splitRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	var cells []string
	var cur strings.Builder
	for i := 0; i < len(line); i++ {
		if line[i] == '\\' && i+1 < len(line) && line[i+1] == '|' {
			cur.WriteByte('|')
			i++
			continue
		}
		if line[i] == '|' {
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
			continue
		}
		cur.WriteByte(line[i])
	}
	return append(cells, strings.TrimSpace(cur.String()))
}

// unquote strips one pair of surrounding backticks; two backticks alone are the empty string.
func unquote(s string) (string, bool) {
	if len(s) < 2 || s[0] != '`' || s[len(s)-1] != '`' {
		return "", false
	}
	return s[1 : len(s)-1], true
}

func substitute(id int, s string, legend map[string]string) string {
	out := tokenRE.ReplaceAllStringFunc(s, func(tok string) string {
		if v, ok := legend[tok]; ok {
			return v
		}
		if _, ok := derivedTokens[tok]; ok {
			return tok
		}
		fail("vector %d: unknown token %s", id, tok)
		return ""
	})
	return out
}

func atoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		fail("not a number: %q", s)
	}
	return n
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "gen: "+format+"\n", a...)
	os.Exit(1)
}
