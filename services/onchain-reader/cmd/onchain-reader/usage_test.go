// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
)

// TestUsageSubcommand: groups from stdin, one JSON line per kind in the documented order, counts-only summary, no
// account anywhere in the output.
func TestUsageSubcommand(t *testing.T) {
	dir, a, b := writeLake(t)
	stdin = strings.NewReader("# registry projects\nproj-1 " + a + "\nproj-1 " + b + "\nproj-2 " + b + "\n")
	t.Cleanup(func() { stdin = os.Stdin })
	var out, errOut bytes.Buffer
	code := run([]string{"usage", "-network", "testnet", "-groups", "-", "-from-day", "2026-11-03", "-to-day", "2026-11-03", dir}, &out, &errOut)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	kinds := []string{}
	groups := map[string]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatal(err)
		}
		k := m["kind"].(string)
		if len(kinds) == 0 || kinds[len(kinds)-1] != k {
			kinds = append(kinds, k)
		}
		if k == "group" {
			groups[m["group"].(string)] = m
		}
	}
	if strings.Join(kinds, ",") != "day,group,contract,function" {
		t.Errorf("kinds in order = %v (no week: the day is incomplete)", kinds)
	}
	if g := groups["proj-1"]; g["invocations"] != 3.0 || g["distinct_invokers"] != 2.0 || g["contracts_invoked"] != 2.0 {
		t.Errorf("proj-1 = %v", g)
	}
	if g := groups["proj-2"]; g["invocations"] != 1.0 || g["distinct_invokers"] != 1.0 {
		t.Errorf("proj-2 = %v", g)
	}
	for _, who := range []string{"alice", "bob"} {
		if strings.Contains(out.String(), fixture.AccountStrkey(fixture.ID(who))) || strings.Contains(errOut.String(), fixture.AccountStrkey(fixture.ID(who))) {
			t.Fatalf("output names %s", who)
		}
	}
	if !strings.Contains(errOut.String(), "onchain-reader usage: files=3 ledgers=2 ") || !strings.Contains(errOut.String(), " invocations=3 contract_calls=0 weeks=0") {
		t.Errorf("summary = %q", errOut.String())
	}
}

func TestUsageExitCodes(t *testing.T) {
	dir, a, _ := writeLake(t)
	t.Cleanup(func() { stdin = os.Stdin })
	for _, c := range []struct {
		in   string
		args []string
		want int
	}{
		{"p " + a, []string{"usage", "-groups", "-", "-from-day", "2026-11-03", "-to-day", "2026-11-03"}, 2},                            // no path
		{"p " + a, []string{"usage", "-groups", "-", dir}, 2},                                                                           // days required
		{"p", []string{"usage", "-groups", "-", "-from-day", "2026-11-03", "-to-day", "2026-11-03", dir}, 2},                            // malformed line
		{"p " + a, []string{"usage", "-groups", "-", "-from-day", "2026-11-03", "-to-day", "2026-11-03", t.TempDir()}, 1},               // no files
		{"p " + a, []string{"usage", "-network", "pubnet", "-groups", "-", "-from-day", "2026-11-03", "-to-day", "2026-11-03", dir}, 1}, // wrong network
	} {
		stdin = strings.NewReader(c.in)
		var out, errOut bytes.Buffer
		if got := run(c.args, &out, &errOut); got != c.want {
			t.Errorf("%v: exit %d, want %d (%s)", c.args, got, c.want, errOut.String())
		}
	}
}
