// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/testpki"
)

type tlsHarness struct {
	*harness
	ts       *httptest.Server
	ca       *testpki.CA
	dir      string
	reloader *TLSReloader
	files    TLSFiles
}

func newTLSHarness(t *testing.T) *tlsHarness {
	t.Helper()
	h := newHarness(t, true)
	ca := testpki.NewCA(t, "scf-test-ca")
	dir := t.TempDir()
	srv := ca.Server(t, "engine-proxy")
	files := TLSFiles{
		CertFile:     testpki.Write(t, dir, "server.pem", srv.CertPEM),
		KeyFile:      testpki.Write(t, dir, "server-key.pem", srv.KeyPEM),
		ClientCAFile: testpki.Write(t, dir, "ca.pem", ca.PEM),
	}
	rl, err := NewTLSReloader(files)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(h.srv)
	ts.TLS = rl.ServerConfig()
	ts.Config.ConnState = rl.ConnState
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return &tlsHarness{harness: h, ts: ts, ca: ca, dir: dir, reloader: rl, files: files}
}

func (th *tlsHarness) client(t *testing.T, leaf *testpki.Leaf) *http.Client {
	t.Helper()
	return &http.Client{Transport: &http.Transport{TLSClientConfig: th.clientTLS(t, leaf)}}
}

// clientTLS is the client side of the mutual-TLS handshake for leaf (nil: no client certificate).
func (th *tlsHarness) clientTLS(t *testing.T, leaf *testpki.Leaf) *tls.Config {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(th.ca.Cert)
	cfg := &tls.Config{MinVersion: tls.VersionTLS13, ServerName: "engine-proxy", RootCAs: pool}
	if leaf != nil {
		kp, err := tls.X509KeyPair(leaf.CertPEM, leaf.KeyPEM)
		if err != nil {
			t.Fatal(err)
		}
		cfg.Certificates = []tls.Certificate{kp}
	}
	return cfg
}

// revoke writes a CRL revoking leaves and reloads the proxy's TLS configuration (what SIGHUP does).
func (th *tlsHarness) revoke(t *testing.T, leaves ...*testpki.Leaf) {
	t.Helper()
	certs := make([]*x509.Certificate, 0, len(leaves))
	for _, l := range leaves {
		certs = append(certs, l.Cert)
	}
	th.files.CRLFile = testpki.Write(t, th.dir, "crl.pem", th.ca.CRL(t, certs...))
	th.reloader.files = th.files
	if err := th.reloader.Reload(); err != nil {
		t.Fatal(err)
	}
}

