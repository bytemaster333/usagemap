// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/policy"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/visit"
)

const (
	site     = "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
	sur      = "2001:db8:5c1f:9a2e:77d0:13ab:e4c2:b9f"
	surLong  = "2001:0db8:5c1f:9a2e:77d0:13ab:e4c2:0b9f"
	chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

var (
	edgeID = policy.Identity{Node: "edge-a1", Role: policy.RoleEdge}
	rdrID  = policy.Identity{Node: "core-a-control-plane", Role: policy.RoleReader}
	provID = policy.Identity{Node: "core-a-umami-reconcile", Role: policy.RoleProvisioner}
)

// recorded is one request seen by a fake upstream.
type recorded struct {
	Method, Path, Query string
	Header              http.Header
	Body                []byte
}

// fakeUmami mimics the Umami 3.5.0 answers measured in S-01 for the routes the proxy forwards.
type fakeUmami struct {
	mu        sync.Mutex
	reqs      []recorded
	n         int
	seedLogin int    // status for admin/umami logins
	provLogin int    // status for logins as provUser (0: 200)
	sendBody  string // overrides the /api/send answer when set
}

// provUser and provPass are the provisioning identity of the gate-probe tests.
const provUser, provPass = "scf-provisioner", "provisioner-password-from-sops"

func (f *fakeUmami) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.reqs = append(f.reqs, recorded{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Clone(), b})
	f.n++
	n := f.n
	seed := f.seedLogin
	prov := f.provLogin
	sendBody := f.sendBody
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Set-Cookie", "x=1") // must not be passed back
	switch {
	case r.URL.Path == "/api/send":
		if sendBody != "" {
			_, _ = io.WriteString(w, sendBody)
			return
		}
		fmt.Fprintf(w, `{"cache":"tok-%d","sessionId":"sess-%d","visitId":"visitid-%d"}`, n, n, n)
	case r.URL.Path == "/api/auth/login":
		if isSeedLogin(b) {
			w.WriteHeader(seed)
			_, _ = io.WriteString(w, `{}`)
			return
		}
		var c struct{ Username, Password string }
		_ = json.Unmarshal(b, &c)
		if c.Username == provUser && (prov != 0 && prov != http.StatusOK || c.Password != provPass) {
			if prov == 0 {
				prov = http.StatusUnauthorized
			}
			w.WriteHeader(prov)
			_, _ = io.WriteString(w, `{}`)
			return
		}
		_, _ = io.WriteString(w, `{"token":"t"}`)
	default:
		_, _ = io.WriteString(w, `{"ok":true}`)
	}
}

func (f *fakeUmami) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

func (f *fakeUmami) last(t *testing.T) recorded {
	t.Helper()
	r := f.requests()
	if len(r) == 0 {
		t.Fatal("upstream received no request")
	}
	return r[len(r)-1]
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type harness struct {
	srv     *Server
	umami   *fakeUmami
	umamiTS *httptest.Server
	cp      *fakeUmami
	store   *visit.Store
	gate    *Gate
	metrics *Metrics
	logs    *syncBuffer
}

func newHarness(t *testing.T, gateOpen bool) *harness {
	t.Helper()
	h := &harness{umami: &fakeUmami{seedLogin: http.StatusUnauthorized}, cp: &fakeUmami{}, logs: &syncBuffer{}}
	h.umamiTS = httptest.NewServer(h.umami)
	t.Cleanup(h.umamiTS.Close)
	cpTS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.cp.ServeHTTP(w, r)
	}))
	t.Cleanup(cpTS.Close)
	uu, _ := url.Parse(h.umamiTS.URL)
	cu, _ := url.Parse(cpTS.URL)
	h.store = visit.New(visit.Config{})
	h.gate = &Gate{}
	if gateOpen {
		h.gate.Observe(http.StatusUnauthorized)
	}
	h.metrics = NewMetrics()
	logger := slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	h.srv = New(Config{UmamiURL: uu, ControlPlaneURL: cu, Store: h.store, Gate: h.gate, Metrics: h.metrics, Logger: logger})
	return h
}

