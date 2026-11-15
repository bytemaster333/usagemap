// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/challenge"
	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/geo"
	"github.com/bytemaster333/usagemap/services/gateway/internal/keys"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/multiplicity"
	"github.com/bytemaster333/usagemap/services/gateway/internal/netclass"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
	"github.com/bytemaster333/usagemap/services/gateway/internal/transport"
)

const (
	siteKey = "Q4mZ8bS1pTn0aR7cLx2VwE"
	siteID  = "0193b7e2-0000-7000-8000-0000000000a1"
	tenant  = "0193b7e2-0000-7000-8000-00000000000a"
	website = "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
	twin    = "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a42"
	chrome  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Safari/537.36"
)

type memSpool struct {
	mu       sync.Mutex
	recs     []*spool.EventRecord
	fail     error
	barriers int // Append calls without records (commit barrier)
}

func (m *memSpool) Append(_ context.Context, recs []spool.Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(recs) == 0 {
		m.barriers++
	}
	if m.fail != nil {
		return m.fail
	}
	for _, r := range recs {
		m.recs = append(m.recs, r.(*spool.EventRecord))
	}
	return nil
}

type fakeGeo map[string]string

func (g fakeGeo) Country(a netip.Addr) string {
	if c, ok := g[geo.Truncate(a).String()]; ok {
		return c
	}
	return "XX"
}

type env struct {
	srv   *Server
	sp    *memSpool
	agg   *counters.Agg
	now   time.Time
	store *snapshot.Store
	priv  ed25519.PrivateKey
	seq   int64
	t     *testing.T
	// payloadMod adjusts every snapshot payload apply builds (settings of the D1 tests).
	payloadMod func(*snapshot.Payload)
}

func baseSite() snapshot.Site {
	tw := twin
	return snapshot.Site{SiteID: siteID, TenantID: tenant, SiteKey: siteKey, UmamiWebsiteID: website, UmamiTwinWebsiteID: &tw,
		Status: "active", Profile: "standard", VisitorID: "on", VisitorIDOffCountries: []string{}, ExcludeCountries: []string{},
		PathFolding: "full", RateLimitPerMin: 6000, DailyQuota: 1000000,
		Domains: []snapshot.Domain{{Host: "example.org", IncludeSubdomains: true, Verified: true}, {Host: "staging.test", Verified: false}}}
}

func newEnv(t *testing.T, mod func(*snapshot.Site), classDir string) *env {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	e := &env{now: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC), priv: priv, t: t, sp: &memSpool{}, agg: counters.New()}
	e.store = snapshot.NewStore(filepath.Join(t.TempDir(), "s.json"), snapshot.Keys{"k": pub})
	site := baseSite()
	if mod != nil {
		mod(&site)
	}
	e.apply(site, "active")
	ring, _ := keys.NewRing(func() time.Time { return e.now })
	for _, k := range keys.Kinds {
		_, _ = ring.Generate(k, keys.ID(k, e.now))
	}
	e.srv = &Server{Snap: e.store, Ring: ring, Geo: fakeGeo{"203.0.113.0": "DE", "198.51.100.0": "RU"}, Net: netclass.New(classDir), Mult: multiplicity.New(),
		Spool: e.sp, Counters: e.agg, Metrics: metrics.New(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return e.now }}
	e.srv.Init()
	return e
}

func (e *env) apply(site snapshot.Site, tenantStatus string) {
	e.seq++
	p := snapshot.Payload{Sequence: e.seq, IssuedAt: e.now.Format(time.RFC3339),
		Settings: snapshot.Settings{PowCost: 256, PowMax: 32, PowMaxMultiplier: 8, WebEventsPerToken: 5, WebRequestsPerMinSubnet: 600,
			MultiplicityThresholds:      snapshot.Thresholds{"exact_ip": {"datacenter": 3, "unknown": 6}, "subnet": {"datacenter": 6, "unknown": 24}},
			MultiplicityEventThresholds: snapshot.Thresholds{"exact_ip": {"unknown": 60}, "subnet": {"unknown": 240}}, PathnormRulesVersion: "scf-path-rules/1.0.0"},
		Tenants:         []snapshot.Tenant{{TenantID: tenant, Status: tenantStatus, Level: 1}},
		Sites:           []snapshot.Site{site},
		TrackerVersions: []snapshot.TrackerVersion{{Version: "1.0.0", Status: "active"}, {Version: "0.9.0", Status: "withdrawn"}},
	}
	if e.payloadMod != nil {
		e.payloadMod(&p)
	}
	pb, _ := json.Marshal(p)
	env := snapshot.Envelope{Format: snapshot.Format, Alg: "Ed25519", Kid: "k", Payload: base64.RawURLEncoding.EncodeToString(pb), Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(e.priv, pb))}
	raw, _ := json.Marshal(env)
	if err := e.store.Apply(raw); err != nil {
		e.t.Fatal(err)
	}
}

type req struct {
	path    string
	body    string
	ip      string
	ua      string
	origin  string
	headers map[string]string
	tr      *transport.Snapshot // connection fingerprint (nil = plaintext listener, no check)
}

