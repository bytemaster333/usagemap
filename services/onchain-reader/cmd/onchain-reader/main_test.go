// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

func writeLake(t *testing.T) (dir, contractA, contractB string) {
	t.Helper()
	dir = t.TempDir()
	a, b := fixture.ID("contract-a"), fixture.ID("contract-b")
	alice, bob := fixture.Account(fixture.ID("alice")), fixture.Account(fixture.ID("bob"))
	base := time.Date(2026, 11, 3, 23, 59, 50, 0, time.UTC)
	ledgers := map[uint32][]fixture.Tx{
		200: {{Source: alice, Contract: &a, Function: "f", Success: true, Seq: 1}, {Source: bob, Contract: &a, Function: "f", Success: false, Seq: 2}},
		201: {{Source: alice, Contract: &b, Function: "g", Success: true, Seq: 3}},
		202: {{Source: bob, Contract: &a, Function: "f", Success: true, Seq: 4}},
	}
	var ls []xdr.LedgerCloseMeta
	for seq := uint32(200); seq <= 202; seq++ {
		ls = append(ls, fixture.Ledger(seq, base.Add(time.Duration(seq-200)*5*time.Second), seq%2 == 0, ledgers[seq]))
	}
	for _, l := range fixture.Chain(ls) {
		seq := l.LedgerSequence()
		p := filepath.Join(dir, filepath.FromSlash(lake.ObjectName(seq, 64000)))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if err := lake.EncodeBatch(&buf, fixture.Batch(l)); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir, fixture.ContractStrkey(a), fixture.ContractStrkey(b)
}

func TestRunWritesOnchainDailyRows(t *testing.T) {
	dir, a, b := writeLake(t)
	cf := filepath.Join(t.TempDir(), "contracts.txt")
	if err := os.WriteFile(cf, []byte("# declared contracts\n\n"+b+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := run([]string{"-network", "testnet", "-contract", a, "-contracts", cf, dir}, &out, &errOut)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	got := map[string]count.Row{}
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		var r count.Row
		dec := json.NewDecoder(strings.NewReader(sc.Text()))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			t.Fatal(err)
		}
		got[r.Contract+"/"+r.Day] = r
	}
	want := map[string][3]int64{
		a + "/2026-11-03": {2, 1, 2}, b + "/2026-11-03": {1, 1, 1}, // ledgers 200, 201 (23:59:50, 23:59:55)
		a + "/2026-11-04": {1, 1, 1}, b + "/2026-11-04": {0, 0, 0}, // ledger 202 (00:00:00)
	}
	if len(got) != len(want) {
		t.Fatalf("rows = %v", got)
	}
	for k, w := range want {
		r := got[k]
		if [3]int64{r.Invocations, r.SuccessfulInvocations, r.DistinctInvokers} != w || r.DataSource != "ledger_files" {
			t.Errorf("%s = %+v, want %v", k, r, w)
		}
	}
	if !strings.Contains(errOut.String(), "files=3 ledgers=3") {
		t.Errorf("summary = %q", errOut.String())
	}
	for _, acc := range []string{"alice", "bob"} {
		if strings.Contains(out.String()+errOut.String(), fixture.AccountStrkey(fixture.ID(acc))) {
			t.Fatal("invoker identity in output")
		}
	}
}

func TestRunExitCodes(t *testing.T) {
	dir, a, _ := writeLake(t)
	empty := t.TempDir()
	corrupt := filepath.Join(t.TempDir(), "x.xdr.zst")
	_ = os.WriteFile(corrupt, []byte("garbage"), 0o600)
	cases := []struct {
		name string
		args []string
		code int
	}{
		{"no paths", []string{"-contract", a}, 2},
		{"no contracts", []string{dir}, 2},
		{"bad contract", []string{"-contract", "GABC", dir}, 2},
		{"missing contracts file", []string{"-contracts", "/nonexistent", dir}, 2},
		{"unknown flag", []string{"-nope"}, 2},
		{"empty directory", []string{"-contract", a, empty}, 1},
		{"corrupt file", []string{"-contract", a, corrupt}, 1},
		{"wrong network", []string{"-network", "pubnet", "-contract", a, dir}, 1},
	}
	for _, tc := range cases {
		var out, errOut bytes.Buffer
		if got := run(tc.args, &out, &errOut); got != tc.code {
			t.Errorf("%s: exit %d, want %d (%s)", tc.name, got, tc.code, errOut.String())
		}
	}
}

// TestRealLedgerFiles runs against a local copy of public pubnet ledger files when SCF_ONCHAIN_SAMPLE_DIR is set
// (manual check, no network in the test itself): every transaction result must match an envelope by hash.
func TestRealLedgerFiles(t *testing.T) {
	dir := os.Getenv("SCF_ONCHAIN_SAMPLE_DIR")
	if dir == "" {
		t.Skip("SCF_ONCHAIN_SAMPLE_DIR not set")
	}
	var out, errOut bytes.Buffer
	usdc := "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" // Circle USDC Stellar asset contract on pubnet
	if code := run([]string{"-network", "pubnet", "-contract", usdc, dir}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "unmatched_results=0") || strings.Contains(errOut.String(), " ledgers=0 ") {
		t.Fatalf("summary = %q", errOut.String())
	}
	t.Log(strings.TrimSpace(errOut.String()))
}

// The jobs service passes the contract list on stdin (`-contracts -`): a Node.js child's stdin is a socket, which
// cannot be reopened through /dev/stdin.
func TestContractsFromStdin(t *testing.T) {
	dir, a, _ := writeLake(t)
	stdin = strings.NewReader("# from the jobs service\n" + a + "\n")
	defer func() { stdin = os.Stdin }()
	var out, errOut bytes.Buffer
	if code := run([]string{"-network", "testnet", "-contracts", "-", dir}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if n := strings.Count(out.String(), "\n"); n != 2 { // contract a × 2 days
		t.Fatalf("lines = %d: %s", n, out.String())
	}
}

// A store that changes one ledger (here: a result turned into a success) without rebuilding the chain is refused:
// the ledger's own result hash no longer matches its header. One rebuilt with fresh hashes no
// longer follows its predecessor.
func TestRejectsLedgersOutsideTheHashChain(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(l *xdr.LedgerCloseMeta)
	}{
		{"changed result", func(l *xdr.LedgerCloseMeta) {
			if l.V == 1 {
				l.V1.TxProcessing[0].Result.Result.FeeCharged++
			} else {
				l.V2.TxProcessing[0].Result.Result.FeeCharged++
			}
		}},
		{"re-sealed ledger", func(l *xdr.LedgerCloseMeta) {
			if l.V == 1 {
				l.V1.TxProcessing[0].Result.Result.FeeCharged++
			} else {
				l.V2.TxProcessing[0].Result.Result.FeeCharged++
			}
			if _, err := lake.Seal(l, [32]byte{9}); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, a, _ := writeLake(t)
			p := filepath.Join(dir, filepath.FromSlash(lake.ObjectName(201, 64000)))
			b, err := lake.ReadBatchFile(p, 0)
			if err != nil {
				t.Fatal(err)
			}
			tc.change(&b.LedgerCloseMetas[0])
			var buf bytes.Buffer
			if err := lake.EncodeBatch(&buf, b); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
				t.Fatal(err)
			}
			var out, errOut bytes.Buffer
			if code := run([]string{"-network", "testnet", "-contract", a, dir}, &out, &errOut); code != 1 {
				t.Fatalf("exit %d, want 1: %s", code, errOut.String())
			}
			if !strings.Contains(errOut.String(), "ledger integrity") || out.Len() != 0 {
				t.Fatalf("stderr %q stdout %q", errOut.String(), out.String())
			}
		})
	}
}

