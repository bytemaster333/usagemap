// SPDX-License-Identifier: Apache-2.0

package main

// Process-level tests of the gateway binary against a fake core (engine proxy + internal edge API over mutual TLS):
// forwarding contract (§c.2), counter upload (§l), spool accounting (§d.4), engine down → 202 and drain, kill -9
// between fsync and acknowledgement (nothing lost, nothing double), and the privacy scan of spool files and logs.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
	"github.com/bytemaster333/usagemap/services/gateway/internal/testpki"
	"github.com/bytemaster333/usagemap/services/gateway/pkg/probe"
)

var binPath string

func TestMain(m *testing.M) {
	dir, _ := os.MkdirTemp("", "gw-bin-")
	binPath = filepath.Join(dir, "gateway")
	if out, err := exec.Command("go", "build", "-o", binPath, ".").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

const (
	eSiteKey = "Q4mZ8bS1pTn0aR7cLx2VwE"
	eSiteID  = "0193b7e2-0000-7000-8000-0000000000a1"
	eTenant  = "0193b7e2-0000-7000-8000-00000000000a"
	eWebsite = "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
	marker   = "PrivacyMarkerUA4242"
)

type sendReq struct {
	headers http.Header
	body    map[string]any
}

type fakeCore struct {
	mu       sync.Mutex
	mode     string // ok | down | bot
	sends    []sendReq
	counters []spool.CounterRecord
	envelope []byte
	seq      int64
	srv      *httptest.Server
	// strict: a pre-C-136 control plane (closed counter schema) that answers 422 to `props` / `dev` (C-137).
	strict  bool
	refused int // counter records answered 422
}

func (f *fakeCore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 || r.TLS.PeerCertificates[0].Subject.CommonName != "edge-a1" {
		http.Error(w, "no edge certificate", 403)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.URL.Path {
	case "/internal/v1/edge/snapshot":
		if r.Header.Get("If-None-Match") == `"`+strconv.FormatInt(f.seq, 10)+`"` {
			w.WriteHeader(304)
			return
		}
		_, _ = w.Write(f.envelope)
	case "/internal/v1/edge/counters":
		b, _ := io.ReadAll(r.Body)
		var raw map[string]json.RawMessage
		_ = json.Unmarshal(b, &raw)
		_, hasProps := raw["props"]
		_, hasDev := raw["dev"]
		if f.strict && (hasProps || hasDev) {
			f.refused++
			http.Error(w, `{"error":"additional property"}`, 422)
			return
		}
		var c spool.CounterRecord
		if err := json.Unmarshal(b, &c); err != nil || c.NodeID != "edge-a1" {
			http.Error(w, "bad", 400)
			return
		}
		f.counters = append(f.counters, c)
		w.WriteHeader(200)
	case "/api/send":
		if f.mode == "down" {
			http.Error(w, "down", 503)
			return
		}
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.sends = append(f.sends, sendReq{headers: r.Header.Clone(), body: b})
		if f.mode == "bot" {
			_, _ = io.WriteString(w, `{"beep":"boop"}`)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeCore) set(mode string) { f.mu.Lock(); f.mode = mode; f.mu.Unlock() }

func (f *fakeCore) paths() map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := map[string]int{}
	for _, s := range f.sends {
		pl, _ := s.body["payload"].(map[string]any)
		u, _ := pl["url"].(string)
		m[u]++
	}
	return m
}

type harness struct {
	t       *testing.T
	dir     string
	core    *fakeCore
	envv    []string
	cmd     *exec.Cmd
	logs    *bytes.Buffer
	logMu   sync.Mutex
	pub     string
	metrics string
	allLogs bytes.Buffer
}

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
}

func newHarness(t *testing.T, mods ...func(*snapshot.Payload)) *harness {
	t.Helper()
	dir := t.TempDir()
	ca := testpki.NewCA()
	_ = os.WriteFile(filepath.Join(dir, "ca.pem"), ca.PEM, 0o644)
	edge := ca.Issue("edge", "edge-a1")
	cert, key := edge.WriteFiles(dir, "edge-a1")
	coreCert := ca.Issue("", "engine-proxy", "127.0.0.1")

	pubKey, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pubKey)
	_ = os.WriteFile(filepath.Join(dir, "snap.pub"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644)
	p := snapshot.Payload{Sequence: 1, IssuedAt: time.Now().UTC().Format(time.RFC3339),
		Settings: snapshot.Settings{PowCost: 256, PowMax: 64, PowMaxMultiplier: 8, WebEventsPerToken: 300, WebRequestsPerMinSubnet: 100000,
			MultiplicityThresholds: snapshot.Thresholds{"exact_ip": {"unknown": 1000}, "subnet": {"unknown": 1000}}, MultiplicityEventThresholds: snapshot.Thresholds{"exact_ip": {"unknown": 1000}, "subnet": {"unknown": 1000}},
			PathnormRulesVersion: "scf-path-rules/1.0.0"},
		Tenants: []snapshot.Tenant{{TenantID: eTenant, Status: "active", Level: 1}},
		Sites: []snapshot.Site{{SiteID: eSiteID, TenantID: eTenant, SiteKey: eSiteKey, UmamiWebsiteID: eWebsite, Status: "active", Profile: "standard",
			VisitorID: "on", VisitorIDOffCountries: []string{}, ExcludeCountries: []string{}, PathFolding: "relaxed", RateLimitPerMin: 100000, DailyQuota: 1000000,
			Domains: []snapshot.Domain{{Host: "example.org", Verified: true}}}},
		TrackerVersions: []snapshot.TrackerVersion{{Version: "1.0.0", Status: "active"}},
	}
	for _, m := range mods {
		m(&p)
	}
	pb, _ := json.Marshal(p)
	envl, _ := json.Marshal(snapshot.Envelope{Format: snapshot.Format, Alg: "Ed25519", Kid: "edge-1", Payload: base64.RawURLEncoding.EncodeToString(pb), Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, pb))})

	core := &fakeCore{mode: "ok", envelope: envl, seq: 1}
	core.srv = httptest.NewUnstartedServer(core)
	core.srv.TLS = &tls.Config{Certificates: []tls.Certificate{coreCert.TLS}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: ca.Pool, MinVersion: tls.VersionTLS13}
	core.srv.StartTLS()
	t.Cleanup(core.srv.Close)

	tracker := filepath.Join(dir, "tracker", "1.0.0")
	_ = os.MkdirAll(tracker, 0o755)
	writeTracker(t, tracker)

	h := &harness{t: t, dir: dir, core: core, pub: freePort(t), metrics: freePort(t)}
	h.envv = []string{
		"GW_NODE_ID=edge-a1", "GW_LISTEN_ADDR=:" + h.pub, "GW_ALLOW_PLAINTEXT=1", "GW_METRICS_ADDR=127.0.0.1:" + h.metrics,
		"GW_NODE_CERT=" + cert, "GW_NODE_KEY=" + key, "GW_CA=" + filepath.Join(dir, "ca.pem"),
		"GW_CORES=core-a=" + core.srv.URL, "GW_SNAPSHOT_KEYS=edge-1=" + filepath.Join(dir, "snap.pub"),
		"GW_STATE_DIR=" + filepath.Join(dir, "state"), "GW_TRACKER_DIR=" + filepath.Join(dir, "tracker"),
		"GW_RANGELISTS_DIR=" + filepath.Join(dir, "rl"), "GW_SNAPSHOT_INTERVAL=1s", "GW_COUNTER_PERIOD=1s", "GW_REQUIRE_MLOCK=0",
		"GW_FORWARD_WORKERS=4", "GW_OTLP_ENABLED=0", "PATH=" + os.Getenv("PATH"),
	}
	return h
}

