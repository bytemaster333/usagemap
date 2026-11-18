// SPDX-License-Identifier: Apache-2.0

// Command stellar-scf is UsageMap's Stellar CLI plugin: any `stellar-<name>`
// executable on PATH runs as `stellar <name>` (stellar-cli v30
// commands/plugin/default.rs), so `stellar scf check …` runs this binary with
// `check …`. It also works on its own as `stellar-scf check …`.
//
// It never reads the Stellar CLI configuration directory (its identity/ holds
// secret keys) or any other file it was not given; secrets (ingest token,
// share key) come only from an environment variable or a named file and are
// never printed. `check` and `route` are offline; `init` is offline unless
// --api is given; `status` and `test` call the public endpoints only.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// version is set at release time with -ldflags "-X main.version=…".
var version = "0.1.0"

// Exit codes.
const (
	exitOK      = 0
	exitFailed  = 1 // status/test: a check failed
	exitUsage   = 2
	exitDropped = 3 // check --fail-on-drop and something was dropped
)

// maxPayload bounds the input like the gateway's OTLP body limit would.
const maxPayload = 8 << 20

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

const usage = `stellar scf — UsageMap for Stellar ecosystem projects

Usage (as a Stellar CLI plugin, or as stellar-scf):
  stellar scf check  [-f FILE|-] [--services LIST] [--received-at newest|now|NS] [--level L0…L3] [--json] [--fail-on-drop]
  stellar scf route  [--template] [--json] PATH|-
  stellar scf init   --site KEY [--profile standard|strict] [--tracker-version V] [--service NAME] [--api | --manifest FILE] [--json]
  stellar scf status [--site KEY] [--origin URL] [--slug SLUG] [--token-file F] [--share-key-file F] [--json]
  stellar scf test   [--site KEY] [--service NAME] [--token-file F] [--dry-run] [--json]
  stellar scf version

check   Dry run of UsageMap's real sanitise step on an OTLP/JSON payload (metrics
        or traces): what would be kept, redacted and dropped, the attribute keys
        never stored, and a fix hint per reason. Offline.
route   What the production path rules make of one path or route template. Offline;
        the input is never echoed.
init    The pinned tracker <script> (with its SRI hash) and the OpenTelemetry
        environment for a site key / service. Offline unless --api.
status  Platform health, the site key at the edge, the ingest token (an empty,
        unstored export) and the project's public counted data.
test    The portal's test commands: the web challenge for --site, and one
        never-counted data point (route /usagemap-test) for --service.

Endpoints: --portal (default ` + defaultPortal + `), --ingest and --otlp (default ` + defaultIngest + `).
Secrets: $` + envIngestToken + ` / $` + envShareKey + ` or --token-file / --share-key-file, never argv.
Flags go after the subcommand: "stellar --quiet scf …" does not reach the plugin.
Exit: 0 ok · 1 a check failed · 2 usage or input error · 3 check --fail-on-drop dropped data.
`

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return exitUsage
	}
	switch args[0] {
	case "check":
		return runCheck(args[1:], stdin, stdout, stderr)
	case "route":
		return runRoute(args[1:], stdin, stdout, stderr)
	case "init":
		return runInit(args[1:], stdout, stderr)
	case "status":
		return runStatus(args[1:], stdout, stderr)
	case "test":
		return runTest(args[1:], stdout, stderr)
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
	fs := newFlags("check", stderr)
	file := fs.String("f", "-", "OTLP/JSON file, - for stdin")
	services := fs.String("services", "*", "declared service names, comma-separated, or *")
	recv := fs.String("received-at", "newest", "receipt time: newest, now, or Unix nanoseconds")
	level := fs.String("level", "L1", "tenant verification level L0…L3")
	asJSON := fs.Bool("json", false, "print the report as JSON")
	failOnDrop := fs.Bool("fail-on-drop", false, "exit 3 when anything would be dropped")
	pos, args := leadingArg(args)
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if pos == "" && fs.NArg() == 1 {
		pos = fs.Arg(0)
	} else if fs.NArg() > 0 {
		return fail(stderr, "check", fmt.Errorf("unexpected argument %q", fs.Arg(0)))
	}
	if pos != "" { // `stellar scf check payload.json`
		if *file != "-" {
			return fail(stderr, "check", fmt.Errorf("give the file once (-f or as an argument)"))
		}
		*file = pos
	}
	var r io.Reader = stdin
	if *file != "-" {
		f, err := os.Open(*file)
		if err != nil {
			return fail(stderr, "check", err)
		}
		defer f.Close()
		r = f
	}
	payload, err := io.ReadAll(io.LimitReader(r, maxPayload+1))
	if err != nil {
		return fail(stderr, "check", err)
	}
	if len(payload) > maxPayload {
		return fail(stderr, "check", fmt.Errorf("payload larger than 8 MiB"))
	}
	rep, err := Check(payload, Options{Services: *services, ReceivedAt: *recv, Level: *level})
	if err != nil {
		return fail(stderr, "check", err)
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

// leadingArg splits off a first argument that is not a flag, so that both
// `check FILE --json` and `check --json FILE` work.
func leadingArg(args []string) (string, []string) {
	if len(args) > 0 && args[0] != "-" && !strings.HasPrefix(args[0], "-") {
		return args[0], args[1:]
	}
	return "", args
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
