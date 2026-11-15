// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/dedup"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/visit"
)

const (
	// MaxSendBody is the body bound of §c.5 step 1.
	MaxSendBody = 16 << 10
	maxUA       = 512

	HeaderSurrogate = "x-scf-surrogate-ip"
	HeaderCountry   = "cf-ipcountry"
	HeaderVisit     = "x-scf-visit"
	HeaderCache     = "x-umami-cache"
	// HeaderEventKey carries the event's de-duplication key (32 lower-case hex, §c.2). Never forwarded.
	HeaderEventKey = "x-scf-event-key"
)

// surrogatePrefix: every surrogate is under 2001:db8::/32 (wire-formats §c.3). Anything else could be a real
// address and is refused, so no real IP can ever reach Umami through the proxy.
var surrogatePrefix = netip.MustParsePrefix("2001:db8::/32")

var (
	uuidPattern    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	countryPattern = regexp.MustCompile(`^[A-Z]{2}$`)
)

// Payload fields the gateway may send (wire-formats §c.2). Everything else — notably ip and userAgent, which would
// replace the surrogate and the country (S-01) — is refused with 400 and never forwarded.
var allowedPayload = map[string]bool{
	"website": true, "hostname": true, "url": true, "referrer": true, "screen": true, "language": true,
	"name": true, "data": true, "tag": true, "timestamp": true,
}

type sendEvent struct {
	website   string
	timestamp int64
}

// parseSend validates a /api/send body; it returns a closed-set reason on failure.
func parseSend(body []byte) (sendEvent, string) {
	var top map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&top); err != nil || top == nil || dec.More() {
		return sendEvent{}, "bad_json"
	}
	for k := range top {
		if k != "type" && k != "payload" {
			return sendEvent{}, "unknown_field"
		}
	}
	var typ string
	if json.Unmarshal(top["type"], &typ) != nil || typ != "event" {
		return sendEvent{}, "bad_type"
	}
	var p map[string]json.RawMessage
	if json.Unmarshal(top["payload"], &p) != nil || p == nil {
		return sendEvent{}, "bad_json"
	}
	for k := range p {
		if !allowedPayload[k] {
			if k == "ip" || k == "userAgent" {
				return sendEvent{}, "forbidden_field"
			}
			return sendEvent{}, "unknown_field"
		}
	}
	var ev sendEvent
	if json.Unmarshal(p["website"], &ev.website) != nil || !uuidPattern.MatchString(ev.website) {
		return sendEvent{}, "bad_website"
	}
	ev.website = strings.ToLower(ev.website)
	ts, ok := parseTimestamp(p["timestamp"])
	if !ok {
		return sendEvent{}, "bad_timestamp"
	}
	ev.timestamp = ts
	var tag string
	if json.Unmarshal(p["tag"], &tag) != nil || (tag != "v" && tag != "s") {
		return sendEvent{}, "bad_tag"
	}
	for _, k := range []string{"hostname", "url", "referrer", "screen", "language", "name"} {
		if raw, ok := p[k]; ok {
			var s string
			if json.Unmarshal(raw, &s) != nil {
				return sendEvent{}, "bad_field"
			}
		}
	}
	return ev, ""
}

