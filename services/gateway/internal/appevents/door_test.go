// SPDX-License-Identifier: Apache-2.0

package appevents

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
)

const (
	tenantA  = "0193b7e2-0000-7000-8000-00000000000a"
	tenantP  = "0193b7e2-0000-7000-8000-00000000000b"
	tenantS  = "0193b7e2-0000-7000-8000-00000000000c"
	siteA    = "0193b7e2-0000-7000-8000-0000000000a1"
	keyA     = "AAAAAAAAAAAAAAAAAAAAAA"
	keyP     = "PPPPPPPPPPPPPPPPPPPPPP"
	keyS     = "SSSSSSSSSSSSSSSSSSSSSS"
	keyQ     = "QQQQQQQQQQQQQQQQQQQQQQ"
	sessionA = "k3J9xQ2mT7vR1aB8cD4eF6"
	sessionB = "Zz9yXw8vUt7sRq6pOn5mL4"
)

type env struct {
	t    *testing.T
	door *Door
	agg  *counters.Agg
	reg  *metrics.Registry
	now  time.Time
	h    http.Handler
}

func newEnv(t *testing.T, mut func(*snapshot.Payload)) *env {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	s := snapshot.NewStore(filepath.Join(t.TempDir(), "s.json"), snapshot.Keys{"k": pub})
	p := snapshot.Payload{Sequence: 1, IssuedAt: "x", Settings: snapshot.Settings{WebRequestsPerMinSubnet: 600},
		Tenants: []snapshot.Tenant{{TenantID: tenantA, Status: "active"}, {TenantID: tenantP, Status: "pending"}, {TenantID: tenantS, Status: "suspended"}},
		Sites: []snapshot.Site{
			{SiteID: siteA, TenantID: tenantA, SiteKey: keyA, UmamiWebsiteID: siteA, Status: "active", Profile: "standard", PathFolding: "full", RateLimitPerMin: 600, DailyQuota: 100000},
			{SiteID: "0193b7e2-0000-7000-8000-0000000000b1", TenantID: tenantP, SiteKey: keyP, UmamiWebsiteID: siteA, Status: "active", Profile: "standard", PathFolding: "full", RateLimitPerMin: 600, DailyQuota: 100000},
			{SiteID: "0193b7e2-0000-7000-8000-0000000000c1", TenantID: tenantS, SiteKey: keyS, UmamiWebsiteID: siteA, Status: "active", Profile: "standard", PathFolding: "full", RateLimitPerMin: 600, DailyQuota: 100000},
			{SiteID: "0193b7e2-0000-7000-8000-0000000000d1", TenantID: tenantA, SiteKey: keyQ, UmamiWebsiteID: siteA, Status: "over_quota", Profile: "standard", PathFolding: "full", RateLimitPerMin: 600, DailyQuota: 100000},
		}}
	if mut != nil {
		mut(&p)
	}
	pb, _ := json.Marshal(p)
	raw, _ := json.Marshal(snapshot.Envelope{Format: snapshot.Format, Alg: "Ed25519", Kid: "k", Payload: base64.RawURLEncoding.EncodeToString(pb), Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, pb))})
	if err := s.Apply(raw); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, agg: counters.New(), reg: metrics.New(), now: time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)}
	e.door = &Door{Snap: s, Counters: e.agg, Metrics: e.reg, Now: func() time.Time { return e.now }}
	e.door.Init()
	mux := http.NewServeMux()
	e.door.Register(mux)
	e.h = mux
	return e
}

func (e *env) post(body string, hdr ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(hdr); i += 2 {
		r.Header.Set(hdr[i], hdr[i+1])
	}
	r.RemoteAddr = "203.0.113.7:5555"
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	return w
}

func (e *env) cell(day, platform, event, key, value string) int64 {
	return e.agg.GetApp(counters.AppKey{Tenant: tenantA, Site: siteA, Day: day, Platform: platform, Event: event, Key: key, Value: value})
}

