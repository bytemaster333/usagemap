// SPDX-License-Identifier: Apache-2.0

// Package probes is the probe runner of one probe source (`mon-c`, `probe-d`, or an edge node's cross-provider
// prober; C-30, C-78, wire-formats §o). Every 30 s, aligned to the wall clock so that all sources probe the same
// round, it runs — concurrently — the availability round (hostname A, then B on failure, good when a 202 arrives
// within 2 s), the first attempt per hostname, a direct attempt per edge node and, when configured, an OTLP/HTTP
// export; every 60 s the signed-in dashboard journey (C-93). Canary events go through the gateway's own probe client
// (`services/gateway/pkg/probe`), which behaves like the pinned tracker. Each result is appended to the raw store and
// exported to Prometheus. A failing self-check makes the source abstain (it does not vote).
package probes

import (
	"bytes"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/journey"
	"github.com/bytemaster333/usagemap/ops/internal/metrics"
	"github.com/bytemaster333/usagemap/ops/internal/store"
	"github.com/bytemaster333/usagemap/services/gateway/pkg/probe"
)

// Config of a source.
type Config struct {
	Source         string
	Hosts          map[string]string // "host-a" → https://ingest.domain-a (the order host-a, host-b is the tracker's)
	Nodes          map[string]string // node id → https://edge-a1.domain-a (the node's own origin, bypassing DNS)
	SiteKey        string
	Origin         string
	TrackerVersion string
	Deadline       time.Duration // 2 s (C-78)
	Interval       time.Duration // 30 s
	JourneyEvery   time.Duration // 60 s (C-93)
	SelfCheckURL   string        // e.g. this host's resolver or a reference endpoint; empty = always voting
	OTLPURL        string        // https://ingest.domain-a/v1/metrics, empty = no OTLP probe
	OTLPToken      string
	// TrackerAPI: the control plane's public origin; when set, every TrackerEvery each ingest hostname's
	// /lib/<TrackerVersion>/<profile>.js must hash to the integrity the API publishes (GET /v1/tracker/versions).
	TrackerAPI   string
	TrackerEvery time.Duration
	Journey      *journey.Config
	IngestClient *http.Client
}

// Runner runs rounds.
type Runner struct {
	Cfg     Config
	Store   *store.Writer
	Metrics *metrics.Registry
	Log     *slog.Logger
	Now     func() time.Time
}

// Describe registers the metric families.
func Describe(m *metrics.Registry) {
	m.Describe("scf_probe_canary_accepted_total", "counter", "Canary events answered 202 (wire-formats §o; durability_reconcile reads the hourly increase).")
	m.Describe("scf_probe_results_total", "counter", "Probe results by kind, target and outcome (good, bad, abstain).")
	m.Describe("scf_probe_last_bad", "gauge", "Last result per kind and target: 1 bad, 0 good; absent while abstaining.")
	m.Describe("scf_probe_last_timestamp_seconds", "gauge", "Round start of the last voting result per kind and target (unix seconds).")
	m.Describe("scf_probe_last_latency_seconds", "gauge", "Latency of the last result per kind and target.")
	m.Describe("scf_probe_self_check_ok", "gauge", "1 when the source's own self-check passed (the source votes).")
	m.Describe("scf_probe_store_errors_total", "counter", "Raw-store append failures.")
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Run loops until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	iv := r.Cfg.Interval
	for {
		now := r.now()
		next := now.Truncate(iv).Add(iv)
		t := time.NewTimer(next.Sub(now))
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		r.Round(ctx, next)
	}
}

type target struct{ kind, name, url string }

