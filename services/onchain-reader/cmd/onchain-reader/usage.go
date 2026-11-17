// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/usage"
)

// readMembers reads "<group> <C…>" lines (a file, or stdin for "-"); blank lines and # comments are ignored.
func readMembers(path string) ([]usage.Member, error) {
	var r io.Reader = stdin
	if path != "-" {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	}
	var out []usage.Member
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		if len(f) != 2 {
			return nil, fmt.Errorf("line %d: want \"<group> <contract>\"", n)
		}
		out = append(out, usage.Member{Group: f[0], Contract: f[1]})
	}
	return out, sc.Err()
}

// runUsage is `onchain-reader usage`: the Ecosystem Usage Map figures (package usage) as JSON lines of five kinds —
// day, group, contract, function, week — in that order. Exit codes as the counting command.
func runUsage(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("onchain-reader usage", flag.ContinueOnError)
	fs.SetOutput(stderr)
	groups := fs.String("groups", "", "file with one \"<group> <contract strkey>\" pair per line (- = stdin)")
	net := fs.String("network", "pubnet", "pubnet, testnet or a network passphrase")
	from := fs.String("from-day", "", "first UTC day (YYYY-MM-DD), inclusive; required")
	to := fs.String("to-day", "", "last UTC day (YYYY-MM-DD), inclusive; required")
	maxBytes := fs.Int64("max-batch-bytes", lake.DefaultMaxDecompressed, "refuse a batch that decompresses to more bytes")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *groups == "" || fs.NArg() == 0 {
		fmt.Fprintln(stderr, "onchain-reader usage: -groups and at least one file or directory are required")
		return 2
	}
	members, err := readMembers(*groups)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader usage: groups: %v\n", err)
		return 2
	}
	pass := passphrase(*net)
	counter, err := usage.New(pass, members, *from, *to)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader usage: %v\n", err)
		return 2
	}
	files, err := inputFiles(fs.Args(), *from, *to)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader usage: %v\n", err)
		return 1
	}
	if len(files) == 0 {
		fmt.Fprintln(stderr, "onchain-reader usage: no ledger data files (*.xdr.zst, *.xdr.zstd) found")
		return 1
	}
	var chain lake.Chain
	for _, f := range files {
		batch, err := lake.ReadBatchFile(f, *maxBytes)
		if err != nil {
			fmt.Fprintf(stderr, "onchain-reader usage: %v\n", err)
			return 1
		}
		for _, lcm := range batch.LedgerCloseMetas {
			if err := chain.Add(lcm); err != nil {
				fmt.Fprintf(stderr, "onchain-reader usage: %s: %v\n", filepath.Base(f), err)
				return 1
			}
			if err := counter.AddLedger(lcm); err != nil {
				fmt.Fprintf(stderr, "onchain-reader usage: %v\n", err)
				return 1
			}
		}
	}
	if err := chain.Verify(); err != nil {
		fmt.Fprintf(stderr, "onchain-reader usage: %v\n", err)
		return 1
	}
	s := counter.Stats()
	if s.UnmatchedResults > 0 {
		fmt.Fprintln(stderr, "onchain-reader usage: some results matched no envelope — is -network right?")
		return 1
	}
	r := counter.Result(chain.Hash)
	enc := newLineWriter(stdout, pass)
	var lines []any
	for _, l := range r.Days {
		lines = append(lines, l)
	}
	for _, l := range r.Groups {
		lines = append(lines, l)
	}
	for _, l := range r.Contracts {
		lines = append(lines, l)
	}
	for _, l := range r.Functions {
		lines = append(lines, l)
	}
	for _, l := range r.Weeks {
		lines = append(lines, l)
	}
	for _, l := range lines {
		if err := enc.Encode(l); err != nil {
			fmt.Fprintf(stderr, "onchain-reader usage: write: %v\n", err)
			return 1
		}
	}
	// Counts only, never an account.
	fmt.Fprintf(stderr, "onchain-reader usage: files=%d ledgers=%d duplicate_ledgers=%d out_of_range_ledgers=%d transactions=%d invocations=%d contract_calls=%d weeks=%d%s\n",
		len(files), s.Ledgers, s.DuplicateLedgers, s.OutOfRangeLedgers, s.Transactions, s.Invocations, s.ContractCalls, len(r.Weeks), devSuffix(pass))
	return 0
}
