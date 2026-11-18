// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

const version = "0.0.0-spike"

// Exit codes.
const (
	exitOK      = 0
	exitUsage   = 2
	exitDropped = 3 // --fail-on-drop and something was dropped
)

// maxPayload bounds the input like the gateway's OTLP body limit would.
const maxPayload = 8 << 20

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

const usage = `stellar scf — UsageMap for Stellar projects (spike)

Usage:
  stellar scf check [-f FILE|-] [--services LIST] [--received-at newest|now|NS] [--json] [--fail-on-drop]
  stellar scf version

check  Dry run of the UsageMap sanitise step on an OTLP/JSON payload (metrics or
       traces): what would be kept, redacted and dropped, and which attributes
       are never stored. Local only: no network, no Stellar CLI config read.
`

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return exitUsage
	}
	switch args[0] {
	case "check":
		return runCheck(args[1:], stdin, stdout, stderr)
	case "version", "--version":
		fmt.Fprintln(stdout, "stellar-scf", version)
		return exitOK
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return exitOK
	}
	fmt.Fprintf(stderr, "stellar scf: unknown command %q\n\n%s", args[0], usage)
	return exitUsage
}

func runCheck(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	file := fs.String("f", "-", "OTLP/JSON file, - for stdin")
	services := fs.String("services", "*", "declared service names, comma-separated, or *")
	recv := fs.String("received-at", "newest", "receipt time: newest, now, or Unix nanoseconds")
	level := fs.String("level", "L1", "tenant verification level L0…L3")
	asJSON := fs.Bool("json", false, "print the report as JSON")
	failOnDrop := fs.Bool("fail-on-drop", false, "exit 3 when anything would be dropped")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	var r io.Reader = stdin
	if *file != "-" {
		f, err := os.Open(*file)
		if err != nil {
			fmt.Fprintln(stderr, "stellar scf check:", err)
			return exitUsage
		}
		defer f.Close()
		r = f
	}
	payload, err := io.ReadAll(io.LimitReader(r, maxPayload+1))
	if err != nil {
		fmt.Fprintln(stderr, "stellar scf check:", err)
		return exitUsage
	}
	if len(payload) > maxPayload {
		fmt.Fprintln(stderr, "stellar scf check: payload larger than 8 MiB")
		return exitUsage
	}
	rep, err := Check(payload, Options{Services: *services, ReceivedAt: *recv, Level: *level})
	if err != nil {
		fmt.Fprintln(stderr, "stellar scf check:", err)
		return exitUsage
	}
	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(rep)
	} else {
		printReport(stdout, rep)
	}
	if *failOnDrop && rep.DroppedItems() > 0 {
		return exitDropped
	}
	return exitOK
}

func printReport(w io.Writer, r *Report) {
	unit := "data points"
	if r.Signal == "traces" {
		unit = "spans"
	}
	fmt.Fprintf(w, "UsageMap dry run (scfsanitize")
	if r.RulesVersion != "" {
		fmt.Fprintf(w, ", %s", r.RulesVersion)
	}
	fmt.Fprintf(w, ")\nsignal %s · %d input %s · received at %s\n\n", r.Signal, r.InputItems, unit, r.ReceivedAt)

	fmt.Fprintf(w, "KEPT %d\n", r.KeptItems)
	for _, s := range r.Kept {
		status := ""
		if s.Status != 0 {
			status = fmt.Sprint(s.Status)
		}
		fmt.Fprintf(w, "  %-30s %-22s %-7s %-34s %-4s count=%d\n", s.Name, s.Service, s.Method, s.Route, status, s.Count)
	}
	if len(r.Redacted) > 0 {
		fmt.Fprintln(w, "\nREDACTED (kept, a route value was replaced)")
		for _, d := range r.Redacted {
			fmt.Fprintf(w, "  %-24s %-22s %d\n", d.Reason, d.Service, d.Count)
		}
	}
	fmt.Fprintf(w, "\nDROPPED %d\n", r.DroppedItems())
	for _, d := range r.Dropped {
		fmt.Fprintf(w, "  %-24s %-22s %d\n", d.Reason, d.Service, d.Count)
	}
	fmt.Fprintf(w, "\nNEVER STORED (attribute keys removed; values not shown)\n  %s\n", wrap(r.RemovedAttributes))
	if len(r.Hints) > 0 {
		fmt.Fprintln(w, "\nHINTS")
		for _, h := range r.Hints {
			fmt.Fprintf(w, "  - %s\n", h)
		}
	}
}

func wrap(keys []string) string {
	if len(keys) == 0 {
		return "(none)"
	}
	var b strings.Builder
	line := 0
	for i, k := range keys {
		if i > 0 {
			if line+2+len(k) > 100 {
				b.WriteString(",\n  ")
				line = 0
			} else {
				b.WriteString(", ")
				line += 2
			}
		}
		b.WriteString(k)
		line += len(k)
	}
	return b.String()
}