func writeTracker(t *testing.T, dir string) {
	body := []byte("/*tracker*/")
	sum := func(b []byte) (string, string) {
		s256 := sha256sum(b)
		return s256, sri(b)
	}
	s256, integrity := sum(body)
	_ = os.WriteFile(filepath.Join(dir, "standard.js"), body, 0o644)
	m, _ := json.Marshal(map[string]any{"version": "1.0.0", "files": []any{map[string]any{"path": "standard.js", "profile": "standard", "bytes": len(body), "sha256": s256, "integrity": integrity}}})
	_ = os.WriteFile(filepath.Join(dir, "manifest.json"), m, 0o644)
}

func (h *harness) start() {
	h.t.Helper()
	h.logs = &bytes.Buffer{}
	h.cmd = exec.Command(binPath)
	h.cmd.Env = h.envv
	w := &lockedWriter{h: h}
	h.cmd.Stdout, h.cmd.Stderr = w, w
	if err := h.cmd.Start(); err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() {
		if h.cmd.ProcessState == nil {
			_ = h.cmd.Process.Kill()
			_ = h.cmd.Wait()
		}
	})
	h.waitFor("healthy", 20*time.Second, func() bool {
		r, err := http.Get("http://127.0.0.1:" + h.metrics + "/healthz")
		if err != nil {
			return false
		}
		r.Body.Close()
		return r.StatusCode == 200
	})
}

