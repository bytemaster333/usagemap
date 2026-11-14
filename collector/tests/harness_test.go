// SPDX-License-Identifier: Apache-2.0
package collectortests

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/bytemaster333/usagemap/collector/tests/internal/otlpsend"
	"github.com/bytemaster333/usagemap/collector/tests/internal/pki"
	"github.com/bytemaster333/usagemap/collector/tests/internal/sink"
)

// Host ports of the Collector tests: 56160–56179. The binary tests
// use 56160–56164, the Compose tests 56170–56175.
const (
	portGRPC    = 56160
	portHTTP    = 56161
	portHealth  = 56162
	portMetrics = 56163
	portWriter  = 56164

	testTenant  = "11111111-2222-4333-8444-555555555555"
	otherTenant = "99999999-8888-4777-8666-555555555555"
)

var (
	httpBase = fmt.Sprintf("http://127.0.0.1:%d", portHTTP)
	grpcAddr = fmt.Sprintf("127.0.0.1:%d", portGRPC)
)

// itEnabled: SCF_COLLECTOR_IT=1 turns a missing binary or Docker into a failure.
func itEnabled() bool { return os.Getenv("SCF_COLLECTOR_IT") == "1" }

func skipOrFail(t *testing.T, format string, a ...any) {
	t.Helper()
	if itEnabled() {
		t.Fatalf(format, a...)
	}
	t.Skipf(format+" (set SCF_COLLECTOR_IT=1 to make this a failure)", a...)
}

// otelcolBin returns the scf-otelcol binary: $SCF_OTELCOL_BIN or collector/_build/scf-otelcol.
func otelcolBin(t *testing.T) string {
	t.Helper()
	p := os.Getenv("SCF_OTELCOL_BIN")
	if p == "" {
		p = "../_build/scf-otelcol"
	}
	abs, _ := filepath.Abs(p)
	if _, err := os.Stat(abs); err != nil {
		skipOrFail(t, "scf-otelcol binary not found at %s; run collector/scripts/build.sh", abs)
	}
	return abs
}

// lockedBuffer collects the Collector's log output.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

// collector is one scf-otelcol process.
type collector struct {
	t       *testing.T
	cmd     *exec.Cmd
	logs    *lockedBuffer
	done    chan struct{}
	exitErr error
}

// testEnv is the environment of the Collector under test.
type testEnv struct {
	pki        pki.Files
	queueDir   string
	queueBytes int64  // SCF_QUEUE_BYTES; 0 = 64 MiB
	workDir    string // the process's working directory (must stay empty)
}