func batch(key string, events ...string) string {
	return `{"v":1,"k":"` + key + `","platform":"ios","app_version":"1.4.2-beta.3+77","sdk_version":"mobile-rn/0.1.0","events":[` + strings.Join(events, ",") + `]}`
}

func ev(ts time.Time, session, name, props string) string {
	s := fmt.Sprintf(`{"ts":%d,"session":%q,"name":%q`, ts.UnixMilli(), session, name)
	if props != "" {
		s += `,"props":` + props
	}
	return s + "}"
}

func TestAcceptedEventsBecomeSelfAttestedCells(t *testing.T) {
	e := newEnv(t, nil)
	w := e.post(batch(keyA,
		ev(e.now, sessionA, "swap_started", `{"tier":"pro","asset_class":"stablecoin"}`),
		ev(e.now, sessionA, "swap_started", `{"tier":"free"}`),
		ev(e.now, sessionB, "app_open", ""),
	))
	if w.Code != http.StatusAccepted || w.Body.String() != `{"accepted":3,"dropped":0}` {
		t.Fatalf("answer %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "*" || w.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("any origin, never credentials")
	}
	day := "2026-11-19"
	for _, c := range []struct {
		event, key, value string
		want              int64
	}{
		{"swap_started", "_total", "all", 2}, {"swap_started", "tier", "pro", 1}, {"swap_started", "tier", "free", 1},
		{"swap_started", "asset_class", "stablecoin", 1}, {"app_open", "_total", "all", 1},
		{"_session", "_total", "all", 2}, {"_session", "app_version", "1.4.2", 2}, {"_session", "sdk_version", "mobile-rn/0.1.0", 2},
	} {
		if got := e.cell(day, "ios", c.event, c.key, c.value); got != c.want {
			t.Errorf("%s/%s/%s = %d, want %d", c.event, c.key, c.value, got, c.want)
		}
	}
	// The same session later the same day is not a new session.
	e.now = e.now.Add(10 * time.Minute)
	e.post(batch(keyA, ev(e.now, sessionA, "app_open", "")))
	if got := e.cell(day, "ios", "_session", "_total", "all"); got != 2 {
		t.Fatalf("sessions %d", got)
	}
}

func TestNothingIdentifyingIsKept(t *testing.T) {
	e := newEnv(t, nil)
	e.post(batch(keyA, ev(e.now, sessionA, "app_open", `{"tier":"pro"}`)),
		"User-Agent", "MyWallet/1.4.2 (iPhone; iOS 18.1) CFNetwork", "X-Forwarded-For", "198.51.100.9")
	sp := fmt.Sprintf("%v", e.door.card) + fmt.Sprintf("%+v", e.agg) + fmt.Sprintf("%+v", e.door.sessions)
	for _, bad := range []string{sessionA, "iPhone", "CFNetwork", "203.0.113", "198.51.100"} {
		if strings.Contains(sp, bad) {
			t.Fatalf("%q kept in memory state", bad)
		}
	}
	var out bytes.Buffer
	rec := httptest.NewRecorder()
	e.reg.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	out.Write(rec.Body.Bytes())
	for _, bad := range []string{sessionA, keyA, siteA, tenantA, "swap", "app_open"} {
		if strings.Contains(out.String(), bad) {
			t.Fatalf("metrics carry %q", bad)
		}
	}
	if !strings.Contains(out.String(), `scf_gateway_app_events_total{outcome="accepted",reason="none"} 1`) {
		t.Fatalf("metrics: %s", out.String())
	}
}

func TestUnsafeAndNonEnumValuesAreDroppedPerEvent(t *testing.T) {
	e := newEnv(t, nil)
	w := e.post(batch(keyA,
		ev(e.now, sessionA, "paid", `{"to":"gabc"}`),                 // fine
		ev(e.now, sessionA, "paid", `{"to":"GBRPYHIL2CI3FNQ4BXLF"}`), // upper case: not a token (a full address exceeds 32: 400)
		ev(e.now, sessionA, "paid", `{"memo":"Hello world"}`),        // free text
		ev(e.now, sessionA, "paid", `{"order":"order_1234567"}`),     // id-like digit run
		ev(e.now, sessionA, "paid", `{"tx":"deadbeefcafe0123"}`),     // hex-like
		ev(e.now, sessionA, "user_alice@example.com", ""),            // outside the name rule
	))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("a name outside the name rule rejects the batch: %d", w.Code)
	}
	w = e.post(batch(keyA,
		ev(e.now, sessionA, "paid", `{"to":"gabc"}`),
		ev(e.now, sessionA, "paid", `{"to":"GBRPYHIL2CI3FNQ4BXLF"}`),
		ev(e.now, sessionA, "paid", `{"memo":"Hello world"}`),
		ev(e.now, sessionA, "paid", `{"order":"order_1234567"}`),
		ev(e.now, sessionA, "paid", `{"tx":"deadbeefcafe0123"}`),
		ev(e.now, sessionA, "user_1234567", ""),
	))
	if w.Code != http.StatusAccepted || w.Body.String() != `{"accepted":1,"dropped":5}` {
		t.Fatalf("answer %d %s", w.Code, w.Body)
	}
	day := "2026-11-19"
	if e.cell(day, "ios", "paid", "_total", "all") != 1 || e.cell(day, "ios", "_dropped", "reason", DropValue) != 3 ||
		e.cell(day, "ios", "_dropped", "reason", DropUnsafe) != 2 {
		t.Fatalf("cells: %+v", e.agg)
	}
}

