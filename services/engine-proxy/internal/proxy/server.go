// SPDX-License-Identifier: Apache-2.0

// Package proxy is the engine proxy's HTTP handler: it authenticates callers by their node certificate, applies the
// policy (deny-list, per-caller allow-lists, bootstrap gate), implements the visit rule on POST /api/send and
// forwards allowed calls to Umami or the local control plane (wire-formats §c.5, C-60, C-74, C-99, C-112).
package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/dedup"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/policy"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/visit"
)

const (
	upstreamUA = "scf-engine-proxy"

	maxProvisionBody = 64 << 10 // provisioning bodies are small JSON objects
	maxEdgeAPIBody   = 4 << 20  // counter records (wire-formats §d.3, §l)
	maxUmamiResponse = 16 << 20 // P12 pages of websites
	maxCPResponse    = 32 << 20 // signed snapshot (§e)

	// HeaderEdgeNode is set on calls to the control plane's internal edge API: the edge's certificate node name
	// (§l: the control plane checks that node_id equals the certificate's node). Incoming values are discarded. The
	// name matches the control plane's default SCF_EDGE_NODE_HEADER.
	HeaderEdgeNode = "X-Scf-Edge-Node"
)

// Config wires a Server.
type Config struct {
	UmamiURL        *url.URL
	ControlPlaneURL *url.URL     // may be nil: the internal edge API then answers 503
	ControlPlane    *http.Client // client for the control plane (mutual TLS when its URL is https); default Client
	Store           *visit.Store
	Dedup           *dedup.Memory // event-key memory of /api/send (nil = no de-duplication)
	Gate            *Gate
	Metrics         *Metrics
	Logger          *slog.Logger
	Client          *http.Client // upstream client (plain HTTP on the core node's internal networks)
}

// Server is the engine proxy's request handler.
type Server struct {
	c Config
}

// New returns a Server.
func New(c Config) *Server {
	if c.Client == nil {
		c.Client = &http.Client{Timeout: 30 * time.Second}
	}
	if c.ControlPlane == nil {
		c.ControlPlane = c.Client
	}
	// Never follow redirects from upstreams: answers go back to the caller as they are.
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	cl := *c.Client
	cl.CheckRedirect = noRedirect
	c.Client = &cl
	cp := *c.ControlPlane
	cp.CheckRedirect = noRedirect
	c.ControlPlane = &cp
	return &Server{c: c}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func writeJSONError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "5")
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `{"error":"`+code+`"}`)
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	start := time.Now()
	w := &statusWriter{ResponseWriter: rw}
	var id policy.Identity
	var err error
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		err = errNoCert
	} else {
		id, err = policy.IdentityFromCert(r.TLS.PeerCertificates[0])
	}
	if err != nil {
		s.c.Metrics.Add("scf_engine_proxy_denials_total", 1, "node", "unknown", "role", "unknown", "reason", "bad_certificate")
		writeJSONError(w, http.StatusForbidden, "forbidden")
		s.c.Logger.Warn("request_refused", "role", "unknown", "method", safeMethod(r.Method), "reason", "bad_certificate", "status", w.status)
		return
	}
	d := policy.Decide(id, r.Method, r.URL, s.c.Gate.IsOpen())
	extra := []any{}
	if !d.Allowed {
		s.c.Metrics.Add("scf_engine_proxy_denials_total", 1, "node", id.Node, "role", string(id.Role), "reason", d.Reason)
		code := "forbidden"
		if d.Status == http.StatusServiceUnavailable {
			code = "bootstrap_pending"
		}
		writeJSONError(w, d.Status, code)
		extra = append(extra, "reason", d.Reason)
	} else {
		switch d.Target {
		case policy.TargetSend:
			extra = s.handleSend(w, r)
		case policy.TargetUmami:
			extra = s.forwardUmami(w, r, d)
		case policy.TargetControlPlane:
			extra = s.forwardControlPlane(w, r, id)
		case policy.TargetPurge:
			n := s.c.Store.PurgeWebsite(d.WebsiteID)
			s.c.Metrics.Add("scf_engine_proxy_token_purge_requests_total", 1, "source", "purge_endpoint")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
			extra = append(extra, "purged_entries", n)
		}
	}
	if w.status == 0 {
		w.status = http.StatusOK
	}
	dur := time.Since(start)
	s.c.Metrics.Add("scf_engine_proxy_requests_total", 1, "role", string(id.Role), "route", d.Route, "code", strconv.Itoa(w.status))
	s.c.Metrics.observe(d.Route, dur)
	attrs := append([]any{"node", id.Node, "role", string(id.Role), "method", safeMethod(r.Method), "route", d.Route,
		"status", w.status, "dur_ms", dur.Milliseconds()}, extra...)
	s.c.Logger.Info("request", attrs...)
}

type constError string

func (e constError) Error() string { return string(e) }

const errNoCert = constError("no client certificate")

// safeMethod keeps the method label bounded.
func safeMethod(m string) string {
	switch m {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions:
		return m
	}
	return "other"
}

func copyHeaders(dst, src http.Header, names ...string) {
	for _, n := range names {
		if v := src.Values(n); len(v) > 0 {
			for _, x := range v {
				dst.Add(n, x)
			}
		}
	}
}