func newEnv(t *testing.T) (*testEnv, *pki.CA, *pki.Leaf) {
	t.Helper()
	ca, err := pki.NewCA("scf-test-ca")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	files, srv, err := ca.WriteFiles(dir, false, "localhost", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	return &testEnv{pki: files, queueDir: filepath.Join(t.TempDir(), "queue"), workDir: t.TempDir()}, ca, srv
}

func (e *testEnv) vars() []string {
	return []string{
		"SCF_WRITER_ENDPOINT=https://localhost:" + strconv.Itoa(portWriter),
		"SCF_MTLS_CA_FILE=" + e.pki.CA,
		"SCF_MTLS_CERT_FILE=" + e.pki.ClientCert,
		"SCF_MTLS_KEY_FILE=" + e.pki.ClientKey,
		fmt.Sprintf("SCF_OTLP_GRPC_ENDPOINT=127.0.0.1:%d", portGRPC),
		fmt.Sprintf("SCF_OTLP_HTTP_ENDPOINT=127.0.0.1:%d", portHTTP),
		fmt.Sprintf("SCF_HEALTH_ENDPOINT=127.0.0.1:%d", portHealth),
		fmt.Sprintf("SCF_SELF_METRICS_PORT=%d", portMetrics),
		"SCF_QUEUE_DIR=" + e.queueDir,
		fmt.Sprintf("SCF_QUEUE_BYTES=%d", cmp.Or(e.queueBytes, 64<<20)),
		"GOMAXPROCS=4",
	}
}

func startCollector(t *testing.T, e *testEnv) *collector {
	t.Helper()
	bin := otelcolBin(t)
	for _, port := range []int{portGRPC, portHTTP, portHealth, portMetrics} {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatalf("port %d is not free (another collector still running?): %v", port, err)
		}
		l.Close()
	}
	cfg, _ := filepath.Abs(configPath)
	cmd := exec.Command(bin, "--config", cfg)
	cmd.Env = e.vars()
	cmd.Dir = e.workDir
	logs := &lockedBuffer{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	c := &collector{t: t, cmd: cmd, logs: logs, done: make(chan struct{})}
	go func() { c.exitErr = cmd.Wait(); close(c.done) }()
	t.Cleanup(c.stop)
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", portHealth))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return c
			}
		}
		select {
		case <-c.done:
			t.Fatalf("collector exited during start-up (%v):\n%s", c.exitErr, logs.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("collector not healthy after 30 s:\n%s", logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// kill9 kills the process without any chance to flush.
func (c *collector) kill9() {
	_ = c.cmd.Process.Signal(syscall.SIGKILL)
	<-c.done
}

func (c *collector) stop() {
	select {
	case <-c.done:
		return
	default:
	}
	_ = c.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-c.done:
	case <-time.After(15 * time.Second):
		c.kill9()
	}
}

// startSink starts the mutual-TLS writer stand-in on portWriter.
func startSink(t *testing.T, ca *pki.CA, srv *pki.Leaf) *sink.Sink {
	t.Helper()
	tlsCfg, err := ca.ServerTLS(srv)
	if err != nil {
		t.Fatal(err)
	}
	var l net.Listener
	for range 50 { // the port may be in TIME_WAIT from a previous sink
		if l, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", portWriter)); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	s := sink.New(tlsCfg)
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// waitFor polls cond until it is true or the timeout expires.
func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// selfMetric sums the Prometheus samples of name whose labels include want.
func selfMetric(t *testing.T, port int, name string, want map[string]string) (float64, bool) {
	t.Helper()
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/metrics", port))
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	return promSum(resp.Body, name, want)
}

var promLine = regexp.MustCompile(`^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)`)
var promLabel = regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"`)

func promSum(r io.Reader, name string, want map[string]string) (float64, bool) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var sum float64
	found := false
	for sc.Scan() {
		m := promLine.FindStringSubmatch(sc.Text())
		if m == nil || m[1] != name {
			continue
		}
		labels := map[string]string{}
		for _, l := range promLabel.FindAllStringSubmatch(m[3], -1) {
			labels[l[1]] = l[2]
		}
		ok := true
		for k, v := range want {
			if labels[k] != v {
				ok = false
			}
		}
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(m[4], 64)
		if err == nil {
			sum += v
			found = true
		}
	}
	return sum, found
}

// ---- payloads ------------------------------------------------------------

func meta(tenant string, recv time.Time) otlpsend.Meta {
	return otlpsend.Meta{Tenant: tenant, Allowed: "checkout,s06b-go-code,load", ReceivedAt: recv.UnixNano()}
}

// canaryTraces mirrors the eight spans of S-04 (README §2) with its canary
// values in resource, span attributes, events, links and span names.
func canaryTraces(now time.Time) ptrace.Traces {
	td := ptrace.NewTraces()
	res := func(service string) ptrace.SpanSlice {
		rs := td.ResourceSpans().AppendEmpty()
		_ = rs.Resource().Attributes().FromRaw(map[string]any{"service.name": service, "service.instance.id": "inst-1",
			"deployment.environment.name": "prod", "host.name": "CANARY-HOST-9b1c", "tenant.id": "FORGED-TENANT",
			"scf.tenant.id": "FORGED-TENANT", "process.command_args": []any{"node", "CANARY-ARGS"}})
		return rs.ScopeSpans().AppendEmpty().Spans()
	}
	n := 0
	add := func(spans ptrace.SpanSlice, kind ptrace.SpanKind, parent pcommon.SpanID, flags uint32, attrs map[string]any) ptrace.Span {
		n++
		sp := spans.AppendEmpty()
		sp.SetTraceID(pcommon.TraceID{0xca, 0x7a, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, byte(n)})
		sp.SetSpanID(pcommon.SpanID{0xca, 0x7a, 0, 0, 0, 0, 0, byte(n)})
		sp.SetParentSpanID(parent)
		sp.SetKind(kind)
		sp.SetFlags(flags)
		sp.SetName("GET /users/42 CANARY-NAME")
		sp.SetStartTimestamp(pcommon.NewTimestampFromTime(now.Add(-120 * time.Millisecond)))
		sp.SetEndTimestamp(pcommon.NewTimestampFromTime(now))
		sp.Status().SetMessage("CANARY-STATUS")
		_ = sp.Attributes().FromRaw(attrs)
		return sp
	}
	pii := func(m map[string]any) map[string]any {
		out := map[string]any{"client.address": "203.0.113.77", "user_agent.original": "CANARY-UA-55aa",
			"url.query": "token=CANARY-QUERY-1234", "enduser.id": "CANARY-USER"}
		maps.Copy(out, m)
		return out
	}
	local := pcommon.SpanID{0x75, 0x8d, 0x7d, 0x3f, 0x5b, 0x5e, 0x98, 0x6c}
	remote := pcommon.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7}
	none := pcommon.NewSpanIDEmpty()
	s := res("checkout")
	add(s, ptrace.SpanKindServer, local, 0x101, pii(map[string]any{"http.route": "/internal/nested", "http.request.method": "GET", "http.response.status_code": 200}))
	add(s, ptrace.SpanKindClient, local, 0x101, pii(map[string]any{"url.full": "https://horizon.example/accounts/CANARY", "http.request.method": "GET"}))
	add(s, ptrace.SpanKindInternal, local, 0x101, pii(nil))
	sp := add(s, ptrace.SpanKindServer, remote, 0x301, pii(map[string]any{"http.route": "/users/{id}", "url.path": "/users/42", "http.request.method": "GET", "http.response.status_code": 200}))
	sp.Events().AppendEmpty().SetName("CANARY-EVENT")
	sp.Links().AppendEmpty().Attributes().PutStr("x", "CANARY-LINK")
	add(s, ptrace.SpanKindServer, none, 0x101, pii(map[string]any{"url.path": "/orders/7", "http.request.method": "POST", "http.response.status_code": 500}))
	add(s, ptrace.SpanKindServer, none, 0x101, pii(nil))
	sp = add(s, ptrace.SpanKindServer, remote, 0x301, pii(map[string]any{"http.route": "/sampled", "http.request.method": "GET", "http.response.status_code": 200}))
	sp.TraceState().FromRaw("ot=th:c,vendor=CANARY-STATE")
	add(res("forbidden-svc"), ptrace.SpanKindServer, none, 0x101, map[string]any{"http.route": "/x"})
	return td
}

// onePoint builds a single-point server-duration request with route.
func onePoint(service, route string, at time.Time, extra map[string]any) pmetric.Metrics {
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	_ = r.Resource().Attributes().FromRaw(map[string]any{"service.name": service, "service.instance.id": "i-1"})
	m := r.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName("http.server.request.duration")
	m.SetUnit("s")
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	dp := h.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(at.Add(-time.Minute)))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(at))
	dp.ExplicitBounds().FromRaw([]float64{0.1, 1})
	dp.BucketCounts().FromRaw([]uint64{1, 0, 0})
	dp.SetCount(1)
	dp.SetSum(0.05)
	attrs := map[string]any{"http.route": route, "http.request.method": "GET", "http.response.status_code": 200}
	maps.Copy(attrs, extra)
	_ = dp.Attributes().FromRaw(attrs)
	return md
}