func TestStaleAndLateEvents(t *testing.T) {
	e := newEnv(t, nil)
	w := e.post(batch(keyA,
		ev(e.now.Add(-25*time.Hour), sessionA, "app_open", ""),
		ev(e.now.Add(10*time.Minute), sessionA, "app_open", ""),
		ev(e.now.Add(-11*time.Hour), sessionB, "app_open", ""), // yesterday 23:00: counted on its own day
	))
	if w.Body.String() != `{"accepted":1,"dropped":2}` {
		t.Fatalf("answer %s", w.Body)
	}
	if e.cell("2026-11-18", "ios", "app_open", "_total", "all") != 1 || e.cell("2026-11-18", "ios", "_session", "_total", "all") != 1 ||
		e.cell("2026-11-19", "ios", "_dropped", "reason", DropStale) != 2 {
		t.Fatal("late event on its day; stale and future dropped today")
	}
}

func TestCardinalityBudget(t *testing.T) {
	e := newEnv(t, nil)
	for i := 0; i < MaxNamesPerSiteDay; i += 10 {
		var evs []string
		for j := i; j < i+10; j++ {
			evs = append(evs, ev(e.now, sessionA, fmt.Sprintf("event_%d", j), ""))
		}
		if w := e.post(batch(keyA, evs...)); w.Body.String() != `{"accepted":10,"dropped":0}` {
			t.Fatalf("batch %d: %s", i, w.Body)
		}
	}
	w := e.post(batch(keyA, ev(e.now, sessionA, "one_more", ""), ev(e.now, sessionA, "event_3", "")))
	if w.Body.String() != `{"accepted":1,"dropped":1}` {
		t.Fatalf("name budget: %s", w.Body)
	}
	// The next day starts a fresh budget.
	e.now = e.now.Add(24 * time.Hour)
	if w := e.post(batch(keyA, ev(e.now, sessionA, "one_more", ""))); w.Body.String() != `{"accepted":1,"dropped":0}` {
		t.Fatalf("next day: %s", w.Body)
	}
}