func readLimited(r io.Reader, limit int64) ([]byte, bool, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) > limit {
		return nil, true, nil
	}
	return b, false, nil
}

// forwardUmami forwards an allowed reader or provisioner call to Umami with an allow-list of headers.
func (s *Server) forwardUmami(w http.ResponseWriter, r *http.Request, d policy.Decision) []any {
	var body []byte
	if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
		b, tooBig, err := readLimited(r.Body, maxProvisionBody)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "bad_request")
			return []any{"reason", "body_read"}
		}
		if tooBig {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large")
			return []any{"reason", "body_too_large"}
		}
		body = b
	}
	u := *s.c.UmamiURL
	u.Path = r.URL.Path
	u.RawPath = ""
	u.RawQuery = r.URL.RawQuery // validated parameter by parameter by the policy
	req, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), bytes.NewReader(body))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "engine_unavailable")
		return []any{"error_kind", "request"}
	}
	if body == nil {
		req.Body = http.NoBody
		req.ContentLength = 0
	}
	copyHeaders(req.Header, r.Header, "Authorization", "Content-Type")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", upstreamUA)
	resp, err := s.c.Client.Do(req)
	if err != nil {
		kind := ErrorKind(err)
		s.c.Metrics.Add("scf_engine_proxy_upstream_errors_total", 1, "upstream", "umami", "kind", kind)
		writeJSONError(w, http.StatusBadGateway, "engine_unavailable")
		return []any{"error_kind", kind}
	}
	defer resp.Body.Close()
	out, tooBig, err := readLimited(resp.Body, maxUmamiResponse)
	if err != nil || tooBig {
		s.c.Metrics.Add("scf_engine_proxy_upstream_errors_total", 1, "upstream", "umami", "kind", "response")
		writeJSONError(w, http.StatusBadGateway, "engine_unavailable")
		return []any{"error_kind", "response"}
	}
	extra := []any{}
	if d.Login && isSeedLogin(body) {
		s.c.Gate.Observe(resp.StatusCode)
		extra = append(extra, "bootstrap_check", resp.StatusCode == http.StatusUnauthorized)
	}
	if d.PurgeAfter && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		s.c.Store.PurgeWebsite(d.WebsiteID)
		s.c.Metrics.Add("scf_engine_proxy_token_purge_requests_total", 1, "source", "website_delete")
	}
	copyHeaders(w.Header(), resp.Header, "Content-Type")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(out)
	return extra
}

// forwardControlPlane forwards the internal edge API (snapshot pull, counter upload) to the local control plane,
// adding the caller's certificate identity.
func (s *Server) forwardControlPlane(w http.ResponseWriter, r *http.Request, id policy.Identity) []any {
	if s.c.ControlPlaneURL == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "control_plane_unavailable")
		return []any{"error_kind", "not_configured"}
	}
	var body io.Reader = http.NoBody
	if r.Method == http.MethodPost {
		b, tooBig, err := readLimited(r.Body, maxEdgeAPIBody)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "bad_request")
			return []any{"reason", "body_read"}
		}
		if tooBig {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "body_too_large")
			return []any{"reason", "body_too_large"}
		}
		body = bytes.NewReader(b)
	}
	u := *s.c.ControlPlaneURL
	u.Path = r.URL.Path
	u.RawPath = ""
	u.RawQuery = ""
	req, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), body)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "control_plane_unavailable")
		return []any{"error_kind", "request"}
	}
	copyHeaders(req.Header, r.Header, "Content-Type", "Content-Encoding", "If-None-Match", "Accept", "Accept-Encoding")
	req.Header.Set(HeaderEdgeNode, id.Node)
	req.Header.Set("User-Agent", upstreamUA)
	resp, err := s.c.ControlPlane.Do(req)
	if err != nil {
		kind := ErrorKind(err)
		s.c.Metrics.Add("scf_engine_proxy_upstream_errors_total", 1, "upstream", "control_plane", "kind", kind)
		writeJSONError(w, http.StatusBadGateway, "control_plane_unavailable")
		return []any{"error_kind", kind}
	}
	defer resp.Body.Close()
	out, tooBig, err := readLimited(resp.Body, maxCPResponse)
	if err != nil || tooBig {
		s.c.Metrics.Add("scf_engine_proxy_upstream_errors_total", 1, "upstream", "control_plane", "kind", "response")
		writeJSONError(w, http.StatusBadGateway, "control_plane_unavailable")
		return []any{"error_kind", "response"}
	}
	copyHeaders(w.Header(), resp.Header, "Content-Type", "Content-Encoding", "ETag", "Cache-Control", "Retry-After")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(out)
	return nil
}

// stripIdentifiers removes cache, sessionId and visitId from a JSON object answer and returns the cache token.
// A 200 answer that is not a JSON object is replaced by {} so nothing unparsed can leak.
func stripIdentifiers(b []byte) (out []byte, cache string) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		return []byte("{}"), ""
	}
	if raw, ok := m["cache"]; ok {
		_ = json.Unmarshal(raw, &cache)
	}
	delete(m, "cache")
	delete(m, "sessionId")
	delete(m, "visitId")
	out, err := json.Marshal(m)
	if err != nil {
		return []byte("{}"), cache
	}
	return out, cache
}
