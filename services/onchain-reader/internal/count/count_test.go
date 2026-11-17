// SPDX-License-Identifier: Apache-2.0

package count_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
)

var (
	cA, cB, cX        = fixture.ID("contract-a"), fixture.ID("contract-b"), fixture.ID("contract-x")
	alice, bob, carol = fixture.ID("alice"), fixture.ID("bob"), fixture.ID("carol")
	dave              = fixture.ID("dave")
	day1              = time.Date(2026, 11, 1, 23, 59, 55, 0, time.UTC)
	day2              = time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	strA, strB, strX  = fixture.ContractStrkey(cA), fixture.ContractStrkey(cB), fixture.ContractStrkey(cX)
	daveAsOpSource    = fixture.Account(dave)
)

func ledgers() []xdr.LedgerCloseMeta {
	l100 := fixture.Ledger(100, day1.Add(-10*time.Second), false, []fixture.Tx{
		{Source: fixture.Account(alice), Contract: &cA, Function: "swap", Success: true, Seq: 1},
		{Source: fixture.Account(alice), Contract: &cA, Function: "swap", Success: false, Seq: 2},
		{Source: fixture.MuxedAccount(bob, 7), Contract: &cA, Function: "swap", Success: true, FeeBump: true, Seq: 3},
		{Source: fixture.Account(carol), OpSource: &daveAsOpSource, Contract: &cB, Function: "mint", Success: true, Seq: 4},
		{Source: fixture.Account(carol), Contract: &cX, Function: "other", Success: true, Seq: 5},
		{Source: fixture.Account(carol), Success: true, Seq: 6}, // payment
	})
	l101 := fixture.Ledger(101, day1, true, []fixture.Tx{
		{Source: fixture.Account(alice), Contract: &cA, Function: "swap", Success: true, Seq: 7},
		{Source: fixture.MuxedAccount(bob, 9), Contract: &cA, Function: "swap", Success: false, FeeBump: true, Seq: 8},
	})
	l102 := fixture.Ledger(102, day2, true, []fixture.Tx{{Source: fixture.Account(carol), Success: true, Seq: 9}})
	return []xdr.LedgerCloseMeta{l100, l101, l102}
}