func TestCellBudget(t *testing.T) {
	e := newEnv(t, nil)
	n := 0
	for n < MaxCellsPerSiteDay {
		var evs []string
		for j := 0; j < 20 && n < MaxCellsPerSiteDay; j++ {
			props := map[string]string{}
			for k := 0; k < 5; k++ {
				props[fmt.Sprintf("k%d", k)] = fmt.Sprintf("v%c%c", 'a'+n%26, 'a'+(n/26)%26)
				n++
			}
			pb, _ := json.Marshal(props)
			evs = append(evs, ev(e.now, sessionA, "cells", string(pb)))
		}
		e.post(batch(keyA, evs...))
	}
	w := e.post(batch(keyA, ev(e.now, sessionA, "cells", `{"k9":"brand_new"}`), ev(e.now, sessionA, "cells", `{"k0":"vaa"}`)))
	if w.Body.String() != `{"accepted":1,"dropped":1}` {
		t.Fatalf("cell budget: %s", w.Body)
	}
}

func TestTelegramMiniApp(t *testing.T) {
	e := newEnv(t, nil)
	body := `{"v":1,"k":"` + keyA + `","platform":"web","tma_platform":"desktop","app_version":"2.0","sdk_version":"mobile-rn/0.1.0","events":[` + ev(e.now, sessionA, "mini_app_open", "") + `]}`
	if w := e.post(body); w.Code != http.StatusAccepted {
		t.Fatalf("tma: %d %s", w.Code, w.Body)
	}
	if e.cell("2026-11-19", "web", "_session", "tma_platform", "desktop") != 1 || e.cell("2026-11-19", "web", "_session", "app_version", "2.0") != 1 {
		t.Fatal("tma_platform cell")
	}
	for _, bad := range []string{
		strings.Replace(body, `"desktop"`, `"tdesktop"`, 1),              // raw WebApp.platform: map it first
		strings.Replace(body, `"platform":"web"`, `"platform":"ios"`, 1), // a Mini App is a web page
		strings.Replace(body, `"events"`, `"init_data":"user=%7B%22id%22%3A1%7D","events"`, 1),
	} {
		if w := e.post(bad); w.Code != http.StatusBadRequest {
			t.Fatalf("%s → %d", bad, w.Code)
		}
	}
	r := httptest.NewRequest(http.MethodOptions, Path, nil)
	r.Header.Set("Origin", "https://web.telegram.org")
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent || w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight %d", w.Code)
	}
}

func TestShapeErrors(t *testing.T) {
	e := newEnv(t, nil)
	ok := ev(e.now, sessionA, "a", "")
	many := make([]string, MaxEvents+1)
	for i := range many {
		many[i] = ok
	}
	for name, body := range map[string]string{
		"not json":         "nope",
		"no events":        batch(keyA),
		"too many events":  batch(keyA, many...),
		"bad key":          batch("short", ok),
		"unknown field":    strings.Replace(batch(keyA, ok), `"v":1`, `"v":1,"device_id":"x"`, 1),
		"event field":      batch(keyA, `{"ts":1,"session":"`+sessionA+`","name":"a","user_id":"u"}`),
		"short session":    batch(keyA, ev(e.now, "abc", "a", "")),
		"no ts":            batch(keyA, `{"session":"`+sessionA+`","name":"a"}`),
		"number prop":      batch(keyA, ev(e.now, sessionA, "a", `{"n":5}`)),
		"bool prop":        batch(keyA, ev(e.now, sessionA, "a", `{"n":true}`)),
		"bad prop key":     batch(keyA, ev(e.now, sessionA, "a", `{"Bad":"x"}`)),
		"too many props":   batch(keyA, ev(e.now, sessionA, "a", `{"a":"x","b":"x","c":"x","d":"x","e":"x","f":"x","g":"x","h":"x","i":"x"}`)),
		"long value":       batch(keyA, ev(e.now, sessionA, "a", `{"a":"`+strings.Repeat("x", 33)+`"}`)),
		"platform":         strings.Replace(batch(keyA, ok), `"ios"`, `"windows"`, 1),
		"app version":      strings.Replace(batch(keyA, ok), `1.4.2-beta.3+77`, `latest`, 1),
		"sdk version":      strings.Replace(batch(keyA, ok), `mobile-rn/0.1.0`, `rn`, 1),
		"schema version":   strings.Replace(batch(keyA, ok), `"v":1`, `"v":2`, 1),
		"trailing garbage": batch(keyA, ok) + "{}",
	} {
		if w := e.post(body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	if w := e.post(batch(keyA, ok), "Content-Type", "application/x-www-form-urlencoded"); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("content type: %d", w.Code)
	}
	if w := e.post(batch(keyA, ok), "Content-Type", "text/plain;charset=UTF-8"); w.Code != http.StatusAccepted {
		t.Errorf("text/plain: %d", w.Code)
	}
	big := batch(keyA, ev(e.now, sessionA, "a", `{"a":"`+strings.Repeat("x", 9000)+`"}`))
	if w := e.post(big); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("size: %d", w.Code)
	}
}