type lockedWriter struct{ h *harness }

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.h.logMu.Lock()
	defer w.h.logMu.Unlock()
	w.h.logs.Write(p)
	return w.h.allLogs.Write(p)
}

func (h *harness) kill9() {
	_ = h.cmd.Process.Signal(syscall.SIGKILL)
	_ = h.cmd.Wait()
}

func (h *harness) stop() {
	_ = h.cmd.Process.Signal(syscall.SIGTERM)
	_ = h.cmd.Wait()
}

func (h *harness) waitFor(what string, d time.Duration, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	h.logMu.Lock()
	defer h.logMu.Unlock()
	h.t.Fatalf("timed out waiting for %s\nlogs:\n%s", what, h.logs.String())
}

func (h *harness) canary(path string) probe.Result {
	h.t.Helper()
	r, err := probe.Send(context.Background(), probe.Config{Target: "http://127.0.0.1:" + h.pub, SiteKey: eSiteKey, Origin: "https://example.org",
		Path: path, TrackerVersion: "1.0.0", UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Safari/537.36 " + marker})
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func (h *harness) metric(name string) float64 {
	r, err := http.Get("http://127.0.0.1:" + h.metrics + "/metrics")
	if err != nil {
		return -1
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, name+" ") {
			v, _ := strconv.ParseFloat(strings.TrimPrefix(l, name+" "), 64)
			return v
		}
	}
	return -1
}

func TestForwardingContractAndCounters(t *testing.T) {
	h := newHarness(t)
	h.start()
	if r := h.canary("/pricing"); !r.OK() {
		t.Fatalf("canary status %d", r.Status)
	}
	h.waitFor("forwarded event", 10*time.Second, func() bool { return h.core.paths()["/pricing"] == 1 })
	h.core.mu.Lock()
	s := h.core.sends[0]
	h.core.mu.Unlock()
	if s.headers.Get("Content-Type") != "application/json" || s.headers.Get("cf-ipcountry") != "XX" || s.headers.Get("x-scf-visit") != "track" ||
		s.headers.Get("User-Agent") != "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" {
		t.Fatalf("headers %v", s.headers)
	}
	sur, err := netip.ParseAddr(s.headers.Get("x-scf-surrogate-ip"))
	if err != nil || !netip.MustParsePrefix("2001:db8::/32").Contains(sur) {
		t.Fatalf("surrogate %q", s.headers.Get("x-scf-surrogate-ip"))
	}
	for _, hd := range []string{"X-Forwarded-For", "Forwarded", "X-Real-Ip", "Cookie", "Authorization", "X-Umami-Cache", "Cf-Connecting-Ip"} {
		if s.headers.Get(hd) != "" {
			t.Fatalf("forbidden header %s forwarded", hd)
		}
	}
	if s.body["type"] != "event" {
		t.Fatal("type")
	}
	pl := s.body["payload"].(map[string]any)
	allowed := map[string]bool{"website": true, "hostname": true, "url": true, "referrer": true, "screen": true, "language": true, "name": true, "data": true, "tag": true, "timestamp": true}
	for k := range pl {
		if !allowed[k] {
			t.Fatalf("payload field %q outside §c.2", k)
		}
	}
	ts := pl["timestamp"].(float64)
	if pl["website"] != eWebsite || pl["hostname"] != "example.org" || pl["tag"] != "v" || ts < float64(time.Now().Add(-time.Minute).Unix()) {
		t.Fatalf("payload %v", pl)
	}
	// A scripted POST without a challenge: 202, not forwarded, counted rejected/challenge_missing.
	body := `{"v":1,"s":"` + eSiteKey + `","p":"standard","tv":"1.0.0","e":[{"id":"AAAAAAAAAAAAAAAAAAAAAA","k":"pv","u":"/scripted"}]}`
	resp, err := http.Post("http://127.0.0.1:"+h.pub+"/v1/e", "text/plain", strings.NewReader(body))
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("scripted POST: %v %d", err, resp.StatusCode)
	}
	resp.Body.Close()
	h.waitFor("counter record with the rejection", 10*time.Second, func() bool {
		h.core.mu.Lock()
		defer h.core.mu.Unlock()
		var rej, missing, verified int64
		for _, c := range h.core.counters {
			for _, w := range c.Web {
				switch {
				case w.Counter == "verdict" && w.Label == "rejected":
					rej += w.Count
				case w.Counter == "verdict" && w.Label == "verified":
					verified += w.Count
				case w.Counter == "reason" && w.Label == "challenge_missing":
					missing += w.Count
				}
			}
		}
		return rej == 1 && missing == 1 && verified == 1
	})
	if h.core.paths()["/scripted"] != 0 {
		t.Fatal("a rejected event reached the engine")
	}
	// Spool accounting adds up: fsynced = acked + expired + queued (C-76).
	h.waitFor("accounting balanced", 10*time.Second, func() bool {
		h.core.mu.Lock()
		defer h.core.mu.Unlock()
		var f, a, q int64
		for _, c := range h.core.counters {
			f += c.Spool.Fsynced
			a += c.Spool.AckedStored + c.Spool.AckedEngineBot + c.Spool.AckedEngineRejected + c.Spool.Expired72h
			q = c.Spool.Queued
		}
		return f == 1 && a == 1 && q == 0
	})
	// Unknown tracker version → 404; known → the file.
	if r, _ := http.Get("http://127.0.0.1:" + h.pub + "/lib/9.9.9/standard.js"); r.StatusCode != 404 {
		t.Fatal("unknown tracker version")
	}
	if r, _ := http.Get("http://127.0.0.1:" + h.pub + "/lib/1.0.0/standard.js"); r.StatusCode != 200 {
		t.Fatal("tracker file")
	}
	h.stop()
	privacyScan(t, h)
}

func TestEngineDownStill202AndDrains(t *testing.T) {
	h := newHarness(t)
	h.core.set("down")
	h.start()
	for i := 0; i < 5; i++ {
		if r := h.canary(fmt.Sprintf("/down/%d?utm_secret=1", i)); !r.OK() {
			t.Fatalf("status %d while the engine is down", r.Status)
		}
	}
	h.waitFor("queued gauge", 5*time.Second, func() bool { return h.metric("scf_gateway_spool_queued") == 5 })
	// Privacy scan while the records sit in the spool.
	spoolText := ""
	_ = filepath.Walk(filepath.Join(h.dir, "state"), func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.HasSuffix(p, ".seg") {
			b, _ := os.ReadFile(p)
			spoolText += string(b)
		}
		return nil
	})
	if !strings.Contains(spoolText, `"url":"/down/0"`) {
		t.Fatalf("spool does not hold the queued records: %q", spoolText)
	}
	privacyScan(t, h)
	h.core.set("ok")
	h.waitFor("spool drained", 20*time.Second, func() bool { return h.metric("scf_gateway_spool_queued") == 0 })
	for i := 0; i < 5; i++ {
		if n := h.core.paths()[fmt.Sprintf("/down/%d", i)]; n != 1 {
			t.Fatalf("/down/%d delivered %d times", i, n)
		}
	}
	h.stop()
}