func certFor(id policy.Identity) *x509.Certificate {
	return &x509.Certificate{Subject: pkix.Name{CommonName: id.Node, OrganizationalUnit: []string{string(id.Role)}}}
}

func (h *harness) do(id *policy.Identity, method, target string, body string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.55:40000"
	if id != nil {
		r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{certFor(*id)}}
	} else {
		r.TLS = &tls.ConnectionState{}
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.srv.ServeHTTP(w, r)
	return w
}

func event(website string, ts int64, extra string) string {
	return fmt.Sprintf(`{"type":"event","payload":{"website":%q,"hostname":"app.example.org","url":"/pricing","screen":"1536x864","language":"en","tag":"v","timestamp":%d%s}}`, website, ts, extra)
}

func sendHeaders(mode string) map[string]string {
	return map[string]string{
		"Content-Type":  "application/json",
		"User-Agent":    chromeUA,
		HeaderSurrogate: sur,
		HeaderCountry:   "DE",
		HeaderVisit:     mode,
	}
}

func at(hh, mm int) int64 { return time.Date(2026, 11, 12, hh, mm, 0, 0, time.UTC).Unix() }

func (h *harness) send(t *testing.T, ts int64, mode string) *httptest.ResponseRecorder {
	t.Helper()
	return h.do(&edgeID, "POST", "/api/send", event(site, ts, ""), sendHeaders(mode))
}

// ------------------------------------------------------------------ visit rule on the wire

func TestSendReplaysTokenAcrossClockHourAndStartsNewVisitAfter31Minutes(t *testing.T) {
	h := newHarness(t, true)
	w := h.send(t, at(10, 55), "track")
	if w.Code != 200 || w.Body.String() != "{}" {
		t.Fatalf("first send = %d %q, want 200 {}", w.Code, w.Body.String())
	}
	if c := h.umami.last(t).Header.Get(HeaderCache); c != "" {
		t.Fatalf("first event carried a cache token %q", c)
	}
	h.send(t, at(11, 5), "track") // other clock hour, 10 min later
	if c := h.umami.last(t).Header.Get(HeaderCache); c != "tok-1" {
		t.Fatalf("second event cache = %q, want tok-1", c)
	}
	h.send(t, at(11, 36), "track") // 31 min after 11:05
	if c := h.umami.last(t).Header.Get(HeaderCache); c != "" {
		t.Fatalf("event after a 31-minute gap carried %q", c)
	}
	h.send(t, at(11, 40), "track") // the new visit's token (tok-3) is replayed
	if c := h.umami.last(t).Header.Get(HeaderCache); c != "tok-3" {
		t.Fatalf("event in the new visit cache = %q, want tok-3", c)
	}
	if got := h.metrics.Get("scf_engine_proxy_send_visit_total", "visit", "refused_window", "code", "200"); got != 1 {
		t.Fatalf("refused_window count = %v", got)
	}
}

func TestSendSurrogateSpellingIsCanonicalised(t *testing.T) {
	h := newHarness(t, true)
	hd := sendHeaders("track")
	hd[HeaderSurrogate] = surLong
	h.do(&edgeID, "POST", "/api/send", event(site, at(10, 0), ""), hd)
	if got := h.umami.last(t).Header.Get(HeaderSurrogate); got != sur {
		t.Fatalf("surrogate forwarded as %q, want RFC 5952 %q", got, sur)
	}
	h.send(t, at(10, 1), "track")
	if c := h.umami.last(t).Header.Get(HeaderCache); c != "tok-1" {
		t.Fatalf("other spelling of the same surrogate got cache %q", c)
	}
}