func mustCounter(t *testing.T, contracts []string, from, to string) *count.Counter {
	t.Helper()
	c, err := count.New(fixture.Passphrase, contracts, from, to)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCountsPerContractAndDay(t *testing.T) {
	c := mustCounter(t, []string{strB, strA}, "", "")
	ls := ledgers()
	for _, l := range append(ls, ls[1]) { // ledger 101 twice: overlapping files
		if err := c.AddLedger(l); err != nil {
			t.Fatal(err)
		}
	}
	got := c.Rows()
	type exp struct {
		contract, day                 string
		inv, ok, distinct, ledgersDay int64
	}
	want := []exp{
		{strA, "2026-11-01", 5, 3, 2, 2}, // alice ×3 (1 failed), bob ×2 via muxed + fee bump (1 failed)
		{strB, "2026-11-01", 1, 1, 1, 2}, // operation source dave, not the tx source carol
		{strA, "2026-11-02", 0, 0, 0, 1},
		{strB, "2026-11-02", 0, 0, 0, 1},
	}
	// Rows are sorted by day, then contract strkey.
	if strB < strA {
		want[0], want[1] = want[1], want[0]
		want[2], want[3] = want[3], want[2]
	}
	if len(got) != len(want) {
		t.Fatalf("rows = %+v", got)
	}
	for i, w := range want {
		g := got[i]
		if g.Contract != w.contract || g.Day != w.day || g.Invocations != w.inv || g.SuccessfulInvocations != w.ok ||
			g.DistinctInvokers != w.distinct || g.LedgersInDay != w.ledgersDay || g.DataSource != "ledger_files" {
			t.Errorf("row %d = %+v, want %+v", i, g, w)
		}
	}
	s := c.Stats()
	if s.Ledgers != 3 || s.DuplicateLedgers != 1 || s.UnmatchedResults != 0 || s.MatchedInvocations != 6 || s.Transactions != 9 {
		t.Errorf("stats = %+v", s)
	}
}

func TestDayBounds(t *testing.T) {
	c := mustCounter(t, []string{strA}, "2026-11-02", "2026-11-02")
	for _, l := range ledgers() {
		if err := c.AddLedger(l); err != nil {
			t.Fatal(err)
		}
	}
	rows := c.Rows()
	if len(rows) != 1 || rows[0].Day != "2026-11-02" || rows[0].Invocations != 0 {
		t.Fatalf("rows = %+v", rows)
	}
	if c.Stats().OutOfRangeLedgers != 2 {
		t.Errorf("stats = %+v", c.Stats())
	}
}

func TestWrongNetworkLeavesResultsUnmatched(t *testing.T) {
	c, err := count.New(network.PublicNetworkPassphrase, []string{strA}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.AddLedger(ledgers()[0]); err != nil {
		t.Fatal(err)
	}
	if c.Stats().UnmatchedResults != 6 || c.Rows()[0].Invocations != 0 {
		t.Errorf("stats = %+v rows = %+v", c.Stats(), c.Rows())
	}
}

func TestNewValidates(t *testing.T) {
	cases := map[string]struct {
		pass      string
		contracts []string
		from, to  string
	}{
		"no passphrase":        {"", []string{strA}, "", ""},
		"no contracts":         {fixture.Passphrase, nil, "", ""},
		"account not contract": {fixture.Passphrase, []string{fixture.AccountStrkey(alice)}, "", ""},
		"garbage":              {fixture.Passphrase, []string{"Cnot-a-key"}, "", ""},
		"bad day":              {fixture.Passphrase, []string{strA}, "2026-13-01", ""},
		"reversed range":       {fixture.Passphrase, []string{strA}, "2026-11-02", "2026-11-01"},
	}
	for name, tc := range cases {
		if _, err := count.New(tc.pass, tc.contracts, tc.from, tc.to); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestMalformedLedgerIsAnErrorAndCountsNothing(t *testing.T) {
	c := mustCounter(t, []string{strA}, "", "")
	bad := ledgers()[0]
	bad.V1.TxSet.V1TxSet.Phases[0].V = 7 // unknown phase: the SDK accessor panics
	if err := c.AddLedger(bad); err == nil {
		t.Fatal("no error for a malformed ledger")
	}
	if len(c.Rows()) != 1 || c.Rows()[0].Invocations != 0 {
		t.Errorf("rows after failure = %+v", c.Rows())
	}
}

// Privacy invariant: no invoker identity (G…, M… strkey or raw key) appears in the output.
func TestOutputCarriesNoInvokerIdentity(t *testing.T) {
	c := mustCounter(t, []string{strA, strB}, "", "")
	for _, l := range ledgers() {
		if err := c.AddLedger(l); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := json.Marshal(c.Rows())
	if err != nil {
		t.Fatal(err)
	}
	out := string(raw)
	for _, id := range [][32]byte{alice, bob, carol, dave} {
		if strings.Contains(out, fixture.AccountStrkey(id)) || strings.Contains(out, string(id[:])) {
			t.Fatalf("output contains an invoker identity: %s", out)
		}
	}
	if strings.Contains(out, "\"G") || strings.Contains(out, "\"M") {
		t.Fatalf("output contains an account strkey: %s", out)
	}
	if strings.Contains(out, strX) {
		t.Fatalf("output contains an unrequested contract: %s", out)
	}
}

// A day is complete only when its ledgers are contiguous and the run also saw the ledger just before its first and
// just after its last (both outside the day, possibly outside the requested range): only then can the caller store it
// (C-128: never a partial day).
func TestDayCompleteness(t *testing.T) {
	d1 := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	at := func(seq uint32, ts time.Time) xdr.LedgerCloseMeta { return fixture.Ledger(seq, ts, false, nil) }
	cases := []struct {
		name    string
		ledgers []xdr.LedgerCloseMeta
		want    map[string]bool // day → complete
		first   map[string]uint32
		last    map[string]uint32
	}{
		{
			name: "bounded on both sides by out-of-range neighbours",
			ledgers: []xdr.LedgerCloseMeta{
				at(9, d1.Add(-5*time.Second)), at(10, d1), at(11, d1.Add(5*time.Second)), at(12, d1.Add(24*time.Hour)),
			},
			want:  map[string]bool{"2026-11-05": true},
			first: map[string]uint32{"2026-11-05": 10},
			last:  map[string]uint32{"2026-11-05": 11},
		},
		{
			name:    "no ledger after the day",
			ledgers: []xdr.LedgerCloseMeta{at(9, d1.Add(-5*time.Second)), at(10, d1), at(11, d1.Add(5*time.Second))},
			want:    map[string]bool{"2026-11-05": false},
		},
		{
			name:    "no ledger before the day",
			ledgers: []xdr.LedgerCloseMeta{at(10, d1), at(11, d1.Add(5*time.Second)), at(12, d1.Add(24*time.Hour))},
			want:    map[string]bool{"2026-11-05": false},
		},
		{
			name: "gap inside the day",
			ledgers: []xdr.LedgerCloseMeta{
				at(9, d1.Add(-5*time.Second)), at(10, d1), at(12, d1.Add(10*time.Second)), at(13, d1.Add(24*time.Hour)),
			},
			want: map[string]bool{"2026-11-05": false},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := mustCounter(t, []string{strA}, "2026-11-05", "2026-11-05")
			for _, l := range tc.ledgers {
				if err := c.AddLedger(l); err != nil {
					t.Fatal(err)
				}
			}
			rows := c.Rows()
			if len(rows) != len(tc.want) {
				t.Fatalf("rows = %+v", rows)
			}
			for _, r := range rows {
				if r.Complete != tc.want[r.Day] {
					t.Errorf("%s complete = %v, want %v", r.Day, r.Complete, tc.want[r.Day])
				}
				if f, ok := tc.first[r.Day]; ok && (r.LedgerFirst != f || r.LedgerLast != tc.last[r.Day]) {
					t.Errorf("%s ledgers %d..%d, want %d..%d", r.Day, r.LedgerFirst, r.LedgerLast, f, tc.last[r.Day])
				}
			}
		})
	}
}

func TestAnchorNamesTheLedgerAfterEachCompleteDay(t *testing.T) {
	rows := []count.Row{
		{Day: "2026-11-01", LedgerFirst: 10, LedgerLast: 19, Complete: true},
		{Day: "2026-11-02", LedgerFirst: 20, LedgerLast: 29, Complete: false},
		{Day: "2026-11-03", LedgerFirst: 30, LedgerLast: 39, Complete: true}, // ledger 40 was not read
	}
	hashes := map[uint32][32]byte{20: {0xab, 0x01}, 30: {0xcd}}
	count.Anchor(rows, func(seq uint32) ([32]byte, bool) { h, ok := hashes[seq]; return h, ok })
	if rows[0].AnchorLedger == nil || *rows[0].AnchorLedger != 20 || rows[0].AnchorHash == nil ||
		*rows[0].AnchorHash != "ab01"+strings.Repeat("0", 60) {
		t.Fatalf("complete day = %+v", rows[0])
	}
	if rows[1].AnchorLedger != nil || rows[1].AnchorHash != nil {
		t.Fatalf("incomplete day has an anchor: %+v", rows[1])
	}
	if rows[2].Complete || rows[2].AnchorLedger != nil {
		t.Fatalf("complete day without its anchor ledger must turn incomplete: %+v", rows[2])
	}
}
