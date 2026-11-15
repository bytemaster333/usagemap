// SPDX-License-Identifier: Apache-2.0

package integration

// zz_: these run last — the load test leaves many rows behind and the database-loss test stops PostgreSQL.

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/obs"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

var (
	loadWriter = portBase + 9
	lossWriter = portBase + 10
)

func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func postWriter(c *http.Client, port int, body []byte) (int, error) {
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("https://127.0.0.1:%d/v1/metrics", port), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Content-Encoding", "gzip")
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// Sustained 10× the design target (S-05 load model): 300 tenants × 50 cumulative series exported every 10 s =
// 1,500 points/s in 30 requests/s of 50 points, over mutual TLS with gzip, through PgBouncer, with fsync on.
// SCF_WSD_LOAD_SECONDS sets the duration (default 60; 0 skips).
func TestSustainedTenTimesTargetLoad(t *testing.T) {
	secs := 60
	if v := os.Getenv("SCF_WSD_LOAD_SECONDS"); v != "" {
		secs, _ = strconv.Atoi(v)
	}
	if secs <= 0 {
		t.Skip("SCF_WSD_LOAD_SECONDS=0")
	}
	const tenants, series, interval = 300, 50, 10 * time.Second
	ctx := context.Background()
	rows, err := superConn(t).Query(ctx, `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by)
SELECT uuidv7(), 'load-' || g || '-' || substr(md5(random()::text), 1, 6), 'load', 'active', $1 FROM generate_series(1, $2) g
RETURNING tenant_id::text`, userID, tenants)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	p := newPKI(t)
	reg := obs.New()
	st := store.New(writerPool(t, 16), store.Options{Observer: obs.StoreObserver{R: reg},
		Logger: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))})
	w := startWriter(t, p, loadWriter, st)
	w.reg = reg
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: p.clientTLS(t, p.EdgeCert, p.EdgeKey),
		MaxIdleConnsPerHost: 64, ForceAttemptHTTP2: true}}
	start := time.Now().Add(-time.Hour)
	body := func(tenant string, round int, ts time.Time) []byte {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "load", instance: "pod-1", recv: ts})
		sm := rm.ScopeMetrics().AppendEmpty()
		sm.Scope().SetName("@opentelemetry/instrumentation-http")
		m := sm.Metrics().AppendEmpty()
		m.SetName(rules.MetricStable)
		m.SetUnit("s")
		h := m.SetEmptyHistogram()
		h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
		for s := range series {
			dp := h.DataPoints().AppendEmpty()
			dp.SetStartTimestamp(pcommonTS(start))
			dp.SetTimestamp(pcommonTS(ts))
			dp.ExplicitBounds().FromRaw(bounds15)
			c := make([]uint64, 15)
			for i := range c {
				c[i] = uint64((round + 1) * (1 + (s+i)%4))
			}
			var n uint64
			for _, x := range c {
				n += x
			}
			dp.BucketCounts().FromRaw(c)
			dp.SetCount(n)
			dp.SetSum(float64(n) * 0.08)
			_ = dp.Attributes().FromRaw(pointAttrs(fmt.Sprintf("/r%d", s%10), map[string]any{
				"http.response.status_code": int64([]int{200, 201, 404, 500, 503}[s/10])}))
		}
		b, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
		return gzipBytes(b)
	}
	// Warm-up round (first points seed state, services/groups/routes get created), not measured.
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	for _, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if code, err := postWriter(client, loadWriter, body(id, 0, time.Now())); err != nil || code != 200 {
				t.Errorf("warm-up: %d %v", code, err)
			}
		}()
	}
	wg.Wait()
	// Start the measured minute from a clean checkpoint. The test container keeps PostgreSQL's default checkpoint
	// schedule (checkpoint_timeout 5 min, as in production), and the tests before this one in the package dirty the
	// shared buffers, so otherwise a timed checkpoint can land anywhere in the measured window. On a shared runner its
	// final fsync stalled every commit for ~2 s (p99 1.8–2.2 s in three runs, p50 ≈ 40 ms); a production node checkpoints
	// on its own schedule on a premium SSD. The checkpointer statistics below show whether one still ran during the run.
	if _, err := superConn(t).Exec(ctx, "CHECKPOINT"); err != nil {
		t.Fatal(err)
	}
	ckpt := func() (n int64, writeMs, syncMs float64) {
		_ = superConn(t).QueryRow(ctx, `SELECT num_timed + num_requested, write_time, sync_time FROM pg_stat_checkpointer`).Scan(&n, &writeMs, &syncMs)
		return
	}
	ck0, cw0, cs0 := ckpt()
	rounds := max(1, int(time.Duration(secs)*time.Second/interval))
	var mu sync.Mutex
	var lat []time.Duration
	slow := map[int]int{} // second of the run → requests slower than 500 ms that started in it
	var failures atomic.Int64
	t0 := time.Now()
	for r := 1; r <= rounds; r++ {
		roundStart := t0.Add(time.Duration(r-1) * interval)
		for i, id := range ids {
			at := roundStart.Add(time.Duration(i) * interval / tenants) // paced: one request every 33 ms
			time.Sleep(time.Until(at))
			b := body(id, r, at)
			wg.Add(1)
			go func() {
				defer wg.Done()
				s := time.Now()
				code, err := postWriter(client, loadWriter, b)
				d := time.Since(s)
				if err != nil || code != 200 {
					failures.Add(1)
				}
				mu.Lock()
				lat = append(lat, d)
				if d > 500*time.Millisecond {
					slow[int(s.Sub(t0).Seconds())]++
				}
				mu.Unlock()
			}()
		}
	}
	wg.Wait()
	elapsed := time.Since(t0)
	slices.Sort(lat)
	q := func(p float64) time.Duration { return lat[int(math.Ceil(p*float64(len(lat))))-1] }
	points := float64(len(lat) * series)
	rate := points / elapsed.Seconds()
	t.Logf("10× load: %d requests (%d points) in %.1f s = %.0f points/s, %.1f tenant transactions/s; latency p50 %v p95 %v p99 %v max %v; failures %d",
		len(lat), int(points), elapsed.Seconds(), rate, float64(len(lat))/elapsed.Seconds(), q(0.5).Round(time.Millisecond),
		q(0.95).Round(time.Millisecond), q(0.99).Round(time.Millisecond), lat[len(lat)-1].Round(time.Millisecond), failures.Load())
	ck1, cw1, cs1 := ckpt()
	t.Logf("checkpoints during the run: %d (write %.0f ms, sync %.0f ms); seconds with requests slower than 500 ms: %v",
		ck1-ck0, cw1-cw0, cs1-cs0, slow)
	t.Logf("writer counters: committed %v, write_error %v, unavailable %v, retried %v", w.reg.Get(obs.TxTotal, "outcome", "committed"),
		w.reg.Get(obs.TxTotal, "outcome", "write_error"), w.reg.Get(obs.TxTotal, "outcome", "unavailable"), w.reg.Get(obs.TxTotal, "outcome", "retried"))
	if failures.Load() != 0 {
		t.Fatalf("%d requests failed", failures.Load())
	}
	if rate < 1500*0.95 {
		t.Fatalf("sustained %.0f points/s, below the 10× target of 1,500", rate)
	}
	if q(0.99) > time.Second {
		t.Fatalf("p99 %v above 1 s", q(0.99))
	}
	var stored int64
	_ = superConn(t).QueryRow(ctx, `SELECT COALESCE(sum(request_count), 0)::bigint FROM scf.api_metrics_1d WHERE tenant_id = ANY($1::uuid[])`, ids).Scan(&stored)
	if stored == 0 {
		t.Fatal("nothing stored")
	}
}