func TestSendNoneKeepsNoVisitState(t *testing.T) {
	h := newHarness(t, true)
	h.send(t, at(10, 0), "none")
	h.send(t, at(10, 1), "none")
	if c := h.umami.last(t).Header.Get(HeaderCache); c != "" {
		t.Fatalf("x-scf-visit: none replayed %q", c)
	}
	if st := h.store.Stats(); st.Size != 0 {
		t.Fatalf("store size = %d, want 0", st.Size)
	}
	if w := h.send(t, at(10, 2), "none"); w.Body.String() != "{}" {
		t.Fatalf("identifiers not stripped for none: %q", w.Body.String())
	}
}

func TestSendForwardsOnlyAllowListedHeaders(t *testing.T) {
	h := newHarness(t, true)
	hd := sendHeaders("track")
	for k, v := range map[string]string{
		HeaderCache:           "forged-token",
		"X-Forwarded-For":     "198.51.100.7",
		"Forwarded":           "for=198.51.100.7",
		"X-Real-Ip":           "198.51.100.7",
		"Cf-Connecting-Ip":    "198.51.100.7",
		"True-Client-Ip":      "198.51.100.7",
		"Cf-Region-Code":      "BY",
		"Cf-Ipcity":           "Munich",
		"Cookie":              "a=b",
		"Authorization":       "Bearer x",
		"X-Umami-Client-Ip":   "198.51.100.7",
		"X-Vercel-Ip-Country": "US",
	} {
		hd[k] = v
	}
	h.do(&edgeID, "POST", "/api/send", event(site, at(10, 0), ""), hd)
	got := h.umami.last(t).Header
	if got.Get(HeaderCache) != "" {
		t.Fatal("incoming x-umami-cache was forwarded")
	}
	allowed := map[string]bool{"Content-Type": true, "User-Agent": true, "X-Scf-Surrogate-Ip": true, "Cf-Ipcountry": true,
		"Accept-Encoding": true, "Content-Length": true}
	for k := range got {
		if !allowed[k] {
			t.Errorf("header %s reached Umami", k)
		}
	}
	if got.Get("User-Agent") != chromeUA || got.Get(HeaderCountry) != "DE" {
		t.Errorf("UA/country not passed on: %v", got)
	}
}

func TestSendDefaultsMissingCountryToXX(t *testing.T) {
	h := newHarness(t, true)
	hd := sendHeaders("track")
	delete(hd, HeaderCountry)
	if w := h.do(&edgeID, "POST", "/api/send", event(site, at(10, 0), ""), hd); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if c := h.umami.last(t).Header.Get(HeaderCountry); c != "XX" {
		t.Fatalf("country = %q, want XX", c)
	}
}