func (e *env) do(r req) *httptest.ResponseRecorder {
	hr := httptest.NewRequest(http.MethodPost, r.path, strings.NewReader(r.body))
	hr.RemoteAddr = r.ip + ":4242"
	if strings.Contains(r.ip, ":") {
		hr.RemoteAddr = "[" + r.ip + "]:4242"
	}
	hr.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	hr.Header.Set("User-Agent", r.ua)
	if r.origin != "" {
		hr.Header.Set("Origin", r.origin)
	}
	hr.Header.Set("Sec-Fetch-Mode", "cors")
	hr.Header.Set("Sec-Fetch-Site", "cross-site")
	hr.Header.Set("Sec-Fetch-Dest", "empty")
	hr.Header.Set("Accept-Language", "en-US,en;q=0.9")
	for k, v := range r.headers {
		if v == "" {
			hr.Header.Del(k)
		} else {
			hr.Header.Set(k, v)
		}
	}
	if r.tr != nil {
		hr = hr.WithContext(transport.ContextWith(hr.Context(), *r.tr))
	}
	rr := httptest.NewRecorder()
	if r.path == "/v1/c" {
		e.srv.Challenge(rr, hr)
	} else {
		e.srv.Events(rr, hr)
	}
	return rr
}

// browser fetches a challenge and solves it like the tracker.
func (e *env) browser(ip, ua, origin string) (string, uint32) {
	e.t.Helper()
	rr := e.do(req{path: "/v1/c", body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`, ip: ip, ua: ua, origin: origin})
	if rr.Code != 200 {
		e.t.Fatalf("challenge: %d %s", rr.Code, rr.Body)
	}
	var c struct {
		T   string `json:"t"`
		Pow struct {
			Cost, Max int
			Pfx       string
		} `json:"pow"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &c)
	n, ok := challenge.Solve(c.T, c.Pow.Cost, c.Pow.Max, c.Pow.Pfx)
	if !ok {
		e.t.Fatal("unsolvable")
	}
	return c.T, n
}

var idn int

func eid() string {
	idn++
	return fmt.Sprintf("%022d", idn)
}

func pv(path string) string { return `{"id":"` + eid() + `","k":"pv","u":"` + path + `"}` }

func batch(token string, c *uint32, sg string, events ...string) string {
	s := `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0","t":"` + token + `"`
	if c != nil {
		s += fmt.Sprintf(`,"c":%d`, *c)
	}
	if sg != "" {
		s += `,"sg":` + sg
	}
	return s + `,"e":[` + strings.Join(events, ",") + `]}`
}

const goodSG = `{"wd":0,"vis":"v","act":1}`

func (e *env) reasons() map[string]int64 {
	out := map[string]int64{}
	for _, r := range []string{"ua_bot", "origin_mismatch", "fetch_impossible", "challenge_missing", "challenge_invalid", "challenge_expired",
		"proof_invalid", "token_flood", "tenant_pending", "tenant_suspended", "proof_missing", "challenge_unverifiable", "ctx_moved",
		"domain_unverified", "automation_flag", "hidden_or_prerender", "net_datacenter", "multiplicity_high", "header_inconsistent", "transport_mismatch",
		"origin_missing", "rate_anomaly"} {
		if n := e.agg.Get(tenant, siteID, e.now, "reason", r); n > 0 {
			out[r] = n
		}
	}
	return out
}

func TestVerifiedEndToEnd(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, c := e.browser("203.0.113.77", chrome, "https://www.example.org")
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.77", ua: chrome, origin: "https://www.example.org",
		body: batch(tok, &c, goodSG, `{"id":"`+eid()+`","k":"pv","u":"/pricing?utm_source=x#frag","r":"news.ycombinator.com","w":"l","l":"en","wk":true}`)})
	if rr.Code != 202 || rr.Body.Len() != 0 {
		t.Fatalf("status %d %q", rr.Code, rr.Body)
	}
	if rr.Header().Get("Access-Control-Allow-Origin") != "https://www.example.org" {
		t.Fatal("CORS for a declared domain")
	}
	if len(e.sp.recs) != 1 {
		t.Fatalf("records %d", len(e.sp.recs))
	}
	r := e.sp.recs[0]
	if r.Tag != "v" || r.Target != "main" || *r.UmamiWebsiteID != website || r.Country != "DE" || r.URL != "/pricing" ||
		r.Hostname != "www.example.org" || r.ReferrerHost != "news.ycombinator.com" || r.Screen != "1536x864" || r.Language != "en" ||
		r.ReceivedAtMs != e.now.UnixMilli() || r.UA != "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" {
		t.Fatalf("record %+v", r)
	}
	if a := netip.MustParseAddr(r.Surrogate); !netip.MustParsePrefix("2001:db8::/32").Contains(a) {
		t.Fatalf("surrogate %s", r.Surrogate)
	}
	if e.agg.Get(tenant, siteID, e.now, "verdict", "verified") != 1 || e.agg.Get(tenant, siteID, e.now, "kit_present_pageviews", "all") != 1 ||
		e.agg.Get(tenant, siteID, e.now, "identifier", "identified") != 1 {
		t.Fatal("counters")
	}
	// C-129: the tracker version of an accepted event (payload tv 1.0.0 → label v1_0_0)
	if got := e.agg.Get(tenant, siteID, e.now, "tracker_version", "v1_0_0"); got != 1 {
		t.Fatalf("tracker_version/v1_0_0 = %d, want 1", got)
	}
	if len(e.reasons()) != 0 {
		t.Fatalf("unexpected reasons %v", e.reasons())
	}
	// Same visitor, same day → same surrogate; another IP → another one.
	tok2, c2 := e.browser("203.0.113.77", chrome, "https://www.example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.77", ua: chrome, origin: "https://www.example.org", body: batch(tok2, &c2, goodSG, pv("/a"))})
	tok3, c3 := e.browser("203.0.113.78", chrome, "https://www.example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.78", ua: chrome, origin: "https://www.example.org", body: batch(tok3, &c3, goodSG, pv("/b"))})
	if e.sp.recs[1].Surrogate != r.Surrogate || e.sp.recs[2].Surrogate == r.Surrogate {
		t.Fatal("surrogate must be stable per (site, ip, ua, day) and differ across addresses")
	}
}