// letters turns i into a short lower-case word (stays a literal in pathnorm).
func letters(i int) string {
	var b []byte
	for {
		b = append([]byte{byte('a' + i%26)}, b...)
		i /= 26
		if i == 0 {
			return string(b)
		}
		i--
	}
}

// pointRoutes returns the scf.route of every data point of a sink record.
func pointRoutes(t *testing.T, r sink.Record) []string {
	t.Helper()
	md, err := r.Metrics()
	if err != nil {
		t.Fatalf("undecodable record: %v", err)
	}
	var out []string
	forPoints(md, func(_ pcommon.Resource, _ pmetric.Metric, attrs pcommon.Map, _ int64) {
		if v, ok := attrs.Get("scf.route"); ok {
			out = append(out, v.Str())
		}
	})
	return out
}

// forPoints calls fn for each data point with its value (count or int sum).
func forPoints(md pmetric.Metrics, fn func(res pcommon.Resource, m pmetric.Metric, attrs pcommon.Map, value int64)) {
	for _, r := range md.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				switch m.Type() {
				case pmetric.MetricTypeHistogram:
					for _, dp := range m.Histogram().DataPoints().All() {
						fn(r.Resource(), m, dp.Attributes(), int64(dp.Count()))
					}
				case pmetric.MetricTypeExponentialHistogram:
					for _, dp := range m.ExponentialHistogram().DataPoints().All() {
						fn(r.Resource(), m, dp.Attributes(), int64(dp.Count()))
					}
				case pmetric.MetricTypeSum:
					for _, dp := range m.Sum().DataPoints().All() {
						fn(r.Resource(), m, dp.Attributes(), dp.IntValue())
					}
				}
			}
		}
	}
}

// canaryRE matches every canary value the tests send in fields that must be dropped.
var canaryRE = regexp.MustCompile(`CANARY|FORGED|203\.0\.113|/users/42|horizon\.example`)

// scanDir fails if any file under dir contains a canary.
func scanDir(t *testing.T, dir string) int {
	t.Helper()
	files := 0
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		files++
		b, err := os.ReadFile(p)
		if err != nil {
			t.Errorf("read %s: %v", p, err)
			return nil
		}
		if loc := canaryRE.FindIndex(b); loc != nil {
			t.Errorf("canary %q found on disk in %s", b[loc[0]:loc[1]], p)
		}
		return nil
	})
	return files
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return c
}

func contains(s []string, sub string) bool {
	for _, x := range s {
		if strings.Contains(x, sub) {
			return true
		}
	}
	return false
}
