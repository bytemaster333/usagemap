// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/protocols"
)

// readProtocolInput reads "group <label> <C…>" and "protocol <label> <C…>" lines (a file, or stdin for "-"); blank
// lines and # comments are ignored.
func readProtocolInput(path string) ([]protocols.Member, []protocols.ProtocolContract, error) {
	var r io.Reader = stdin
	if path != "-" {
		f, err := os.Open(path)
		if err != nil {
			return nil, nil, err
		}
		defer f.Close()
		r = f
	}
	var ms []protocols.Member
	var ps []protocols.ProtocolContract
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		switch {
		case len(f) == 3 && f[0] == "group":
			ms = append(ms, protocols.Member{Group: f[1], Contract: f[2]})
		case len(f) == 3 && f[0] == "protocol":
			ps = append(ps, protocols.ProtocolContract{Protocol: f[1], Contract: f[2]})
		default:
			return nil, nil, fmt.Errorf("line %d: want \"group <label> <contract>\" or \"protocol <label> <contract>\"", n)
		}
	}
	return ms, ps, sc.Err()
}

// runProtocols is `onchain-reader protocols`: per group, UTC day and DeFi protocol, the transactions touching the
// group's contracts that also touch the protocol's contracts (package protocols), as JSON lines of four kinds — day,
// group, protocol, network — in that order. Exit codes as the counting command.
func runProtocols(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("onchain-reader protocols", flag.ContinueOnError)
	fs.SetOutput(stderr)
	input := fs.String("input", "", "file with \"group <label> <C…>\" and \"protocol <label> <C…>\" lines (- = stdin)")
	net := fs.String("network", "pubnet", "pubnet, testnet, standalone or a network passphrase")
	from := fs.String("from-day", "", "first UTC day (YYYY-MM-DD), inclusive; required")
	to := fs.String("to-day", "", "last UTC day (YYYY-MM-DD), inclusive; required")
	maxBytes := fs.Int64("max-batch-bytes", lake.DefaultMaxDecompressed, "refuse a batch that decompresses to more bytes")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *input == "" || fs.NArg() == 0 {
		fmt.Fprintln(stderr, "onchain-reader protocols: -input and at least one file or directory are required")
		return 2
	}
	members, protos, err := readProtocolInput(*input)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader protocols: input: %v\n", err)
		return 2
	}
	pass := passphrase(*net)
	counter, err := protocols.New(pass, members, protos, *from, *to)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader protocols: %v\n", err)
		return 2
	}
	files, err := inputFiles(fs.Args(), *from, *to)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader protocols: %v\n", err)
		return 1
	}
	if len(files) == 0 {
		fmt.Fprintln(stderr, "onchain-reader protocols: no ledger data files (*.xdr.zst, *.xdr.zstd) found")
		return 1
	}
	var chain lake.Chain
	for _, f := range files {
		batch, err := lake.ReadBatchFile(f, *maxBytes)
		if err != nil {
			fmt.Fprintf(stderr, "onchain-reader protocols: %v\n", err)
			return 1
		}
		for _, lcm := range batch.LedgerCloseMetas {
			if err := chain.Add(lcm); err != nil {
				fmt.Fprintf(stderr, "onchain-reader protocols: %s: %v\n", filepath.Base(f), err)
				return 1
			}
			if err := counter.AddLedger(lcm); err != nil {
				fmt.Fprintf(stderr, "onchain-reader protocols: %v\n", err)
				return 1
			}
		}
	}
	if err := chain.Verify(); err != nil {
		fmt.Fprintf(stderr, "onchain-reader protocols: %v\n", err)
		return 1
	}
	s := counter.Stats()
	if s.UnmatchedResults > 0 {
		fmt.Fprintln(stderr, "onchain-reader protocols: some results matched no envelope — is -network right?")
		return 1
	}
	r := counter.Result(chain.Hash)
	out := newLineWriter(stdout, pass)
	var lines []any
	for _, l := range r.Days {
		lines = append(lines, l)
	}
	for _, l := range r.Groups {
		lines = append(lines, l)
	}
	for _, l := range r.Protocols {
		lines = append(lines, l)
	}
	for _, l := range r.Network {
		lines = append(lines, l)
	}
	for _, l := range lines {
		if err := out.Encode(l); err != nil {
			fmt.Fprintf(stderr, "onchain-reader protocols: write: %v\n", err)
			return 1
		}
	}
	// Counts only: no account is read at all, no contract leaves the run.
	fmt.Fprintf(stderr, "onchain-reader protocols: files=%d ledgers=%d duplicate_ledgers=%d out_of_range_ledgers=%d transactions=%d soroban_transactions=%d group_transactions=%d protocol_transactions=%d%s\n",
		len(files), s.Ledgers, s.DuplicateLedgers, s.OutOfRangeLedgers, s.Transactions, s.SorobanTransactions,
		s.GroupTransactions, s.ProtocolTransactions, devSuffix(pass))
	return 0
}

// lineWriter writes JSON lines; on a development network (standalone, e.g. a local Quickstart) every line carries
// "dev": true, which the jobs service's strict parsers refuse — development figures can never be stored as network
// figures.
type lineWriter struct {
	enc *json.Encoder
	w   io.Writer
	dev bool
}

func newLineWriter(w io.Writer, pass string) *lineWriter {
	return &lineWriter{enc: json.NewEncoder(w), w: w, dev: isDevNetwork(pass)}
}

func (l *lineWriter) Encode(v any) error {
	if !l.dev {
		return l.enc.Encode(v)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) < 2 || b[0] != '{' || b[len(b)-1] != '}' {
		return fmt.Errorf("line is not an object")
	}
	sep := ","
	if len(b) == 2 {
		sep = ""
	}
	_, err = fmt.Fprintf(l.w, "%s%s\"dev\":true}\n", b[:len(b)-1], sep)
	return err
}

func devSuffix(pass string) string {
	if isDevNetwork(pass) {
		return " network=standalone dev=1"
	}
	return ""
}
