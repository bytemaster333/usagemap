// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/dedup"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/visit"
)

// Metrics is a small Prometheus text-format registry (stdlib only). Label values come from closed sets (roles, route
// templates, reasons, node names from certificates); no key, token, surrogate, path or query is ever a label.
type Metrics struct {
	mu       sync.Mutex
	counters map[string]map[string]float64 // name -> rendered label set -> value
	help     map[string]string
	dedup    atomic.Pointer[dedup.Memory]
}

// WithDedup adds the event-key memory's gauges to /metrics.
func (m *Metrics) WithDedup(d *dedup.Memory) *Metrics { m.dedup.Store(d); return m }

// NewMetrics returns an empty registry.
func NewMetrics() *Metrics {
	return &Metrics{counters: map[string]map[string]float64{}, help: map[string]string{
		"scf_engine_proxy_requests_total":             "Requests by caller role, route template and HTTP status.",
		"scf_engine_proxy_request_duration_seconds":   "Total request duration by route template (sum and count).",
		"scf_engine_proxy_denials_total":              "Refused callers by node, role and reason (deny_list, not_allowed, bad_query, bad_path, gate_closed, bad_certificate).",
		"scf_engine_proxy_send_rejected_total":        "POST /api/send answered 400 by the proxy itself, by reason.",
		"scf_engine_proxy_send_visit_total":           "Visit-token decision per forwarded identified event (hit = token replayed).",
		"scf_engine_proxy_upstream_errors_total":      "Transport errors talking to upstreams, by upstream and kind.",
		"scf_engine_proxy_token_purge_requests_total": "Visit-token purge requests (DELETE /internal/v1/visit-tokens/websites/{id}) and P9 purges.",
	}}
}

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
func (m *Metrics) Add(name string, v float64, kv ...string) {
	l := labels(kv...)
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.counters[name]
	if c == nil {
		c = map[string]float64{}
		m.counters[name] = c
	}
	c[l] += v
}

// Get returns a counter value (tests).
func (m *Metrics) Get(name string, kv ...string) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.counters[name][labels(kv...)]
}

func (m *Metrics) observe(route string, d time.Duration) {
	m.Add("scf_engine_proxy_request_duration_seconds_sum", d.Seconds(), "route", route)
	m.Add("scf_engine_proxy_request_duration_seconds_count", 1, "route", route)
}

func writeSample(w io.Writer, name, l string, v float64) {
	if l == "" {
		fmt.Fprintf(w, "%s %g\n", name, v)
		return
	}
	fmt.Fprintf(w, "%s{%s} %g\n", name, l, v)
}

// Handler renders the registry plus the visit-store and gate state.
func (m *Metrics) Handler(store *visit.Store, gate *Gate) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		m.mu.Lock()
		names := make([]string, 0, len(m.counters))
		for n := range m.counters {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			base := strings.TrimSuffix(strings.TrimSuffix(n, "_sum"), "_count")
			kind := "counter"
			if base != n {
				kind = "summary"
			}
			if h, ok := m.help[base]; ok && (kind == "counter" || strings.HasSuffix(n, "_sum")) {
				fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", base, h, base, kind)
			}
			ls := make([]string, 0, len(m.counters[n]))
			for l := range m.counters[n] {
				ls = append(ls, l)
			}
			sort.Strings(ls)
			for _, l := range ls {
				writeSample(w, n, l, m.counters[n][l])
			}
		}
		m.mu.Unlock()

		st := store.Stats()
		gauge := func(name, help string, v float64) {
			fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %g\n", name, help, name, name, v)
		}
		counter := func(name, help string, v uint64) {
			fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, v)
		}
		gauge("scf_engine_proxy_visit_tokens", "Entries in the visit-token memory.", float64(st.Size))
		if d := m.dedup.Load(); d != nil {
			size, evicted, _ := d.Stats()
			gauge("scf_engine_proxy_event_keys", "Event keys in the de-duplication memory.", float64(size))
			counter("scf_engine_proxy_event_key_evictions_total", "Event keys evicted before their window ended.", uint64(evicted))
		}
		gauge("scf_engine_proxy_deleted_websites", "Website ids on the 72-hour deleted list.", float64(st.DeletedWebsites))
		counter("scf_engine_proxy_visit_lookup_hits_total", "Lookups that replayed a token.", st.Hits)
		counter("scf_engine_proxy_visit_lookup_misses_total", "Lookups without an entry.", st.Misses)
		counter("scf_engine_proxy_visit_replays_refused_total", "Replays refused by the 30-minute rule on event timestamps.", st.RefusedWindow)
		counter("scf_engine_proxy_visit_lookup_deleted_total", "Lookups for a website on the deleted list.", st.DeletedLookups)
		counter("scf_engine_proxy_visit_stored_total", "Tokens stored from Umami answers.", st.Stored)
		counter("scf_engine_proxy_visit_store_skipped_backlog_total", "Answers to long-delayed backlog events whose token was not stored.", st.SkippedBacklog)
		counter("scf_engine_proxy_visit_store_skipped_deleted_total", "Answers for deleted websites whose token was not stored.", st.SkippedDeleted)
		counter("scf_engine_proxy_visit_store_rejected_total", "Unusable tokens (empty, oversized, bad surrogate).", st.Rejected)
		counter("scf_engine_proxy_visit_evictions_total", "LRU evictions at the entry bound.", st.Evictions)
		counter("scf_engine_proxy_visit_expired_total", "Entries dropped by the idle TTL.", st.Expired)
		counter("scf_engine_proxy_visit_purges_total", "Website purges.", st.Purges)
		counter("scf_engine_proxy_visit_purged_entries_total", "Entries dropped by website purges.", st.PurgedEntries)
		counter("scf_engine_proxy_visit_daily_resets_total", "Resets at 00:00 UTC.", st.DailyResets)
		open := 0.0
		if gate.IsOpen() {
			open = 1
		}
		gauge("scf_engine_proxy_bootstrap_gate_open", "1 once a B5 check was answered 401 since this start.", open)
		counter("scf_engine_proxy_bootstrap_gate_opened_total", "Times the gate opened.", uint64(gate.opened.Load()))
		counter("scf_engine_proxy_bootstrap_gate_closed_total", "Times an open gate closed again (seed admin answered 200).", uint64(gate.closed.Load()))
		counter("scf_engine_proxy_bootstrap_probes_total", "B5 probes run by the proxy itself.", uint64(gate.probes.Load()))
		counter("scf_engine_proxy_bootstrap_probe_errors_total", "B5 probes that failed in transport.", uint64(gate.probeErrs.Load()))
		gauge("scf_engine_proxy_bootstrap_probe_last_status", "Umami's status for the last probe's seed login (0: transport error).", float64(gate.lastProbe.Load()))
		gauge("scf_engine_proxy_bootstrap_probe_provisioner_last_status", "Status of the last probe's provisioning-identity login (0: not run or transport error, -1: no credentials configured).", float64(gate.lastProv.Load()))
	})
}