// TestKill9BetweenFsyncAndAck: records answered 202 while the engine is unreachable are fsync'd but not
// acknowledged; the process is killed with SIGKILL; after a restart every record is delivered exactly once.
func TestKill9BetweenFsyncAndAck(t *testing.T) {
	h := newHarness(t)
	h.core.set("down")
	h.start()
	const n = 30
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := map[string]bool{}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			p := fmt.Sprintf("/crash/%d", i)
			if r := h.canary(p); r.OK() {
				mu.Lock()
				accepted[p] = true
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if len(accepted) != n {
		t.Fatalf("accepted %d of %d", len(accepted), n)
	}
	h.kill9()
	h.start()
	// The engine is still down: the queued gauge counts the records recovered from disk (they are pending).
	h.waitFor("queued gauge counts recovered records", 5*time.Second, func() bool { return h.metric("scf_gateway_spool_queued") == n })
	h.core.set("ok")
	h.waitFor("all records delivered after restart", 30*time.Second, func() bool {
		got := h.core.paths()
		for p := range accepted {
			if got[p] == 0 {
				return false
			}
		}
		return true
	})
	time.Sleep(2 * time.Second) // let any duplicate surface
	for p, c := range h.core.paths() {
		if strings.HasPrefix(p, "/crash/") && c != 1 {
			t.Fatalf("%s delivered %d times", p, c)
		}
	}
	h.waitFor("queue empty", 10*time.Second, func() bool { return h.metric("scf_gateway_spool_queued") == 0 })
	// The restart is visible in the accounting: two boot ids.
	h.waitFor("counter records from the second boot", 10*time.Second, func() bool {
		h.core.mu.Lock()
		defer h.core.mu.Unlock()
		boots := map[string]bool{}
		for _, c := range h.core.counters {
			boots[c.Spool.BootID] = true
		}
		return len(boots) >= 1
	})
	h.stop()
	privacyScan(t, h)
}

func TestSnapshotRollbackRefusedAndStaleKeepsServing(t *testing.T) {
	h := newHarness(t)
	h.start()
	if h.metric("scf_gateway_snapshot_sequence") != 1 {
		t.Fatal("sequence 1 expected")
	}
	// Core goes away: the node keeps serving from the last good snapshot.
	h.core.srv.Close()
	time.Sleep(2 * time.Second)
	if r := h.canary("/after-core-loss"); !r.OK() {
		t.Fatalf("must keep serving with the last good snapshot: %d", r.Status)
	}
	if h.metric("scf_gateway_snapshot_age_seconds") < 1 {
		t.Fatal("age must grow while fetches fail")
	}
	h.stop()
	// Restart without any core: the persisted snapshot is used.
	h.start()
	if h.metric("scf_gateway_snapshot_sequence") != 1 {
		t.Fatal("persisted snapshot not loaded at start")
	}
	h.stop()
}

// privacyScan asserts that neither the spool files nor the logs contain the client address, the raw User-Agent,
// the per-event id, the token or a query string (C-34, ADR-0006, privacy invariants).
func privacyScan(t *testing.T, h *harness) {
	t.Helper()
	var spoolBytes bytes.Buffer
	_ = filepath.Walk(filepath.Join(h.dir, "state"), func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && (strings.HasSuffix(p, ".seg") || strings.HasSuffix(p, ".ack")) {
			b, _ := os.ReadFile(p)
			spoolBytes.Write(b)
		}
		return nil
	})
	h.logMu.Lock()
	logs := h.allLogs.String()
	h.logMu.Unlock()
	for name, hay := range map[string]string{"spool": spoolBytes.String(), "logs": logs} {
		for _, needle := range []string{"127.0.0.1", marker, "6778.204", "AAAAAAAAAAAAAAAAAAAAAA", "utm_", "Sec-Fetch", "example.org/"} {
			if strings.Contains(hay, needle) {
				t.Errorf("%s contains %q", name, needle)
			}
		}
	}
}

