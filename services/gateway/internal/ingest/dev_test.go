// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
)

// Dev/preview origins and debug mode (wire-formats §a.6 step 1, §a.8, §b.1, §b.3; C-136, C-137).

const devOrigin = "http://localhost:3000"

func devEnv(t *testing.T, mod func(*snapshot.Site)) *env {
	t.Helper()
	e := newEnv(t, nil, "")
	e.payloadMod = func(p *snapshot.Payload) { p.Settings.CounterFeatures = []string{"props", "dev"} }
	s := baseSite()
	s.DevOrigins = []string{"localhost", "127.0.0.1", "myapp-*.vercel.app", "example.org"}
	if mod != nil {
		mod(&s)
	}
	e.apply(s, "active")
	return e
}

// testNow is the clock of every test env (newEnv).
var testNow = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

func debugUntil(d time.Duration) func(*snapshot.Site) {
	return func(s *snapshot.Site) {
		u := testNow.Add(d).Format(time.RFC3339)
		s.DebugUntil = &u
	}
}

func httptestPreflight(h http.Handler, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodOptions, "/v1/e", nil)
	r.Header.Set("Origin", origin)
	r.Header.Set("Access-Control-Request-Method", "POST")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	return rr
}

// (a) at unit level: dev events change no counter, no property row, nothing in the spool, no quota, per-site rate,
// multiplicity, rate-history, nonce or event-id state; they land in the `dev` buffer only.
func TestDevEventsAreNeverCounted(t *testing.T) {
	e := devEnv(t, func(s *snapshot.Site) { s.DailyQuota = 1; s.RateLimitPerMin = 2 })
	for i := 0; i < 6; i++ {
		tok, c := e.browser("203.0.113.5", chrome, devOrigin)
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: batch(tok, &c, goodSG,
			fmt.Sprintf(`{"id":"%s","k":"pv","u":"/dev/%d?secret=1"}`, eid(), i),
			wl(`"sv":1,"n":"wallet_connect","wt":"freighter","net":"testnet","ck":"new"`),
			wl(`"sv":1,"n":"tx_submitted","net":"testnet","rc":"success"`),
			`{"id":"`+eid()+`","k":"ev","u":"/","n":"signup","d":{"plan":"pro"}}`)})
		if rr.Code != 202 {
			t.Fatalf("dev batch %d: %d", i, rr.Code)
		}
		if got := rr.Header().Get(DebugHeader); got != "v=1; class=dev; reasons=dev_origin" {
			t.Fatalf("dev header outside debug mode: %q", got)
		}
		if rr.Header().Get("Access-Control-Allow-Origin") != devOrigin || rr.Header().Get("Access-Control-Expose-Headers") != DebugHeader {
			t.Fatalf("dev CORS: %v", rr.Header())
		}
	}
	if len(e.sp.recs) != 0 {
		t.Fatalf("dev events spooled: %d", len(e.sp.recs))
	}
	if rows := e.agg.WebRows(siteID); len(rows) != 0 {
		t.Fatalf("dev events counted: %v", rows)
	}
	if e.agg.PropRows(siteID) != 0 {
		t.Fatal("dev events reached the property rollup")
	}
	dev := e.agg.Dev(siteID)
	if len(dev) != 20 { // 24 events, at most 20 per site and record (§a.8)
		t.Fatalf("dev entries %d", len(dev))
	}
	kinds := map[string]bool{}
	for _, d := range dev {
		kinds[d.Kind+"/"+d.Name] = true
		if d.WouldBe != "verified" || d.Reason != nil || d.TenantID != tenant || strings.ContainsAny(d.Path, "?#") {
			t.Fatalf("dev entry %+v", d)
		}
	}
	for _, k := range []string{"pageview/pageview", "stellar/wallet_connect", "stellar/tx_submitted", "custom/signup"} {
		if !kinds[k] {
			t.Errorf("dev entry %s missing: %v", k, kinds)
		}
	}
	b, _ := json.Marshal(dev)
	for _, leak := range []string{"203.0.113", "localhost", "Chrome", "pro", "secret", "freighter", "testnet"} {
		if strings.Contains(string(b), leak) {
			t.Fatalf("dev entries carry %q: %s", leak, b)
		}
	}
	// Quota (1 verified/day), per-site rate (2/min) and multiplicity are untouched: production still gets through.
	for i := 0; i < 2; i++ {
		tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/prod"))})
		want := []int{202, 429}[i] // the second one hits the quota of 1, not anything the dev traffic used
		if rr.Code != want {
			t.Fatalf("production batch %d after dev traffic: %d", i, rr.Code)
		}
		if rr.Header().Get(DebugHeader) != "" {
			t.Fatal("no debug header outside debug mode on production traffic")
		}
	}
	if e.agg.Get(tenant, siteID, e.now, "multiplicity", "one") != 1 || e.reasons()["multiplicity_high"] != 0 || e.reasons()["rate_anomaly"] != 0 {
		t.Fatalf("production verdict state touched by dev traffic: %v %v", e.agg.WebRows(siteID), e.reasons())
	}
}

