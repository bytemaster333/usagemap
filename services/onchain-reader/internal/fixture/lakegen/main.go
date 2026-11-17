// SPDX-License-Identifier: Apache-2.0

// Command lakegen writes a synthetic ledger data lake (Galexie layout, one ledger per zstd XDR batch) from a JSON
// description read on stdin, for tests of the callers of onchain-reader (the jobs service's onchain_correlation
// integration test, the reader's PostgreSQL integration test). Accounts and contracts are named by labels and derived
// with fixture.ID, so fixtures are deterministic and contain no real key; the transactions are hashed with the
// passphrase of -network (default testnet, fixture.Passphrase).
//
//	go run ./internal/fixture/lakegen [-network testnet|pubnet|<passphrase>] DIR < spec.json
//	lakegen [-network …] -demo-days N DIR
//
// spec: {"ledgers":[{"seq":10,"closed_at":"2026-11-05T00:00:00Z","v2":false,"txs":[{"source":"alice","muxed":0,
// "op_source":"","contract":"contract-a","function":"swap","success":true,"fee_bump":false,
// "auth":[{"contract":"token","function":"transfer","args":[1],"sub":[]}],"footprint":["oracle"]}]}]}  (no "contract" →
// a payment; "function" defaults to "f"; "auth" lists the roots of the invocation's authorization trees; "footprint"
// the contracts whose instance entry the Soroban footprint lists, as for every contract the transaction runs)
//
// -demo-days N writes the fixture mirror of the local stack (infra/compose, service onchain-fixture) instead: a
// ledger every 30 minutes covering the N whole UTC days before today plus the boundary ledgers on both sides, so
// every one of those days is complete. Each day, contract "smoke-contract" is invoked three times (alice twice, one
// of them failed; bob once) and "smoke-conflict" once (carol). Existing batch files in DIR are replaced. This mode
// is the only one built into an image (the `lakegen` target of the Dockerfile, local stack only).
//
// It prints {"contracts":{"<label>":"C…"},"ledgers":{"<seq>":"<hex hash>"}}: every contract label used and the hash of
// every ledger written (a test Horizon serves these as the network's copy for the day-anchor check, C-144).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/stellar/go-stellar-sdk/network"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/stellar/go-stellar-sdk/xdr"
)

type txSpec struct {
	Source   string     `json:"source"`
	Muxed    uint64     `json:"muxed"`
	OpSource string     `json:"op_source"`
	Contract string     `json:"contract"`
	Function string     `json:"function"` // default "f"
	Auth     []callSpec `json:"auth"`     // authorization trees (usage map: contract calls)
	// Footprint: contract labels whose instance entry the Soroban footprint lists (protocol interactions)
	Footprint []string `json:"footprint"`
	Success   bool     `json:"success"`
	FeeBump   bool     `json:"fee_bump"`
}

// callSpec is one node of an authorization tree: {"contract":"token","function":"transfer","args":[1],"sub":[…]}.
type callSpec struct {
	Contract string     `json:"contract"`
	Function string     `json:"function"`
	Args     []uint32   `json:"args"`
	Sub      []callSpec `json:"sub"`
}

func (c callSpec) call(contracts map[string]string) fixture.Call {
	id := fixture.ID(c.Contract)
	contracts[c.Contract] = fixture.ContractStrkey(id)
	out := fixture.Call{Contract: id, Function: c.Function, Args: c.Args}
	for _, s := range c.Sub {
		out.Sub = append(out.Sub, s.call(contracts))
	}
	return out
}

type ledgerSpec struct {
	Seq      uint32    `json:"seq"`
	ClosedAt time.Time `json:"closed_at"`
	V2       bool      `json:"v2"`
	Txs      []txSpec  `json:"txs"`
}

type spec struct {
	Ledgers []ledgerSpec `json:"ledgers"`
}

// now is the clock of -demo-days (a variable for tests).
var now = time.Now

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

