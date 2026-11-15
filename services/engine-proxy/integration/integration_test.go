// SPDX-License-Identifier: Apache-2.0

//go:build integration

// Integration test of the engine proxy against a real Umami 3.5.0 (run.sh starts it). It proves, on the real engine:
//   - the bootstrap gate holds edges back until B5, and the restartable bootstrap runs through the proxy;
//   - one visit survives a UTC clock-hour boundary (token replayed within 30 minutes);
//   - a 31-minute gap starts a new visit (the proxy's inactivity rule; Umami alone would keep the token's visit for
//     ever) — and without the proxy's token (x-scf-visit: none) Umami splits the visit at the clock hour;
//   - Umami's cache, sessionId and visitId never reach the edge;
//   - the token purge before P9 keeps events out of a deleted website (S-01 case H reproduced without it);
//   - a fresh proxy instance re-checks the gate by itself.
package integration

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/bootstrap"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/proxy"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/testpki"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/visit"
)

const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

type env struct {
	umami    *url.URL
	ca       *testpki.CA
	proxyURL string
	gate     *proxy.Gate
	store    *visit.Store
	edge     *http.Client
	reader   *http.Client
	prov     *http.Client
	logs     *bytes.Buffer
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func uuidV4() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func surrogate() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return fmt.Sprintf("2001:db8:%x:%x:%x:%x:%x:%x", int(b[0])<<8|int(b[1]), int(b[2])<<8|int(b[3]), int(b[4])<<8|int(b[5]),
		int(b[6])<<8|int(b[7]), int(b[8])<<8|int(b[9]), int(b[10])<<8|int(b[11]))
}

// startProxy starts a fresh in-process engine proxy (empty memory, closed gate) in front of the real Umami.
func startProxy(t *testing.T, umami *url.URL, ca *testpki.CA) (string, *proxy.Gate, *visit.Store, *bytes.Buffer) {
	t.Helper()
	dir := t.TempDir()
	srv := ca.Server(t, "engine-proxy")
	rl, err := proxy.NewTLSReloader(proxy.TLSFiles{
		CertFile:     testpki.Write(t, dir, "s.pem", srv.CertPEM),
		KeyFile:      testpki.Write(t, dir, "k.pem", srv.KeyPEM),
		ClientCAFile: testpki.Write(t, dir, "ca.pem", ca.PEM),
	})
	if err != nil {
		t.Fatal(err)
	}
	store := visit.New(visit.Config{})
	gate := &proxy.Gate{}
	logs := &bytes.Buffer{}
	h := proxy.New(proxy.Config{
		UmamiURL: umami, Store: store, Gate: gate, Metrics: proxy.NewMetrics(),
		Logger: slog.New(slog.NewJSONHandler(logs, nil)),
		Client: &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}},
	})
	ts := httptest.NewUnstartedServer(h)
	ts.TLS = rl.ServerConfig()
	ts.Config.ConnState = rl.ConnState
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return ts.URL, gate, store, logs
}

func clientFor(t *testing.T, ca *testpki.CA, node, role string) *http.Client {
	t.Helper()
	l := ca.Client(t, node, role)
	kp, err := tls.X509KeyPair(l.CertPEM, l.KeyPEM)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.Cert)
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "engine-proxy", Certificates: []tls.Certificate{kp}}}}
}