func TestSendRejectsWithoutCallingUmami(t *testing.T) {
	big := strings.Repeat("a", MaxSendBody)
	cases := []struct {
		name   string
		body   string
		mutate func(map[string]string)
		reason string
	}{
		{"payload.ip", event(site, at(10, 0), `,"ip":"203.0.113.9"`), nil, "forbidden_field"},
		{"payload.userAgent", event(site, at(10, 0), `,"userAgent":"x"`), nil, "forbidden_field"},
		{"payload.id", event(site, at(10, 0), `,"id":"x"`), nil, "unknown_field"},
		{"payload.title", event(site, at(10, 0), `,"title":"My page"`), nil, "unknown_field"},
		{"type identify", strings.Replace(event(site, at(10, 0), ""), `"event"`, `"identify"`, 1), nil, "bad_type"},
		{"extra top-level field", `{"type":"event","payload":{},"x":1}`, nil, "unknown_field"},
		{"not json", `{"type":`, nil, "bad_json"},
		{"two documents", event(site, at(10, 0), "") + event(site, at(10, 0), ""), nil, "bad_json"},
		{"oversized", event(site, at(10, 0), `,"data":{"x":"`+big+`"}`), nil, "body_too_large"},
		{"bad website", event("nope", at(10, 0), ""), nil, "bad_website"},
		{"timestamp negative", event(site, -1, ""), nil, "bad_timestamp"},
		{"timestamp too large", event(site, 2147483648, ""), nil, "bad_timestamp"},
		{"timestamp missing", `{"type":"event","payload":{"website":"` + site + `","url":"/","tag":"v"}}`, nil, "bad_timestamp"},
		{"tag x", strings.Replace(event(site, at(10, 0), ""), `"tag":"v"`, `"tag":"x"`, 1), nil, "bad_tag"},
		{"url not a string", strings.Replace(event(site, at(10, 0), ""), `"url":"/pricing"`, `"url":5`, 1), nil, "bad_field"},
		{"missing surrogate", event(site, at(10, 0), ""), func(h map[string]string) { delete(h, HeaderSurrogate) }, "bad_surrogate"},
		{"real IPv4 as surrogate", event(site, at(10, 0), ""), func(h map[string]string) { h[HeaderSurrogate] = "203.0.113.7" }, "bad_surrogate"},
		{"real IPv6 as surrogate", event(site, at(10, 0), ""), func(h map[string]string) { h[HeaderSurrogate] = "2a01:4f8::1" }, "bad_surrogate"},
		{"loopback surrogate", event(site, at(10, 0), ""), func(h map[string]string) { h[HeaderSurrogate] = "::1" }, "bad_surrogate"},
		{"lower-case country", event(site, at(10, 0), ""), func(h map[string]string) { h[HeaderCountry] = "de" }, "bad_country"},
		{"country with region", event(site, at(10, 0), ""), func(h map[string]string) { h[HeaderCountry] = "DE-BY" }, "bad_country"},
		{"no user agent", event(site, at(10, 0), ""), func(h map[string]string) { h["User-Agent"] = "" }, "bad_user_agent"},
		{"bad visit header", event(site, at(10, 0), ""), func(h map[string]string) { h[HeaderVisit] = "maybe" }, "bad_visit_header"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, true)
			hd := sendHeaders("track")
			if c.mutate != nil {
				c.mutate(hd)
			}
			w := h.do(&edgeID, "POST", "/api/send", c.body, hd)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), c.reason) {
				t.Fatalf("got %d %q, want 400 %s", w.Code, w.Body.String(), c.reason)
			}
			if n := len(h.umami.requests()); n != 0 {
				t.Fatalf("Umami was called %d times", n)
			}
		})
	}
}

func TestSendTimestampAsNumericString(t *testing.T) {
	h := newHarness(t, true)
	body := strings.Replace(event(site, at(10, 0), ""), fmt.Sprintf("%d", at(10, 0)), fmt.Sprintf("%q", fmt.Sprint(at(10, 0))), 1)
	if w := h.do(&edgeID, "POST", "/api/send", body, sendHeaders("track")); w.Code != 200 {
		t.Fatalf("status %d %s", w.Code, w.Body.String())
	}
}

func TestSendBotAnswerPassesThroughUnchanged(t *testing.T) {
	h := newHarness(t, true)
	h.umami.sendBody = `{"beep":"boop"}`
	w := h.send(t, at(10, 0), "track")
	if w.Code != 200 || w.Body.String() != `{"beep":"boop"}` {
		t.Fatalf("bot answer = %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("Set-Cookie") != "" {
		t.Fatal("Set-Cookie passed back to the edge")
	}
}

func TestSendNonObjectAnswerIsNeverPassedRaw(t *testing.T) {
	h := newHarness(t, true)
	h.umami.sendBody = `tok-raw-not-json`
	w := h.send(t, at(10, 0), "track")
	if w.Body.String() != "{}" {
		t.Fatalf("raw answer leaked: %q", w.Body.String())
	}
}

func TestSendUmamiDownIs502(t *testing.T) {
	h := newHarness(t, true)
	h.umamiTS.Close()
	if w := h.send(t, at(10, 0), "track"); w.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", w.Code)
	}
}

// ------------------------------------------------------------------ website deletion (purge before P9)

