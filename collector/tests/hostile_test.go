// SPDX-License-Identifier: Apache-2.0
package collectortests

import (
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/collector/tests/internal/otlpsend"
)

// expRequest is one ~200-byte request with two exponential-histogram points
// of one stream that collapse to one attribute set after sanitising (they
// differ only in server.address), as in the G1 review (finding 2).
func expRequest(at time.Time, a, b [2]int32) pmetric.Metrics {
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.Resource().Attributes().PutStr("service.name", "checkout")
	m := r.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName("http.server.request.duration")
	m.SetUnit("s")
	h := m.SetEmptyExponentialHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	for i, p := range [][2]int32{a, b} {
		dp := h.DataPoints().AppendEmpty()
		dp.SetScale(p[0])
		dp.Positive().SetOffset(p[1])
		dp.Positive().BucketCounts().FromRaw([]uint64{1})
		dp.SetCount(1)
		dp.SetStartTimestamp(pcommon.Timestamp(at.Add(-time.Minute).UnixNano()))
		dp.SetTimestamp(pcommon.Timestamp(at.UnixNano()))
		dp.Attributes().PutStr("http.route", "/h")
		dp.Attributes().PutStr("server.address", fmt.Sprintf("h%d", i))
	}
	return md
}

// peakRSS reads the process's peak resident set size (Linux).
func peakRSS(t *testing.T, pid int) int64 {
	t.Helper()
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Fatalf("read /proc status: %v", err)
	}
	for line := range strings.SplitSeq(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "VmHWM:"); ok {
			kb, _ := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(v), " kB"), 10, 64)
			return kb << 10
		}
	}
	t.Fatal("no VmHWM")
	return 0
}

// TestHostileExpHistogramsOverGRPCAndHTTP sends the review's hostile
// exponential histograms to the built binary over both protocols: the
// process must neither panic nor balloon (peak RSS stays below the 400 MiB
// memory_limiter budget), the malformed points are counted, and a normal
// request still goes through afterwards (C-114).
func TestHostileExpHistogramsOverGRPCAndHTTP(t *testing.T) {
	env, ca, srv := newEnv(t)
	s := startSink(t, ca, srv)
	c := startCollector(t, env)
	now := time.Now()
	cases := []struct {
		name string
		a, b [2]int32 // {scale, offset}
	}{
		{"offsets 0 and 1<<25 at scale 0", [2]int32{0, 0}, [2]int32{0, 1 << 25}},
		{"offsets 0 and 1<<25 at scale 20", [2]int32{20, 0}, [2]int32{20, 1 << 25}},
		{"offsets 0 and 1<<30", [2]int32{0, 0}, [2]int32{0, 1 << 30}},
		{"MinInt32 and MaxInt32", [2]int32{0, math.MinInt32}, [2]int32{0, math.MaxInt32}},
		{"scale -1 against MaxInt32", [2]int32{-1, 0}, [2]int32{0, math.MaxInt32}},
		{"scale 20 against scale -10 at the extremes", [2]int32{20, -1075 << 20}, [2]int32{-10, 1}},
	}
	g, err := otlpsend.DialGRPC(grpcAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	for _, tc := range cases {
		md := expRequest(now, tc.a, tc.b)
		if err := otlpsend.HTTPMetrics(ctx(t), httpBase, md, meta(testTenant, now)); err != nil {
			t.Fatalf("%s over HTTP: %v\n%s", tc.name, err, c.logs.String())
		}
		if err := g.Metrics(ctx(t), md, meta(testTenant, now)); err != nil {
			t.Fatalf("%s over gRPC: %v\n%s", tc.name, err, c.logs.String())
		}
		select {
		case <-c.done:
			t.Fatalf("%s: collector died (%v):\n%s", tc.name, c.exitErr, c.logs.String())
		default:
		}
	}
	// 6 cases × 2 protocols; malformed per case: 1, 0, 1, 2, 1, 0 = 5 → 10.
	var malformed float64
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		malformed, _ = selfMetric(t, portMetrics, "otelcol_processor_scfsanitize_dropped", map[string]string{"reason": "malformed_point"})
		if malformed >= 10 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	rss := peakRSS(t, c.cmd.Process.Pid)
	t.Logf("malformed_point %v, peak RSS %d MiB", malformed, rss>>20)
	if malformed != 10 {
		t.Errorf("malformed_point = %v, want 10", malformed)
	}
	if rss > 400<<20 {
		t.Errorf("peak RSS %d MiB", rss>>20)
	}
	if strings.Contains(c.logs.String(), "panic") {
		i := strings.Index(c.logs.String(), "panic")
		t.Fatalf("panic in the log: …%s…", c.logs.String()[i:min(len(c.logs.String()), i+600)])
	}
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", portHealth))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("health after hostile input: %v %v", resp, err)
	}
	resp.Body.Close()
	s.Reset()
	if err := otlpsend.HTTPMetrics(ctx(t), httpBase, onePoint("checkout", "/after", now, nil), meta(testTenant, now)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 20*time.Second, "normal request after hostile ones", func() bool {
		for _, r := range s.Records() {
			for _, route := range pointRoutes(t, r) {
				if route == "/after" {
					return true
				}
			}
		}
		return false
	})
}

// TestQueueBoundedInBytes: the persistent queue is bounded in bytes (C-114):
// with no writer and SCF_QUEUE_BYTES = 16 KiB, requests are refused (503,
// which the gateway passes on) once the queue holds 16 KiB, and the queue
// never exceeds the bound.
func TestQueueBoundedInBytes(t *testing.T) {
	env, _, _ := newEnv(t)
	env.queueBytes = 16 << 10
	startCollector(t, env)
	now := time.Now()
	refused := -1
	for i := range 2000 {
		md := onePoint("load", "/b/"+letters(i), now, nil)
		if err := otlpsend.HTTPMetrics(ctx(t), httpBase, md, meta(testTenant, now)); err != nil {
			if !strings.Contains(err.Error(), "503") {
				t.Fatalf("request %d: %v", i, err)
			}
			refused = i
			break
		}
	}
	if refused < 0 {
		t.Fatal("2000 requests accepted: the queue has no byte bound")
	}
	q, _ := selfMetric(t, portMetrics, "otelcol_exporter_queue_size", nil)
	c, _ := selfMetric(t, portMetrics, "otelcol_exporter_queue_capacity", nil)
	t.Logf("first refusal at request %d; queue %v of %v bytes", refused, q, c)
	if c != 16<<10 || q > c || q == 0 {
		t.Fatalf("queue %v, capacity %v", q, c)
	}
}