// postOn sends one event over a fresh connection that uses cfg (and its session cache) and reports whether the
// TLS session was resumed.
func (th *tlsHarness) postOn(t *testing.T, cfg *tls.Config) (code int, resumed bool, err error) {
	t.Helper()
	tr := &http.Transport{TLSClientConfig: cfg, DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	req, _ := http.NewRequest("POST", th.ts.URL+"/api/send", strings.NewReader(event(site, at(10, 0), "")))
	for k, v := range sendHeaders("track") {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return 0, false, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, resp.TLS != nil && resp.TLS.DidResume, nil
}

func (th *tlsHarness) post(t *testing.T, c *http.Client) (int, error) {
	t.Helper()
	req, _ := http.NewRequest("POST", th.ts.URL+"/api/send", strings.NewReader(event(site, at(10, 0), "")))
	for k, v := range sendHeaders("track") {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

func TestMutualTLSAcceptsOnlyNodeCertificatesOfThePrivateCA(t *testing.T) {
	th := newTLSHarness(t)

	edge := th.ca.Client(t, "edge-a1", "edge")
	if code, err := th.post(t, th.client(t, edge)); err != nil || code != 200 {
		t.Fatalf("edge with valid certificate: %d %v", code, err)
	}

	// No client certificate: the handshake fails.
	if _, err := th.post(t, th.client(t, nil)); err == nil {
		t.Fatal("client without certificate was accepted")
	}

	// A certificate from another CA: the handshake fails.
	other := testpki.NewCA(t, "other-ca").Client(t, "edge-a1", "edge")
	if _, err := th.post(t, th.client(t, other)); err == nil {
		t.Fatal("certificate of a foreign CA was accepted")
	}

	// A valid certificate without a known role: 403 from the handler.
	norole := th.ca.Client(t, "edge-a2", "")
	if code, err := th.post(t, th.client(t, norole)); err != nil || code != 403 {
		t.Fatalf("certificate without role: %d %v", code, err)
	}

	// A reader certificate cannot send events.
	reader := th.ca.Client(t, "core-a-control-plane", "reader")
	if code, err := th.post(t, th.client(t, reader)); err != nil || code != 403 {
		t.Fatalf("reader sending events: %d %v", code, err)
	}
}

func TestRevocationTakesEffectOnReload(t *testing.T) {
	th := newTLSHarness(t)
	edge := th.ca.Client(t, "edge-a1", "edge")
	c := th.client(t, edge)
	if code, err := th.post(t, c); err != nil || code != 200 {
		t.Fatalf("before revocation: %d %v", code, err)
	}
	th.files.CRLFile = testpki.Write(t, th.dir, "crl.pem", th.ca.CRL(t, edge.Cert))
	th.reloader.files = th.files
	if err := th.reloader.Reload(); err != nil {
		t.Fatal(err)
	}
	c2 := th.client(t, edge) // new connection
	if _, err := th.post(t, c2); err == nil {
		t.Fatal("revoked certificate accepted after reload")
	}
	other := th.ca.Client(t, "edge-b1", "edge")
	if code, err := th.post(t, th.client(t, other)); err != nil || code != 200 {
		t.Fatalf("unrevoked certificate: %d %v", code, err)
	}
}

// A revoked certificate must not keep working through TLS session resumption. The client keeps its
// session cache across connections, exactly like a long-running forwarder.
func TestRevokedCertificateCannotResumeASession(t *testing.T) {
	th := newTLSHarness(t)
	edge := th.ca.Client(t, "edge-a1", "edge")
	cfg := th.clientTLS(t, edge)
	cfg.ClientSessionCache = tls.NewLRUClientSessionCache(8)
	if code, _, err := th.postOn(t, cfg); err != nil || code != 200 {
		t.Fatalf("first connection: %d %v", code, err)
	}
	code, resumed, err := th.postOn(t, cfg)
	if err != nil || code != 200 || !resumed {
		t.Fatalf("second connection must resume (else this test proves nothing): %d resumed=%v %v", code, resumed, err)
	}
	th.revoke(t, edge)
	if code, resumed, err := th.postOn(t, cfg); err == nil {
		t.Fatalf("revoked certificate accepted after reload: %d resumed=%v", code, resumed)
	}
}

// Session tickets issued before a reload are not accepted afterwards (ticket keys rotate), so every connection after
// a certificate, CA or CRL change goes through a full handshake.
func TestReloadRotatesSessionTicketKeys(t *testing.T) {
	th := newTLSHarness(t)
	edge := th.ca.Client(t, "edge-a1", "edge")
	cfg := th.clientTLS(t, edge)
	cfg.ClientSessionCache = tls.NewLRUClientSessionCache(8)
	if code, _, err := th.postOn(t, cfg); err != nil || code != 200 {
		t.Fatalf("first connection: %d %v", code, err)
	}
	if err := th.reloader.Reload(); err != nil {
		t.Fatal(err)
	}
	code, resumed, err := th.postOn(t, cfg)
	if err != nil || code != 200 {
		t.Fatalf("after reload: %d %v", code, err)
	}
	if resumed {
		t.Fatal("a session ticket from before the reload was accepted")
	}
	if _, resumed, _ := th.postOn(t, cfg); !resumed {
		t.Fatal("tickets issued after the reload must work")
	}
}

// The revocation check runs in VerifyConnection, which crypto/tls also calls for resumed sessions.
func TestVerifyConnectionRefusesRevokedPeerOnResumption(t *testing.T) {
	th := newTLSHarness(t)
	edge := th.ca.Client(t, "edge-a1", "edge")
	th.revoke(t, edge)
	cfg := th.reloader.cur.Load()
	if cfg.VerifyConnection == nil {
		t.Fatal("no VerifyConnection")
	}
	cs := tls.ConnectionState{DidResume: true, PeerCertificates: []*x509.Certificate{edge.Cert}}
	if err := cfg.VerifyConnection(cs); err == nil {
		t.Fatal("revoked certificate passed VerifyConnection on a resumed session")
	}
	ok := th.ca.Client(t, "edge-b1", "edge")
	if err := cfg.VerifyConnection(tls.ConnectionState{DidResume: true, PeerCertificates: []*x509.Certificate{ok.Cert}}); err != nil {
		t.Fatalf("unrevoked certificate refused: %v", err)
	}
	if err := cfg.VerifyConnection(tls.ConnectionState{}); err == nil {
		t.Fatal("connection without a peer certificate passed")
	}
}

// An open keep-alive connection is closed on reload, so a revoked caller cannot keep using a connection it opened
// before the revocation.
func TestReloadClosesOpenKeepAliveConnections(t *testing.T) {
	th := newTLSHarness(t)
	edge := th.ca.Client(t, "edge-a1", "edge")
	cfg := th.clientTLS(t, edge)
	cfg.NextProtos = []string{"http/1.1"}
	conn, err := tls.Dial("tcp", th.ts.Listener.Addr().String(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	br := bufio.NewReader(conn)
	send := func() (*http.Response, error) {
		req, _ := http.NewRequest("POST", th.ts.URL+"/api/send", strings.NewReader(event(site, at(10, 0), "")))
		for k, v := range sendHeaders("track") {
			req.Header.Set(k, v)
		}
		if err := req.Write(conn); err != nil {
			return nil, err
		}
		resp, err := http.ReadResponse(br, req)
		if err != nil {
			return nil, err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp, nil
	}
	if resp, err := send(); err != nil || resp.StatusCode != 200 || resp.Close {
		t.Fatalf("first request on the keep-alive connection: %+v %v", resp, err)
	}
	th.revoke(t, edge)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := br.ReadByte(); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("keep-alive connection still open after reload: %v", err)
	}
	if resp, err := send(); err == nil {
		t.Fatalf("request on the old connection after reload answered %d", resp.StatusCode)
	}
}

func TestCRLFromAnotherCAIsRefused(t *testing.T) {
	th := newTLSHarness(t)
	foreign := testpki.NewCA(t, "other")
	th.reloader.files.CRLFile = testpki.Write(t, th.dir, "crl.pem", foreign.CRL(t))
	if err := th.reloader.Reload(); err == nil {
		t.Fatal("CRL signed by another CA accepted")
	}
}

func TestClientConfigLoadsFiles(t *testing.T) {
	ca := testpki.NewCA(t, "ca")
	l := ca.Client(t, "core-a-umami-reconcile", "provisioner")
	dir := t.TempDir()
	cfg, err := ClientConfig(testpki.Write(t, dir, "c.pem", l.CertPEM), testpki.Write(t, dir, "k.pem", l.KeyPEM),
		testpki.Write(t, dir, "ca.pem", ca.PEM), "engine-proxy")
	if err != nil || len(cfg.Certificates) != 1 || cfg.ServerName != "engine-proxy" || cfg.MinVersion != tls.VersionTLS13 {
		t.Fatalf("ClientConfig = %+v, %v", cfg, err)
	}
	if _, err := ClientConfig(dir+"/missing", dir+"/k.pem", dir+"/ca.pem", "x"); err == nil {
		t.Fatal("missing file accepted")
	}
}

type closeRecorder struct {
	net.Conn
	closed atomic.Bool
}

func (c *closeRecorder) Close() error { c.closed.Store(true); return nil }

// A connection busy with a request when the reload happens is closed only once that request has been answered.
func TestReloadClosesBusyConnectionsAfterTheirRequest(t *testing.T) {
	th := newTLSHarness(t)
	busy, idle, fresh := &closeRecorder{}, &closeRecorder{}, &closeRecorder{}
	th.reloader.ConnState(busy, http.StateNew)
	th.reloader.ConnState(busy, http.StateActive)
	th.reloader.ConnState(idle, http.StateNew)
	th.reloader.ConnState(idle, http.StateActive)
	th.reloader.ConnState(idle, http.StateIdle)
	if err := th.reloader.Reload(); err != nil {
		t.Fatal(err)
	}
	if !idle.closed.Load() {
		t.Fatal("idle connection not closed on reload")
	}
	if busy.closed.Load() {
		t.Fatal("busy connection closed in the middle of its request")
	}
	th.reloader.ConnState(busy, http.StateIdle)
	if !busy.closed.Load() {
		t.Fatal("busy connection not closed after its request")
	}
	// A connection accepted after the reload is not affected by it.
	th.reloader.ConnState(fresh, http.StateNew)
	th.reloader.ConnState(fresh, http.StateActive)
	th.reloader.ConnState(fresh, http.StateIdle)
	if fresh.closed.Load() {
		t.Fatal("connection opened after the reload was closed")
	}
	for _, c := range []*closeRecorder{busy, idle, fresh} {
		th.reloader.ConnState(c, http.StateClosed)
	}
	th.reloader.mu.Lock()
	n := len(th.reloader.conns)
	th.reloader.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d closed connections still tracked", n)
	}
}