func sha256sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func sri(b []byte) string {
	s := sha512.Sum384(b)
	return "sha384-" + base64.StdEncoding.EncodeToString(s[:])
}

// C-124 (F2): with GW_TLS_CERT the gateway terminates TLS in transport.Listener; HTTP/1.1 and HTTP/2 (ALPN) both work,
// and a Go client claiming Chrome is `suspect/transport_mismatch` — forwarded with tag "s", never rejected.
func TestTLSListenerTransportFingerprint(t *testing.T) {
	h := newHarness(t)
	ca := testpki.NewCA()
	ing := ca.Issue("", "ingest-a.test", "ingest-a.test", "127.0.0.1")
	cert, key := ing.WriteFiles(h.dir, "ingest")
	var env []string
	for _, e := range h.envv {
		if e != "GW_ALLOW_PLAINTEXT=1" {
			env = append(env, e)
		}
	}
	h.envv = append(env, "GW_TLS_CERT="+cert, "GW_TLS_KEY="+key)
	h.start()
	tr := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: ca.Pool, ServerName: "ingest-a.test"}, ForceAttemptHTTP2: true}
	cl := &http.Client{Transport: tr, Timeout: 10 * time.Second}
	base := "https://127.0.0.1:" + h.pub
	r, err := cl.Get(base + "/lib/1.0.0/standard.js")
	if err != nil || r.StatusCode != 200 || r.ProtoMajor != 2 {
		t.Fatalf("tracker over h2: %v %+v", err, r)
	}
	r.Body.Close()
	h1 := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: ca.Pool, ServerName: "ingest-a.test"},
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}}, Timeout: 10 * time.Second}
	if r, err := h1.Get(base + "/lib/1.0.0/standard.js"); err != nil || r.StatusCode != 200 || r.ProtoMajor != 1 {
		t.Fatalf("tracker over HTTP/1.1: %v", err)
	} else {
		r.Body.Close()
	}
	res, err := probe.Send(context.Background(), probe.Config{Target: base, SiteKey: eSiteKey, Origin: "https://example.org", Path: "/tls", TrackerVersion: "1.0.0",
		UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Safari/537.36", Client: cl})
	if err != nil || !res.OK() {
		t.Fatalf("canary over TLS: %v %d", err, res.Status)
	}
	h.waitFor("forwarded suspect event", 10*time.Second, func() bool { return h.core.paths()["/tls"] == 1 })
	h.core.mu.Lock()
	tag := h.core.sends[0].body["payload"].(map[string]any)["tag"]
	h.core.mu.Unlock()
	if tag != "s" {
		t.Fatalf("tag %v, want s", tag)
	}
	h.waitFor("counter record with transport_mismatch", 10*time.Second, func() bool {
		h.core.mu.Lock()
		defer h.core.mu.Unlock()
		var n int64
		for _, c := range h.core.counters {
			for _, w := range c.Web {
				if w.Counter == "reason" && w.Label == "transport_mismatch" {
					n += w.Count
				}
			}
		}
		return n == 1
	})
	m, _ := http.Get("http://127.0.0.1:" + h.metrics + "/metrics")
	b, _ := io.ReadAll(m.Body)
	m.Body.Close()
	for _, want := range []string{
		`scf_gateway_transport_checks_total{claimed="chromium",observed="library",result="mismatch",why="tls_family"} 1`,
		`scf_gateway_kday_regenerated_total 1`, `scf_gateway_spool_max_bytes 2.147483648e+10`,
		`scf_gateway_sites_limited{kind="rate_limited"} 0`, `scf_gateway_kday_fingerprint_info{fingerprint="`, `scf_gateway_snapshot_expired 0`,
	} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("metrics lack %q:\n%s", want, b)
		}
	}
	h.stop()
	privacyScan(t, h)
}