func TestScriptedPostWithoutChallengeIsRejected(t *testing.T) {
	e := newEnv(t, nil, "")
	for _, tok := range []string{"", "garbage", strings.Repeat("A", 123)} {
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.9", ua: chrome, origin: "https://example.org", body: batch(tok, nil, "", pv("/x"))})
		if rr.Code != 202 {
			t.Fatalf("%q: status %d (must be 202 whatever the verdict)", tok, rr.Code)
		}
	}
	// A body without t at all is also a well-formed batch.
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.9", ua: chrome, origin: "https://example.org", body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0","e":[` + pv("/y") + `]}`})
	if rr.Code != 202 {
		t.Fatal(rr.Code)
	}
	if len(e.sp.recs) != 0 {
		t.Fatal("rejected events must never be spooled")
	}
	r := e.reasons()
	if r["challenge_missing"] != 4 || e.agg.Get(tenant, siteID, e.now, "verdict", "rejected") != 4 {
		t.Fatalf("reasons %v", r)
	}
	// rejected events are not counted under tracker_version (C-129: verified + suspect only)
	if got := e.agg.Get(tenant, siteID, e.now, "tracker_version", "v1_0_0"); got != 0 {
		t.Fatalf("tracker_version counted %d rejected events", got)
	}
}

func TestRejectReasons(t *testing.T) {
	cases := map[string]struct {
		ip, ua, origin string
		headers        map[string]string
		tamper         func(tok string, c uint32) (string, *uint32)
		advance        time.Duration
		want           string
	}{
		"origin mismatch":  {origin: "https://evil.test", want: "origin_mismatch"},
		"ua bot":           {ua: "curl/8.5.0", want: "ua_bot"},
		"headless chrome":  {ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36", want: "ua_bot"},
		"fetch impossible": {headers: map[string]string{"Sec-Fetch-Mode": "navigate"}, want: "fetch_impossible"},
		"proof invalid":    {tamper: func(t string, c uint32) (string, *uint32) { x := (c + 1) % 32; return t, &x }, want: "proof_invalid"},
		"expired":          {advance: 31 * time.Minute, want: "challenge_expired"},
	}
	for name, c := range cases {
		e := newEnv(t, nil, "")
		ip, ua, origin := "203.0.113.5", chrome, "https://example.org"
		tok, n := e.browser(ip, ua, origin)
		if c.ua != "" {
			ua = c.ua
		}
		if c.origin != "" {
			origin = c.origin
		}
		cp := &n
		if c.tamper != nil {
			tok, cp = c.tamper(tok, n)
		}
		e.now = e.now.Add(c.advance)
		rr := e.do(req{path: "/v1/e", ip: ip, ua: ua, origin: origin, headers: c.headers, body: batch(tok, cp, goodSG, pv("/r"))})
		if rr.Code != 202 || len(e.sp.recs) != 0 || e.reasons()[c.want] != 1 {
			t.Errorf("%s: code %d records %d reasons %v", name, rr.Code, len(e.sp.recs), e.reasons())
		}
	}
}

func TestTenantStatus(t *testing.T) {
	for _, st := range []string{"pending", "suspended"} {
		e := newEnv(t, nil, "")
		e.apply(baseSite(), st)
		tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))})
		if rr.Code != 202 || len(e.sp.recs) != 0 || e.reasons()["tenant_"+st] != 1 {
			t.Errorf("%s: %d %v", st, rr.Code, e.reasons())
		}
	}
}