func setup(t *testing.T) *env {
	t.Helper()
	raw := os.Getenv("EP_IT_UMAMI_URL")
	if raw == "" {
		t.Skip("EP_IT_UMAMI_URL not set; run services/engine-proxy/integration/run.sh")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	ca := testpki.NewCA(t, "scf-it-ca")
	e := &env{umami: u, ca: ca}
	e.proxyURL, e.gate, e.store, e.logs = startProxy(t, u, ca)
	e.edge = clientFor(t, ca, "edge-a1", "edge")
	e.reader = clientFor(t, ca, "core-a-control-plane", "reader")
	e.prov = clientFor(t, ca, "core-a-umami-reconcile", "provisioner")
	return e
}

func do(t *testing.T, c *http.Client, method, u, token string, body any, hdr map[string]string) (int, []byte) {
	t.Helper()
	var rd io.Reader = http.NoBody
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, u, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, u, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func (e *env) send(t *testing.T, website, sur string, ts int64, mode string) (int, string) {
	t.Helper()
	st, b := do(t, e.edge, "POST", e.proxyURL+"/api/send", "", map[string]any{
		"type": "event",
		"payload": map[string]any{"website": website, "hostname": "it.example.org", "url": "/pricing",
			"screen": "1536x864", "language": "en", "tag": "v", "timestamp": ts},
	}, map[string]string{"User-Agent": chromeUA, "x-scf-surrogate-ip": sur, "cf-ipcountry": "DE", "x-scf-visit": mode})
	return st, string(b)
}

type stats struct {
	Pageviews, Visitors, Visits, Bounces, Totaltime float64
}

func (e *env) stats(t *testing.T, token, website string, day time.Time) stats {
	t.Helper()
	start := day.UnixMilli()
	end := day.Add(24*time.Hour).UnixMilli() - 1 // Umami's endAt is inclusive (C-99)
	st, b := do(t, e.reader, "GET", fmt.Sprintf("%s/api/websites/%s/stats?startAt=%d&endAt=%d&timezone=UTC", e.proxyURL, website, start, end), token, nil, nil)
	if st != 200 {
		t.Fatalf("stats: %d %s", st, b)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("stats body %s", b)
	}
	num := func(k string) float64 {
		var v any
		_ = json.Unmarshal(raw[k], &v)
		switch x := v.(type) {
		case float64:
			return x
		case map[string]any: // older shape {value, prev}
			f, _ := x["value"].(float64)
			return f
		case string:
			var f float64
			fmt.Sscan(x, &f)
			return f
		}
		return -1
	}
	return stats{num("pageviews"), num("visitors"), num("visits"), num("bounces"), num("totaltime")}
}

func (e *env) createWebsite(t *testing.T, token string) string {
	t.Helper()
	id := uuidV4()
	st, b := do(t, e.prov, "POST", e.proxyURL+"/api/websites", token, map[string]string{"id": id, "name": "it-" + id[:8], "domain": "it.example.org"}, nil)
	if st != 200 {
		t.Fatalf("P7: %d %s", st, b)
	}
	return id
}

func TestEngineProxyAgainstRealUmami(t *testing.T) {
	e := setup(t)
	seedPW, provPW := "seed-"+randHex(16), "prov-"+randHex(16)

	// --- bootstrap gate: edges wait until B5 -------------------------------------------------------------
	if st, _ := e.send(t, uuidV4(), surrogate(), time.Now().Unix(), "track"); st != http.StatusServiceUnavailable {
		t.Fatalf("send before bootstrap = %d, want 503", st)
	}
	// --- C-114: after B2 the seed credentials are refused, but the provisioning identity does not exist yet; the
	// proxy's own probe must keep the gate closed. B1 and B2 are run by hand here, the bootstrapper resumes after.
	st, body := do(t, e.prov, "POST", e.proxyURL+"/api/auth/login", "", map[string]string{"username": "admin", "password": "umami"}, nil)
	if st != 200 {
		t.Fatalf("B1: %d", st)
	}
	var b1 struct{ Token string }
	_ = json.Unmarshal(body, &b1)
	if st, _ := do(t, e.prov, "POST", e.proxyURL+"/api/me/password", b1.Token, map[string]string{"currentPassword": "umami", "newPassword": seedPW}, nil); st != 200 {
		t.Fatalf("B2: %d", st)
	}
	_, midGate, _, _ := startProxy(t, e.umami, e.ca)
	midGate.Provisioner = &proxy.Credentials{Username: "scf-provisioner", Password: provPW}
	if st := midGate.Probe(t.Context(), &http.Client{Timeout: 10 * time.Second}, e.umami); st != 401 || midGate.IsOpen() {
		t.Fatalf("probe after B2, before B3: seed status %d, open %v (want 401, closed)", st, midGate.IsOpen())
	}

	base, _ := url.Parse(e.proxyURL)
	b := &bootstrap.Bootstrapper{
		Base: base, HTTP: e.prov, Logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Config: bootstrap.Config{SeedPassword: seedPW, ProvisionerUser: "scf-provisioner", ProvisionerPassword: provPW},
		Retry:  bootstrap.RetryPolicy{Initial: 500 * time.Millisecond, Max: 2 * time.Second, Deadline: 2 * time.Minute},
	}
	res, err := b.Run(t.Context())
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	t.Logf("bootstrap steps: %v", res.Steps)
	if !e.gate.IsOpen() {
		t.Fatal("gate closed after B5")
	}
	res, err = b.Run(t.Context())
	if err != nil || strings.Join(res.Steps, ",") != "P1,B5" {
		t.Fatalf("bootstrap re-run = %v, %v (want P1,B5)", res.Steps, err)
	}
	// The seed admin is gone: admin/umami and admin/<interim> both refused by the real Umami.
	for _, pw := range []string{"umami", seedPW} {
		if st, _ := do(t, e.prov, "POST", e.proxyURL+"/api/auth/login", "", map[string]string{"username": "admin", "password": pw}, nil); st != 401 {
			t.Fatalf("seed admin login with %s-password = %d, want 401", map[bool]string{true: "default", false: "interim"}[pw == "umami"], st)
		}
	}
	st, body = do(t, e.prov, "POST", e.proxyURL+"/api/auth/login", "", map[string]string{"username": "scf-provisioner", "password": provPW}, nil)
	if st != 200 {
		t.Fatalf("P1: %d", st)
	}
	var login struct{ Token string }
	_ = json.Unmarshal(body, &login)

	// --- the visit rule on the real engine ----------------------------------------------------------------
	day := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -2)
	at := func(hh, mm int) int64 {
		return day.Add(time.Duration(hh)*time.Hour + time.Duration(mm)*time.Minute).Unix()
	}

	tracked := e.createWebsite(t, login.Token)
	s1 := surrogate()
	for _, ev := range []struct{ hh, mm int }{{10, 55}, {11, 5}, {11, 36}} {
		st, body := e.send(t, tracked, s1, at(ev.hh, ev.mm), "track")
		if st != 200 || body != "{}" {
			t.Fatalf("send %02d:%02d = %d %q, want 200 {} (cache/sessionId/visitId stripped)", ev.hh, ev.mm, st, body)
		}
	}
	got := e.stats(t, login.Token, tracked, day)
	// Expected: visit A = 10:55 + 11:05 (one visit across the clock hour, 600 s), visit B = 11:36 alone (31-minute
	// gap; a bounce). Umami's clock-hour rule alone would give {10:55} {11:05, 11:36} = 1860 s; a token replayed for
	// ever would give one visit.
	want := stats{Pageviews: 3, Visitors: 1, Visits: 2, Bounces: 1, Totaltime: 600}
	if got != want {
		t.Fatalf("tracked visitor stats = %+v, want %+v", got, want)
	}

	// Control: the same three events without the proxy's visit memory follow Umami's clock-hour rule.
	control := e.createWebsite(t, login.Token)
	s2 := surrogate()
	for _, ev := range []struct{ hh, mm int }{{10, 55}, {11, 5}, {11, 36}} {
		if st, _ := e.send(t, control, s2, at(ev.hh, ev.mm), "none"); st != 200 {
			t.Fatalf("control send = %d", st)
		}
	}
	got = e.stats(t, login.Token, control, day)
	if want := (stats{Pageviews: 3, Visitors: 1, Visits: 2, Bounces: 1, Totaltime: 1860}); got != want {
		t.Fatalf("control stats = %+v, want %+v (Umami's clock-hour visits)", got, want)
	}

	// --- Umami's own bot check stays enabled (bot.engine-bot-detection, C-36) and its answer passes through unchanged ------------
	st, bot := do(t, e.edge, "POST", e.proxyURL+"/api/send", "", map[string]any{
		"type": "event", "payload": map[string]any{"website": tracked, "hostname": "it.example.org", "url": "/bot",
			"tag": "v", "timestamp": at(12, 30)},
	}, map[string]string{"User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"x-scf-surrogate-ip": surrogate(), "cf-ipcountry": "US", "x-scf-visit": "track"})
	if st != 200 || string(bot) != `{"beep":"boop"}` {
		t.Fatalf("bot User-Agent = %d %s, want 200 {\"beep\":\"boop\"}", st, bot)
	}
	if got := e.stats(t, login.Token, tracked, day); got.Pageviews != 3 {
		t.Fatalf("bot event was stored: %+v", got)
	}

	// --- website deletion ---------------------------------------------------------------------------------
	// Without the purge (P9 sent straight to Umami, bypassing the proxy), a remembered token lets an event into the
	// deleted website — S-01 case H.
	unpurged := e.createWebsite(t, login.Token)
	s3 := surrogate()
	if st, _ := e.send(t, unpurged, s3, at(12, 0), "track"); st != 200 {
		t.Fatal("send to unpurged website")
	}
	if st, b := do(t, &http.Client{}, "DELETE", e.umami.String()+"/api/websites/"+unpurged, login.Token, nil, nil); st != 200 {
		t.Fatalf("direct P9: %d %s", st, b)
	}
	st, sb := e.send(t, unpurged, s3, at(12, 1), "track")
	t.Logf("event with a replayed token into a website deleted behind the proxy's back: %d %s", st, sb)
	if st != 200 {
		t.Fatalf("S-01 case H not reproduced (status %d): the purge test below would prove nothing", st)
	}
	// With the purge on this core before P9 (through the proxy): Umami refuses the event.
	purged := e.createWebsite(t, login.Token)
	if st, _ := e.send(t, purged, s3, at(12, 0), "track"); st != 200 {
		t.Fatal("send to purged website")
	}
	if st, _ := do(t, e.prov, "DELETE", e.proxyURL+"/internal/v1/visit-tokens/websites/"+purged, "", nil, nil); st != 204 {
		t.Fatalf("token purge = %d", st)
	}
	if st, b := do(t, e.prov, "DELETE", e.proxyURL+"/api/websites/"+purged, login.Token, nil, nil); st != 200 {
		t.Fatalf("P9 via proxy = %d %s", st, b)
	}
	st, sb = e.send(t, purged, s3, at(12, 1), "track")
	if st != 400 || !strings.Contains(sb, "Website not found") {
		t.Fatalf("event for a deleted, purged website = %d %q, want 400 Website not found", st, sb)
	}

	// --- refusals on the real engine -------------------------------------------------------------------------
	for _, c := range []struct {
		cl     *http.Client
		m, u   string
		status int
	}{
		{e.edge, "POST", "/api/batch", 403},
		{e.edge, "GET", "/api/websites/" + tracked + "/stats?startAt=1&endAt=2&timezone=UTC", 403},
		{e.reader, "GET", "/api/admin/websites", 403},
		{e.reader, "GET", "/script.js", 403},
		{e.prov, "GET", "/openapi.json", 403},
	} {
		if st, _ := do(t, c.cl, c.m, e.proxyURL+c.u, login.Token, nil, nil); st != c.status {
			t.Errorf("%s %s = %d, want %d", c.m, c.u, st, c.status)
		}
	}

	// --- a restarted proxy re-checks the gate by itself ------------------------------------------------------
	_, gate2, _, _ := startProxy(t, e.umami, e.ca)
	if gate2.IsOpen() {
		t.Fatal("a fresh proxy starts with an open gate")
	}
	if st := gate2.Probe(t.Context(), &http.Client{Timeout: 10 * time.Second}, e.umami); st != 401 || gate2.IsOpen() {
		t.Fatalf("fresh proxy without provisioning credentials: probe %d, open %v (only the worker's B5 may open it)", st, gate2.IsOpen())
	}
	gate2.Provisioner = &proxy.Credentials{Username: "scf-provisioner", Password: provPW}
	if st := gate2.Probe(t.Context(), &http.Client{Timeout: 10 * time.Second}, e.umami); st != 401 || !gate2.IsOpen() {
		t.Fatalf("fresh proxy B5 probe = %d, open %v", st, gate2.IsOpen())
	}

	// --- the proxy's logs carry no surrogate, token or UA ----------------------------------------------------
	for _, bad := range []string{s1, s2, s3, "2001:db8", chromeUA, login.Token, seedPW, provPW, "startAt"} {
		if strings.Contains(e.logs.String(), bad) {
			t.Errorf("proxy logs contain %q", bad)
		}
	}
	st0 := e.store.Stats()
	t.Logf("visit memory: %+v", st0)
	if st0.Hits < 1 || st0.RefusedWindow < 1 {
		t.Fatalf("visit memory counters = %+v, want hits and a refused replay", st0)
	}
}