func passphrase(v string) string {
	switch v {
	case "pubnet", "mainnet":
		return network.PublicNetworkPassphrase
	case "testnet":
		return network.TestNetworkPassphrase
	case "standalone", "quickstart":
		return "Standalone Network ; February 2017"
	default:
		return v
	}
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fl := flag.NewFlagSet("lakegen", flag.ContinueOnError)
	fl.SetOutput(stderr)
	net := fl.String("network", "testnet", "pubnet, testnet or a network passphrase")
	demo := fl.Int("demo-days", 0, "write the local stack's demo mirror for the N days before today (no stdin spec)")
	if err := fl.Parse(args); err != nil {
		return 2
	}
	if fl.NArg() != 1 || *net == "" || *demo < 0 || *demo > 31 {
		fmt.Fprintln(stderr, "usage: lakegen [-network N] DIR < spec.json  |  lakegen [-network N] -demo-days 1…31 DIR")
		return 2
	}
	dir := fl.Arg(0)
	pass := passphrase(*net)
	var sp spec
	if *demo > 0 {
		sp = demoSpec(now().UTC(), *demo)
		if err := removeBatches(dir); err != nil {
			fmt.Fprintf(stderr, "lakegen: %v\n", err)
			return 1
		}
	} else {
		dec := json.NewDecoder(stdin)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&sp); err != nil {
			fmt.Fprintf(stderr, "lakegen: spec: %v\n", err)
			return 2
		}
	}
	contracts := map[string]string{}
	var txSeq int64
	var built []xdr.LedgerCloseMeta
	for _, ls := range sp.Ledgers {
		txs := make([]fixture.Tx, 0, len(ls.Txs))
		for _, ts := range ls.Txs {
			txSeq++
			src := fixture.Account(fixture.ID(ts.Source))
			if ts.Muxed != 0 {
				src = fixture.MuxedAccount(fixture.ID(ts.Source), ts.Muxed)
			}
			fn := ts.Function
			if fn == "" {
				fn = "f"
			}
			tx := fixture.Tx{Source: src, Function: fn, Success: ts.Success, FeeBump: ts.FeeBump, Seq: txSeq}
			for _, a := range ts.Auth {
				tx.Auth = append(tx.Auth, a.call(contracts))
			}
			for _, f := range ts.Footprint {
				id := fixture.ID(f)
				contracts[f] = fixture.ContractStrkey(id)
				tx.Footprint = append(tx.Footprint, id)
			}
			if ts.OpSource != "" {
				op := fixture.Account(fixture.ID(ts.OpSource))
				tx.OpSource = &op
			}
			if ts.Contract != "" {
				id := fixture.ID(ts.Contract)
				tx.Contract = &id
				contracts[ts.Contract] = fixture.ContractStrkey(id)
			}
			txs = append(txs, tx)
		}
		built = append(built, fixture.LedgerFor(pass, ls.Seq, ls.ClosedAt.UTC(), ls.V2, txs))
	}
	// Consecutive ledgers name their predecessor's hash, as on a real network (the reader verifies the chain) — also
	// a predecessor written into DIR by an earlier run, so a lake can be extended ledger by ledger.
	sort.Slice(built, func(i, j int) bool { return built[i].LedgerSequence() < built[j].LedgerSequence() })
	for i := range built {
		seq := built[i].LedgerSequence()
		if (i > 0 && built[i-1].LedgerSequence() == seq-1) || seq < 2 {
			continue
		}
		prev, err := lake.ReadBatchFile(filepath.Join(dir, filepath.FromSlash(lake.ObjectName(seq-1, 64000))), 0)
		if err != nil || len(prev.LedgerCloseMetas) == 0 {
			continue // no predecessor on disk
		}
		if _, err := lake.Seal(&built[i], [32]byte(prev.LedgerCloseMetas[len(prev.LedgerCloseMetas)-1].LedgerHash())); err != nil {
			fmt.Fprintf(stderr, "lakegen: %v\n", err)
			return 1
		}
	}
	hashes := map[string]string{}
	for _, l := range fixture.Chain(built) {
		if err := write(dir, l); err != nil {
			fmt.Fprintf(stderr, "lakegen: %v\n", err)
			return 1
		}
		hashes[strconv.FormatUint(uint64(l.LedgerSequence()), 10)] = l.LedgerHash().HexString()
	}
	if err := json.NewEncoder(stdout).Encode(map[string]any{"contracts": contracts, "ledgers": hashes}); err != nil {
		return 1
	}
	return 0
}

// demoSpec: ledger 2 closes at 23:37 on the day before the window, then one ledger every 30 minutes (:07 and :37) up
// to 00:07 today, so each of the `days` days before today is complete (its neighbours' boundary ledgers exist).
func demoSpec(now time.Time, days int) spec {
	today := now.Truncate(24 * time.Hour)
	first := today.AddDate(0, 0, -days).Add(-23 * time.Minute)
	var sp spec
	seq := uint32(2)
	for at := first; !at.After(today.Add(7 * time.Minute)); at = at.Add(30 * time.Minute) {
		ls := ledgerSpec{Seq: seq, ClosedAt: at, V2: seq%2 == 0}
		switch at.Sub(at.Truncate(24 * time.Hour)) {
		case 10*time.Hour + 7*time.Minute:
			ls.Txs = []txSpec{{Source: "alice", Contract: "smoke-contract", Success: true}, {Source: "carol", Contract: "smoke-conflict", Success: true}}
		case 12*time.Hour + 7*time.Minute:
			ls.Txs = []txSpec{{Source: "bob", Contract: "smoke-contract", Success: true, FeeBump: true}, {Source: "dave", Success: true}}
		case 14*time.Hour + 7*time.Minute:
			ls.Txs = []txSpec{{Source: "alice", Contract: "smoke-contract", Success: false}}
		}
		sp.Ledgers = append(sp.Ledgers, ls)
		seq++
	}
	return sp
}

// removeBatches deletes the batch files a previous demo run left (the regenerated lake reuses the sequence numbers).
func removeBatches(dir string) error {
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() && lake.IsBatchFile(d.Name()) {
			return os.Remove(p)
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func write(dir string, l xdr.LedgerCloseMeta) error {
	p := filepath.Join(dir, filepath.FromSlash(lake.ObjectName(l.LedgerSequence(), 64000)))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := lake.EncodeBatch(&buf, fixture.Batch(l)); err != nil {
		return err
	}
	return os.WriteFile(p, buf.Bytes(), 0o644)
}
