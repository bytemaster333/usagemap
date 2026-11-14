// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/obs"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

const testAddr = "127.0.0.1:56188" // writer test host port range 56180–56199

type fakeApplier struct {
	mu      sync.Mutex
	down    atomic.Bool // Ping fails
	failNow atomic.Bool // next Apply reports a lost connection
	busyNow atomic.Bool // next Apply reports a busy database (timeout, pool wait)
	parts   int
	budget  time.Duration // remaining budget of the last Apply's context
}

func (f *fakeApplier) Apply(ctx context.Context, _ [32]byte, _ *batch.TenantPart) (store.Result, error) {
	if dl, ok := ctx.Deadline(); ok {
		f.mu.Lock()
		f.budget = time.Until(dl)
		f.mu.Unlock()
	}
	if f.busyNow.Swap(false) {
		return store.Result{}, fmt.Errorf("%w: tenant transaction timed out", store.ErrBusy)
	}
	if f.failNow.Swap(false) {
		f.down.Store(true)
		return store.Result{}, store.ErrUnavailable
	}
	f.mu.Lock()
	f.parts++
	f.mu.Unlock()
	return store.Result{Applied: 1}, nil
}

func (f *fakeApplier) Ping(context.Context) error {
	if f.down.Load() {
		return store.ErrUnavailable
	}
	return nil
}

type pki struct {
	dir                   string
	ca                    *x509.Certificate
	srvCert, srvKey       string
	edgeCert, edgeKey     string
	readerCert, readerKey string
}