func TestPurgeBeforeP9ThenNoTokenEverReplayed(t *testing.T) {
	h := newHarness(t, true)
	h.send(t, at(10, 0), "track")
	if h.store.Stats().Size != 1 {
		t.Fatal("token not stored")
	}
	// 1. the provisioning worker purges the website's tokens on this core (before P9)
	w := h.do(&provID, "DELETE", "/internal/v1/visit-tokens/websites/"+site, "", nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("purge = %d", w.Code)
	}
	if n := len(h.umami.requests()); n != 1 {
		t.Fatalf("purge reached Umami (%d requests)", n)
	}
	// 2. an event still in flight for the website gets no token, and its answer's token is not kept
	h.send(t, at(10, 1), "track")
	if c := h.umami.last(t).Header.Get(HeaderCache); c != "" {
		t.Fatalf("token replayed into a deleted website: %q", c)
	}
	if h.store.Stats().Size != 0 {
		t.Fatal("token stored for a deleted website")
	}
	// 3. P9 through this proxy is forwarded and purges again
	if w := h.do(&provID, "DELETE", "/api/websites/"+site, "", map[string]string{"Authorization": "Bearer t"}); w.Code != 200 {
		t.Fatalf("P9 = %d", w.Code)
	}
	if got := h.metrics.Get("scf_engine_proxy_token_purge_requests_total", "source", "website_delete"); got != 1 {
		t.Fatalf("P9 purge count = %v", got)
	}
	if !h.store.IsDeleted(site) {
		t.Fatal("website not on the deleted list")
	}
}

func TestPurgeEndpointOnlyForProvisioner(t *testing.T) {
	h := newHarness(t, true)
	for _, id := range []policy.Identity{edgeID, rdrID} {
		if w := h.do(&id, "DELETE", "/internal/v1/visit-tokens/websites/"+site, "", nil); w.Code != http.StatusForbidden {
			t.Fatalf("%s purge = %d, want 403", id.Role, w.Code)
		}
	}
}

// ------------------------------------------------------------------ bootstrap gate