func TestSuspectReasons(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "datacenter.txt"), []byte("192.0.2.0/24\n"), 0o644)
	cases := map[string]struct {
		ip, origin, sg string
		noProof        bool
		headers        map[string]string
		ua             string
		want           []string
	}{
		"proof missing":     {noProof: true, want: []string{"proof_missing"}},
		"datacenter":        {ip: "192.0.2.10", want: []string{"net_datacenter"}},
		"webdriver":         {sg: `{"wd":1,"vis":"v","act":1}`, want: []string{"automation_flag"}},
		"hidden pageview":   {sg: `{"wd":0,"vis":"h","act":1}`, want: []string{"hidden_or_prerender"}},
		"prerender":         {sg: `{"wd":0,"vis":"p","act":1}`, want: []string{"hidden_or_prerender"}},
		"unverified domain": {origin: "https://staging.test", want: []string{"domain_unverified"}},
		// A browser that sends fetch metadata always sends Origin on a cross-origin POST.
		"no origin, referer":  {origin: "-", headers: map[string]string{"Referer": "https://example.org/x"}, want: []string{"header_inconsistent"}},
		"no origin at all":    {origin: "-", want: []string{"origin_missing"}},
		"missing fetch meta":  {headers: map[string]string{"Sec-Fetch-Mode": "", "Sec-Fetch-Site": ""}, want: []string{"header_inconsistent"}},
		"missing lang":        {headers: map[string]string{"Accept-Language": ""}, want: []string{"header_inconsistent"}},
		"jsdom automation ua": {ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 jsdom/24", want: []string{"automation_flag"}},
	}
	for name, c := range cases {
		e := newEnv(t, nil, dir)
		ip, origin, sg, ua := "203.0.113.5", "https://example.org", goodSG, chrome
		if c.ip != "" {
			ip = c.ip
		}
		if c.origin != "" {
			origin = c.origin
		}
		if c.sg != "" {
			sg = c.sg
		}
		if c.ua != "" {
			ua = c.ua
		}
		tok, n := e.browser(ip, ua, "https://example.org")
		cp := &n
		if c.noProof {
			cp = nil
		}
		if origin == "-" {
			origin = ""
		}
		rr := e.do(req{path: "/v1/e", ip: ip, ua: ua, origin: origin, headers: c.headers, body: batch(tok, cp, sg, pv("/s"))})
		if rr.Code != 202 {
			t.Errorf("%s: %d", name, rr.Code)
			continue
		}
		got := e.reasons()
		if len(got) != len(c.want) {
			t.Errorf("%s: reasons %v, want %v", name, got, c.want)
			continue
		}
		for _, w := range c.want {
			if got[w] != 1 {
				t.Errorf("%s: reasons %v, want %v", name, got, c.want)
			}
		}
		wantTag := "v"
		if len(c.want) > 0 {
			wantTag = "s"
		}
		if len(e.sp.recs) != 1 || e.sp.recs[0].Tag != wantTag {
			t.Errorf("%s: records %d", name, len(e.sp.recs))
		}
	}
}

func TestStrictProfileStripsAndIgnoresSignals(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) { s.Profile = "strict" }, "")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org",
		body: batch(tok, &c, `{"wd":1,"vis":"h","act":0}`, `{"id":"`+eid()+`","k":"pv","u":"/","r":"a.test","w":"s","l":"de","wk":true}`)})
	if rr.Code != 202 || len(e.sp.recs) != 1 {
		t.Fatal(rr.Code)
	}
	r := e.sp.recs[0]
	if r.Tag != "v" || r.ReferrerHost != "" || r.Screen != "" || r.Language != "" {
		t.Fatalf("strict record %+v (signals must neither be kept nor make it suspect)", r)
	}
	if e.agg.Get(tenant, siteID, e.now, "drop", "profile_field_stripped") != 2 || e.agg.Get(tenant, siteID, e.now, "kit_present_pageviews", "all") != 0 {
		t.Fatal("profile_field_stripped counter")
	}
}

func TestPathAndPropertyScrubbing(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	acct := "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"
	seed := "S" + strings.Repeat("A", 55)
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG,
		`{"id":"`+eid()+`","k":"pv","u":"/account/`+acct+`/x/`+seed+`?q=1"}`,
		`{"id":"`+eid()+`","k":"ev","u":"/u/alice@example.org","n":"signup","d":{"plan":"free","who":"bob@example.org","addr":"`+acct+`","n":3,"ok":true}}`,
		`{"id":"`+eid()+`","k":"ev","u":"/","n":"`+strings.Repeat("ab12", 9)+`"}`,
		`{"id":"`+eid()+`","k":"wl","u":"/swap","n":"sign_completed","wid":"varial","sk":"tx","dur":"5_30s","err":"other","net":"public"}`,
		`{"id":"`+eid()+`","k":"wl","u":"/swap","n":"wallet_connected","wid":"varial","net":"public","sk":"tx"}`)})
	if rr.Code != 202 {
		t.Fatal(rr.Code)
	}
	if len(e.sp.recs) != 3 {
		t.Fatalf("records %d (the event with an unsafe name must be dropped)", len(e.sp.recs))
	}
	all, _ := json.Marshal(e.sp.recs)
	for _, leak := range []string{acct, seed, "alice@", "bob@", "q=1"} {
		if strings.Contains(string(all), leak) {
			t.Fatalf("%q reached the spool: %s", leak, all)
		}
	}
	if e.sp.recs[0].URL != "/account/{account}/x/{redacted}" || e.sp.recs[1].URL != "/u/{redacted}" {
		t.Fatalf("paths %q %q", e.sp.recs[0].URL, e.sp.recs[1].URL)
	}
	d := e.sp.recs[1].Data
	if d["plan"] != "free" || d["who"] != nil || d["addr"] != nil || d["ok"] != true {
		t.Fatalf("custom data %v", d)
	}
	// The legacy sign_completed is counted only (C-137); the legacy wallet_connected is forwarded as v1
	// wallet_connect with its fields under the rollup keys; the misplaced `sk` is stripped and counted (§a.3.1).
	w := e.sp.recs[2]
	if w.Kind != "wallet" || w.Name != "wallet_connect" || len(w.Data) != 3 || w.Data["wallet"] != "freighter" || w.Data["network"] != "mainnet" ||
		w.Data["connect_kind"] != "new" {
		t.Fatalf("wallet %+v", w)
	}
	if e.agg.Get(tenant, siteID, e.now, "drop", "profile_field_stripped") != 1 {
		t.Fatal("misplaced wallet field must be counted as stripped")
	}
	pk := counters.PropKey{Tenant: tenant, Site: siteID, Event: "sign_approved", Network: "mainnet", Key: "_total", Value: "all", Verdict: "verified"}
	if e.agg.GetProp(pk, e.now) != 1 {
		t.Fatal("legacy sign_completed must be counted as sign_approved")
	}
	pk.Key, pk.Value = "error_class", "unknown"
	if e.agg.GetProp(pk, e.now) != 0 {
		t.Fatal("sign_approved carries no error_class (placement)")
	}
	if e.agg.Get(tenant, siteID, e.now, "drop", "path_redacted") != 2 || e.agg.Get(tenant, siteID, e.now, "drop", "prop_redacted") != 3 {
		t.Fatalf("drop counters path %d prop %d", e.agg.Get(tenant, siteID, e.now, "drop", "path_redacted"), e.agg.Get(tenant, siteID, e.now, "drop", "prop_redacted"))
	}
}