func newPKI(t *testing.T) *pki {
	t.Helper()
	dir := t.TempDir()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ca"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &caKey.PublicKey, caKey)
	ca, _ := x509.ParseCertificate(der)
	write := func(name, typ string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: b}), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	write("ca.pem", "CERTIFICATE", der)
	issue := func(name string, subj pkix.Name, eku x509.ExtKeyUsage) (string, string) {
		k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		s, _ := rand.Int(rand.Reader, big.NewInt(1<<60))
		c := &x509.Certificate{SerialNumber: s, Subject: subj, NotBefore: time.Now().Add(-time.Hour),
			NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{eku},
			DNSNames: []string{"writers.mesh.test"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
		d, err := x509.CreateCertificate(rand.Reader, c, ca, &k.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		kd, _ := x509.MarshalPKCS8PrivateKey(k)
		return write(name+".pem", "CERTIFICATE", d), write(name+"-key.pem", "PRIVATE KEY", kd)
	}
	p := &pki{dir: dir, ca: ca}
	p.srvCert, p.srvKey = issue("srv", pkix.Name{CommonName: "core-a-writer"}, x509.ExtKeyUsageServerAuth)
	p.edgeCert, p.edgeKey = issue("edge", pkix.Name{CommonName: "edge-a1", OrganizationalUnit: []string{"edge"}}, x509.ExtKeyUsageClientAuth)
	p.readerCert, p.readerKey = issue("reader", pkix.Name{CommonName: "core-a-jobs", OrganizationalUnit: []string{"reader"}}, x509.ExtKeyUsageClientAuth)
	return p
}

func (p *pki) client(t *testing.T, cert, key string, maxTLS uint16) *http.Client {
	pool := x509.NewCertPool()
	pool.AddCert(p.ca)
	cfg := &tls.Config{RootCAs: pool, ServerName: "writers.mesh.test", MaxVersion: maxTLS}
	if cert != "" {
		c, err := tls.LoadX509KeyPair(cert, key)
		if err != nil {
			t.Fatal(err)
		}
		cfg.Certificates = []tls.Certificate{c}
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: cfg, ForceAttemptHTTP2: true}}
}

func start(t *testing.T) (*Server, *fakeApplier, *pki, *obs.Registry) {
	t.Helper()
	p := newPKI(t)
	tr, err := NewTLSReloader(TLSFiles{CertFile: p.srvCert, KeyFile: p.srvKey, ClientCAFile: filepath.Join(p.dir, "ca.pem")})
	if err != nil {
		t.Fatal(err)
	}
	app := &fakeApplier{}
	reg := obs.New()
	s := New(Config{Addr: testAddr, ProbeInterval: 50 * time.Millisecond, MaxBodyBytes: 1 << 20}, tr, app, reg,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	opened := s.WaitOpen()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = s.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("listener did not open")
	}
	return s, app, p, reg
}

func body(t *testing.T) []byte {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("scf.tenant.id", "0198a000-0000-7000-8000-00000000000a")
	rm.Resource().Attributes().PutStr("service.name", "svc")
	b, err := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func post(c *http.Client, path, ct, enc string, b []byte) (*http.Response, error) {
	req, _ := http.NewRequest(http.MethodPost, "https://"+testAddr+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", ct)
	if enc != "" {
		req.Header.Set("Content-Encoding", enc)
	}
	return c.Do(req)
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

type reply struct {
	resp *http.Response
	err  error
}

func do(r *http.Response, err error) reply { return reply{r, err} }

func status(t *testing.T, r reply) int {
	t.Helper()
	resp, err := r.resp, r.err
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

func TestResponsesAndClientIdentity(t *testing.T) {
	_, app, p, _ := start(t)
	edge := p.client(t, p.edgeCert, p.edgeKey, 0)
	pb := "application/x-protobuf"
	if c := status(t, do(post(edge, "/v1/metrics", pb, "gzip", gz(body(t))))); c != 200 || app.parts != 1 {
		t.Fatalf("gzip protobuf: %d, parts %d", c, app.parts)
	}
	if c := status(t, do(post(edge, "/v1/metrics", pb, "", body(t)))); c != 200 {
		t.Fatalf("plain protobuf: %d", c)
	}
	for name, tc := range map[string]struct {
		path, ct, enc string
		b             []byte
		want          int
	}{
		"garbage":   {"/v1/metrics", pb, "", []byte{0xff, 0xff, 0x01}, 400},
		"bad gzip":  {"/v1/metrics", pb, "gzip", []byte("nope"), 400},
		"too large": {"/v1/metrics", pb, "gzip", gz(make([]byte, 2<<20)), 400},
		"json":      {"/v1/metrics", "application/json", "", []byte("{}"), 415},
		"logs":      {"/v1/logs", pb, "", body(t), 404},
	} {
		if c := status(t, do(post(edge, tc.path, tc.ct, tc.enc, tc.b))); c != tc.want {
			t.Errorf("%s: %d, want %d", name, c, tc.want)
		}
	}
	// Only edge-node certificates of our CA, TLS 1.3 only.
	for name, c := range map[string]*http.Client{
		"reader OU": p.client(t, p.readerCert, p.readerKey, 0),
		"no cert":   p.client(t, "", "", 0),
		"TLS 1.2":   p.client(t, p.edgeCert, p.edgeKey, tls.VersionTLS12),
	} {
		if resp, err := post(c, "/v1/metrics", pb, "", body(t)); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				t.Errorf("%s: accepted", name)
			}
		}
	}
}

// Loss of the database connection: the request in flight gets 503 + Retry-After, the listener closes (connection
// refused, so the Collector's dialer moves to the other writer) and reopens when the database is back (C-107).
func TestListenerClosesOnDatabaseLossAndReopens(t *testing.T) {
	s, app, p, reg := start(t)
	edge := p.client(t, p.edgeCert, p.edgeKey, 0)
	app.failNow.Store(true)
	resp, err := post(edge, "/v1/metrics", "application/x-protobuf", "", body(t))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 503 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("status %d, Retry-After %q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", testAddr, 200*time.Millisecond)
		if err != nil {
			break
		}
		c.Close()
		if time.Now().After(deadline) {
			t.Fatal("listener still accepting connections with the database down")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if s.Open() || reg.Get(obs.ListenerOpen) != 0 {
		t.Fatal("server reports an open listener")
	}
	reopened := s.WaitOpen()
	app.down.Store(false)
	select {
	case <-reopened:
	case <-time.After(5 * time.Second):
		t.Fatal("listener not reopened")
	}
	edge2 := p.client(t, p.edgeCert, p.edgeKey, 0)
	if c := status(t, do(post(edge2, "/v1/metrics", "application/x-protobuf", "", body(t)))); c != 200 {
		t.Fatalf("after recovery: %d", c)
	}
	if reg.Get(obs.ListenerCycles, "transition", "closed") < 1 {
		t.Fatal("transition not counted")
	}
}

// The writer never logs a peer address: net/http's TLS handshake lines are replaced.
func TestHandshakeLogHasNoAddress(t *testing.T) {
	var buf bytes.Buffer
	h := handshakeLog{reg: obs.New(), log: slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))}
	_, _ = h.Write([]byte("http: TLS handshake error from 203.0.113.9:4711: remote error: bad certificate\n"))
	if strings.Contains(buf.String(), "203.0.113") {
		t.Fatalf("address logged: %s", buf.String())
	}
	if h.reg.Get(obs.TLSErrors) != 1 {
		t.Fatal("handshake error not counted")
	}
}

// A busy database (a transaction deadline, no pooled connection) is answered 503 + Retry-After so the Collector retries,
// but the listener stays open: closing it would fail every tenant over for one slow transaction.
func TestBusyDatabaseKeepsTheListenerOpen(t *testing.T) {
	s, app, p, reg := start(t)
	edge := p.client(t, p.edgeCert, p.edgeKey, 0)
	app.busyNow.Store(true)
	resp, err := post(edge, "/v1/metrics", "application/x-protobuf", "", body(t))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 503 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("status %d, Retry-After %q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
	time.Sleep(200 * time.Millisecond) // several probe intervals
	if !s.Open() || reg.Get(obs.ListenerCycles, "transition", "closed") != 0 {
		t.Fatal("a busy database closed the listener")
	}
	if c := status(t, do(post(edge, "/v1/metrics", "application/x-protobuf", "", body(t)))); c != 200 {
		t.Fatalf("next request: %d", c)
	}
}

// The request budget is below the Collector's 15 s exporter timeout, so the writer answers before the Collector
// gives up and retries a request that is still being applied.
func TestRequestBudgetBelowCollectorTimeout(t *testing.T) {
	_, app, p, _ := start(t)
	edge := p.client(t, p.edgeCert, p.edgeKey, 0)
	if c := status(t, do(post(edge, "/v1/metrics", "application/x-protobuf", "", body(t)))); c != 200 {
		t.Fatalf("status %d", c)
	}
	app.mu.Lock()
	b := app.budget
	app.mu.Unlock()
	if b <= 0 || b > DefaultWorkTimeout || DefaultWorkTimeout >= 15*time.Second {
		t.Fatalf("budget %s, default %s: must be below the Collector's 15 s timeout", b, DefaultWorkTimeout)
	}
}
