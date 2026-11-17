// SPDX-License-Identifier: Apache-2.0

// Package metrics is a minimal Prometheus text-format registry (counters and gauges with closed label sets). Labels
// are node ids, hostnames, provider names and fixed words — never an address of a visitor, a token or a header.
package metrics

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// Registry holds counters and gauges.
type Registry struct {
	mu    sync.Mutex
	help  map[string]string
	kind  map[string]string
	vals  map[string]map[string]float64
	order []string
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{help: map[string]string{}, kind: map[string]string{}, vals: map[string]map[string]float64{}}
}

// Describe registers a metric family.
func (r *Registry) Describe(name, kind, help string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.kind[name]; !ok {
		r.order = append(r.order, name)
	}
	r.kind[name], r.help[name] = kind, help
	if r.vals[name] == nil {
		r.vals[name] = map[string]float64{}
	}
}

// Labels renders label pairs k1, v1, k2, v2 … in the Prometheus text format.
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
	defer r.mu.Unlock()
	if r.vals[name] == nil {
		r.vals[name] = map[string]float64{}
	}
	r.vals[name][l] += v
}

// Set sets a gauge.
func (r *Registry) Set(name string, v float64, kv ...string) {
	l := Labels(kv...)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.vals[name] == nil {
		r.vals[name] = map[string]float64{}
	}
	r.vals[name][l] = v
}

// Get returns the current value (tests).
func (r *Registry) Get(name string, kv ...string) float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.vals[name][Labels(kv...)]
}

// Write renders every family in registration order.
func (r *Registry) Write(w io.Writer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, name := range r.order {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", name, r.help[name], name, r.kind[name])
		keys := make([]string, 0, len(r.vals[name]))
		for k := range r.vals[name] {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if k == "" {
				fmt.Fprintf(w, "%s %g\n", name, r.vals[name][k])
			} else {
				fmt.Fprintf(w, "%s{%s} %g\n", name, k, r.vals[name][k])
			}
		}
	}
}

// Handler serves /metrics.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		r.Write(w)
	})
}
