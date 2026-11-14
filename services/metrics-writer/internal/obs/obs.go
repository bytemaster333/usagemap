// SPDX-License-Identifier: Apache-2.0

// Package obs is the writer's Prometheus registry (text format 0.0.4, stdlib only). Label values come from closed
// sets (outcomes, reasons, HTTP codes); no tenant id, service name, route, address or header is ever a label.
package obs

import (
	"fmt"
	"io"
	"math"
	"slices"
	"strings"
	"sync"
	"time"
)

var buckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10}

type histogram struct {
	counts []uint64
	sum    float64
	n      uint64
}

// Registry holds counters, gauges and histograms.
type Registry struct {
	mu       sync.Mutex
	help     map[string]string
	kinds    map[string]string
	counters map[string]map[string]float64
	gauges   map[string]map[string]float64
	hists    map[string]map[string]*histogram
}

// Metric names.
const (
	Requests       = "scf_writer_requests_total"
	RequestSeconds = "scf_writer_request_duration_seconds"
	TxTotal        = "scf_writer_tenant_transactions_total"
	TxSeconds      = "scf_writer_tenant_transaction_duration_seconds"
	PointsTotal    = "scf_writer_points_total"
	Dropped        = "scf_ingest_dropped" // the writer's own data-quality counts, by reason (also in api_ingest_counters)
	ListenerOpen   = "scf_writer_listener_open"
	DBUp           = "scf_writer_database_up"
	ListenerCycles = "scf_writer_listener_transitions_total"
	TLSErrors      = "scf_writer_tls_handshake_errors_total"
	BuildInfo      = "scf_writer_build_info"
)

// New returns a registry with the writer's metric families declared.
func New() *Registry {
	r := &Registry{help: map[string]string{}, kinds: map[string]string{}, counters: map[string]map[string]float64{},
		gauges: map[string]map[string]float64{}, hists: map[string]map[string]*histogram{}}
	r.declare(Requests, "counter", "OTLP requests by HTTP status code.")
	r.declare(RequestSeconds, "histogram", "OTLP request duration (decode, all tenant transactions, response).")
	r.declare(TxTotal, "counter", "Tenant transactions by outcome (committed, duplicate, tenant_gone, write_error, poison, unavailable, busy, timeout, retried).")
	r.declare(TxSeconds, "histogram", "Tenant transaction duration by result.")
	r.declare(PointsTotal, "counter", "Data points by outcome (received, no_tenant, applied, seeded, stale, zero_delta, tenant_gone).")
	r.declare(Dropped, "counter", "Data points the writer dropped or flagged, by data-quality reason (wire-formats h.3).")
	r.declare(ListenerOpen, "gauge", "1 while the OTLP listener accepts connections (closed while the database is unreachable).")
	r.declare(DBUp, "gauge", "1 while the last database probe succeeded.")
	r.declare(ListenerCycles, "counter", "Listener transitions (opened, closed).")
	r.declare(TLSErrors, "counter", "TLS handshake failures on the OTLP listener (peer addresses are never logged).")
	r.declare(BuildInfo, "gauge", "Build information.")
	return r
}

func (r *Registry) declare(name, kind, help string) { r.help[name], r.kinds[name] = help, kind }

func labels(kv ...string) string {
	var b strings.Builder
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%s=%q", kv[i], kv[i+1])
	}
	return b.String()
}

// Add increments a counter.
func (r *Registry) Add(name string, v float64, kv ...string) {
	l := labels(kv...)
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.counters[name]
	if m == nil {
		m = map[string]float64{}
		r.counters[name] = m
	}
	m[l] += v
}

// Set sets a gauge.
func (r *Registry) Set(name string, v float64, kv ...string) {
	l := labels(kv...)
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.gauges[name]
	if m == nil {
		m = map[string]float64{}
		r.gauges[name] = m
	}
	m[l] = v
}

// Observe records a duration in a histogram.
func (r *Registry) Observe(name string, d time.Duration, kv ...string) {
	l := labels(kv...)
	s := d.Seconds()
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.hists[name]
	if m == nil {
		m = map[string]*histogram{}
		r.hists[name] = m
	}
	h := m[l]
	if h == nil {
		h = &histogram{counts: make([]uint64, len(buckets))}
		m[l] = h
	}
	for i, b := range buckets {
		if s <= b {
			h.counts[i]++
		}
	}
	h.sum += s
	h.n++
}

// Get returns a counter or gauge value (tests).
func (r *Registry) Get(name string, kv ...string) float64 {
	l := labels(kv...)
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.counters[name]; ok {
		return m[l]
	}
	return r.gauges[name][l]
}

// WriteTo renders the registry in the Prometheus text format.
func (r *Registry) WriteTo(w io.Writer) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var b strings.Builder
	names := make([]string, 0, len(r.help))
	for n := range r.help {
		names = append(names, n)
	}
	slices.Sort(names)
	for _, n := range names {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", n, r.help[n], n, r.kinds[n])
		switch r.kinds[n] {
		case "counter":
			writeSeries(&b, n, r.counters[n])
		case "gauge":
			writeSeries(&b, n, r.gauges[n])
		case "histogram":
			ls := make([]string, 0, len(r.hists[n]))
			for l := range r.hists[n] {
				ls = append(ls, l)
			}
			slices.Sort(ls)
			for _, l := range ls {
				h := r.hists[n][l]
				sep := ""
				if l != "" {
					sep = ","
				}
				for i, bound := range buckets {
					fmt.Fprintf(&b, "%s_bucket{%s%sle=\"%g\"} %d\n", n, l, sep, bound, h.counts[i])
				}
				fmt.Fprintf(&b, "%s_bucket{%s%sle=\"+Inf\"} %d\n", n, l, sep, h.n)
				fmt.Fprintf(&b, "%s_sum%s %g\n%s_count%s %d\n", n, braces(l), h.sum, n, braces(l), h.n)
			}
		}
	}
	k, err := io.WriteString(w, b.String())
	return int64(k), err
}

func braces(l string) string {
	if l == "" {
		return ""
	}
	return "{" + l + "}"
}

func writeSeries(b *strings.Builder, n string, m map[string]float64) {
	ls := make([]string, 0, len(m))
	for l := range m {
		ls = append(ls, l)
	}
	slices.Sort(ls)
	for _, l := range ls {
		v := m[l]
		s := fmt.Sprintf("%g", v)
		if v == math.Trunc(v) && math.Abs(v) < 1e15 {
			s = fmt.Sprintf("%d", int64(v))
		}
		fmt.Fprintf(b, "%s%s %s\n", n, braces(l), s)
	}
}

// StoreObserver adapts the registry to store.Observer.
type StoreObserver struct{ R *Registry }

func (o StoreObserver) Outcome(outcome string)        { o.R.Add(TxTotal, 1, "outcome", outcome) }
func (o StoreObserver) Reason(reason string, n int64) { o.R.Add(Dropped, float64(n), "reason", reason) }
func (o StoreObserver) Points(outcome string, n int64) {
	o.R.Add(PointsTotal, float64(n), "outcome", outcome)
}
func (o StoreObserver) TxSeconds(d time.Duration, result string) {
	o.R.Observe(TxSeconds, d, "result", result)
}