// writeDayLake writes ledgers 300…303: 300 closes on 2026-11-04, 301 and 302 on 2026-11-05, 303 on 2026-11-06, so
// 2026-11-05 is complete. change, when set, alters ledger 302 before the chain is sealed: a forged but self-consistent
// chain (every hash recomputed), which the integrity checks alone cannot tell from the real one.
func writeDayLake(t *testing.T, change func(seq uint32, txs []fixture.Tx) []fixture.Tx) (dir, contract string) {
	t.Helper()
	dir = t.TempDir()
	a := fixture.ID("contract-a")
	alice := fixture.Account(fixture.ID("alice"))
	at := map[uint32]time.Time{
		300: time.Date(2026, 11, 4, 23, 59, 58, 0, time.UTC),
		301: time.Date(2026, 11, 5, 0, 0, 3, 0, time.UTC),
		302: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC),
		303: time.Date(2026, 11, 6, 0, 0, 2, 0, time.UTC),
	}
	var ls []xdr.LedgerCloseMeta
	for seq := uint32(300); seq <= 303; seq++ {
		txs := []fixture.Tx{}
		if seq == 302 {
			txs = append(txs, fixture.Tx{Source: alice, Contract: &a, Function: "f", Success: true, Seq: 1})
		}
		if change != nil {
			txs = change(seq, txs)
		}
		ls = append(ls, fixture.Ledger(seq, at[seq], seq%2 == 0, txs))
	}
	for _, l := range fixture.Chain(ls) {
		p := filepath.Join(dir, filepath.FromSlash(lake.ObjectName(l.LedgerSequence(), 64000)))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if err := lake.EncodeBatch(&buf, fixture.Batch(l)); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir, fixture.ContractStrkey(a)
}