// parseTimestamp accepts what Umami accepts on our path (§j.4): an integer 0 … 2^31−1, as a JSON number or a
// numeric string.
func parseTimestamp(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	s := string(raw)
	if raw[0] == '"' {
		if json.Unmarshal(raw, &s) != nil {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || n > 2147483647 {
		return 0, false
	}
	return n, true
}

func (s *Server) rejectSend(w http.ResponseWriter, reason string) []any {
	s.c.Metrics.Add("scf_engine_proxy_send_rejected_total", 1, "reason", reason)
	writeJSONError(w, http.StatusBadRequest, reason)
	return []any{"reason", reason}
}

// handleSend implements §c.5 steps 1–3 for POST /api/send from an edge.
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) []any {
	body, tooBig, err := readLimited(r.Body, MaxSendBody)
	if err != nil {
		return s.rejectSend(w, "body_read")
	}
	if tooBig {
		return s.rejectSend(w, "body_too_large")
	}
	ev, reason := parseSend(body)
	if reason != "" {
		return s.rejectSend(w, reason)
	}
	sur, err := netip.ParseAddr(r.Header.Get(HeaderSurrogate))
	if err != nil || !sur.Is6() || sur.Zone() != "" || !surrogatePrefix.Contains(sur) {
		return s.rejectSend(w, "bad_surrogate")
	}
	country := r.Header.Get(HeaderCountry)
	if country == "" {
		country = "XX" // C-99: Umami (no geo database) answers 500 without a country header
	}
	if !countryPattern.MatchString(country) {
		return s.rejectSend(w, "bad_country")
	}
	ua := r.Header.Get("User-Agent")
	if ua == "" || len(ua) > maxUA {
		return s.rejectSend(w, "bad_user_agent")
	}
	track := false
	switch r.Header.Get(HeaderVisit) {
	case "track":
		track = true
	case "none", "":
	default:
		return s.rejectSend(w, "bad_visit_header")
	}
	var key [16]byte
	hasKey := false
	if v := r.Header.Get(HeaderEventKey); v != "" {
		if len(v) != 32 || strings.ToLower(v) != v {
			return s.rejectSend(w, "bad_event_key")
		}
		if _, err := hex.Decode(key[:], []byte(v)); err != nil {
			return s.rejectSend(w, "bad_event_key")
		}
		hasKey = true
	}
	// De-duplication by event key (§c.5): the first copy is forwarded; a later copy within the window is
	// answered with the first one's outcome and never reaches Umami; a concurrent copy waits for the first.
	var delivered dedup.Outcome
	if hasKey && s.c.Dedup != nil {
		out, dup, err := s.c.Dedup.Begin(r.Context(), key)
		if err != nil {
			writeJSONError(w, http.StatusServiceUnavailable, "engine_unavailable")
			return []any{"error_kind", "dedup_wait"}
		}
		if dup {
			s.c.Metrics.Add("scf_engine_proxy_send_duplicates_total", 1)
			body := `{}`
			if out == dedup.Bot {
				body = `{"beep":"boop"}`
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(body))
			return []any{"visit", "duplicate"}
		}
		defer func() { s.c.Dedup.Finish(key, delivered) }()
	}

	token, res := "", visit.Miss
	if track {
		token, res = s.c.Store.Lookup(ev.website, sur.String(), ev.timestamp)
	}
	u := *s.c.UmamiURL
	u.Path = "/api/send"
	u.RawPath = ""
	u.RawQuery = ""
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "engine_unavailable")
		return []any{"error_kind", "request"}
	}
	// The outgoing request is rebuilt from an allow-list: no incoming header other than these four reaches Umami
	// (so never x-umami-cache from an edge, x-forwarded-for, cf-connecting-ip, cookies …).
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ua)
	req.Header.Set(HeaderSurrogate, sur.String())
	req.Header.Set(HeaderCountry, country)
	if token != "" {
		req.Header.Set(HeaderCache, token)
	}
	resp, err := s.c.Client.Do(req)
	if err != nil {
		kind := ErrorKind(err)
		s.c.Metrics.Add("scf_engine_proxy_upstream_errors_total", 1, "upstream", "umami", "kind", kind)
		writeJSONError(w, http.StatusBadGateway, "engine_unavailable")
		return []any{"error_kind", kind}
	}
	defer resp.Body.Close()
	out, tooBig, err := readLimited(resp.Body, 64<<10)
	if err != nil || tooBig {
		s.c.Metrics.Add("scf_engine_proxy_upstream_errors_total", 1, "upstream", "umami", "kind", "response")
		writeJSONError(w, http.StatusBadGateway, "engine_unavailable")
		return []any{"error_kind", "response"}
	}
	visitLabel := "untracked"
	if track {
		visitLabel = res.String()
	}
	if resp.StatusCode == http.StatusOK {
		var cache string
		out, cache = stripIdentifiers(out)
		if track && cache != "" {
			s.c.Store.Store(ev.website, sur.String(), cache, ev.timestamp)
		}
		delivered = dedup.Stored
		if bytes.Equal(bytes.TrimSpace(out), []byte(`{"beep":"boop"}`)) {
			delivered = dedup.Bot
		}
	}
	s.c.Metrics.Add("scf_engine_proxy_send_visit_total", 1, "visit", visitLabel, "code", strconv.Itoa(resp.StatusCode))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(out)
	return []any{"visit", visitLabel}
}