func TestSiteAndTenantStates(t *testing.T) {
	e := newEnv(t, nil)
	ok := ev(e.now, sessionA, "a", "")
	for key, want := range map[string]int{"ZZZZZZZZZZZZZZZZZZZZZZ": 404, keyP: 403, keyS: 403, keyQ: 429} {
		if w := e.post(batch(key, ok)); w.Code != want {
			t.Errorf("%s: %d want %d", key, w.Code, want)
		}
	}
	e.door.Draining = func() bool { return true }
	if w := e.post(batch(keyA, ok)); w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Errorf("draining: %d", w.Code)
	}
	exp := newEnv(t, func(p *snapshot.Payload) { p.ExpiresAt = "2026-11-01T00:00:00Z" })
	if w := exp.post(batch(keyA, ok)); w.Code != 503 || !strings.Contains(w.Body.String(), "snapshot_expired") {
		t.Errorf("expired: %d %s", w.Code, w.Body)
	}
}

func TestRateLimitsAndQuota(t *testing.T) {
	e := newEnv(t, func(p *snapshot.Payload) { p.Sites[0].RateLimitPerMin = 40; p.Sites[0].DailyQuota = 25 })
	ok := ev(e.now, sessionA, "a", "")
	// subnet limit = max(40/4, 10) = 10 per minute
	for i := 0; i < 10; i++ {
		if w := e.post(batch(keyA, ok)); w.Code != 202 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := e.post(batch(keyA, ok))
	if w.Code != 429 || !strings.Contains(w.Body.String(), "rate_limited") || w.Header().Get("Retry-After") == "" {
		t.Fatalf("subnet limit: %d %s", w.Code, w.Body)
	}
	// Quota: 25 per day; 10 used. A batch of 16 would exceed it.
	e.now = e.now.Add(2 * time.Minute)
	evs := make([]string, 16)
	for i := range evs {
		evs[i] = ok
	}
	if w := e.post(batch(keyA, evs...)); w.Code != 429 || !strings.Contains(w.Body.String(), "quota_exceeded") {
		t.Fatalf("quota: %d %s", w.Code, w.Body)
	}
	if w := e.post(batch(keyA, evs[:15]...)); w.Code != 202 {
		t.Fatalf("within quota: %d %s", w.Code, w.Body)
	}
}

func TestNotAWebEvent(t *testing.T) {
	// App events never touch web counters (verdicts, drops, quota of verified events).
	e := newEnv(t, nil)
	e.post(batch(keyA, ev(e.now, sessionA, "a", "")))
	for _, c := range []string{"verdict", "drop", "reason"} {
		for _, l := range []string{"verified", "suspect", "rejected", "rate_limited", "quota_exceeded"} {
			if e.agg.Get(tenantA, siteA, e.now, c, l) != 0 {
				t.Fatalf("web counter %s/%s touched", c, l)
			}
		}
	}
}