func runRows(t *testing.T, args ...string) map[string]count.Row {
	t.Helper()
	var out, errOut bytes.Buffer
	if code := run(args, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	got := map[string]count.Row{}
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		var r count.Row
		dec := json.NewDecoder(strings.NewReader(sc.Text()))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			t.Fatal(err)
		}
		got[r.Day] = r
	}
	return got
}

// A complete day names its anchor: the first ledger after the day and that ledger's hash. Through the verified chain
// the anchor's hash commits to every ledger of the day and to the close times that bound it, so one comparison with
// an independent copy of that hash (Horizon /ledgers/{seq}, done by the jobs service) authenticates the day's counts.
// An incomplete day has no anchor (null).
func TestRunNamesTheAnchorOfEachCompleteDay(t *testing.T) {
	dir, a := writeDayLake(t, nil)
	got := runRows(t, "-network", "testnet", "-contract", a, dir)
	day := got["2026-11-05"]
	if !day.Complete || day.Invocations != 1 || day.AnchorLedger == nil || *day.AnchorLedger != 303 {
		t.Fatalf("complete day = %+v", day)
	}
	b, err := lake.ReadBatchFile(filepath.Join(dir, filepath.FromSlash(lake.ObjectName(303, 64000))), 0)
	if err != nil {
		t.Fatal(err)
	}
	want := b.LedgerCloseMetas[0].LedgerHash().HexString()
	if day.AnchorHash == nil || *day.AnchorHash != want {
		t.Fatalf("anchor hash = %v, want %s", day.AnchorHash, want)
	}
	for _, d := range []string{"2026-11-04", "2026-11-06"} {
		if r := got[d]; r.Complete || r.AnchorLedger != nil || r.AnchorHash != nil {
			t.Errorf("incomplete day %s = %+v", d, r)
		}
	}
	// The JSON line carries the two fields even when they are null (the jobs parser expects every field).
	var out, errOut bytes.Buffer
	_ = run([]string{"-network", "testnet", "-contract", a, dir}, &out, &errOut)
	if !strings.Contains(out.String(), `"anchor_ledger":null,"anchor_hash":null`) ||
		!strings.Contains(out.String(), `"anchor_ledger":303,"anchor_hash":"`+want+`"`) {
		t.Fatalf("output = %s", out.String())
	}
}

// Register C-144 open item: a store serving a whole forged chain (one extra invocation, every hash recomputed) passes
// every integrity check of the reader — the counts change — but the anchor hash differs from the real network's, so
// the comparison with Horizon refuses the day.
func TestForgedSelfConsistentChainIsAcceptedButChangesTheAnchor(t *testing.T) {
	realDir, a := writeDayLake(t, nil)
	forgedDir, _ := writeDayLake(t, func(seq uint32, txs []fixture.Tx) []fixture.Tx {
		if seq != 302 {
			return txs
		}
		c := fixture.ID("contract-a")
		mallory := fixture.Account(fixture.ID("mallory"))
		return append(txs, fixture.Tx{Source: mallory, Contract: &c, Function: "f", Success: true, Seq: 2})
	})
	genuine := runRows(t, "-network", "testnet", "-contract", a, realDir)["2026-11-05"]
	forged := runRows(t, "-network", "testnet", "-contract", a, forgedDir)["2026-11-05"]
	if !forged.Complete || forged.Invocations != 2 || genuine.Invocations != 1 {
		t.Fatalf("genuine %+v forged %+v", genuine, forged)
	}
	if *forged.AnchorLedger != *genuine.AnchorLedger || *forged.AnchorHash == *genuine.AnchorHash {
		t.Fatalf("anchor of the forged chain = %d/%s, genuine %d/%s", *forged.AnchorLedger, *forged.AnchorHash,
			*genuine.AnchorLedger, *genuine.AnchorHash)
	}
}