// (b) a dev-issued token is refused on a production batch; a production token works on a dev batch.
func TestDevTokenRefusedOnProductionBatch(t *testing.T) {
	e := devEnv(t, nil)
	tok, c := e.browser("203.0.113.5", chrome, devOrigin)
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/stolen"))})
	if rr.Code != 202 || len(e.sp.recs) != 0 {
		t.Fatalf("dev token on production: %d, %d records", rr.Code, len(e.sp.recs))
	}
	if e.reasons()["challenge_invalid"] != 1 || e.agg.Get(tenant, siteID, e.now, "verdict", "rejected") != 1 {
		t.Fatalf("reasons %v", e.reasons())
	}
	// The same token is fine on a dev batch.
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: batch(tok, &c, goodSG, pv("/ok"))})
	if d := e.agg.Dev(siteID); len(d) != 1 || d[0].WouldBe != "verified" {
		t.Fatalf("dev token on a dev batch: %+v", d)
	}
	// A production token on a dev batch is not a dev-bit violation.
	ptok, pc := e.browser("203.0.113.5", chrome, "https://example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: batch(ptok, &pc, goodSG, pv("/p"))})
	if d := e.agg.Dev(siteID); len(d) != 2 || d[1].WouldBe != "verified" {
		t.Fatalf("production token on a dev batch: %+v", d)
	}
	// Without proof the would-be verdict says why, in the dev buffer (never in the header outside debug mode).
	tok2, _ := e.browser("203.0.113.5", chrome, devOrigin)
	rr = e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: batch(tok2, nil, goodSG, pv("/np"))})
	if d := e.agg.Dev(siteID); d[2].WouldBe != "suspect" || d[2].Reason == nil || *d[2].Reason != "proof_missing" {
		t.Fatalf("would-be verdict %+v", d[2])
	}
	if rr.Header().Get(DebugHeader) != "v=1; class=dev; reasons=dev_origin" {
		t.Fatalf("header leaks the would-be verdict: %q", rr.Header().Get(DebugHeader))
	}
}

func TestDeclaredDomainWinsOverDevOrigin(t *testing.T) {
	e := devEnv(t, nil) // example.org is both a declared domain and a dev origin
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))})
	if rr.Code != 202 || len(e.sp.recs) != 1 || rr.Header().Get(DebugHeader) != "" || len(e.agg.Dev(siteID)) != 0 {
		t.Fatalf("declared domain must be production: %d recs=%d header=%q", rr.Code, len(e.sp.recs), rr.Header().Get(DebugHeader))
	}
}

