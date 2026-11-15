// SPDX-License-Identifier: Apache-2.0

package main

// Process-level test of the OTLP front door: SDK payloads (OTLP/HTTP JSON from collector testdata, and a hand-encoded
// OTLP/gRPC protobuf) → gateway binary → the REAL Collector binary (collector/_build, our scf-otelcol with
// scfsanitize, production config) → a fake metrics writer over mutual TLS. Asserts the tenant metadata (incl. the
// tenant level, C-116) reaches the writer, that sanitising happened, and that no credential, vendor key or client
// User-Agent ends up in the Collector's on-disk queue, its logs or the gateway's logs.

import (
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/otlp"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/testpki"
)

const (
	oTenant  = "0193b7e2-0000-7000-8000-0000000000c1"
	oTokenID = "OtlpToken001"
	oSecret  = "S3cretS3cretS3cretS3cretXyz"
	oVendor  = "VendorKeyMarker777"
	oUA      = "OTel-Exporter-UAMarker/9.9"
)

func collectorBinary(t *testing.T) string {
	if p := os.Getenv("SCF_COLLECTOR_BIN"); p != "" {
		return p
	}
	src, _ := filepath.Abs("../../../../collector/_build")
	if _, err := os.Stat(filepath.Join(src, "go.mod")); err != nil {
		t.Skip("collector/_build not generated (collector/scripts/build.sh --generate-only); set SCF_COLLECTOR_BIN")
	}
	out := filepath.Join(t.TempDir(), "scf-otelcol")
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = src
	cmd.Env = append(os.Environ(), "GOWORK=off", "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the Collector: %v\n%s", err, b)
	}
	return out
}

type writerSink struct {
	mu     sync.Mutex
	bodies [][]byte
}

func (s *writerSink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var rd io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			http.Error(w, "bad gzip", 400)
			return
		}
		rd = zr
	}
	b, _ := io.ReadAll(rd)
	s.mu.Lock()
	s.bodies = append(s.bodies, b)
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(200)
}

func (s *writerSink) all() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return bytes.Join(s.bodies, []byte{0})
}

// pb helpers for a hand-encoded ExportMetricsServiceRequest.
func pbBytes(field int, v []byte) []byte {
	b := binary.AppendUvarint(nil, uint64(field<<3|2))
	b = binary.AppendUvarint(b, uint64(len(v)))
	return append(b, v...)
}
func pbVarint(field int, v uint64) []byte {
	return binary.AppendUvarint(binary.AppendUvarint(nil, uint64(field<<3)), v)
}
func pbFixed64(field int, v uint64) []byte {
	b := binary.AppendUvarint(nil, uint64(field<<3|1))
	return binary.LittleEndian.AppendUint64(b, v)
}
func kvString(k, v string) []byte {
	return append(pbBytes(1, []byte(k)), pbBytes(2, pbBytes(1, []byte(v)))...)
}
func kvInt(k string, v uint64) []byte {
	return append(pbBytes(1, []byte(k)), pbBytes(2, pbVarint(3, v))...)
}

func grpcMetricsRequest(service string, now time.Time) []byte {
	var packedCounts, packedBounds []byte
	for _, c := range []uint64{1, 2, 0} {
		packedCounts = binary.LittleEndian.AppendUint64(packedCounts, c)
	}
	for _, b := range []float64{0.1, 1} {
		packedBounds = binary.LittleEndian.AppendUint64(packedBounds, math.Float64bits(b))
	}
	var dp []byte
	dp = append(dp, pbFixed64(2, uint64(now.Add(-time.Minute).UnixNano()))...)
	dp = append(dp, pbFixed64(3, uint64(now.UnixNano()))...)
	dp = append(dp, pbFixed64(4, 3)...)
	dp = append(dp, pbFixed64(5, math.Float64bits(0.9))...)
	dp = append(dp, pbBytes(6, packedCounts)...)
	dp = append(dp, pbBytes(7, packedBounds)...)
	dp = append(dp, pbBytes(9, kvString("http.route", "/grpc/{id}"))...)
	dp = append(dp, pbBytes(9, kvString("http.request.method", "GET"))...)
	dp = append(dp, pbBytes(9, kvInt("http.response.status_code", 200))...)
	hist := append(pbBytes(1, dp), pbVarint(2, 2)...) // cumulative
	metric := append(pbBytes(1, []byte("http.server.request.duration")), pbBytes(3, []byte("s"))...)
	metric = append(metric, pbBytes(9, hist)...)
	scope := append(pbBytes(1, pbBytes(1, []byte("go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"))), pbBytes(2, metric)...)
	res := pbBytes(1, kvString("service.name", service))
	res = append(res, pbBytes(1, kvString("service.instance.id", "inst-1"))...)
	rm := append(pbBytes(1, res), pbBytes(2, scope)...)
	return pbBytes(1, rm)
}