func (r *Runner) selfCheck(ctx context.Context) bool {
	if r.Cfg.SelfCheckURL == "" {
		return true
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.Cfg.SelfCheckURL, nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 500
}

func (r *Runner) path(suffix string) string { return "/canary/" + r.Cfg.Source + "/" + suffix }

func (r *Runner) base() probe.Config {
	return probe.Config{SiteKey: r.Cfg.SiteKey, Origin: r.Cfg.Origin, TrackerVersion: r.Cfg.TrackerVersion, Client: r.Cfg.IngestClient}
}

// Round runs one round that starts at start (aligned).
func (r *Runner) Round(ctx context.Context, start time.Time) []store.Row {
	vote := r.selfCheck(ctx)
	r.Metrics.Set("scf_probe_self_check_ok", b2f(vote), "source", r.Cfg.Source)
	var (
		mu   sync.Mutex
		rows []store.Row
		wg   sync.WaitGroup
	)
	add := func(kind, tgt, path string, ok bool, status int, lat time.Duration) {
		o := store.Good
		if !ok {
			o = store.Bad
		}
		if !vote {
			o = store.Abstain
		}
		row := store.Row{RoundStart: start.UTC(), Source: r.Cfg.Source, Kind: kind, Target: tgt, Outcome: o, Status: status,
			LatencyMS: lat.Milliseconds()}
		mu.Lock()
		rows = append(rows, row)
		mu.Unlock()
		r.Metrics.Add("scf_probe_results_total", 1, "source", r.Cfg.Source, "kind", kind, "target", tgt, "outcome", o)
		if ok && path != "" {
			r.Metrics.Add("scf_probe_canary_accepted_total", 1, "source", r.Cfg.Source, "path", path)
		}
		if vote {
			r.Metrics.Set("scf_probe_last_bad", b2f(!ok), "source", r.Cfg.Source, "kind", kind, "target", tgt)
			r.Metrics.Set("scf_probe_last_timestamp_seconds", float64(start.Unix()), "source", r.Cfg.Source, "kind", kind, "target", tgt)
			r.Metrics.Set("scf_probe_last_latency_seconds", lat.Seconds(), "source", r.Cfg.Source, "kind", kind, "target", tgt)
		}
	}
	hostNames := sortedKeys(r.Cfg.Hosts)
	if len(hostNames) > 0 {
		wg.Add(1)
		go func() { // availability round, the SLI
			defer wg.Done()
			c := r.base()
			c.Path = r.path("round")
			var hosts []string
			for _, h := range hostNames {
				hosts = append(hosts, r.Cfg.Hosts[h])
			}
			t0 := time.Now()
			res, _, ok := probe.Round(ctx, c, hosts, r.Cfg.Deadline)
			add(store.KindRound, "ingest", c.Path, ok, res.Status, time.Since(t0))
		}()
	}
	var single []target
	for _, h := range hostNames {
		single = append(single, target{store.KindHost, h, r.Cfg.Hosts[h]})
	}
	for _, n := range sortedKeys(r.Cfg.Nodes) {
		single = append(single, target{store.KindNode, n, r.Cfg.Nodes[n]})
	}
	for _, tg := range single {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := r.base()
			c.Target = strings.TrimRight(tg.url, "/")
			c.Path = r.path(tg.name)
			pctx, cancel := context.WithTimeout(ctx, r.Cfg.Deadline)
			defer cancel()
			t0 := time.Now()
			res, err := probe.Send(pctx, c)
			add(tg.kind, tg.name, c.Path, err == nil && res.OK() && time.Since(t0) <= r.Cfg.Deadline, res.Status, time.Since(t0))
		}()
	}
	if r.Cfg.OTLPURL != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			t0 := time.Now()
			st, ok := r.otlp(ctx, start)
			add(store.KindOTLP, "otlp-http", "", ok, st, time.Since(t0))
		}()
	}
	if r.Cfg.TrackerAPI != "" && r.Cfg.TrackerEvery > 0 && start.UnixNano()%int64(r.Cfg.TrackerEvery) == 0 {
		for _, h := range hostNames {
			wg.Add(1)
			go func() {
				defer wg.Done()
				t0 := time.Now()
				st, ok := r.trackerFiles(ctx, r.Cfg.Hosts[h])
				add(store.KindTracker, h, "", ok, st, time.Since(t0))
			}()
		}
	}
	if r.Cfg.Journey != nil && r.Cfg.JourneyEvery > 0 && start.UnixNano()%int64(r.Cfg.JourneyEvery) == 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := journey.Run(ctx, *r.Cfg.Journey)
			add(store.KindJourney, "dashboard", "", res.OK, res.Status, res.Elapsed)
			if !res.OK {
				r.log().Info("journey failed", "source", r.Cfg.Source, "step", res.Step, "status", res.Status)
			}
		}()
	}
	wg.Wait()
	sort.Slice(rows, func(i, j int) bool { return rows[i].Kind+rows[i].Target < rows[j].Kind+rows[j].Target })
	if r.Store != nil {
		if err := r.Store.Append(rows...); err != nil {
			r.Metrics.Add("scf_probe_store_errors_total", 1, "source", r.Cfg.Source)
			r.log().Error("raw store append failed", "source", r.Cfg.Source)
		}
	}
	return rows
}

