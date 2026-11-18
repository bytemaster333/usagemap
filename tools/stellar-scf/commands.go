// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

// endpoints are the deployment origins shared by init, status and test.
type endpoints struct {
	portal, ingest, otlp *string
}

func addEndpoints(fs *flag.FlagSet) endpoints {
	return endpoints{
		portal: fs.String("portal", defaultPortal, "portal / API origin"),
		ingest: fs.String("ingest", defaultIngest, "web ingest origin (serves the tracker)"),
		otlp:   fs.String("otlp", defaultOTLP, "OTLP ingest origin"),
	}
}

func (e endpoints) resolve() (portal, ingest, otlp string, err error) {
	if portal, err = baseURL("portal", *e.portal); err != nil {
		return
	}
	if ingest, err = baseURL("ingest", *e.ingest); err != nil {
		return
	}
	otlp, err = baseURL("otlp", *e.otlp)
	return
}

func newFlags(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

func fail(stderr io.Writer, cmd string, err error) int {
	fmt.Fprintf(stderr, "stellar scf %s: %v\n", cmd, err)
	return exitUsage
}

func checkProfile(p string) error {
	if p != "standard" && p != "strict" {
		return fmt.Errorf("--profile must be standard or strict, got %q", p)
	}
	return nil
}

// ---------------------------------------------------------------- init

// InitOutput is what `init --json` prints.
type InitOutput struct {
	Tracker *struct {
		Version   string `json:"version"`
		Profile   string `json:"profile"`
		Source    string `json:"source"`
		Snippet   string `json:"snippet"`
		Install   string `json:"npm_install"`
		NPMImport string `json:"npm_code"`
	} `json:"tracker,omitempty"`
	OTel *struct {
		Env   map[string]string `json:"env"`
		Notes []string          `json:"notes"`
	} `json:"otel,omitempty"`
}

func runInit(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("init", stderr)
	site := fs.String("site", "", "public site key (22 characters, from the portal's website page)")
	service := fs.String("service", "", "API service name (as registered in the portal) for the OpenTelemetry variables")
	profile := fs.String("profile", "standard", "tracker profile: standard or strict")
	want := fs.String("tracker-version", "", "tracker version to pin (default: newest active)")
	manifest := fs.String("manifest", "", "local tracker release list (JSON) instead of the built-in snapshot")
	useAPI := fs.Bool("api", false, "read the live tracker release list from the portal (the only network call of init)")
	asJSON := fs.Bool("json", false, "print JSON")
	ep := addEndpoints(fs)
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() > 0 {
		return fail(stderr, "init", fmt.Errorf("unexpected argument %q", fs.Arg(0)))
	}
	if *site == "" && *service == "" {
		return fail(stderr, "init", errors.New("give --site (web tracker) and/or --service (OpenTelemetry)"))
	}
	portal, ingest, otlp, err := ep.resolve()
	if err != nil {
		return fail(stderr, "init", err)
	}
	var out InitOutput
	if *site != "" {
		if !reSiteKey.MatchString(*site) {
			return fail(stderr, "init", errors.New("--site must be the 22-character site key shown in the portal"))
		}
		if err := checkProfile(*profile); err != nil {
			return fail(stderr, "init", err)
		}
		raw, source, err := releaseList(*manifest, *useAPI, portal, ingest)
		if err != nil {
			return fail(stderr, "init", err)
		}
		vs, err := ParseVersions(raw)
		if err != nil {
			return fail(stderr, "init", err)
		}
		v, f, err := Pick(vs, *want, *profile)
		if err != nil {
			return fail(stderr, "init", err)
		}
		pkg := "@usagemap/tracker"
		if *profile == "strict" {
			pkg += "/strict"
		}
		out.Tracker = &struct {
			Version   string `json:"version"`
			Profile   string `json:"profile"`
			Source    string `json:"source"`
			Snippet   string `json:"snippet"`
			Install   string `json:"npm_install"`
			NPMImport string `json:"npm_code"`
		}{v.Version, *profile, source, ScriptTag(ingest, f, *site),
			"pnpm add --save-exact @usagemap/tracker@" + v.Version,
			`import { init } from "` + pkg + `";` + "\n\n" + `init({ site: "` + *site + `" });`}
	}
	if *service != "" {
		if strings.ContainsAny(*service, "\r\n\"'`$\\") || len(*service) > 128 {
			return fail(stderr, "init", errors.New("--service must be a plain service name"))
		}
		out.OTel = &struct {
			Env   map[string]string `json:"env"`
			Notes []string          `json:"notes"`
		}{otelEnv(otlp, *service), []string{
			"Replace <INGEST_TOKEN> with an ingest token of this project (shown once when you create it in the portal).",
			"Replace <INSTANCE_ID> with a value unique per running process (for example the host or pod name).",
			`Register the API service "` + *service + `" in the portal first: data of services that are not registered is not stored.`,
			"These variables make UsageMap the service's only OpenTelemetry backend. To keep your own APM as well (dual export), use the portal's API set-up wizard.",
			"Only the HTTP server request-duration metric is kept; logs are refused. Dry-run a captured payload with: stellar scf check -f payload.json --services " + *service,
		}}
	}
	if *asJSON {
		return writeJSON(stdout, out)
	}
	if t := out.Tracker; t != nil {
		fmt.Fprintf(stdout, "# Web tracker %s (%s profile; release list: %s)\n", t.Version, t.Profile, t.Source)
		fmt.Fprintf(stdout, "# Paste into the <head> of every page. integrity + crossorigin pin the exact bytes.\n%s\n\n", t.Snippet)
		fmt.Fprintf(stdout, "# Or bundle it with your app:\n#   %s\n%s\n", t.Install, indent(t.NPMImport, ""))
		fmt.Fprintf(stdout, "\n# Check the key is live at the edge: stellar scf status --site %s\n", *site)
	}
	if o := out.OTel; o != nil {
		if out.Tracker != nil {
			fmt.Fprintln(stdout)
		}
		fmt.Fprintln(stdout, "# OpenTelemetry (any SDK): environment of the service")
		for _, k := range otelOrder {
			fmt.Fprintf(stdout, "export %s=%s\n", k, shellQuote(o.Env[k]))
		}
		fmt.Fprintln(stdout)
		for _, n := range o.Notes {
			fmt.Fprintf(stdout, "# - %s\n", n)
		}
		fmt.Fprintf(stdout, "\n# Then: export %s=… (never on the command line) and run: stellar scf test --service %s\n", envIngestToken, *service)
	}
	return exitOK
}

// releaseList returns the raw tracker release list and where it came from.
func releaseList(file string, useAPI bool, portal, ingest string) ([]byte, string, error) {
	switch {
	case file != "":
		b, err := os.ReadFile(file)
		return b, file, err
	case useAPI:
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		res, err := doRequest(ctx, "GET", portal+"/v1/tracker/versions", map[string]string{"Accept": "application/json"}, nil)
		if err != nil {
			return nil, "", err
		}
		if res.Status != 200 {
			return nil, "", fmt.Errorf("%s/v1/tracker/versions answered HTTP %d", portal, res.Status)
		}
		return res.Body, portal + "/v1/tracker/versions", nil
	}
	if !slices.Contains(embeddedHosts(), ingest) {
		return nil, "", fmt.Errorf("the built-in release list belongs to %s; for %s pass --api (live list) or --manifest FILE: the SRI hash depends on the deployment",
			strings.Join(embeddedHosts(), " / "), ingest)
	}
	var w struct {
		FetchedAt string `json:"fetched_at"`
	}
	_ = json.Unmarshal(embeddedReleases, &w)
	return embeddedReleases, "built-in snapshot of " + w.FetchedAt + " (use --api for the live list)", nil
}

var otelOrder = []string{
	"OTEL_SERVICE_NAME", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_HEADERS", "OTEL_METRICS_EXPORTER", "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER",
}

// otelEnv mirrors the portal kit's otelEnv (control-plane src/onboarding/kit.ts).
func otelEnv(otlp, service string) map[string]string {
	return map[string]string{
		"OTEL_SERVICE_NAME":           service,
		"OTEL_RESOURCE_ATTRIBUTES":    "service.instance.id=<INSTANCE_ID>",
		"OTEL_EXPORTER_OTLP_ENDPOINT": otlp,
		"OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
		"OTEL_EXPORTER_OTLP_HEADERS":  "Authorization=Bearer%20<INGEST_TOKEN>",
		"OTEL_METRICS_EXPORTER":       "otlp",
		"OTEL_TRACES_EXPORTER":        "none",
		"OTEL_LOGS_EXPORTER":          "none",
	}
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func indent(s, pfx string) string {
	return pfx + strings.ReplaceAll(s, "\n", "\n"+pfx)
}

func writeJSON(w io.Writer, v any) int {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return exitOK
}

// ---------------------------------------------------------------- status / test

type probeFlags struct {
	site, origin, profile, slug, tokenFile, shareFile *string
	asJSON                                            *bool
	ep                                                endpoints
}

func addProbeFlags(fs *flag.FlagSet) probeFlags {
	return probeFlags{
		site:      fs.String("site", "", "public site key to check at the edge"),
		origin:    fs.String("origin", "http://localhost", "Origin header of the web check (domains have no oracle: the key is what is checked)"),
		profile:   fs.String("profile", "standard", "tracker profile of the web check"),
		slug:      fs.String("slug", "", "project slug for the public metrics document"),
		tokenFile: fs.String("token-file", "", "file holding the ingest token (default: $"+envIngestToken+")"),
		shareFile: fs.String("share-key-file", "", "file holding a share key for non-public stats (default: $"+envShareKey+")"),
		asJSON:    fs.Bool("json", false, "print JSON"),
		ep:        addEndpoints(fs),
	}
}

func latestTrackerVersion() string {
	vs, err := ParseVersions(embeddedReleases)
	if err == nil {
		for _, v := range vs {
			if v.Status == "active" {
				return v.Version
			}
		}
	}
	return "1.1.0"
}

func runStatus(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("status", stderr)
	pf := addProbeFlags(fs)
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() > 0 {
		return fail(stderr, "status", fmt.Errorf("unexpected argument %q", fs.Arg(0)))
	}
	portal, ingest, otlp, err := pf.ep.resolve()
	if err != nil {
		return fail(stderr, "status", err)
	}
	if err := validateWebFlags(pf); err != nil {
		return fail(stderr, "status", err)
	}
	token, err := readSecret(*pf.tokenFile, envIngestToken)
	if err != nil {
		return fail(stderr, "status", err)
	}
	share, err := readSecret(*pf.shareFile, envShareKey)
	if err != nil {
		return fail(stderr, "status", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	probes := []Probe{probeHealth(ctx, portal)}
	if *pf.site != "" {
		probes = append(probes, probeSite(ctx, ingest, *pf.site, *pf.profile, latestTrackerVersion(), *pf.origin))
	} else {
		probes = append(probes, Probe{Name: "site key at the edge", State: stateSkip, Detail: "pass --site"})
	}
	if token != "" {
		probes = append(probes, probeToken(ctx, otlp, token))
	} else {
		probes = append(probes, Probe{Name: "ingest token", State: stateSkip, Detail: "set $" + envIngestToken + " or --token-file"})
	}
	if *pf.slug != "" {
		probes = append(probes, probeFirstEvent(ctx, portal, *pf.slug, share))
	} else {
		probes = append(probes, Probe{Name: "counted data", State: stateSkip, Detail: "pass --slug"})
	}
	return report(stdout, probes, *pf.asJSON)
}

func validateWebFlags(pf probeFlags) error {
	if *pf.site != "" && !reSiteKey.MatchString(*pf.site) {
		return errors.New("--site must be the 22-character site key shown in the portal")
	}
	if err := checkProfile(*pf.profile); err != nil {
		return err
	}
	u, err := url.Parse(*pf.origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		return errors.New("--origin must be an origin such as https://www.example.org")
	}
	return nil
}

func runTest(args []string, stdout, stderr io.Writer) int {
	fs := newFlags("test", stderr)
	pf := addProbeFlags(fs)
	service := fs.String("service", "", "registered API service name: sends one never-counted test data point (route /usagemap-test)")
	dry := fs.Bool("dry-run", false, "print what would be sent (token replaced by a placeholder) and send nothing")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() > 0 {
		return fail(stderr, "test", fmt.Errorf("unexpected argument %q", fs.Arg(0)))
	}
	if *pf.site == "" && *service == "" {
		return fail(stderr, "test", errors.New("give --site (web) and/or --service (API)"))
	}
	_, ingest, otlp, err := pf.ep.resolve()
	if err != nil {
		return fail(stderr, "test", err)
	}
	if err := validateWebFlags(pf); err != nil {
		return fail(stderr, "test", err)
	}
	if *service != "" && (strings.ContainsAny(*service, "\r\n") || len(*service) > 128) {
		return fail(stderr, "test", errors.New("--service must be a plain service name"))
	}
	now := time.Now()
	if *dry {
		if *pf.site != "" {
			body, _ := json.Marshal(map[string]any{"v": 1, "s": *pf.site, "p": *pf.profile, "tv": latestTrackerVersion()})
			fmt.Fprintf(stdout, "# web\ncurl -sS -i %s \\\n  -H %s \\\n  -H 'Content-Type: text/plain;charset=UTF-8' \\\n  --data %s\n\n",
				shellQuote(ingest+"/v1/c"), shellQuote("Origin: "+*pf.origin), shellQuote(string(body)))
		}
		if *service != "" {
			fmt.Fprintf(stdout, "# api\ncurl -sS -i %s \\\n  -H 'Authorization: Bearer <INGEST_TOKEN>' \\\n  -H 'Content-Type: application/json' \\\n  --data %s\n",
				shellQuote(otlp+"/v1/metrics"), shellQuote(string(testMetric(*service, now, os.Getpid()))))
		}
		return exitOK
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var probes []Probe
	if *pf.site != "" {
		probes = append(probes, probeSite(ctx, ingest, *pf.site, *pf.profile, latestTrackerVersion(), *pf.origin))
	}
	if *service != "" {
		token, err := readSecret(*pf.tokenFile, envIngestToken)
		if err != nil {
			return fail(stderr, "test", err)
		}
		if token == "" {
			return fail(stderr, "test", fmt.Errorf("the API test needs an ingest token in $%s or --token-file (never on the command line)", envIngestToken))
		}
		probes = append(probes, sendTestMetric(ctx, otlp, token, *service, now))
	}
	return report(stdout, probes, *pf.asJSON)
}

func report(w io.Writer, probes []Probe, asJSON bool) int {
	code := exitOK
	for _, p := range probes {
		if p.State == stateFail {
			code = exitFailed
		}
	}
	if asJSON {
		writeJSON(w, map[string]any{"ok": code == exitOK, "checks": probes})
		return code
	}
	for _, p := range probes {
		h := ""
		if p.HTTP != 0 {
			h = fmt.Sprintf(" [HTTP %d]", p.HTTP)
		}
		fmt.Fprintf(w, "%-4s  %-22s %s%s\n", strings.ToUpper(p.State), p.Name, p.Detail, h)
	}
	return code
}

// ---------------------------------------------------------------- route

// RouteOutput is what `route --json` prints. The input is never echoed: it
// may hold the very secret the rules redact.
type RouteOutput struct {
	Kind         string         `json:"kind"`
	Route        string         `json:"route"`
	Rules        []string       `json:"rules"`
	Redactions   map[string]int `json:"redactions"`
	Flags        []string       `json:"flags"`
	RulesVersion string         `json:"rules_version"`
}

func runRoute(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := newFlags("route", stderr)
	tmpl := fs.Bool("template", false, "the input is an http.route template (as a framework reports it), not a raw path")
	asJSON := fs.Bool("json", false, "print JSON")
	pos, args := leadingArg(args)
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	rest := fs.Args()
	if pos != "" {
		rest = append([]string{pos}, rest...)
	}
	var in string
	switch {
	case len(rest) == 0 || (len(rest) == 1 && rest[0] == "-"):
		b, err := io.ReadAll(io.LimitReader(stdin, 64<<10))
		if err != nil {
			return fail(stderr, "route", err)
		}
		in = strings.TrimRight(string(b), "\r\n")
	case len(rest) == 1:
		in = rest[0]
	default:
		return fail(stderr, "route", errors.New("one path or template (or - on stdin)"))
	}
	out := Route(in, *tmpl)
	if *asJSON {
		return writeJSON(stdout, out)
	}
	fmt.Fprintf(stdout, "%s → %s  (%s)\n", out.Kind, out.Route, out.RulesVersion)
	if len(out.Rules) > 0 {
		fmt.Fprintf(stdout, "rules: %s\n", strings.Join(out.Rules, ", "))
	}
	for _, k := range slices.Sorted(maps.Keys(out.Redactions)) {
		fmt.Fprintf(stdout, "redacted: %s ×%d (value not shown)\n", k, out.Redactions[k])
	}
	if out.Redactions["stellar_seed/path"]+out.Redactions["stellar_seed/route"]+out.Redactions["stellar_seed/query"] > 0 {
		fmt.Fprintln(stdout, "WARNING: a Stellar secret seed was in this URL. Treat the account as compromised and rotate it.")
	}
	if len(out.Flags) > 0 {
		fmt.Fprintf(stdout, "flags: %s\n", strings.Join(out.Flags, ", "))
	}
	return exitOK
}

// Route normalises one input with the production rule set (packages/pathnorm).
func Route(in string, template bool) RouteOutput {
	opts := pathnorm.Options{Input: pathnorm.InputPath}
	kind := "path"
	if template {
		opts.Input, kind = pathnorm.InputRoute, "route"
	}
	r := pathnorm.Normalize(in, opts)
	out := RouteOutput{Kind: kind, Route: r.Route, Rules: []string{}, Redactions: map[string]int{}, Flags: []string{}, RulesVersion: r.RulesVersion()}
	for _, x := range r.Rules {
		out.Rules = append(out.Rules, string(x))
	}
	r.Redactions.Each(func(k pathnorm.Kind, l pathnorm.Location, n int) {
		out.Redactions[k.String()+"/"+l.String()] = n
	})
	for _, f := range []struct {
		f    pathnorm.Flags
		name string
	}{
		{pathnorm.FlagRedacted, "redacted"}, {pathnorm.FlagQueryStripped, "query_stripped"},
		{pathnorm.FlagTruncated, "truncated"}, {pathnorm.FlagTooLong, "too_long"},
		{pathnorm.FlagInvalid, "invalid"}, {pathnorm.FlagMethodStripped, "method_stripped"}, {pathnorm.FlagEmpty, "empty"},
	} {
		if r.Flags.Has(f.f) {
			out.Flags = append(out.Flags, f.name)
		}
	}
	return out
}