func TestClientSuppliedFieldsRefused(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	for _, extra := range []string{`"ip":"1.2.3.4"`, `"userAgent":"x"`, `"timestamp":1`, `"hostname":"evil.test"`, `"title":"t"`} {
		body := batch(tok, &c, goodSG, `{"id":"`+eid()+`","k":"pv","u":"/",`+extra+`}`)
		if rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: body}); rr.Code != 400 {
			t.Errorf("%s: %d (closed schema)", extra, rr.Code)
		}
		top := strings.Replace(batch(tok, &c, goodSG, pv("/")), `{"v":1`, `{`+extra+`,"v":1`, 1)
		if rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: top}); rr.Code != 400 {
			t.Errorf("top-level %s: %d", extra, rr.Code)
		}
	}
	if len(e.sp.recs) != 0 {
		t.Fatal("nothing may be spooled")
	}
}

func TestResponses(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	big := batch(tok, &c, goodSG, `{"id":"`+eid()+`","k":"ev","u":"/","n":"x","d":{"a":"`+strings.Repeat("x", 9000)+`"}}`)
	cases := []struct {
		body string
		code int
		resp string
	}{
		{"not json", 400, `{"error":"malformed"}`},
		{big, 400, `{"error":"too_large"}`},
		{strings.Replace(batch(tok, &c, "", pv("/")), siteKey, "AAAAAAAAAAAAAAAAAAAAAA", 1), 404, `{"error":"unknown_site"}`},
		{strings.Replace(batch(tok, &c, "", pv("/")), `"tv":"1.0.0"`, `"tv":"0.9.0"`, 1), 410, `{"error":"withdrawn"}`},
		{batch(tok, &c, "", strings.Repeat(pv("/")+",", 10)+pv("/")), 400, `{"error":"malformed"}`},
	}
	for i, cs := range cases {
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: cs.body})
		if rr.Code != cs.code || rr.Body.String() != cs.resp {
			t.Errorf("case %d: %d %s", i, rr.Code, rr.Body)
		}
	}
	// GPC/DNT: 202 and dropped.
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", headers: map[string]string{"Sec-GPC": "1"}, body: batch(tok, &c, goodSG, pv("/"))})
	if rr.Code != 202 || len(e.sp.recs) != 0 || e.agg.Get(tenant, siteID, e.now, "drop", "gpc_dnt") != 1 {
		t.Fatal("GPC")
	}
	// Spool failure: 503 with Retry-After and the CORS expose header.
	e.sp.fail = spool.ErrUnavailable
	rr = e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))})
	if rr.Code != 503 || rr.Header().Get("Retry-After") == "" || rr.Header().Get("Access-Control-Expose-Headers") != "Retry-After" {
		t.Fatalf("503: %d %v", rr.Code, rr.Header())
	}
	if e.agg.Get(tenant, siteID, e.now, "verdict", "verified") != 0 {
		t.Fatal("a refused batch must not be counted")
	}
}

func TestRateLimitAndQuota(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) { s.RateLimitPerMin = 3; s.DailyQuota = 2 }, "")
	e.srv.LiveNodes = func() int { return 1 }
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	codes := []int{}
	for i := 0; i < 4; i++ {
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))})
		codes = append(codes, rr.Code)
		if rr.Code == 429 {
			if rr.Header().Get("Retry-After") == "" || rr.Header().Get("Access-Control-Expose-Headers") != "Retry-After" {
				t.Fatal("429 headers")
			}
		}
	}
	// 1, 2 accepted; then the node's quota share (2 verified/day) is used up → every further batch of the tenant is
	// 429 quota_exceeded, decided before the verdict.
	if fmt.Sprint(codes) != "[202 202 429 429]" {
		t.Fatalf("codes %v", codes)
	}
	if e.agg.Get(tenant, siteID, e.now, "drop", "quota_exceeded") != 2 {
		t.Fatal("drop counters for 429")
	}
	// Rate limit (3/min): the 4th authenticated request of the minute is 429 rate_limited.
	er := newEnv(t, func(s *snapshot.Site) { s.RateLimitPerMin = 3 }, "")
	tokR, cR := er.browser("203.0.113.5", chrome, "https://example.org")
	codes = codes[:0]
	for i := 0; i < 4; i++ {
		codes = append(codes, er.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tokR, &cR, goodSG, pv("/"))}).Code)
	}
	if fmt.Sprint(codes) != "[202 202 202 429]" || er.agg.Get(tenant, siteID, er.now, "drop", "rate_limited") != 1 {
		t.Fatalf("rate limit codes %v", codes)
	}
	// over_quota from the snapshot.
	e2 := newEnv(t, func(s *snapshot.Site) { s.Status = "over_quota" }, "")
	rr := e2.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))})
	if rr.Code != 429 || rr.Body.String() != `{"error":"quota_exceeded"}` {
		t.Fatalf("over_quota: %d %s", rr.Code, rr.Body)
	}
	// Two live nodes halve the share.
	e3 := newEnv(t, func(s *snapshot.Site) { s.RateLimitPerMin = 4 }, "")
	e3.srv.LiveNodes = func() int { return 2 }
	tok3, c3 := e3.browser("203.0.113.5", chrome, "https://example.org")
	ok := 0
	for i := 0; i < 5; i++ {
		if e3.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok3, &c3, goodSG, pv("/"))}).Code != 429 {
			ok++
		}
	}
	if ok != 2 {
		t.Fatalf("node share with two live nodes: %d accepted", ok)
	}
}

