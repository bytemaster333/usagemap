// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"net/http"
	"strings"
	"time"
)

// Health reports whether the node can accept ingest (snapshot present, keys ready, spool durable).
type Health func() (ok bool, reason string)

// Handler routes the public listener (§a.1). Nothing on it carries tenant data except what the routes return.
func (s *Server) Handler(lib http.Handler, health Health, extra ...func(*http.ServeMux)) http.Handler {
	mux := http.NewServeMux()
	for _, x := range extra {
		x(mux) // e.g. the OTLP front door (wire-formats §f)
	}
	mux.Handle("/lib/", lib)
	mux.HandleFunc("POST /v1/c", s.Challenge)
	mux.HandleFunc("POST /v1/e", s.Events)
	preflight := func(w http.ResponseWriter, r *http.Request) {
		// Only clients sending a non-safelisted content type preflight (§a.1). No body yet, so the origin is checked
		// against every declared domain and dev origin in the snapshot, and any origin passes while a site is in debug
		// mode (§a.8).
		o := r.Header.Get("Origin")
		if v := s.Snap.Current(); o != "" && v != nil {
			if v.PreflightOK(o, s.Now()) {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", o)
				h.Add("Vary", "Origin")
				h.Set("Access-Control-Allow-Methods", "POST")
				h.Set("Access-Control-Allow-Headers", "content-type")
				h.Set("Access-Control-Max-Age", "600")
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}
	mux.HandleFunc("OPTIONS /v1/c", preflight)
	mux.HandleFunc("OPTIONS /v1/e", preflight)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		if ok, reason := health(); !ok {
			writeJSON(w, http.StatusServiceUnavailable, `{"status":"unavailable","reason":"`+reason+`"}`)
			return
		}
		writeJSON(w, http.StatusOK, `{"status":"ok"}`)
	})
	return timed(s, mux)
}

func timed(s *Server, next http.Handler) http.Handler {
	bounds := []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t := time.Now()
		next.ServeHTTP(w, r)
		route := "other"
		switch {
		case r.URL.Path == "/v1/c":
			route = "challenge"
		case r.URL.Path == "/v1/e":
			route = "events"
		case len(r.URL.Path) > 5 && r.URL.Path[:5] == "/lib/":
			route = "lib"
		case r.URL.Path == "/v1/app-events":
			route = "app_events"
		case r.URL.Path == "/healthz":
			route = "healthz"
		case strings.HasPrefix(r.URL.Path, "/v1/metrics"), strings.HasPrefix(r.URL.Path, "/v1/traces"), strings.HasPrefix(r.URL.Path, "/v1/logs"), strings.HasPrefix(r.URL.Path, "/opentelemetry."):
			route = "otlp"
		}
		s.Metrics.Observe("scf_gateway_request_duration_seconds", bounds, time.Since(t).Seconds(), "route", route)
	})
}
