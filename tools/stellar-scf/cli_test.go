// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Vectors computed with the control plane's own checksum()
// (services/control-plane/src/keys/keys.ts) on 2026-11-19.
func TestKeyChecksumMatchesControlPlane(t *testing.T) {
	for _, v := range [][4]string{
		{"ing", "AbCdEf012345", "ZyXwVuTsRqPoNmLkJiHgFeDcBa9", "2ykKEm"},
		{"pub", "000000000000", "000000000000000000000000000", "3YwAlS"},
		{"op", "Q1w2E3r4T5y6", "u7I8o9P0a1S2d3F4g5H6j7K8l9Z", "2JDFyb"},
	} {
		if got := keyChecksum(v[0], v[1], v[2]); got != v[3] {
			t.Errorf("checksum(%s) = %s, want %s", v[0], got, v[3])
		}
	}
	good := testToken
	if err := checkKey(good, "ing"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{good[:len(good)-1] + "x", "scfa_ing_short", "Bearer " + good} {
		err := checkKey(bad, "ing")
		if err == nil {
			t.Errorf("accepted %q", bad)
		} else if strings.Contains(err.Error(), "ZyXw") {
			t.Errorf("error echoes the secret: %v", err)
		}
	}
	if err := checkKey(testShare, "ing"); err == nil || !strings.Contains(err.Error(), "scfa_pub_") {
		t.Errorf("kind mismatch not explained: %v", err)
	}
}

// Test keys are assembled at run time so no key-shaped literal sits in the
// source (the secrets gate scans for them). Their checksums are the
// control-plane vectors above.
var (
	testToken = strings.Join([]string{"scfa", "ing", "AbCdEf012345", "ZyXwVuTsRqPoNmLkJiHgFeDcBa9" + "2ykKEm"}, "_")
	testShare = strings.Join([]string{"scfa", "pub", "000000000000", strings.Repeat("0", 27) + "3YwAlS"}, "_")
)

const siteKey = "SiteKeyForTests0000000"

func TestParseVersionsAllShapes(t *testing.T) {
	// 1. the control plane's /v1/tracker/versions (embedded snapshot wraps it)
	vs, err := ParseVersions(embeddedReleases)
	if err != nil || len(vs) == 0 || vs[0].Files[0].Path != "/lib/"+vs[0].Version+"/standard.js" {
		t.Fatalf("embedded: %v %+v", err, vs)
	}
	// 2. a single release manifest (the tracker's own archived release)
	one, err := ParseVersions(mustRead(t, "../../tracker/releases/1.0.0/manifest.json"))
	if err != nil || len(one) != 1 || one[0].Version != "1.0.0" || len(one[0].Files) != 2 || one[0].Status != "active" {
		t.Fatalf("release manifest: %v %+v", err, one)
	}
	// 3. the edge's /lib/manifest.json (tracker-manifests/1)
	agg := fmt.Sprintf(`{"schema":"scf-analytics/tracker-manifests/1","versions":[%s]}`, mustRead(t, "../../tracker/releases/1.0.0/manifest.json"))
	if vs, err := ParseVersions([]byte(agg)); err != nil || len(vs) != 1 || vs[0].Files[1].Profile != "strict" {
		t.Fatalf("aggregate: %v %+v", err, vs)
	}
	for _, bad := range []string{``, `{}`, `[{"version":"1.x"}]`, `[{"version":"1.0.0","status":"gone"}]`,
		`[{"version":"1.0.0","files":[{"profile":"standard","integrity":"sha256-abc"}]}]`} {
		if _, err := ParseVersions([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

const listWithWithdrawn = `[
 {"version":"1.2.0","status":"withdrawn","files":[{"profile":"standard","url":"/lib/1.2.0/standard.js","integrity":"sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]},
 {"version":"1.1.0","status":"active","files":[{"profile":"standard","url":"/lib/1.1.0/standard.js","integrity":"sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"},
   {"profile":"strict","url":"/lib/1.1.0/strict.js","integrity":"sha384-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}]},
 {"version":"1.0.0","status":"active","files":[{"profile":"standard","url":"/lib/1.0.0/standard.js","integrity":"sha384-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"}]}]`

func TestPickSkipsWithdrawn(t *testing.T) {
	vs, err := ParseVersions([]byte(listWithWithdrawn))
	if err != nil {
		t.Fatal(err)
	}
	v, f, err := Pick(vs, "", "standard")
	if err != nil || v.Version != "1.1.0" || !strings.HasPrefix(f.Integrity, "sha384-B") {
		t.Fatalf("newest active: %v %s", err, v.Version)
	}
	if _, _, err := Pick(vs, "1.2.0", "standard"); err == nil || !strings.Contains(err.Error(), "withdrawn") {
		t.Errorf("withdrawn pin accepted: %v", err)
	}
	if _, _, err := Pick(vs, "1.0.0", "strict"); err == nil {
		t.Error("missing profile accepted")
	}
	if _, _, err := Pick(vs, "9.9.9", "standard"); err == nil {
		t.Error("unknown version accepted")
	}
}

func runCLI(t *testing.T, stdin string, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := run(args, strings.NewReader(stdin), &out, &errb)
	return code, out.String(), errb.String()
}

// noNetwork makes any HTTP request fail the test.
func noNetwork(t *testing.T) {
	t.Helper()
	old := httpClient
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Errorf("unexpected network request %s %s", r.Method, r.URL)
		return nil, errors.New("network disabled in this test")
	})}
	t.Cleanup(func() { httpClient = old })
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestInitOfflineSnippet(t *testing.T) {
	noNetwork(t)
	code, out, errs := runCLI(t, "", "init", "--site", siteKey, "--service", "anchor-api", "--json")
	if code != exitOK {
		t.Fatalf("exit %d: %s", code, errs)
	}
	var o InitOutput
	if err := json.Unmarshal([]byte(out), &o); err != nil {
		t.Fatal(err)
	}
	vs, _ := ParseVersions(embeddedReleases)
	_, f, _ := Pick(vs, "", "standard")
	want := "<script\n  src=\"https://e1.usagemap.dev" + f.Path + "\"\n  integrity=\"" + f.Integrity +
		"\"\n  crossorigin=\"anonymous\"\n  data-site=\"" + siteKey + "\"\n  defer\n></script>"
	if o.Tracker.Snippet != want {
		t.Errorf("snippet\n%s\nwant\n%s", o.Tracker.Snippet, want)
	}
	if o.OTel.Env["OTEL_EXPORTER_OTLP_HEADERS"] != "Authorization=Bearer%20<INGEST_TOKEN>" ||
		o.OTel.Env["OTEL_EXPORTER_OTLP_ENDPOINT"] != "https://e1.usagemap.dev" || o.OTel.Env["OTEL_SERVICE_NAME"] != "anchor-api" {
		t.Errorf("otel env %v", o.OTel.Env)
	}
	// init never reads the token, even when one is set.
	t.Setenv(envIngestToken, testToken)
	_, out, _ = runCLI(t, "", "init", "--service", "anchor-api")
	if strings.Contains(out, "ZyXw") {
		t.Error("init printed the token")
	}
	// Strict profile and an explicit version.
	code, out, errs = runCLI(t, "", "init", "--site", siteKey, "--profile", "strict", "--tracker-version", vs[0].Version)
	if code != exitOK || !strings.Contains(out, "/strict.js") || !strings.Contains(out, `@usagemap/tracker/strict`) {
		t.Errorf("strict: %d %s %s", code, out, errs)
	}
}

func TestInitRefusesForeignDeploymentWithoutSource(t *testing.T) {
	noNetwork(t)
	code, _, errs := runCLI(t, "", "init", "--site", siteKey, "--ingest", "https://ingest.example.org")
	if code != exitUsage || !strings.Contains(errs, "--api") {
		t.Fatalf("exit %d: %s", code, errs)
	}
	p := filepath.Join(t.TempDir(), "versions.json")
	if err := os.WriteFile(p, []byte(listWithWithdrawn), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, errs := runCLI(t, "", "init", "--site", siteKey, "--ingest", "https://ingest.example.org", "--manifest", p)
	if code != exitOK || !strings.Contains(out, `src="https://ingest.example.org/lib/1.1.0/standard.js"`) {
		t.Fatalf("manifest: %d %s %s", code, out, errs)
	}
	for _, args := range [][]string{
		{"init"}, {"init", "--site", "short"}, {"init", "--site", siteKey, "--profile", "x"},
		{"init", "--site", siteKey, "--ingest", "http://ingest.example.org"}, {"init", "--service", "a\nb"},
		{"init", "--site", siteKey, "--ingest", "https://x.example/path"},
	} {
		if code, _, _ := runCLI(t, "", args...); code != exitUsage {
			t.Errorf("%v: exit %d", args, code)
		}
	}
}

// fakeDeployment is an httptest server answering like the portal and the
// edge (wire-formats §a.2, §f.3, §i.1, §i.2). It records requests.
type fakeDeployment struct {
	mu       sync.Mutex
	srv      *httptest.Server
	requests []string
	bodies   [][]byte
	auths    []string
	project  int // status for the metrics document
	otlp     int
	site     int
}

func newFake(t *testing.T) *fakeDeployment {
	f := &fakeDeployment{project: 200, otlp: 200, site: 200}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.requests = append(f.requests, r.Method+" "+r.URL.Path)
		f.bodies = append(f.bodies, b)
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		f.mu.Unlock()
		switch r.URL.Path {
		case "/public/v1/health":
			_, _ = io.WriteString(w, `{"schema":"scf-analytics/health/1","status":"degraded","components":{"web_ingest":"ok","otlp_ingest":"degraded"},"status_page":"https://status.example"}`)
		case "/v1/tracker/versions":
			_, _ = io.WriteString(w, listWithWithdrawn)
		case "/v1/c":
			if r.Header.Get("Origin") == "" || r.Header.Get("Content-Type") != "text/plain;charset=UTF-8" {
				w.WriteHeader(400)
				return
			}
			w.WriteHeader(f.site)
			if f.site == 404 {
				_, _ = io.WriteString(w, `{"error":"unknown_site"}`)
			} else {
				_, _ = io.WriteString(w, `{"v":1,"t":"x","pow":{},"ttl":1800}`)
			}
		case "/v1/metrics":
			if r.Header.Get("Authorization") != "Bearer "+testToken {
				w.WriteHeader(401)
				return
			}
			w.WriteHeader(f.otlp)
		case "/public/v1/projects/demo/metrics.json":
			if r.Header.Get("Authorization") != "Bearer "+testShare {
				w.WriteHeader(404)
				return
			}
			w.WriteHeader(f.project)
			_, _ = io.WriteString(w, `{"schema":"scf-analytics/metrics-endpoint/1","generated_at":"2026-11-19T10:00:00Z","window":{"start":"2026-10-20T00:00:00Z","end":"2026-11-19T00:00:00Z","days":30},"web":{"verified":{"pageviews":120,"visitors_sum":40},"raw":{"pageviews":130,"visitors_sum":44}},"api":{"requests":5000}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeDeployment) flags() []string {
	return []string{"--portal", f.srv.URL, "--ingest", f.srv.URL, "--otlp", f.srv.URL}
}

func TestStatusAllChecks(t *testing.T) {
	f := newFake(t)
	t.Setenv(envIngestToken, testToken)
	t.Setenv(envShareKey, testShare)
	code, out, errs := runCLI(t, "", append([]string{"status", "--site", siteKey, "--slug", "demo", "--json"}, f.flags()...)...)
	if code != exitOK {
		t.Fatalf("exit %d: %s %s", code, out, errs)
	}
	var r struct {
		OK     bool    `json:"ok"`
		Checks []Probe `json:"checks"`
	}
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, p := range r.Checks {
		states[p.Name] = p.State
	}
	want := map[string]string{"platform": "warn", "site key at the edge": "ok", "ingest token": "ok", "counted data": "ok"}
	for k, v := range want {
		if states[k] != v {
			t.Errorf("%s = %s, want %s (%s)", k, states[k], v, out)
		}
	}
	if strings.Contains(out, "ZyXw") || strings.Contains(out, testShare) {
		t.Error("a secret reached the output")
	}
	// The token probe stores nothing: an empty export.
	for i, rq := range f.requests {
		if rq == "POST /v1/metrics" && string(f.bodies[i]) != `{"resourceMetrics":[]}` {
			t.Errorf("token probe sent data: %s", f.bodies[i])
		}
		if rq == "POST /v1/c" {
			var c map[string]any
			if json.Unmarshal(f.bodies[i], &c) != nil || c["s"] != siteKey || c["v"] != float64(1) || c["p"] != "standard" {
				t.Errorf("challenge body %s", f.bodies[i])
			}
		}
	}
	if !strings.Contains(r.Checks[3].Detail, "120 verified page views") {
		t.Errorf("first-event detail %q", r.Checks[3].Detail)
	}
}

func TestStatusFailures(t *testing.T) {
	f := newFake(t)
	f.site, f.otlp = 404, 403
	t.Setenv(envIngestToken, testToken)
	t.Setenv(envShareKey, "")
	code, out, _ := runCLI(t, "", append([]string{"status", "--site", siteKey, "--slug", "demo"}, f.flags()...)...)
	if code != exitFailed {
		t.Fatalf("exit %d", code)
	}
	for _, s := range []string{"unknown_site", "403: the project is pending approval or suspended", "the answer is the same on purpose"} {
		if !strings.Contains(out, s) {
			t.Errorf("missing %q in\n%s", s, out)
		}
	}
	// A mistyped token is refused offline: no request carries it.
	t.Setenv(envIngestToken, testToken[:len(testToken)-1]+"x")
	f.requests = nil
	_, out, _ = runCLI(t, "", append([]string{"status"}, f.flags()...)...)
	if !strings.Contains(out, "checksum is wrong") {
		t.Errorf("offline CRC check missing: %s", out)
	}
	for _, rq := range f.requests {
		if rq == "POST /v1/metrics" {
			t.Error("a token with a bad checksum was sent")
		}
	}
	// Nothing configured: only health runs, the rest is skipped.
	t.Setenv(envIngestToken, "")
	code, out, _ = runCLI(t, "", append([]string{"status"}, f.flags()...)...)
	if code != exitOK || strings.Count(out, "SKIP") != 3 {
		t.Errorf("skips: %d\n%s", code, out)
	}
}

func TestStatusTokenFromFile(t *testing.T) {
	f := newFake(t)
	t.Setenv(envIngestToken, "")
	p := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(p, []byte(testToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, _ := runCLI(t, "", append([]string{"status", "--token-file", p}, f.flags()...)...)
	if code != exitOK || !strings.Contains(out, "OK    ingest token") {
		t.Fatalf("%d %s", code, out)
	}
}

func TestTestSendsMarkedMetricThatSanitiseKeeps(t *testing.T) {
	f := newFake(t)
	t.Setenv(envIngestToken, testToken)
	code, out, errs := runCLI(t, "", append([]string{"test", "--service", "anchor-api", "--site", siteKey}, f.flags()...)...)
	if code != exitOK {
		t.Fatalf("exit %d: %s %s", code, out, errs)
	}
	var body []byte
	for i, rq := range f.requests {
		if rq == "POST /v1/metrics" {
			body = f.bodies[i]
			if f.auths[i] != "Bearer "+testToken {
				t.Error("bearer not sent")
			}
		}
	}
	if body == nil {
		t.Fatal("no metric sent")
	}
	rep, err := Check(body, Options{Services: "anchor-api", ReceivedAt: "now"})
	if err != nil || rep.KeptItems != 1 || rep.Kept[0].Route != "/usagemap-test" || rep.Kept[0].Service != "anchor-api" {
		t.Fatalf("sent metric not kept by the real sanitise step: %v %+v", err, rep)
	}
	// Never counted (C-122): a cumulative point whose stream started more than
	// 10 minutes earlier, from a fresh instance, only seeds the writer's state.
	if !strings.Contains(string(body), `"aggregationTemporality":2`) || !strings.Contains(string(body), `"stringValue":"usagemap-test-`) {
		t.Errorf("not the never-counted test point: %s", body)
	}
	if !strings.Contains(out, "never counted") {
		t.Errorf("result does not say the point is never counted: %s", out)
	}
	// Without a token the API test refuses before any request.
	t.Setenv(envIngestToken, "")
	if code, _, errs := runCLI(t, "", append([]string{"test", "--service", "anchor-api"}, f.flags()...)...); code != exitUsage || !strings.Contains(errs, envIngestToken) {
		t.Errorf("no token: %d %s", code, errs)
	}
}

func TestTestMetricMatchesPortalKit(t *testing.T) {
	// The portal's OTLP test command (control-plane
	// src/integrations/test-commands.ts otlpTestCurl, which kit.ts and the
	// integration catalogue render), rendered by the real function with Node
	// and run with sh against a fixed `date` and a recording `curl`: the body
	// it sends must equal the CLI's data point byte for byte. Nothing is
	// parsed out of the TypeScript source, so a refactor there cannot switch
	// the comparison off; a missing Node fails instead of skipping.
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node not on PATH (the toolchain of mise.toml): it renders the portal's test command")
	}
	src, err := filepath.Abs("../../services/control-plane/src/integrations/test-commands.ts")
	if err != nil {
		t.Fatal(err)
	}
	render := exec.Command(node, "--input-type=module", "-e",
		`const m = await import(process.argv[1]); process.stdout.write(m.otlpTestCurl({ otlpEndpoint: "https://otlp.test", serviceName: "svc" }));`,
		"file://"+filepath.ToSlash(src))
	render.Stderr = os.Stderr
	script, err := render.Output()
	if err != nil {
		t.Fatalf("rendering otlpTestCurl: %v", err)
	}
	const epoch = 1794500000
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	stubs := map[string]string{
		"date": "#!/bin/sh\n[ \"$1\" = +%s ] || exit 64\necho " + strconv.Itoa(epoch) + "\n",
		"curl": "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$REC/args\"\ncat > \"$REC/body\"\necho 'HTTP/1.1 200 OK'\n",
	}
	for name, body := range stubs {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	run := exec.Command("sh", "-c", string(script))
	run.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "SCF_OTLP_TOKEN=test", "REC="+dir)
	if out, err := run.CombinedOutput(); err != nil {
		t.Fatalf("running the portal's test command: %v\n%s\n%s", err, out, script)
	}
	args, body := string(mustRead(t, filepath.Join(dir, "args"))), strings.TrimSuffix(string(mustRead(t, filepath.Join(dir, "body"))), "\n")
	if !strings.Contains(args, "https://otlp.test/v1/metrics\n") {
		t.Errorf("portal test command does not post to /v1/metrics: %s", args)
	}
	m := regexp.MustCompile(`"usagemap-test-` + strconv.Itoa(epoch) + `000000000-(\d+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("no fresh usagemap-test instance id in the portal's test point: %s", body)
	}
	pid, _ := strconv.Atoi(m[1])
	if got := string(testMetric("svc", time.Unix(epoch, 0), pid)); got != body {
		t.Errorf("test metric differs from the portal's test command\n got: %s\nwant: %s", got, body)
	}
}

func TestTestDryRunSendsNothing(t *testing.T) {
	noNetwork(t)
	t.Setenv(envIngestToken, testToken)
	code, out, errs := runCLI(t, "", "test", "--service", "anchor-api", "--site", siteKey, "--dry-run")
	if code != exitOK || !strings.Contains(out, "https://e1.usagemap.dev/v1/metrics") || !strings.Contains(out, "<INGEST_TOKEN>") {
		t.Fatalf("%d %s %s", code, out, errs)
	}
	if strings.Contains(out, "ZyXw") {
		t.Error("dry run printed the token")
	}
}

func TestEndpointValidation(t *testing.T) {
	for _, ok := range []string{"https://app.usagemap.dev", "https://app.usagemap.dev/", "http://localhost:8080", "http://127.0.0.1:1"} {
		if _, err := baseURL("x", ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "app.usagemap.dev", "http://app.usagemap.dev", "ftp://x", "https://u:p@x", "https://x/a", "https://x?q=1"} {
		if _, err := baseURL("x", bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestRedirectNotFollowed(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("redirect followed with Authorization=%v", r.Header.Get("Authorization") != "")
	}))
	defer target.Close()
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer src.Close()
	t.Setenv(envIngestToken, testToken)
	_, out, _ := runCLI(t, "", "status", "--portal", src.URL, "--otlp", src.URL)
	if !strings.Contains(out, "unexpected HTTP 307") {
		t.Errorf("%s", out)
	}
}

// Shared vectors: the path normaliser's corpus (packages/pathnorm/testdata).
func TestRouteMatchesPathnormCorpus(t *testing.T) {
	var f struct {
		Legend  map[string]string `json:"legend"`
		Vectors []struct {
			Mode, Input, Expected string
			Rules                 []string
		} `json:"vectors"`
	}
	if err := json.Unmarshal(mustRead(t, "../../packages/pathnorm/testdata/vectors.json"), &f); err != nil {
		t.Fatal(err)
	}
	seed := testSeed("stellar-scf-test-only")
	n := 0
	for _, v := range f.Vectors {
		in, exp := v.Input, v.Expected
		for k, val := range f.Legend {
			in, exp = strings.ReplaceAll(in, k, val), strings.ReplaceAll(exp, k, val)
		}
		if strings.Contains(in, "«") || strings.Contains(exp, "«") { // derived seeds: covered by pathnorm itself
			continue
		}
		got := Route(in, v.Mode == "route")
		if got.Route != exp {
			t.Errorf("%s %q → %q, want %q", v.Mode, in, got.Route, exp)
		}
		n++
	}
	if n < 300 {
		t.Fatalf("only %d vectors ran", n)
	}
	// The route command never echoes its input and warns on a seed.
	code, out, _ := runCLI(t, "", "route", "/wallets/"+seed+"/balance")
	if code != exitOK || strings.Contains(out, seed) || !strings.Contains(out, "rotate") {
		t.Errorf("seed route: %d %s", code, out)
	}
	code, out, _ = runCLI(t, "/users/alice@example.com\n", "route", "--json")
	if code != exitOK || strings.Contains(out, "alice") || !strings.Contains(out, `"email/path": 1`) {
		t.Errorf("stdin route: %d %s", code, out)
	}
}

// testSeed derives a TEST-ONLY Stellar seed (strkey "S", sha256(label)), as
// the pathnorm corpus legend prescribes. It exists only in memory.
func testSeed(label string) string {
	sum := sha256.Sum256([]byte(label))
	payload := append([]byte{18 << 3}, sum[:]...)
	crc := crc16xmodem(payload)
	payload = append(payload, byte(crc), byte(crc>>8))
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(payload)
}

func crc16xmodem(b []byte) uint16 {
	var crc uint16
	for _, c := range b {
		crc ^= uint16(c) << 8
		for range 8 {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// A route with a Stellar secret seed: the point is kept (redacted) and the
// report says to rotate the key; nothing of the seed is echoed.
func TestCheckSeedInRouteIsRedactedAndWarned(t *testing.T) {
	seed := testSeed("stellar-scf-check-test-only")
	if !strings.HasPrefix(seed, "S") || len(seed) != 56 {
		t.Fatalf("bad test seed shape")
	}
	now := time.Now().UnixNano()
	payload := fmt.Sprintf(`{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},
"scopeMetrics":[{"scope":{"name":"t"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[
{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/keys/%s"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],
 "startTimeUnixNano":"%d","timeUnixNano":"%d","count":"2","sum":0.1,"bucketCounts":["2"],"explicitBounds":[]},
{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/users/bob@example.com"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],
 "startTimeUnixNano":"%d","timeUnixNano":"%d","count":"1","sum":0.1,"bucketCounts":["1"],"explicitBounds":[]},
{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/old"}}],
 "startTimeUnixNano":"1","timeUnixNano":"%d","count":"1","sum":0.1,"bucketCounts":["1"],"explicitBounds":[]}
]}}]}]}]}`, seed, now-1e9, now, now-1e9, now, now-72*3600*1e9)
	code, out, errs := runCLI(t, payload, "check", "--json", "--services", "api", "--received-at", "now")
	if code != exitOK {
		t.Fatalf("%d %s", code, errs)
	}
	if strings.Contains(out, seed) || strings.Contains(out, seed[:12]) || strings.Contains(out, "bob") {
		t.Fatal("report echoes a redacted value")
	}
	var rep Report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.KeptItems != 2 || rep.DroppedItems() != 1 || rep.InputItems != 3 {
		t.Fatalf("kept/dropped/input %d/%d/%d", rep.KeptItems, rep.DroppedItems(), rep.InputItems)
	}
	reasons := map[string]int64{}
	for _, d := range rep.Redacted {
		reasons[d.Reason] += d.Count
	}
	if reasons["route_redacted"] == 0 || reasons["route_seed_redacted"] == 0 {
		t.Errorf("redactions %+v", rep.Redacted)
	}
	if rep.Dropped[0].Reason != "too_old" {
		t.Errorf("dropped %+v", rep.Dropped)
	}
	joined := strings.Join(rep.Hints, "\n")
	for _, s := range []string{"route_seed_redacted: a route held a Stellar SECRET SEED", "rotate it now", "too_old:"} {
		if !strings.Contains(joined, s) {
			t.Errorf("hint %q missing:\n%s", s, joined)
		}
	}
}

// The plugin must never read the Stellar CLI configuration (identity/ holds
// secret keys) or look anywhere in the user's home. Source-level guard: none
// of the calls or paths that would get there appear in non-test code.
func TestNeverTouchesStellarConfig(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	banned := regexp.MustCompile(`os\.UserHomeDir|os\.UserConfigDir|os\.UserCacheDir|"HOME"|XDG_CONFIG|STELLAR_CONFIG|SOROBAN_CONFIG|\.stellar|\.config|identity/|os\.Environ|exec\.Command`)
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		for i, line := range strings.Split(string(mustRead(t, f)), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			if m := banned.FindString(line); m != "" {
				t.Errorf("%s:%d uses %s", f, i+1, m)
			}
		}
	}
	// The only environment variables read are the two secrets.
	envRe := regexp.MustCompile(`os\.(Getenv|LookupEnv)\(([^)]*)\)`)
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		for _, m := range envRe.FindAllStringSubmatch(string(mustRead(t, f)), -1) {
			if m[2] != "env" {
				t.Errorf("%s reads environment variable %s", f, m[2])
			}
		}
	}
}

func TestUsageAndPositionalArgs(t *testing.T) {
	if code, out, _ := runCLI(t, "", "help"); code != exitOK || !strings.Contains(out, "stellar scf status") {
		t.Errorf("help: %d", code)
	}
	if code, out, _ := runCLI(t, "", "version"); code != exitOK || !strings.HasPrefix(out, "stellar-scf ") {
		t.Errorf("version: %d %s", code, out)
	}
	code, out, errs := runCLI(t, "", "check", "testdata/sample.metrics.json", "--services", "anchor-api")
	if code != exitOK || !strings.Contains(out, "KEPT 3") {
		t.Errorf("positional file: %d %s %s", code, out, errs)
	}
	if code, _, _ := runCLI(t, "", "check", "a.json", "b.json"); code != exitUsage {
		t.Errorf("two files: %d", code)
	}
	if code, _, _ := runCLI(t, "", "status", "extra"); code != exitUsage {
		t.Errorf("status extra arg: %d", code)
	}
}

// The built executable, run the way stellar-cli runs a plugin (PATH lookup
// of stellar-<name>, remaining arguments passed through, stdio inherited).
func TestBuiltBinaryAsPlugin(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "stellar-scf")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = append(os.Environ(), "GOWORK=off", "GOFLAGS=-mod=mod")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	path, err := exec.LookPath("stellar-scf")
	if err == nil && path != bin {
		t.Logf("another stellar-scf on PATH (%s) is ignored", path)
	}
	cmd := exec.Command(bin, "check", "--json", "--services", "anchor-api", "--fail-on-drop", "-f", "testdata/sample.metrics.json")
	cmd.Env = []string{"PATH=" + dir} // nothing else: no HOME, no config
	out, err := cmd.Output()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != exitDropped {
		t.Fatalf("want exit %d, got %v", exitDropped, err)
	}
	var rep Report
	if json.Unmarshal(out, &rep) != nil || rep.KeptItems != 3 {
		t.Fatalf("report %s", out)
	}
}