// Losing PostgreSQL closes the writer's listener (connection refused, so the Collector's dialer moves to the other
// writer) and the listener reopens when the database is back (C-107, wire-formats §g.1). Real database, real stop.
func TestZZDatabaseLossClosesListener(t *testing.T) {
	p := newPKI(t)
	st := store.New(writerPool(t, 4), store.Options{TxTimeout: 5 * time.Second})
	w := startWriter(t, p, lossWriter, st)
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: p.clientTLS(t, p.EdgeCert, p.EdgeKey)}}
	tenant := newTenant(t)
	mk := func() []byte {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "loss", recv: time.Now()})
		explicit(rm, "s", rules.MetricStable, false, time.Now(), time.Now(), bounds15,
			[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, pointAttrs("/a", nil))
		b, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
		return gzipBytes(b)
	}
	if code, err := postWriter(client, lossWriter, mk()); err != nil || code != 200 {
		t.Fatalf("before: %d %v", code, err)
	}
	superPool.Reset()
	if out, err := compose("stop", "pg"); err != nil {
		t.Fatalf("stop pg: %v\n%s", err, out)
	}
	restarted := false
	t.Cleanup(func() {
		if !restarted {
			_, _ = compose("start", "pg")
		}
	})
	// A request now gets 503 (+ Retry-After) or finds the listener already closed; either way, within seconds the
	// port refuses connections.
	if code, err := postWriter(client, lossWriter, mk()); err == nil && code != 503 {
		t.Fatalf("with the database down: %d", code)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", lossWriter), 200*time.Millisecond)
		if err != nil {
			break
		}
		c.Close()
		if time.Now().After(deadline) {
			t.Fatal("listener still open with PostgreSQL stopped")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if w.reg.Get(obs.ListenerOpen) != 0 || w.reg.Get(obs.DBUp) != 0 {
		t.Fatal("gauges do not show the outage")
	}
	reopened := w.srv.WaitOpen()
	if out, err := compose("start", "pg"); err != nil {
		t.Fatalf("start pg: %v\n%s", err, out)
	}
	restarted = true
	select {
	case <-reopened:
	case <-time.After(60 * time.Second):
		t.Fatal("listener not reopened after PostgreSQL came back")
	}
	client2 := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: p.clientTLS(t, p.EdgeCert, p.EdgeKey)}}
	var code int
	var err error
	for range 20 { // PgBouncer may need a moment to log in again
		if code, err = postWriter(client2, lossWriter, mk()); err == nil && code == 200 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if code != 200 {
		t.Fatalf("after recovery: %d %v", code, err)
	}
}

func pcommonTS(t time.Time) pcommon.Timestamp { return pcommon.NewTimestampFromTime(t) }