func (r *Runner) log() *slog.Logger {
	if r.Log != nil {
		return r.Log
	}
	return slog.Default()
}

// trackerFiles checks that host serves every profile file of the probe's tracker version with exactly the SRI hash the
// control plane publishes for it — the bytes pages pin (C-100, tracker.intentional-upgrade). Status: the first non-200, or 200.
func (r *Runner) trackerFiles(ctx context.Context, host string) (int, bool) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	get := func(u string) (int, []byte, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return 0, nil, err
		}
		c := r.Cfg.IngestClient
		if c == nil {
			c = http.DefaultClient
		}
		resp, err := c.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return resp.StatusCode, b, err
	}
	st, b, err := get(strings.TrimRight(r.Cfg.TrackerAPI, "/") + "/v1/tracker/versions")
	if err != nil || st != http.StatusOK {
		return st, false
	}
	var versions []struct {
		Version string `json:"version"`
		Files   []struct {
			Profile   string `json:"profile"`
			Integrity string `json:"integrity"`
		} `json:"files"`
	}
	if json.Unmarshal(b, &versions) != nil {
		return st, false
	}
	n := 0
	for _, v := range versions {
		if v.Version != r.Cfg.TrackerVersion {
			continue
		}
		for _, f := range v.Files {
			st, body, err := get(fmt.Sprintf("%s/lib/%s/%s.js", strings.TrimRight(host, "/"), v.Version, f.Profile))
			if err != nil || st != http.StatusOK {
				return st, false
			}
			sum := sha512.Sum384(body)
			if "sha384-"+base64.StdEncoding.EncodeToString(sum[:]) != f.Integrity {
				return st, false
			}
			n++
		}
	}
	return http.StatusOK, n > 0
}

// otlp sends one small OTLP/HTTP JSON metrics export (a gauge named scf.probe.canary) with the probe tenant's token.
func (r *Runner) otlp(ctx context.Context, start time.Time) (int, bool) {
	ctx, cancel := context.WithTimeout(ctx, r.Cfg.Deadline)
	defer cancel()
	ns := start.UnixNano()
	body := fmt.Sprintf(`{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"scf-probe"}}]},`+
		`"scopeMetrics":[{"scope":{"name":"scf-probe"},"metrics":[{"name":"http.server.request.duration","unit":"s",`+
		`"histogram":{"aggregationTemporality":2,"dataPoints":[{"startTimeUnixNano":"%d","timeUnixNano":"%d","count":"1","sum":0.01,`+
		`"bucketCounts":["1","0"],"explicitBounds":[0.1],"attributes":[{"key":"http.route","value":{"stringValue":"/canary/%s"}},`+
		`{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.response.status_code","value":{"intValue":"200"}}]}]}}]}]}]}`,
		ns-int64(time.Second), ns, r.Cfg.Source)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.Cfg.OTLPURL, bytes.NewReader([]byte(body)))
	if err != nil {
		return 0, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.Cfg.OTLPToken)
	client := r.Cfg.IngestClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	resp.Body.Close()
	return resp.StatusCode, resp.StatusCode == http.StatusOK
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
