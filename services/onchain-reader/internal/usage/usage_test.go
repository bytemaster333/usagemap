// SPDX-License-Identifier: Apache-2.0

package usage_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/usage"
)

var (
	cA, cB, cTok, cX = fixture.ID("contract-a"), fixture.ID("contract-b"), fixture.ID("token"), fixture.ID("contract-x")
	sA, sB, sTok     = fixture.ContractStrkey(cA), fixture.ContractStrkey(cB), fixture.ContractStrkey(cTok)
	alice, bob       = fixture.ID("alice"), fixture.ID("bob")
	carol, dave      = fixture.ID("carol"), fixture.ID("dave")
)

func acc(id [32]byte) xdr.MuxedAccount { return fixture.Account(id) }

// chain builds ledgers seq..seq+len(days)-1, one per close time, chained, and returns a hash lookup over them.
func chain(t *testing.T, start uint32, at []time.Time, txs map[int][]fixture.Tx) ([]xdr.LedgerCloseMeta, func(uint32) ([32]byte, bool)) {
	t.Helper()
	var ls []xdr.LedgerCloseMeta
	seq := int64(0)
	for i, a := range at {
		var tx []fixture.Tx
		for _, x := range txs[i] {
			seq++
			x.Seq = seq
			tx = append(tx, x)
		}
		ls = append(ls, fixture.Ledger(start+uint32(i), a, i%2 == 0, tx))
	}
	ls = fixture.Chain(ls)
	var c lake.Chain
	for _, l := range ls {
		if err := c.Add(l); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Verify(); err != nil {
		t.Fatal(err)
	}
	return ls, c.Hash
}

func run(t *testing.T, members []usage.Member, from, to string, ls []xdr.LedgerCloseMeta, h func(uint32) ([32]byte, bool)) usage.Result {
	t.Helper()
	c, err := usage.New(fixture.Passphrase, members, from, to)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range ls {
		if err := c.AddLedger(l); err != nil {
			t.Fatal(err)
		}
	}
	return c.Result(h)
}

func day(d string, hh int) time.Time {
	x, _ := time.Parse(time.DateOnly, d)
	return x.Add(time.Duration(hh) * time.Hour)
}

// TestGroupAndContractFigures: per group distinct invokers are distinct over its contracts, not summed; a contract in
// two groups counts in both; muxed and fee-bumped sources count as the underlying inner source; the operation source
// wins over the transaction source; a failed transaction counts as an invocation, not as a success.
func TestGroupAndContractFigures(t *testing.T) {
	op := acc(dave)
	ls, h := chain(t, 100, []time.Time{day("2026-11-09", -1), day("2026-11-09", 10), day("2026-11-09", 12), day("2026-11-10", 0)},
		map[int][]fixture.Tx{
			1: {
				{Source: acc(alice), Contract: &cA, Function: "swap", Success: true},
				{Source: acc(alice), Contract: &cB, Function: "deposit", Success: true},
				{Source: fixture.MuxedAccount(bob, 4), Contract: &cA, Function: "swap", Success: false, FeeBump: true},
				{Source: acc(carol), OpSource: &op, Contract: &cB, Function: "deposit", Success: true},
				{Source: acc(carol), Contract: &cX, Function: "swap", Success: true}, // not requested
				{Source: acc(carol), Success: true},                                  // payment
			},
			2: {{Source: acc(alice), Contract: &cA, Function: "withdraw", Success: true}},
		})
	r := run(t, []usage.Member{{"p1", sA}, {"p1", sB}, {"p2", sB}}, "2026-11-09", "2026-11-09", ls, h)
	if len(r.Days) != 1 || !r.Days[0].Complete || r.Days[0].LedgersInDay != 2 || *r.Days[0].AnchorLedger != 103 {
		t.Fatalf("days = %+v", r.Days)
	}
	g := map[string]usage.GroupLine{}
	for _, l := range r.Groups {
		g[l.Group] = l
	}
	if p1 := g["p1"]; p1.Invocations != 5 || p1.SuccessfulInvocations != 4 || p1.DistinctInvokers != 3 || p1.ContractsInvoked != 2 {
		t.Errorf("p1 = %+v (want 5 invocations, 4 ok, invokers alice+bob+dave, 2 contracts)", p1)
	}
	if p2 := g["p2"]; p2.Invocations != 2 || p2.DistinctInvokers != 2 || p2.ContractsInvoked != 1 {
		t.Errorf("p2 = %+v (want contract B only: alice, dave)", p2)
	}
	c := map[string]usage.ContractLine{}
	for _, l := range r.Contracts {
		c[l.Contract] = l
	}
	if a := c[sA]; a.Invocations != 3 || a.SuccessfulInvocations != 2 || a.DistinctInvokers != 2 {
		t.Errorf("contract A = %+v", a)
	}
	fn := map[string]int64{}
	for _, f := range r.Functions {
		fn[fmt.Sprintf("%s/%s/%s", f.Contract[:4], f.Function, f.CallerKind)] = f.Calls*10 + f.SuccessfulCalls
	}
	want := map[string]int64{
		sA[:4] + "/swap/account": 21, sA[:4] + "/withdraw/account": 11, sB[:4] + "/deposit/account": 22,
	}
	if fmt.Sprint(fn) != fmt.Sprint(want) {
		t.Errorf("functions = %v, want %v", fn, want)
	}
}

// TestContractCallsFromAuthorizationTrees: sub-invocations of requested contracts are counted as caller kind
// "contract"; the root that is the top-level call itself is not; a root that differs from the top-level call was made
// by a contract; equal nodes of one transaction (two signers) count once; a failed transaction's calls are calls, not
// successes; contract calls never add invokers or active accounts.
func TestContractCallsFromAuthorizationTrees(t *testing.T) {
	transfer := func(arg uint32) fixture.Call {
		return fixture.Call{Contract: cTok, Function: "transfer", Args: []uint32{arg}}
	}
	ls, h := chain(t, 10, []time.Time{day("2026-11-09", -1), day("2026-11-09", 8), day("2026-11-10", 0)},
		map[int][]fixture.Tx{1: {
			// router (X, not requested) → token.transfer: root differs from the top-level call
			{Source: acc(alice), Contract: &cX, Function: "route", Success: true, Auth: []fixture.Call{transfer(1)}},
			// A.swap (root = top-level) → token.transfer twice with different args, and the same node in a second entry
			{Source: acc(bob), Contract: &cA, Function: "swap", Success: true, Auth: []fixture.Call{
				{Contract: cA, Function: "swap", Sub: []fixture.Call{transfer(1), transfer(2)}},
				{Contract: cA, Function: "swap", Sub: []fixture.Call{transfer(2)}},
			}},
			{Source: acc(carol), Contract: &cA, Function: "swap", Success: false, Auth: []fixture.Call{
				{Contract: cA, Function: "swap", Sub: []fixture.Call{transfer(3)}},
			}},
		}})
	r := run(t, []usage.Member{{"dex", sA}, {"tok", sTok}}, "2026-11-09", "2026-11-09", ls, h)
	var tokFn []string
	for _, f := range r.Functions {
		tokFn = append(tokFn, fmt.Sprintf("%s:%s:%s:%d/%d", f.Contract[:4], f.Function, f.CallerKind, f.SuccessfulCalls, f.Calls))
	}
	want := []string{sA[:4] + ":swap:account:1/2", sTok[:4] + ":transfer:contract:3/4"}
	if sTok < sA {
		want[0], want[1] = want[1], want[0]
	}
	if strings.Join(tokFn, ",") != strings.Join(want, ",") {
		t.Errorf("functions = %v, want %v", tokFn, want)
	}
	for _, g := range r.Groups {
		switch g.Group {
		case "tok":
			if g.Invocations != 0 || g.ContractCalls != 4 || g.DistinctInvokers != 0 || g.ContractsInvoked != 1 {
				t.Errorf("tok = %+v", g)
			}
		case "dex":
			if g.Invocations != 2 || g.ContractCalls != 0 || g.DistinctInvokers != 2 {
				t.Errorf("dex = %+v", g)
			}
		}
	}
	for _, c := range r.Contracts {
		if c.Contract == sTok && (c.ContractCalls != 4 || c.SuccessfulContractCalls != 3 || c.DistinctInvokers != 0) {
			t.Errorf("token = %+v", c)
		}
	}
}

// TestWeeklyActiveAccounts: the Growth Hack WAA is distinct initiating accounts over one ISO week (Monday–Sunday UTC),
// reported only when all seven days are complete; failed-only accounts count in active_accounts but not in
// active_accounts_successful; a partial week yields no line.
func TestWeeklyActiveAccounts(t *testing.T) {
	// Sunday 2026-11-08 23:00 (boundary), Mon 2026-11-09 … Sun 2026-11-15 one ledger per day at noon, Mon 2026-11-16 00:00.
	at := []time.Time{day("2026-11-08", 23)}
	for i := 0; i < 7; i++ {
		at = append(at, day("2026-11-09", 12+24*i))
	}
	at = append(at, day("2026-11-16", 0))
	txs := map[int][]fixture.Tx{
		1: {{Source: acc(alice), Contract: &cA, Function: "f", Success: true}},
		3: {{Source: acc(alice), Contract: &cA, Function: "f", Success: true}, {Source: acc(bob), Contract: &cB, Function: "g", Success: true}},
		7: {{Source: acc(carol), Contract: &cA, Function: "f", Success: false}},
		8: {{Source: acc(dave), Contract: &cA, Function: "f", Success: true}}, // Monday of the next week
	}
	ls, h := chain(t, 50, at, txs)
	members := []usage.Member{{"p", sA}, {"p", sB}}
	r := run(t, members, "2026-11-09", "2026-11-15", ls, h)
	if len(r.Weeks) != 1 {
		t.Fatalf("weeks = %+v", r.Weeks)
	}
	w := r.Weeks[0]
	if w.WeekStart != "2026-11-09" || w.ActiveAccounts != 3 || w.ActiveAccountsSuccessful != 2 || w.Invocations != 4 || w.SuccessfulInvocations != 3 {
		t.Errorf("week = %+v (want alice, bob, carol; carol failed only)", w)
	}
	// Daily distinct invokers are per day: summing them (1+2+1) overstates the week (3).
	var sum int64
	for _, g := range r.Groups {
		sum += g.DistinctInvokers
	}
	if sum != 4 {
		t.Errorf("sum of daily invokers = %d", sum)
	}
	// Six days of the week only: no weekly line.
	r = run(t, members, "2026-11-10", "2026-11-16", ls[1:], h)
	if len(r.Weeks) != 0 {
		t.Errorf("partial week reported: %+v", r.Weeks)
	}
	// The week with a missing middle day (ledger of Wednesday removed): not complete, no weekly line.
	gap := append(append([]xdr.LedgerCloseMeta{}, ls[:3]...), ls[4:]...)
	r = run(t, members, "2026-11-09", "2026-11-15", gap, h)
	if len(r.Weeks) != 0 {
		t.Errorf("week with a gap reported: %+v", r.Weeks)
	}
}

// TestFunctionCapAndInvalidNames: at most MaxFunctions names per contract and day, the rest as "(other)"; a name that
// is not a Soroban symbol is "(invalid)".
func TestFunctionCapAndInvalidNames(t *testing.T) {
	var txs []fixture.Tx
	for i := 0; i < usage.MaxFunctions+5; i++ {
		n := 1
		if i < 3 {
			n = 3 // three names called more often stay by rank
		}
		for j := 0; j < n; j++ {
			txs = append(txs, fixture.Tx{Source: acc(alice), Contract: &cA, Function: fmt.Sprintf("fn_%03d", i), Success: true})
		}
	}
	txs = append(txs, fixture.Tx{Source: acc(bob), Contract: &cA, Function: "bad name!", Success: true})
	ls, h := chain(t, 7, []time.Time{day("2026-11-09", -1), day("2026-11-09", 1), day("2026-11-10", 0)}, map[int][]fixture.Tx{1: txs})
	r := run(t, []usage.Member{{"p", sA}}, "2026-11-09", "2026-11-09", ls, h)
	if len(r.Functions) != usage.MaxFunctions {
		t.Fatalf("%d function lines, want %d", len(r.Functions), usage.MaxFunctions)
	}
	var total int64
	names := map[string]int64{}
	for _, f := range r.Functions {
		total += f.Calls
		names[f.Function] = f.Calls
	}
	if total != int64(len(txs)) {
		t.Errorf("calls lost in the cap: %d of %d", total, len(txs))
	}
	if names["fn_000"] != 3 || names[usage.OtherFunction] == 0 {
		t.Errorf("cap kept %v", names)
	}
	if _, ok := names[usage.InvalidFunction]; !ok && names[usage.OtherFunction] < 7 {
		t.Errorf("invalid name neither kept as (invalid) nor merged into (other): %v", names)
	}
}

func TestIncompleteDayHasNoAnchorAndNoWeek(t *testing.T) {
	ls, h := chain(t, 20, []time.Time{day("2026-11-09", 1), day("2026-11-09", 2)}, nil)
	r := run(t, []usage.Member{{"p", sA}}, "2026-11-09", "2026-11-09", ls, h)
	if r.Days[0].Complete || r.Days[0].AnchorLedger != nil || r.Days[0].AnchorHash != nil {
		t.Errorf("day without neighbours = %+v", r.Days[0])
	}
}

func TestNewRejectsBadInput(t *testing.T) {
	cases := []struct {
		m        []usage.Member
		from, to string
	}{
		{nil, "2026-11-01", "2026-11-01"},
		{[]usage.Member{{"bad label", sA}}, "2026-11-01", "2026-11-01"},
		{[]usage.Member{{"p", "CNOTAKEY"}}, "2026-11-01", "2026-11-01"},
		{[]usage.Member{{"p", sA}}, "", "2026-11-01"},
		{[]usage.Member{{"p", sA}}, "2026-11-02", "2026-11-01"},
		{[]usage.Member{{"p", sA}}, "2026-10-01", "2026-11-05"},
	}
	for i, c := range cases {
		if _, err := usage.New(fixture.Passphrase, c.m, c.from, c.to); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

// TestOutputCarriesNoAccount: no line of any kind names an account (G…/M… strkey or raw key).
func TestOutputCarriesNoAccount(t *testing.T) {
	ls, h := chain(t, 30, []time.Time{day("2026-11-09", -1), day("2026-11-09", 5), day("2026-11-10", 0)},
		map[int][]fixture.Tx{1: {{Source: acc(alice), Contract: &cA, Function: "f", Success: true}}})
	r := run(t, []usage.Member{{"p", sA}}, "2026-11-09", "2026-11-09", ls, h)
	b, _ := json.Marshal(r)
	for _, secret := range []string{fixture.AccountStrkey(alice), fmt.Sprintf("%x", alice)} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("output names an invoker: %s", b)
		}
	}
}
