// SPDX-License-Identifier: Apache-2.0

package protocols_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/protocols"
)

var (
	cApp, cApp2, cPool, cRouter, cOracle = fixture.ID("app"), fixture.ID("app-2"), fixture.ID("blend-pool"), fixture.ID("soroswap-router"), fixture.ID("reflector")
	cOther                               = fixture.ID("unrelated")
	s                                    = fixture.ContractStrkey
	alice, bob                           = fixture.Account(fixture.ID("alice")), fixture.Account(fixture.ID("bob"))
)

var registry = []protocols.ProtocolContract{
	{Protocol: "blend", Contract: s(cPool)},
	{Protocol: "soroswap", Contract: s(cRouter)},
	{Protocol: "reflector", Contract: s(cOracle)},
}

func at(d string, hh int) time.Time {
	x, _ := time.Parse(time.DateOnly, d)
	return x.Add(time.Duration(hh) * time.Hour)
}

func build(t *testing.T, start uint32, times []time.Time, txs map[int][]fixture.Tx) ([]xdr.LedgerCloseMeta, func(uint32) ([32]byte, bool)) {
	t.Helper()
	var ls []xdr.LedgerCloseMeta
	seq := int64(0)
	for i, a := range times {
		var tx []fixture.Tx
		for _, x := range txs[i] {
			seq++
			x.Seq = seq
			tx = append(tx, x)
		}
		ls = append(ls, fixture.Ledger(start+uint32(i), a, i%2 == 1, tx))
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

func run(t *testing.T, members []protocols.Member, ls []xdr.LedgerCloseMeta, h func(uint32) ([32]byte, bool)) protocols.Result {
	t.Helper()
	c, err := protocols.New(fixture.Passphrase, members, registry, "2026-11-09", "2026-11-09")
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

// TestProtocolInteractions: a transaction touches a protocol through its top-level call, its authorization trees or
// its footprint (fee-bump: the inner transaction's); per group only transactions that touch the group count, a
// protocol only through contracts that are not the group's own, failed transactions count but not as successful,
// payments and unrelated invocations are ignored, the network line counts every transaction touching the protocol.
func TestProtocolInteractions(t *testing.T) {
	ls, h := build(t, 100, []time.Time{at("2026-11-09", -1), at("2026-11-09", 10), at("2026-11-09", 12), at("2026-11-10", 0)},
		map[int][]fixture.Tx{
			1: {
				// app reads the oracle and supplies to the Blend pool: footprint only.
				{Source: alice, Contract: &cApp, Function: "deposit", Success: true, Footprint: [][32]byte{cApp, cPool, cOracle}},
				// a swap through the Soroswap router that calls app (authorization tree), failed, fee-bumped.
				{Source: bob, Contract: &cRouter, Function: "swap", Success: false, FeeBump: true,
					Auth: []fixture.Call{{Contract: cRouter, Function: "swap", Sub: []fixture.Call{{Contract: cApp, Function: "hook"}}}}},
				// Blend used directly, without app: network figure only.
				{Source: alice, Contract: &cPool, Function: "submit", Success: true, Footprint: [][32]byte{cPool}},
				{Source: bob, Success: true}, // payment
			},
			2: {
				// fee-bumped call of app whose inner footprint names the oracle.
				{Source: bob, Contract: &cApp, Function: "settle", Success: true, FeeBump: true, Footprint: [][32]byte{cApp, cOracle}},
				// app-2 (second group) touches nothing of a protocol.
				{Source: alice, Contract: &cApp2, Function: "f", Success: true, Footprint: [][32]byte{cApp2, cOther}},
			},
		})
	// Group "pool-project" lists the Blend pool itself: it does not interact with itself.
	r := run(t, []protocols.Member{{"proj", s(cApp)}, {"proj", s(cApp2)}, {"pool-project", s(cPool)}}, ls, h)
	if len(r.Days) != 1 || !r.Days[0].Complete || *r.Days[0].AnchorLedger != 103 {
		t.Fatalf("days = %+v", r.Days)
	}
	g := map[string]protocols.GroupLine{}
	for _, l := range r.Groups {
		g[l.Group] = l
	}
	if p := g["proj"]; p.Transactions != 4 || p.SuccessfulTransactions != 3 {
		t.Errorf("proj = %+v, want 4 transactions (3 successful)", p)
	}
	if p := g["pool-project"]; p.Transactions != 2 || p.SuccessfulTransactions != 2 {
		t.Errorf("pool-project = %+v, want 2", p)
	}
	type tx struct{ n, ok int64 }
	got := map[string]tx{}
	for _, l := range r.Protocols {
		got[l.Group+"/"+l.Protocol] = tx{l.Transactions, l.SuccessfulTransactions}
	}
	want := map[string]tx{
		"proj/blend":             {1, 1},
		"proj/reflector":         {2, 2},
		"proj/soroswap":          {1, 0},
		"pool-project/reflector": {1, 1},
	}
	if len(got) != len(want) {
		t.Errorf("protocol lines = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %+v, want %+v", k, got[k], v)
		}
	}
	net := map[string]tx{}
	for _, l := range r.Network {
		net[l.Protocol] = tx{l.Transactions, l.SuccessfulTransactions}
	}
	if net["blend"] != (tx{2, 2}) || net["reflector"] != (tx{2, 2}) || net["soroswap"] != (tx{1, 0}) || len(net) != 3 {
		t.Errorf("network = %v", net)
	}
	// No account, no contract outside the caller's labels.
	b, _ := json.Marshal(r)
	for _, x := range []string{fixture.AccountStrkey(fixture.ID("alice")), fixture.AccountStrkey(fixture.ID("bob")), s(cOther), s(cPool), s(cApp)} {
		if strings.Contains(string(b), x) {
			t.Fatalf("result names %s", x)
		}
	}
}

// TestIncompleteDayHasNoAnchor: without the next day's first ledger the day is incomplete (anchor null); zero group
// and network lines are still written for every day seen.
func TestIncompleteDayHasNoAnchor(t *testing.T) {
	ls, h := build(t, 100, []time.Time{at("2026-11-09", -1), at("2026-11-09", 10)}, nil)
	r := run(t, []protocols.Member{{"proj", s(cApp)}}, ls, h)
	if len(r.Days) != 1 || r.Days[0].Complete || r.Days[0].AnchorHash != nil {
		t.Fatalf("days = %+v", r.Days)
	}
	if len(r.Groups) != 1 || r.Groups[0].Transactions != 0 || len(r.Network) != 3 || len(r.Protocols) != 0 {
		t.Errorf("groups = %+v network = %+v protocols = %+v", r.Groups, r.Network, r.Protocols)
	}
}

func TestNewRejectsBadInput(t *testing.T) {
	m := []protocols.Member{{"proj", s(cApp)}}
	for name, c := range map[string]struct {
		m []protocols.Member
		p []protocols.ProtocolContract
	}{
		"no protocols":          {m, nil},
		"no members":            {nil, registry},
		"bad group":             {[]protocols.Member{{"a b", s(cApp)}}, registry},
		"bad protocol label":    {m, []protocols.ProtocolContract{{"Blend!", s(cPool)}}},
		"contract in two":       {m, []protocols.ProtocolContract{{"blend", s(cPool)}, {"soroswap", s(cPool)}}},
		"account as a contract": {m, []protocols.ProtocolContract{{"blend", fixture.AccountStrkey(fixture.ID("alice"))}}},
	} {
		if _, err := protocols.New(fixture.Passphrase, c.m, c.p, "2026-11-09", "2026-11-09"); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := protocols.New(fixture.Passphrase, m, registry, "2026-11-01", "2026-12-15"); err == nil {
		t.Error("45 days accepted")
	}
}