// (c) outside debug mode the header says nothing beyond class=dev; production requests get no header at all.
func TestDebugHeaderLeaksNothingOutsideDebugMode(t *testing.T) {
	e := devEnv(t, debugUntil(-time.Second)) // debug mode ended a second ago
	check := func(name, origin string, body string, headers map[string]string, want string) {
		t.Helper()
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: origin, body: body, headers: headers})
		if got := rr.Header().Get(DebugHeader); got != want {
			t.Errorf("%s: header %q, want %q", name, got, want)
		}
		if rr.Code != 202 {
			t.Errorf("%s: status %d (C-39)", name, rr.Code)
		}
	}
	// Production: rejected (no token), wrong origin, GPC — nothing.
	check("prod rejected", "https://example.org", batch("", nil, goodSG, pv("/")), nil, "")
	check("prod wrong origin", "https://evil.test", batch("", nil, goodSG, pv("/")), nil, "")
	check("prod gpc", "https://example.org", batch("", nil, goodSG, pv("/")), map[string]string{"Sec-GPC": "1"}, "")
	// Dev: rejected/bot/GPC/suspect — only class=dev.
	check("dev rejected", devOrigin, batch("", nil, goodSG, pv("/")), nil, "v=1; class=dev; reasons=dev_origin")
	check("dev gpc", devOrigin, batch("", nil, goodSG, pv("/")), map[string]string{"Sec-GPC": "1"}, "v=1; class=dev; reasons=dev_origin")
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: "curl/8.14.0", origin: devOrigin, body: batch("", nil, "", pv("/"))})
	if rr.Header().Get(DebugHeader) != "v=1; class=dev; reasons=dev_origin" {
		t.Errorf("bot on dev: %q", rr.Header().Get(DebugHeader))
	}
	// The challenge: dev gets class=dev, production nothing.
	cr := e.do(req{path: "/v1/c", ip: "203.0.113.5", ua: chrome, origin: "https://evil.test", body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`})
	if cr.Header().Get(DebugHeader) != "" || cr.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("challenge from a foreign origin outside debug mode: %v", cr.Header())
	}
	cr = e.do(req{path: "/v1/c", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`})
	if cr.Header().Get(DebugHeader) != "v=1; class=dev; reasons=dev_origin" {
		t.Errorf("dev challenge header %q", cr.Header().Get(DebugHeader))
	}
	// The dev rate limit shows only dev_rate_limited.
	e2 := devEnv(t, nil)
	e2.payloadMod = func(p *snapshot.Payload) { p.Settings.DevEventsPerMinSite = 3 }
	s := baseSite()
	s.DevOrigins = []string{"localhost"}
	e2.apply(s, "active")
	codes, headers := []int{}, []string{}
	for i := 0; i < 3; i++ {
		rr := e2.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: batch("", nil, goodSG, pv("/a"), pv("/b"))})
		codes, headers = append(codes, rr.Code), append(headers, rr.Header().Get(DebugHeader))
	}
	if fmt.Sprint(codes) != "[202 202 202]" || headers[0] != "v=1; class=dev; reasons=dev_origin" || headers[1] != "v=1; class=dev; reasons=dev_origin,dev_rate_limited" {
		t.Fatalf("dev rate limit: %v %v", codes, headers)
	}
	if len(e2.agg.Dev(siteID)) != 2 || len(e2.agg.WebRows(siteID)) != 0 {
		t.Fatalf("dev-rate-limited events must be dropped uncounted: %v", e2.agg.WebRows(siteID))
	}
}