func TestOTLPThroughRealCollector(t *testing.T) {
	colBin := collectorBinary(t)
	h := newHarness(t)
	// The Collector→writer hop gets its own CA (the harness has one for the edge↔core hop).
	wca := testpki.NewCA()
	writerCert := wca.Issue("", "writers", "127.0.0.1")
	nodeCert := wca.Issue("edge", "edge-a1")
	tlsDir := filepath.Join(h.dir, "coltls")
	_ = os.MkdirAll(tlsDir, 0o755)
	_ = os.WriteFile(filepath.Join(tlsDir, "ca.crt"), wca.PEM, 0o644)
	cc, ck := nodeCert.WriteFiles(tlsDir, "node")
	sink := &writerSink{}
	wsrv := httptest.NewUnstartedServer(sink)
	wsrv.TLS = &tls.Config{Certificates: []tls.Certificate{writerCert.TLS}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: wca.Pool, MinVersion: tls.VersionTLS13}
	wsrv.StartTLS()
	defer wsrv.Close()

	// Snapshot with an ingest token for oTenant (level 2 → L2).
	pepper := bytes.Repeat([]byte{0x42}, 32)
	m := hmac.New(sha256.New, pepper)
	m.Write([]byte(oSecret))
	reSnapshot(t, h, []snapshot.Tenant{{TenantID: oTenant, Status: "active", Level: 2}},
		[]snapshot.IngestToken{{TokenID: oTokenID, TenantID: oTenant, Hash: base64.RawURLEncoding.EncodeToString(m.Sum(nil)), PepperVersion: 1}})
	_ = os.WriteFile(filepath.Join(h.dir, "pepper"), []byte("1:"+base64.StdEncoding.EncodeToString(pepper)), 0o600)

	grpcPort, httpPort := freePort(t), freePort(t)
	queue := filepath.Join(h.dir, "queue")
	col := exec.Command(colBin, "--config", "../../../../collector/config/collector.yaml")
	colLog := &syncBuf{}
	col.Stdout, col.Stderr = colLog, colLog
	col.Env = append(os.Environ(), "SCF_WRITER_ENDPOINT="+wsrv.URL, "SCF_MTLS_CA_FILE="+filepath.Join(tlsDir, "ca.crt"),
		"SCF_MTLS_CERT_FILE="+cc, "SCF_MTLS_KEY_FILE="+ck, "SCF_OTLP_GRPC_ENDPOINT=127.0.0.1:"+grpcPort,
		"SCF_OTLP_HTTP_ENDPOINT=127.0.0.1:"+httpPort, "SCF_HEALTH_ENDPOINT=127.0.0.1:"+freePort(t),
		"SCF_SELF_METRICS_PORT="+freePort(t), "SCF_QUEUE_DIR="+queue)
	if err := col.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = col.Process.Kill(); _ = col.Wait() }()

	for i, e := range h.envv {
		if e == "GW_OTLP_ENABLED=0" {
			h.envv[i] = "GW_OTLP_ENABLED=1"
		}
	}
	h.envv = append(h.envv, "GW_PEPPER_ING_FILE="+filepath.Join(h.dir, "pepper"),
		"GW_COLLECTOR_HTTP=http://127.0.0.1:"+httpPort, "GW_COLLECTOR_GRPC=http://127.0.0.1:"+grpcPort)
	h.start()
	key := otlp.MakeIngestKey(oTokenID, oSecret)

	// OTLP/HTTP JSON: the Node SDK payload recorded in S-06a, with timestamps moved to now.
	raw, err := os.ReadFile("../../../../collector/processor/scfsanitizeprocessor/testdata/sdk/node-express.metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	raw = regexp.MustCompile(`"startTimeUnixNano":"\d+"`).ReplaceAll(raw, []byte(`"startTimeUnixNano":"`+strconv.FormatInt(now.Add(-time.Minute).UnixNano(), 10)+`"`))
	raw = regexp.MustCompile(`"timeUnixNano":"\d+"`).ReplaceAll(raw, []byte(`"timeUnixNano":"`+strconv.FormatInt(now.UnixNano(), 10)+`"`))
	send := func() int {
		req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+h.pub+"/v1/metrics", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("DD-API-KEY", oVendor)
		req.Header.Set("User-Agent", oUA)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return -1
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	var code int
	h.waitFor("Collector accepting through the gateway", 30*time.Second, func() bool { code = send(); return code == 200 })

	// OTLP/gRPC protobuf over h2c.
	msg := grpcMetricsRequest("grpc-svc", time.Now())
	frame := make([]byte, 5, 5+len(msg))
	binary.BigEndian.PutUint32(frame[1:], uint32(len(msg)))
	frame = append(frame, msg...)
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	gc := &http.Client{Transport: &http.Transport{Protocols: p}}
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+h.pub+"/opentelemetry.proto.collector.metrics.v1.MetricsService/Export", bytes.NewReader(frame))
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("Te", "trailers")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", oUA)
	resp, err := gc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	st := resp.Trailer.Get("Grpc-Status")
	if st == "" {
		st = resp.Header.Get("Grpc-Status")
	}
	if st != "0" {
		t.Fatalf("gRPC export: grpc-status %q (%s)", st, resp.Header.Get("Grpc-Message"))
	}
	// Logs are refused by both protocols.
	lr, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+h.pub+"/v1/logs", strings.NewReader("{}"))
	lr.Header.Set("Content-Type", "application/json")
	lr.Header.Set("Authorization", "Bearer "+key)
	if r, err := http.DefaultClient.Do(lr); err != nil || r.StatusCode != 404 {
		t.Fatalf("logs: %v", err)
	}

	h.waitFor("both payloads at the writer", 30*time.Second, func() bool {
		all := sink.all()
		return bytes.Contains(all, []byte("s06a-express-sdk")) && bytes.Contains(all, []byte("grpc-svc"))
	})
	all := sink.all()
	for _, want := range []string{oTenant, "scf.tenant.id", "scf.tenant.level", "scf.received_at_unix_nano", "http.server.request.duration"} {
		if !bytes.Contains(all, []byte(want)) {
			t.Errorf("writer payload lacks %q", want)
		}
	}
	for _, leak := range []string{"CANARY-RES", oVendor, oSecret, oUA, "Bearer"} {
		if bytes.Contains(all, []byte(leak)) {
			t.Errorf("writer payload contains %q", leak)
		}
	}
	// Nothing personal or secret on the Collector's disk queue, in its logs, or in the gateway's logs.
	var disk bytes.Buffer
	_ = filepath.Walk(queue, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			b, _ := os.ReadFile(p)
			disk.Write(b)
		}
		return nil
	})
	h.logMu.Lock()
	gwLogs := h.allLogs.String()
	h.logMu.Unlock()
	for name, hay := range map[string]string{"collector queue": disk.String(), "collector logs": colLog.String(), "gateway logs": gwLogs} {
		for _, leak := range []string{oSecret, key, oVendor, oUA, "authorization", "Authorization", "dd-api-key"} {
			if strings.Contains(hay, leak) {
				t.Errorf("%s contains %q", name, leak)
			}
		}
	}
	h.stop()
}

// reSnapshot replaces the harness core's snapshot with one that also carries the given tenants and tokens.
func reSnapshot(t *testing.T, h *harness, tenants []snapshot.Tenant, tokens []snapshot.IngestToken) {
	t.Helper()
	var env snapshot.Envelope
	h.core.mu.Lock()
	defer h.core.mu.Unlock()
	_ = json.Unmarshal(h.core.envelope, &env)
	pb, _ := base64.RawURLEncoding.DecodeString(env.Payload)
	var p snapshot.Payload
	_ = json.Unmarshal(pb, &p)
	p.Sequence++
	p.Settings.OTLPRequestsPerS, p.Settings.OTLPBurst, p.Settings.OTLPBytesPerS = 50, 200, 1<<20
	p.Tenants = append(p.Tenants, tenants...)
	p.IngestTokens = tokens
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	_ = os.WriteFile(filepath.Join(h.dir, "snap.pub"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644)
	nb, _ := json.Marshal(p)
	h.core.envelope, _ = json.Marshal(snapshot.Envelope{Format: snapshot.Format, Alg: "Ed25519", Kid: "edge-1", Payload: base64.RawURLEncoding.EncodeToString(nb), Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, nb))})
	h.core.seq = p.Sequence
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }
