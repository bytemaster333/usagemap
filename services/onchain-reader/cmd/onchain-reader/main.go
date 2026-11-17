// SPDX-License-Identifier: Apache-2.0

// Command onchain-reader counts daily (UTC) invocations of declared Soroban contracts from public Stellar ledger data
// files (Galexie exports: zstd-compressed XDR LedgerCloseMetaBatch objects) and writes one JSON line per contract and
// day in the shape of scf.onchain_daily, data_source "ledger_files". Ledger files are the primary source of the
// on-chain correlation (decision D3, C-136); the jobs scheduler runs `fetch` to fill a local mirror of the files from
// a public store, then counts over the mirror (wire-formats §p, §p.1).
//
//	onchain-reader [-network pubnet|testnet|<passphrase>] (-contract C… … | -contracts FILE|-) [-from-day D] [-to-day D] PATH…
//	onchain-reader fetch [-source URL|aws-pubnet|aws-testnet|lightsail] -dest DIR -from-day D -to-day D [-network N] …
//	onchain-reader usage [-network N] -groups FILE|- -from-day D -to-day D PATH…   (Ecosystem Usage Map, usage.go)
//	onchain-reader protocols [-network N] -input FILE|- -from-day D -to-day D PATH…  (protocol interactions, protocols.go)
//
// -network standalone (alias quickstart) is a local development network (Stellar Quickstart, fetch -source
// quickstart): every output line then carries "dev": true and the jobs service refuses it (README "Local Quickstart").
//
// Exit codes: 0 success, 1 a file or ledger could not be read (fetch: a requested day is not complete in the
// mirror), 2 usage error.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/stellar/go-stellar-sdk/network"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fetch"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

// stdin is where `-contracts -` reads the contract list from (a variable for tests).
var stdin io.Reader = os.Stdin

// baseCtx is the context of a run; main cancels it on SIGTERM/SIGINT so an interrupted fetch leaves a resumable mirror.
var baseCtx = context.Background()

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	baseCtx = ctx
	code := run(os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func passphrase(v string) string {
	switch v {
	case "pubnet", "mainnet":
		return network.PublicNetworkPassphrase
	case "testnet":
		return network.TestNetworkPassphrase
	case "standalone", "quickstart":
		return fetch.StandalonePassphrase
	default:
		return v
	}
}

// isDevNetwork reports a local development network (a Stellar Quickstart's standalone network, its randomised
// passphrase included): its figures are labelled "dev" in every output line and never stored as network figures.
func isDevNetwork(pass string) bool { return fetch.IsStandalone(pass) }

// readContracts reads one C… strkey per line from a file, or from stdin when path is "-"; blank lines and lines
// starting with # are ignored.
func readContracts(path string) ([]string, error) {
	var r io.Reader = stdin
	if path != "-" {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	}
	var out []string
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, line)
	}
	return out, sc.Err()
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "fetch" {
		return runFetch(args[1:], stderr)
	}
	if len(args) > 0 && args[0] == "usage" {
		return runUsage(args[1:], stdout, stderr)
	}
	if len(args) > 0 && args[0] == "protocols" {
		return runProtocols(args[1:], stdout, stderr)
	}
	fs := flag.NewFlagSet("onchain-reader", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var contracts multi
	fs.Var(&contracts, "contract", "contract strkey (C…) to count; repeatable")
	contractsFile := fs.String("contracts", "", "file with one contract strkey per line (- = stdin)")
	net := fs.String("network", "pubnet", "pubnet, testnet or a network passphrase")
	from := fs.String("from-day", "", "first UTC day to count (YYYY-MM-DD), inclusive")
	to := fs.String("to-day", "", "last UTC day to count (YYYY-MM-DD), inclusive")
	maxBytes := fs.Int64("max-batch-bytes", lake.DefaultMaxDecompressed, "refuse a batch that decompresses to more bytes")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *contractsFile != "" {
		more, err := readContracts(*contractsFile)
		if err != nil {
			fmt.Fprintf(stderr, "onchain-reader: contracts file: %v\n", err)
			return 2
		}
		contracts = append(contracts, more...)
	}
	if fs.NArg() == 0 {
		fmt.Fprintln(stderr, "onchain-reader: at least one file or directory is required")
		return 2
	}
	pass := passphrase(*net)
	counter, err := count.New(pass, contracts, *from, *to)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader: %v\n", err)
		return 2
	}
	files, err := inputFiles(fs.Args(), *from, *to)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader: %v\n", err)
		return 1
	}
	if len(files) == 0 {
		fmt.Fprintln(stderr, "onchain-reader: no ledger data files (*.xdr.zst, *.xdr.zstd) found")
		return 1
	}
	// Every ledger is checked against its own header and chained to its predecessor (lake.Chain).
	var chain lake.Chain
	for _, f := range files {
		batch, err := lake.ReadBatchFile(f, *maxBytes)
		if err != nil {
			fmt.Fprintf(stderr, "onchain-reader: %v\n", err)
			return 1
		}
		for _, lcm := range batch.LedgerCloseMetas {
			if err := chain.Add(lcm); err != nil {
				fmt.Fprintf(stderr, "onchain-reader: %s: %v\n", filepath.Base(f), err)
				return 1
			}
			if err := counter.AddLedger(lcm); err != nil {
				fmt.Fprintf(stderr, "onchain-reader: %v\n", err)
				return 1
			}
		}
	}
	if err := chain.Verify(); err != nil {
		fmt.Fprintf(stderr, "onchain-reader: %v\n", err)
		return 1
	}
	rows := counter.Rows()
	count.Anchor(rows, chain.Hash) // one hash per complete day, for the comparison with an independent copy (C-144)
	enc := newLineWriter(stdout, pass)
	for _, r := range rows {
		if err := enc.Encode(r); err != nil {
			fmt.Fprintf(stderr, "onchain-reader: write: %v\n", err)
			return 1
		}
	}
	// Run summary: counts only, never an account or a contract argument.
	s := counter.Stats()
	fmt.Fprintf(stderr, "onchain-reader: files=%d ledgers=%d duplicate_ledgers=%d out_of_range_ledgers=%d transactions=%d unmatched_results=%d invocations=%d%s\n",
		len(files), s.Ledgers, s.DuplicateLedgers, s.OutOfRangeLedgers, s.Transactions, s.UnmatchedResults, s.MatchedInvocations, devSuffix(pass))
	if s.UnmatchedResults > 0 {
		fmt.Fprintln(stderr, "onchain-reader: some results matched no envelope — is -network right?")
		return 1
	}
	return 0
}

// inputFiles lists the batch files to read. A single mirror directory written by `fetch` holds up to
// SCF_ONCHAIN_LEDGER_KEEP_DAYS days; when its index covers every requested day completely only those days' files
// (with the neighbours' boundary batches) are read, otherwise every file below the paths.
func inputFiles(paths []string, from, to string) ([]string, error) {
	if len(paths) == 1 && from != "" && to != "" {
		if info, err := os.Stat(paths[0]); err == nil && info.IsDir() {
			ix, err := fetch.ReadIndex(paths[0])
			if err != nil {
				return nil, err
			}
			if files, ok := ix.Files(filepath.Clean(paths[0]), from, to); ok {
				return files, nil
			}
		}
	}
	return lake.ListFiles(paths)
}