func TestDuplicateEventIDs(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	ev := pv("/dup")
	for i := 0; i < 3; i++ {
		e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, ev)})
	}
	if len(e.sp.recs) != 1 || e.agg.Get(tenant, siteID, e.now, "drop", "duplicate_event_id") != 2 {
		t.Fatalf("records %d", len(e.sp.recs))
	}
	e.now = e.now.Add(11 * time.Minute)
	tok2, c2 := e.browser("203.0.113.5", chrome, "https://example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok2, &c2, goodSG, ev)})
	if len(e.sp.recs) != 2 {
		t.Fatal("ids are remembered for 10 minutes only")
	}
}

func TestTokenFlood(t *testing.T) {
	e := newEnv(t, nil, "") // web_events_per_token = 5 in the test settings
	tok, c := e.browser("203.0.113.5", chrome, "https://example.org")
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/1"), pv("/2"), pv("/3"))})
	e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/4"), pv("/5"), pv("/6"), pv("/7"))})
	if len(e.sp.recs) != 5 || e.reasons()["token_flood"] != 2 {
		t.Fatalf("records %d reasons %v", len(e.sp.recs), e.reasons())
	}
}

func TestVisitorIDAndCountryExclusion(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) {
		s.VisitorID = "off_in"
		s.VisitorIDOffCountries = []string{"DE"}
		s.ExcludeCountries = []string{"RU"}
	}, "")
	for _, ip := range []string{"203.0.113.5", "198.51.100.5", "192.0.2.5"} { // DE, RU, XX
		tok, c := e.browser(ip, chrome, "https://example.org")
		if rr := e.do(req{path: "/v1/e", ip: ip, ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"), pv("/"))}); rr.Code != 202 {
			t.Fatal(rr.Code)
		}
	}
	if len(e.sp.recs) != 4 {
		t.Fatalf("records %d (RU excluded)", len(e.sp.recs))
	}
	de, xx := e.sp.recs[:2], e.sp.recs[2:]
	if de[0].Target != "twin" || *de[0].UmamiWebsiteID != twin || de[0].Surrogate == de[1].Surrogate || de[0].Country != "DE" {
		t.Fatalf("unidentified events: fresh random surrogate per event, twin website: %+v %+v", de[0], de[1])
	}
	if xx[0].Target != "main" || xx[0].Surrogate != xx[1].Surrogate || xx[0].Country != "XX" {
		t.Fatalf("identified events: %+v", xx[0])
	}
	if e.agg.Get(tenant, siteID, e.now, "drop", "country_excluded") != 2 || e.agg.Get(tenant, siteID, e.now, "identifier", "unidentified") != 2 {
		t.Fatal("counters")
	}
	// visitor_id = off: everything to the twin; null twin is spooled with umami_website_id null (resolved later).
	e2 := newEnv(t, func(s *snapshot.Site) { s.VisitorID = "off"; s.UmamiTwinWebsiteID = nil }, "")
	tok, c := e2.browser("203.0.113.5", chrome, "https://example.org")
	e2.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &c, goodSG, pv("/"))})
	if len(e2.sp.recs) != 1 || e2.sp.recs[0].Target != "twin" || e2.sp.recs[0].UmamiWebsiteID != nil || e2.sp.recs[0].Tag != "v" {
		t.Fatalf("visitor_id off: %+v", e2.sp.recs)
	}
}

func TestMultiplicityHigh(t *testing.T) {
	// Many distinct "visitors" (different UAs) behind one address, no proofs → multiplicity_high.
	e := newEnv(t, nil, "")
	var last *httptest.ResponseRecorder
	for i := 0; i < 8; i++ {
		ua := strings.Replace(chrome, "131.0.6778.204", fmt.Sprintf("131.0.%d.1", i), 1)
		tok, _ := e.browser("203.0.113.5", ua, "https://example.org")
		last = e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: ua, origin: "https://example.org", body: batch(tok, nil, goodSG, pv("/"))})
	}
	if last.Code != 202 || e.reasons()["multiplicity_high"] == 0 || e.agg.Get(tenant, siteID, e.now, "multiplicity", "high") == 0 {
		t.Fatalf("reasons %v", e.reasons())
	}
}