func TestBootstrapGateHoldsOthersUntilB5(t *testing.T) {
	h := newHarness(t, false)
	w := h.send(t, at(10, 0), "track")
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") == "" {
		t.Fatalf("send before B5 = %d (Retry-After %q)", w.Code, w.Header().Get("Retry-After"))
	}
	if w := h.do(&rdrID, "GET", "/api/heartbeat", "", nil); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("reader before B5 = %d", w.Code)
	}
	if len(h.umami.requests()) != 0 {
		t.Fatal("Umami called while the gate was closed")
	}
	// The worker's other calls pass (B1–B4 happen before B5).
	if w := h.do(&provID, "POST", "/api/users", `{"username":"p","password":"x","role":"admin"}`, map[string]string{"Content-Type": "application/json"}); w.Code != 200 {
		t.Fatalf("provisioner call with closed gate = %d", w.Code)
	}
	// A login with other credentials does not open the gate, even when refused.
	h.umami.seedLogin = http.StatusUnauthorized
	h.do(&provID, "POST", "/api/auth/login", `{"username":"admin","password":"other"}`, nil)
	if h.gate.IsOpen() {
		t.Fatal("gate opened on a non-seed login")
	}
	// B5: the seed admin's original credentials are refused by Umami -> the gate opens.
	if w := h.do(&provID, "POST", "/api/auth/login", `{"username":"admin","password":"umami"}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("B5 = %d", w.Code)
	}
	if !h.gate.IsOpen() {
		t.Fatal("gate still closed after B5 = 401")
	}
	if w := h.send(t, at(10, 1), "track"); w.Code != 200 {
		t.Fatalf("send after B5 = %d", w.Code)
	}
	// If the seed admin works again (e.g. restored database), the gate closes.
	h.umami.seedLogin = http.StatusOK
	h.do(&provID, "POST", "/api/auth/login", `{"username":"admin","password":"umami"}`, nil)
	if h.gate.IsOpen() {
		t.Fatal("gate stayed open after the seed admin logged in")
	}
}

func TestPasswordChangeOnlyDuringBootstrap(t *testing.T) {
	h := newHarness(t, false)
	if w := h.do(&provID, "POST", "/api/me/password", `{}`, nil); w.Code != 200 {
		t.Fatalf("B2 during bootstrap = %d", w.Code)
	}
	h.gate.Observe(http.StatusUnauthorized)
	if w := h.do(&provID, "POST", "/api/me/password", `{}`, nil); w.Code != http.StatusForbidden {
		t.Fatalf("password change after bootstrap = %d", w.Code)
	}
}

func TestGateProbe(t *testing.T) {
	h := newHarness(t, false)
	h.gate.Provisioner = &Credentials{Username: provUser, Password: provPass}
	u, _ := url.Parse(h.umamiTS.URL)
	h.umami.seedLogin = http.StatusOK
	if st := h.gate.Probe(t.Context(), http.DefaultClient, u); st != 200 || h.gate.IsOpen() {
		t.Fatalf("probe with seed admin present: status %d open %v", st, h.gate.IsOpen())
	}
	h.umami.seedLogin = http.StatusUnauthorized
	if st := h.gate.Probe(t.Context(), http.DefaultClient, u); st != 401 || !h.gate.IsOpen() {
		t.Fatalf("probe after bootstrap: status %d open %v", st, h.gate.IsOpen())
	}
	h.umamiTS.Close()
	if st := h.gate.Probe(t.Context(), http.DefaultClient, u); st != 0 || !h.gate.IsOpen() {
		t.Fatalf("probe with Umami down must not change the gate: status %d open %v", st, h.gate.IsOpen())
	}
}

// C-114: after B2 the seed credentials are already refused, but B3/B4 have not run. The proxy's
// own probe opens the gate only when the seed credentials are refused AND the provisioning identity can sign in.
func TestGateProbeOpensOnlyAfterTheProvisioningIdentityExists(t *testing.T) {
	h := newHarness(t, false)
	u, _ := url.Parse(h.umamiTS.URL)
	h.umami.seedLogin = http.StatusUnauthorized // B2 done: seed password changed
	h.umami.provLogin = http.StatusUnauthorized // B3 not done yet: no provisioning admin

	// Without configured provisioning credentials the probe can never open the gate (only the worker's B5 can).
	if h.gate.Probe(t.Context(), http.DefaultClient, u); h.gate.IsOpen() {
		t.Fatal("probe without provisioning credentials opened the gate")
	}
	h.gate.Provisioner = &Credentials{Username: provUser, Password: provPass}
	if h.gate.Probe(t.Context(), http.DefaultClient, u); h.gate.IsOpen() {
		t.Fatal("gate opened after B2 although the provisioning identity cannot sign in")
	}
	h.umami.provLogin = http.StatusInternalServerError
	if h.gate.Probe(t.Context(), http.DefaultClient, u); h.gate.IsOpen() {
		t.Fatal("gate opened on a provisioning login error")
	}
	h.umami.provLogin = 0 // B3 done: the provisioning admin signs in
	if st := h.gate.Probe(t.Context(), http.DefaultClient, u); st != 401 || !h.gate.IsOpen() {
		t.Fatalf("gate closed although seed refused and provisioner signed in: %d", st)
	}
	// The probe sent exactly: seed login, provisioner login with the configured credentials.
	reqs := h.umami.requests()
	last := reqs[len(reqs)-1]
	if last.Path != "/api/auth/login" || !strings.Contains(string(last.Body), provPass) {
		t.Fatalf("last probe request = %s %s", last.Method, last.Path)
	}
	// A later failure of the provisioning login does not close an open gate; a working seed login does.
	h.umami.provLogin = http.StatusUnauthorized
	if h.gate.Probe(t.Context(), http.DefaultClient, u); !h.gate.IsOpen() {
		t.Fatal("provisioning login failure closed the gate")
	}
	h.umami.seedLogin = http.StatusOK
	if h.gate.Probe(t.Context(), http.DefaultClient, u); h.gate.IsOpen() {
		t.Fatal("gate stayed open with the seed admin back")
	}
	// The probe never logs a credential or token.
	if strings.Contains(h.logs.String(), provPass) {
		t.Fatal("provisioning password in the logs")
	}
}

// ------------------------------------------------------------------ other forwards

func TestReaderForwardKeepsOnlyAuthorization(t *testing.T) {
	h := newHarness(t, true)
	q := "startAt=1&endAt=2&timezone=UTC&tag=v"
	w := h.do(&rdrID, "GET", "/api/websites/"+site+"/stats?"+q, "", map[string]string{
		"Authorization": "Bearer umami_x", "Cookie": "a=b", "X-Forwarded-For": "198.51.100.7", HeaderCache: "t",
	})
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	got := h.umami.last(t)
	if got.Query != q || got.Path != "/api/websites/"+site+"/stats" {
		t.Fatalf("forwarded %s?%s", got.Path, got.Query)
	}
	if got.Header.Get("Authorization") != "Bearer umami_x" {
		t.Fatal("Authorization not forwarded")
	}
	for _, hname := range []string{"Cookie", "X-Forwarded-For", HeaderCache} {
		if got.Header.Get(hname) != "" {
			t.Errorf("%s forwarded", hname)
		}
	}
	if w.Header().Get("Set-Cookie") != "" {
		t.Error("Set-Cookie passed back")
	}
}

func TestControlPlaneForwardCarriesCertificateIdentity(t *testing.T) {
	h := newHarness(t, true)
	w := h.do(&edgeID, "GET", "/internal/v1/edge/snapshot", "", map[string]string{
		"If-None-Match": `"42"`, HeaderEdgeNode: "edge-b9", "Authorization": "x",
	})
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	got := h.cp.last(t)
	if got.Header.Get(HeaderEdgeNode) != "edge-a1" {
		t.Fatalf("identity header = %q", got.Header.Get(HeaderEdgeNode))
	}
	if got.Header.Get("If-None-Match") != `"42"` || got.Header.Get("Authorization") != "" {
		t.Fatalf("headers = %v", got.Header)
	}
	h.do(&edgeID, "POST", "/internal/v1/edge/counters", `{"node_id":"edge-a1"}`, map[string]string{"Content-Type": "application/json"})
	if got := h.cp.last(t); got.Method != "POST" || string(got.Body) != `{"node_id":"edge-a1"}` {
		t.Fatalf("counters forward = %+v", got)
	}
	if len(h.umami.requests()) != 0 {
		t.Fatal("internal edge API reached Umami")
	}
}

func TestRefusalsNeverReachUpstreams(t *testing.T) {
	h := newHarness(t, true)
	for _, tc := range []struct {
		id     policy.Identity
		m, u   string
		status int
	}{
		{edgeID, "POST", "/api/batch", 403},
		{edgeID, "GET", "/api/heartbeat", 403},
		{rdrID, "POST", "/api/send", 403},
		{rdrID, "GET", "/api/websites/" + site + "/export", 403},
		{provID, "POST", "/api/teams/join", 403},
		{provID, "GET", "/openapi.json", 403},
		{provID, "POST", "/api/auth/logout", 403},
	} {
		if w := h.do(&tc.id, tc.m, tc.u, "", nil); w.Code != tc.status {
			t.Errorf("%s %s %s = %d, want %d", tc.id.Role, tc.m, tc.u, w.Code, tc.status)
		}
	}
	if w := h.do(nil, "POST", "/api/send", event(site, at(10, 0), ""), sendHeaders("track")); w.Code != 403 {
		t.Errorf("no certificate = %d", w.Code)
	}
	if n := len(h.umami.requests()) + len(h.cp.requests()); n != 0 {
		t.Fatalf("upstreams received %d requests", n)
	}
	if h.metrics.Get("scf_engine_proxy_denials_total", "node", "edge-a1", "role", "edge", "reason", "deny_list") != 1 {
		t.Error("denial not counted")
	}
}

// ------------------------------------------------------------------ privacy of logs and metrics

func TestLogsAndMetricsNeverContainPersonalOrSecretValues(t *testing.T) {
	h := newHarness(t, true)
	h.send(t, at(10, 0), "track")
	h.send(t, at(10, 5), "track")
	hd := sendHeaders("track")
	hd[HeaderSurrogate] = "203.0.113.77"
	h.do(&edgeID, "POST", "/api/send", event(site, at(10, 6), `,"ip":"198.51.100.99"`), hd)
	h.do(&rdrID, "GET", "/api/websites/"+site+"/stats?startAt=1794441600000&endAt=1794527999999&timezone=UTC", "",
		map[string]string{"Authorization": "Bearer umami_SECRETKEY0123456789abcdefghijk"})
	h.do(&rdrID, "GET", "/api/websites/"+site+"/stats?startAt=1&endAt=2&timezone=UTC&url=/secret-path", "", nil)
	h.do(&provID, "POST", "/api/auth/login", `{"username":"scf-provisioner","password":"hunter2-provisioning"}`, nil)
	h.umamiTS.Close() // transport errors embed URLs and addresses in Go's error strings
	h.send(t, at(10, 7), "track")
	h.do(&rdrID, "GET", "/api/websites/"+site+"/stats?startAt=1794441600000&endAt=1794527999999&timezone=UTC", "", nil)
	ServerErrorLog(slog.New(slog.NewJSONHandler(h.logs, nil))).Printf("http: TLS handshake error from 192.0.2.44:51234: EOF")

	mw := httptest.NewRecorder()
	h.metrics.Handler(h.store, h.gate).ServeHTTP(mw, httptest.NewRequest("GET", "/metrics", nil))
	for name, text := range map[string]string{"logs": h.logs.String(), "metrics": mw.Body.String()} {
		if text == "" {
			t.Fatalf("no %s captured", name)
		}
		for _, bad := range []string{
			sur, "2001:db8", "203.0.113", "198.51.100", "192.0.2", "127.0.0.1", // surrogates and addresses
			"tok-", "sess-", "visitid-", // cache tokens, session and visit ids
			chromeUA, "Mozilla", // User-Agent
			"startAt", "timezone=", "secret-path", "?", // query strings
			"umami_SECRET", "hunter2", "Bearer", // credentials
			site, // ids in paths (routes are templates)
		} {
			if strings.Contains(text, bad) {
				t.Errorf("%s contain %q:\n%s", name, bad, text)
			}
		}
	}
	// The lines are still useful: they have the route template and the visit decision.
	logs := h.logs.String()
	for _, want := range []string{`"route":"POST /api/send"`, `"visit":"hit"`, `"reason":"forbidden_field"`,
		`"error_kind":"connection_refused"`, `"kind":"tls_handshake"`, `"route":"GET /api/websites/{id}/stats"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs lack %s", want)
		}
	}
	// Every line is JSON.
	for _, line := range strings.Split(strings.TrimSpace(logs), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Errorf("not JSON: %q", line)
		}
	}
}

func TestMetricsExposeCounters(t *testing.T) {
	h := newHarness(t, true)
	h.send(t, at(10, 0), "track")
	h.send(t, at(10, 5), "track")
	w := httptest.NewRecorder()
	h.metrics.Handler(h.store, h.gate).ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	body := w.Body.String()
	for _, want := range []string{
		"scf_engine_proxy_visit_tokens 1",
		"scf_engine_proxy_visit_lookup_hits_total 1",
		"scf_engine_proxy_visit_lookup_misses_total 1",
		"scf_engine_proxy_bootstrap_gate_open 1",
		`scf_engine_proxy_requests_total{role="edge",route="POST /api/send",code="200"} 2`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics lack %q\n%s", want, body)
		}
	}
}
