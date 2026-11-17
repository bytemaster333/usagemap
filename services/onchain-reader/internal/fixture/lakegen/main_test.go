// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/network"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

func TestLakegenWritesReadableLake(t *testing.T) {
	dir := t.TempDir()
	spec := `{"ledgers":[
	  {"seq":9,"closed_at":"2026-11-04T23:59:55Z","txs":[]},
	  {"seq":10,"closed_at":"2026-11-05T00:00:00Z","v2":true,"txs":[
	    {"source":"alice","contract":"c1","success":true},
	    {"source":"bob","muxed":3,"contract":"c1","success":false,"fee_bump":true},
	    {"source":"carol","success":true}]},
	  {"seq":11,"closed_at":"2026-11-06T00:00:00Z","txs":[]}]}`
	var out, errOut bytes.Buffer
	if code := run([]string{dir}, strings.NewReader(spec), &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	var res struct {
		Contracts map[string]string
		Ledgers   map[string]string
	}
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	c1 := res.Contracts["c1"]
	if c1 != fixture.ContractStrkey(fixture.ID("c1")) {
		t.Fatalf("contracts = %v", res.Contracts)
	}
	files, err := lake.ListFiles([]string{dir})
	if err != nil || len(files) != 3 {
		t.Fatalf("files = %v, %v", files, err)
	}
	c, err := count.New(fixture.Passphrase, []string{c1}, "2026-11-05", "2026-11-05")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		b, err := lake.ReadBatchFile(f, lake.DefaultMaxDecompressed)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range b.LedgerCloseMetas {
			if err := c.AddLedger(l); err != nil {
				t.Fatal(err)
			}
		}
	}
	// The hash of every ledger written is printed (a test Horizon serves them as the network's copy, C-144).
	if len(res.Ledgers) != 3 {
		t.Fatalf("ledgers = %v", res.Ledgers)
	}
	for _, f := range files {
		b, _ := lake.ReadBatchFile(f, lake.DefaultMaxDecompressed)
		l := b.LedgerCloseMetas[0]
		if got := res.Ledgers[fmt.Sprint(l.LedgerSequence())]; got != l.LedgerHash().HexString() {
			t.Errorf("ledger %d hash = %q, want %s", l.LedgerSequence(), got, l.LedgerHash().HexString())
		}
	}
	rows := c.Rows()
	if len(rows) != 1 || rows[0].Invocations != 2 || rows[0].SuccessfulInvocations != 1 || rows[0].DistinctInvokers != 2 || !rows[0].Complete {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestLakegenRejectsBadSpec(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{t.TempDir()}, strings.NewReader(`{"bogus":1}`), &out, &errOut); code != 2 {
		t.Fatalf("exit %d", code)
	}
}

// TestDemoMirror: the local stack's mirror has every one of the N days before today complete, with the documented
// counts, hashed for the chosen network; a re-run replaces the files.
func TestDemoMirror(t *testing.T) {
	dir := t.TempDir()
	now = func() time.Time { return time.Date(2026, 11, 16, 9, 30, 0, 0, time.UTC) }
	t.Cleanup(func() { now = time.Now })
	for range 2 {
		var out, errOut bytes.Buffer
		if code := run([]string{"-network", "pubnet", "-demo-days", "3", dir}, strings.NewReader(""), &out, &errOut); code != 0 {
			t.Fatalf("exit %d: %s", code, errOut.String())
		}
		var res struct{ Contracts map[string]string }
		if err := json.Unmarshal(out.Bytes(), &res); err != nil || len(res.Contracts) != 2 {
			t.Fatalf("contracts %v %v", res.Contracts, err)
		}
	}
	files, err := lake.ListFiles([]string{dir})
	if err != nil || len(files) != 3*48+2 {
		t.Fatalf("%d files, %v", len(files), err)
	}
	sc, cf := fixture.ContractStrkey(fixture.ID("smoke-contract")), fixture.ContractStrkey(fixture.ID("smoke-conflict"))
	c, err := count.New(network.PublicNetworkPassphrase, []string{sc, cf}, "2026-11-13", "2026-11-15")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		b, err := lake.ReadBatchFile(f, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range b.LedgerCloseMetas {
			if err := c.AddLedger(l); err != nil {
				t.Fatal(err)
			}
		}
	}
	if s := c.Stats(); s.UnmatchedResults != 0 {
		t.Fatalf("hashed for another network: %+v", s)
	}
	rows := c.Rows()
	if len(rows) != 6 {
		t.Fatalf("rows %+v", rows)
	}
	for _, r := range rows {
		want := [3]int64{3, 2, 2}
		if r.Contract == cf {
			want = [3]int64{1, 1, 1}
		}
		if [3]int64{r.Invocations, r.SuccessfulInvocations, r.DistinctInvokers} != want || !r.Complete || r.LedgersInDay != 48 {
			t.Errorf("%+v, want %v and complete", r, want)
		}
	}
}