func TestChallengeEndpoint(t *testing.T) {
	e := newEnv(t, nil, "")
	rr := e.do(req{path: "/v1/c", ip: "203.0.113.5", ua: chrome, origin: "https://evil.test", body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`})
	if rr.Code != 200 || rr.Header().Get("Access-Control-Allow-Origin") != "" || rr.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("undeclared origin still gets a token without CORS (no oracle): %d %v", rr.Code, rr.Header())
	}
	var resp map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	pow := resp["pow"].(map[string]any)
	if resp["ttl"].(float64) != 1800 || pow["alg"] != "pbkdf2-sha256" || pow["max"].(float64) != 32 || pow["cost"].(float64) != 256 {
		t.Fatalf("response %v", resp)
	}
	if rr := e.do(req{path: "/v1/c", ip: "203.0.113.5", ua: chrome, body: `{"v":1,"s":"AAAAAAAAAAAAAAAAAAAAAA","p":"standard","tv":"1.0.0"}`}); rr.Code != 404 {
		t.Fatal("unknown site")
	}
	if rr := e.do(req{path: "/v1/c", ip: "203.0.113.5", ua: chrome, body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0","x":1}`}); rr.Code != 400 {
		t.Fatal("closed schema")
	}
	// Datacenter class doubles the difficulty.
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "datacenter.txt"), []byte("192.0.2.0/24\n"), 0o644)
	e2 := newEnv(t, nil, dir)
	rr = e2.do(req{path: "/v1/c", ip: "192.0.2.1", ua: chrome, body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`})
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if resp["pow"].(map[string]any)["max"].(float64) != 64 {
		t.Fatalf("adaptive difficulty for datacenter: %v", resp["pow"])
	}
}

func TestNoSnapshotRefuses(t *testing.T) {
	e := newEnv(t, nil, "")
	e.srv.Snap = snapshot.NewStore(filepath.Join(t.TempDir(), "x"), nil)
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch("", nil, "", pv("/"))})
	if rr.Code != 503 || rr.Header().Get("Retry-After") == "" {
		t.Fatalf("no snapshot: %d", rr.Code)
	}
}

// C-124 (F2): a header-perfect script on a library TLS stack claiming Chrome is `suspect/transport_mismatch` (never
// rejected on that alone); a Chromium stack claiming Chrome stays verified; a plaintext listener (no fingerprint) is
// unchecked.
func TestTransportMismatch(t *testing.T) {
	library := &transport.Snapshot{Hello: &transport.Hello{ALPN: []string{"h2", "http/1.1"}, Extensions: []uint16{0, 10}}, ALPN: "h2"}
	chromium := &transport.Snapshot{Hello: &transport.Hello{Grease: true, ALPN: []string{"h2", "http/1.1"}, Extensions: []uint16{0, 0x44cd}}, ALPN: "h2",
		H2: &transport.H2{Pseudo: "masp"}}
	for _, c := range []struct {
		name    string
		tr      *transport.Snapshot
		tag     string
		reasons int64
		result  string
	}{
		{"library claiming chrome", library, "s", 1, "mismatch"},
		{"chromium claiming chrome", chromium, "v", 0, "match"},
		{"no fingerprint", nil, "v", 0, "unchecked"},
	} {
		e := newEnv(t, nil, "")
		tok, n := e.browser("203.0.113.5", chrome, "https://example.org")
		rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &n, goodSG, pv("/a")), tr: c.tr})
		if rr.Code != 202 || len(e.sp.recs) != 1 || e.sp.recs[0].Tag != c.tag || e.reasons()["transport_mismatch"] != c.reasons {
			t.Fatalf("%s: code %d recs %d reasons %v", c.name, rr.Code, len(e.sp.recs), e.reasons())
		}
		claimed := "chromium"
		observed := map[string]string{"mismatch": "library", "match": "chromium", "unchecked": "none"}[c.result]
		why := "none"
		if c.result == "mismatch" {
			why = "tls_family"
		}
		if e.srv.Metrics.Get("scf_gateway_transport_checks_total", "claimed", claimed, "observed", observed, "result", c.result, "why", why) != 1 {
			var b strings.Builder
			e.srv.Metrics.Write(&b)
			t.Fatalf("%s: metric missing:\n%s", c.name, b.String())
		}
	}
}

// C-124 (F19): in shadow mode a multiplicity flag is counted as multiplicity/high_shadow and the verdict is unchanged;
// the platform setting applies when the site has no override.
func TestMultiplicityShadow(t *testing.T) {
	shadow := "shadow"
	run := func(e *env) {
		for i := 0; i < 8; i++ {
			ua := strings.Replace(chrome, "131.0.6778.204", fmt.Sprintf("131.0.%d.1", i), 1)
			tok, _ := e.browser("203.0.113.5", ua, "https://example.org")
			e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: ua, origin: "https://example.org", body: batch(tok, nil, goodSG, pv("/"))})
		}
	}
	e := newEnv(t, func(s *snapshot.Site) { s.MultiplicityMode = &shadow }, "")
	run(e)
	if e.reasons()["multiplicity_high"] != 0 || e.agg.Get(tenant, siteID, e.now, "multiplicity", "high_shadow") == 0 ||
		e.agg.Get(tenant, siteID, e.now, "multiplicity", "high") == 0 || e.srv.Metrics.Get("scf_gateway_multiplicity_flags_total", "mode", "shadow") == 0 {
		t.Fatalf("shadow: reasons %v", e.reasons())
	}
	// Without proofs the events are suspect anyway (proof_missing) — shadow changes only the multiplicity reason.
	for _, r := range e.sp.recs {
		if r.Tag != "s" {
			t.Fatalf("verdict changed by shadow mode: %+v", r)
		}
	}
	e2 := newEnv(t, nil, "")
	run(e2)
	if e2.reasons()["multiplicity_high"] == 0 || e2.agg.Get(tenant, siteID, e2.now, "multiplicity", "high_shadow") != 0 ||
		e2.srv.Metrics.Get("scf_gateway_multiplicity_flags_total", "mode", "enforce") == 0 {
		t.Fatalf("enforce: reasons %v", e2.reasons())
	}
}

// Gauge scf_gateway_sites_limited{kind}: sites answered 429 in the last hour, by kind; site ids never exported.
func TestSitesLimited(t *testing.T) {
	e := newEnv(t, func(s *snapshot.Site) { s.Status = "over_quota" }, "")
	tok, n := e.browser("203.0.113.5", chrome, "https://example.org")
	if rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &n, goodSG, pv("/"))}); rr.Code != 429 {
		t.Fatal(rr.Code)
	}
	if got := e.srv.SitesLimited(e.now); got["quota_exceeded"] != 1 || got["rate_limited"] != 0 {
		t.Fatalf("sites limited %v", got)
	}
	if got := e.srv.SitesLimited(e.now.Add(61 * time.Minute)); got["quota_exceeded"] != 0 {
		t.Fatalf("after an hour %v", got)
	}
}

// C-124 (found by the exact chaos check): a single gateway restarted within the hour regenerates K_chal under the
// same epoch id; tokens the visitors' pages got before the restart are `challenge_unverifiable` (suspect, stored),
// not `challenge_invalid` (rejected, lost) — and the hard expiry refuses new ingest with 503 snapshot_expired.
func TestRestartKeepsOutstandingTokensAndSnapshotExpiry(t *testing.T) {
	e := newEnv(t, nil, "")
	tok, n := e.browser("203.0.113.5", chrome, "https://example.org")
	e.now = e.now.Add(time.Minute)
	ring, _ := keys.NewRing(func() time.Time { return e.now }) // the restarted process: fresh keys, same ids
	for _, k := range keys.Kinds {
		_, _ = ring.Generate(k, keys.ID(k, e.now))
	}
	e.srv.Ring = ring
	rr := e.do(req{path: "/v1/e", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: batch(tok, &n, goodSG, pv("/after-restart"))})
	if rr.Code != 202 || len(e.sp.recs) != 1 || e.sp.recs[0].Tag != "s" || e.reasons()["challenge_unverifiable"] != 1 || e.reasons()["challenge_invalid"] != 0 {
		t.Fatalf("token from before the restart: %d recs %d reasons %v", rr.Code, len(e.sp.recs), e.reasons())
	}

	// Hard expiry.
	x := newEnv(t, nil, "")
	x.applyExpiring(x.now.Add(-6 * time.Minute))
	for path, body := range map[string]string{"/v1/c": `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`, "/v1/e": batch("", nil, "", pv("/x"))} {
		rr := x.do(req{path: path, ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: body})
		if rr.Code != 503 || rr.Header().Get("Retry-After") != "30" || !strings.Contains(rr.Body.String(), "snapshot_expired") {
			t.Fatalf("%s on an expired snapshot: %d %s", path, rr.Code, rr.Body)
		}
	}
	x.applyExpiring(x.now.Add(-4 * time.Minute)) // newer snapshot, within the 5-minute grace
	if rr := x.do(req{path: "/v1/c", ip: "203.0.113.5", ua: chrome, origin: "https://example.org", body: `{"v":1,"s":"` + siteKey + `","p":"standard","tv":"1.0.0"}`}); rr.Code != 200 {
		t.Fatalf("newer snapshot must accept again: %d", rr.Code)
	}
}

func (e *env) applyExpiring(exp time.Time) {
	e.seq++
	p := snapshot.Payload{Sequence: e.seq, IssuedAt: e.now.Format(time.RFC3339), ExpiresAt: exp.Format(time.RFC3339),
		Settings: snapshot.Settings{PowCost: 256, PowMax: 32, PowMaxMultiplier: 8, WebEventsPerToken: 5, WebRequestsPerMinSubnet: 600,
			MultiplicityThresholds: snapshot.Thresholds{"exact_ip": {"unknown": 6}, "subnet": {"unknown": 24}}, PathnormRulesVersion: "scf-path-rules/1.0.0"},
		Tenants: []snapshot.Tenant{{TenantID: tenant, Status: "active", Level: 1}}, Sites: []snapshot.Site{baseSite()},
		TrackerVersions: []snapshot.TrackerVersion{{Version: "1.0.0", Status: "active"}}}
	pb, _ := json.Marshal(p)
	env := snapshot.Envelope{Format: snapshot.Format, Alg: "Ed25519", Kid: "k", Payload: base64.RawURLEncoding.EncodeToString(pb), Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(e.priv, pb))}
	raw, _ := json.Marshal(env)
	if err := e.store.Apply(raw); err != nil {
		e.t.Fatal(err)
	}
}

func TestTrackerVersionLabel(t *testing.T) {
	for tv, want := range map[string]string{"1.0.0": "v1_0_0", "12.3.45": "v12_3_45"} {
		if got := trackerVersionLabel(tv); got != want {
			t.Errorf("trackerVersionLabel(%q) = %q, want %q", tv, got, want)
		}
	}
}