func TestDebugModeFullHeader(t *testing.T) {
	e := devEnv(t, debugUntil(time.Hour))
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	cases := []struct {
		name, origin, body string
		headers            map[string]string
		want               string
	}{
		{"verified", "https://example.org", batch(tok, &c, goodSG, pv("/")), nil, "v=1; class=verified; reasons=none"},
		{"rejected", "https://example.org", batch("", nil, goodSG, pv("/")), nil, "v=1; class=rejected; reasons=challenge_missing"},
		{"origin mismatch", "https://evil.test", batch("", nil, goodSG, pv("/")), nil, "v=1; class=rejected; reasons=origin_mismatch,challenge_missing"},
		{"gpc", "https://example.org", batch("", nil, goodSG, pv("/")), map[string]string{"DNT": "1"}, "v=1; class=dropped; reasons=gpc_dnt"},
	}
	for _, cs := range cases {
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: cs.origin, body: cs.body, headers: cs.headers})
		if rr.Code != 202 || rr.Header().Get(DebugHeader) != cs.want {
			t.Errorf("%s: %d %q, want %q", cs.name, rr.Code, rr.Header().Get(DebugHeader), cs.want)
		}
		if rr.Header().Get("Access-Control-Allow-Origin") != cs.origin || !strings.Contains(rr.Header().Get("Access-Control-Expose-Headers"), DebugHeader) {
			t.Errorf("%s: debug mode must allow any origin and expose the header: %v", cs.name, rr.Header())
		}
	}
	dtok, _ := e.browser("203.0.113.5", chrome, devOrigin)
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: batch(dtok, nil, goodSG, pv("/"))})
	if got := rr.Header().Get(DebugHeader); got != "v=1; class=dev; reasons=dev_origin,proof_missing" {
		t.Errorf("dev would-be in debug mode: %q", got)
	}
	for origin, want := range map[string]string{"https://example.org": "v=1; class=challenge; reasons=none",
		"https://evil.test": "v=1; class=challenge; reasons=origin_mismatch", devOrigin: "v=1; class=challenge; reasons=dev_origin"} {
		cr := e.do(req{path: "/v1/c", ip: "203.0.113.5", ua: chrome, origin: origin, body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`})
		if cr.Code != 200 || cr.Header().Get(DebugHeader) != want {
			t.Errorf("challenge %s: %q", origin, cr.Header().Get(DebugHeader))
		}
	}
	// A 429 keeps its status; the header explains it, and both headers are exposed.
	e2 := devEnv(t, func(s *snapshot.Site) { s.Status = "over_quota"; debugUntil(time.Hour)(s) })
	rr = e2.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch("", nil, goodSG, pv("/"))})
	if rr.Code != 429 || rr.Header().Get(DebugHeader) != "v=1; class=dropped; reasons=quota_exceeded" ||
		rr.Header().Get("Access-Control-Expose-Headers") != "Retry-After, X-Scf-Debug" {
		t.Errorf("429 in debug mode: %d %v", rr.Code, rr.Header())
	}
}

func TestDevRequestsPayTheSubnetLimitAndProofCost(t *testing.T) {
	e := devEnv(t, nil)
	e.payloadMod = func(p *snapshot.Payload) { p.Settings.WebRequestsPerMinSubnet = 3 }
	s := baseSite()
	s.DevOrigins = []string{"localhost"}
	e.apply(s, "active")
	codes := []int{}
	for i := 0; i < 4; i++ {
		codes = append(codes, e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: devOrigin, body: batch("", nil, goodSG, pv("/"))}).Code)
	}
	if fmt.Sprint(codes) != "[202 202 202 429]" {
		t.Fatalf("dev requests must consume the per-subnet limit: %v", codes)
	}
	// The dev 429 is not counted; production from the same subnet shares the exhausted limit.
	if e.agg.Get(tenant, siteID, e.now, "drop", "rate_limited") != 0 {
		t.Fatal("a dev 429 must not be counted")
	}
	if rr := e.do(req{path: "/v1/e", ip: "203.0.113.9", ua: chrome, origin: "https://example.org", body: batch("", nil, goodSG, pv("/"))}); rr.Code != 429 {
		t.Fatalf("production from the subnet a dev client exhausted: %d", rr.Code)
	}
	// Challenges too (the adaptive proof cost is the production code path: TestChallengeEndpoint).
	codes = codes[:0]
	for i := 0; i < 4; i++ {
		codes = append(codes, e.do(req{path: "/v1/c", ip: "198.51.100.7", ua: chrome, origin: devOrigin, body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`}).Code)
	}
	if fmt.Sprint(codes) != "[200 200 200 429]" || e.agg.Get(tenant, siteID, e.now, "drop", "rate_limited") != 1 { // the production 429 only
		t.Fatalf("dev challenges: %v", codes)
	}
}

func TestDevOriginsCORSPreflight(t *testing.T) {
	e := devEnv(t, nil)
	h := e.srv.Handler(http.NotFoundHandler(), func() (bool, string) { return true, "" })
	for origin, want := range map[string]bool{devOrigin: true, "https://myapp-pr-12.vercel.app": true, "https://other.vercel.app": false,
		"http://myapp-pr-12.vercel.app": false, "https://example.org": true, "https://evil.test": false} {
		rr := httptestPreflight(h, origin)
		if (rr.Header().Get("Access-Control-Allow-Origin") == origin) != want {
			t.Errorf("preflight %s: %v", origin, rr.Header())
		}
	}
}
