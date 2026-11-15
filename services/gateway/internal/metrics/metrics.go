// SPDX-License-Identifier: Apache-2.0

// Package metrics is a small Prometheus text-format registry (standard library only). Label values come from closed
// sets (routes, statuses, verdicts, reason codes, drop labels, core ids, error kinds); never a site, tenant, path,
// address, User-Agent, token or key.
package metrics

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// Registry holds counters, gauges and histograms.
type Registry struct {
	mu     sync.Mutex
	help   map[string]string
	typ    map[string]string
	vals   map[string]map[string]float64 // name → rendered labels → value
	hists  map[string]map[string]*hist
	gauges []func(emit func(name, labels string, v float64))
}

type hist struct {
	bounds []float64
	counts []uint64
	sum    float64
	n      uint64
}

// New creates a registry.
func New() *Registry {
	return &Registry{help: map[string]string{}, typ: map[string]string{}, vals: map[string]map[string]float64{}, hists: map[string]map[string]*hist{}}
}

// Help declares a metric.
func (r *Registry) Help(name, typ, help string) {
	r.mu.Lock()
	r.help[name], r.typ[name] = help, typ
	r.mu.Unlock()
}

// Labels renders k=v pairs.
func Labels(kv ...string) string {
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
	l := Labels(kv...)
	r.mu.Lock()
	m := r.vals[name]
	if m == nil {
		m = map[string]float64{}
		r.vals[name] = m
	}
	m[l] += v
	r.mu.Unlock()
}

// Get returns a counter's value (tests).
func (r *Registry) Get(name string, kv ...string) float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.vals[name][Labels(kv...)]
}

// Observe records a histogram observation.
func (r *Registry) Observe(name string, bounds []float64, v float64, kv ...string) {
	l := Labels(kv...)
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.hists[name]
	if m == nil {
		m = map[string]*hist{}
		r.hists[name] = m
	}
	h := m[l]
	if h == nil {
		h = &hist{bounds: bounds, counts: make([]uint64, len(bounds))}
		m[l] = h
	}
	for i, b := range h.bounds {
		if v <= b {
			h.counts[i]++
		}
	}
	h.sum += v
	h.n++
}

// GaugeFunc registers a callback that emits gauge values at scrape time.
func (r *Registry) GaugeFunc(fn func(emit func(name, labels string, v float64))) {
	r.mu.Lock()
	r.gauges = append(r.gauges, fn)
	r.mu.Unlock()
}

// Write renders the text format.
func (r *Registry) Write(w io.Writer) {
	type line struct {
		name, labels string
		v            float64
	}
	var gl []line
	r.mu.Lock()
	gauges := append([]func(func(string, string, float64)){}, r.gauges...)
	r.mu.Unlock()
	for _, g := range gauges {
		g(func(name, labels string, v float64) { gl = append(gl, line{name, labels, v}) })
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	names := map[string]bool{}
	for n := range r.vals {
		names[n] = true
	}
	for n := range r.hists {
		names[n] = true
	}
	gauge := map[string][]line{}
	for _, l := range gl {
		names[l.name] = true
		gauge[l.name] = append(gauge[l.name], l)
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, n := range sorted {
		if h, ok := r.help[n]; ok {
			fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", n, h, n, r.typ[n])
		}
		ls := make([]string, 0, len(r.vals[n]))
		for l := range r.vals[n] {
			ls = append(ls, l)
		}
		sort.Strings(ls)
		for _, l := range ls {
			writeSample(w, n, l, r.vals[n][l])
		}
		for _, l := range gauge[n] {
			writeSample(w, n, l.labels, l.v)
		}
		hl := make([]string, 0, len(r.hists[n]))
		for l := range r.hists[n] {
			hl = append(hl, l)
		}
		sort.Strings(hl)
		for _, l := range hl {
			h := r.hists[n][l]
			sep := ""
			if l != "" {
				sep = ","
			}
			for i, b := range h.bounds {
				fmt.Fprintf(w, "%s_bucket{%s%sle=\"%g\"} %d\n", n, l, sep, b, h.counts[i])
			}
			fmt.Fprintf(w, "%s_bucket{%s%sle=\"+Inf\"} %d\n", n, l, sep, h.n)
			writeSample(w, n+"_sum", l, h.sum)
			writeSample(w, n+"_count", l, float64(h.n))
		}
	}
}

func writeSample(w io.Writer, name, labels string, v float64) {
	if labels == "" {
		fmt.Fprintf(w, "%s %g\n", name, v)
		return
	}
	fmt.Fprintf(w, "%s{%s} %g\n", name, labels, v)
}

// Handler serves /metrics.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		r.Write(w)
	})
}
