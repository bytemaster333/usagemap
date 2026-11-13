// SPDX-License-Identifier: Apache-2.0
// sink is a capture endpoint standing in for the metrics-writer. It accepts
// OTLP/HTTP on /v1/{metrics,traces,logs}, hashes the decompressed body
// (SHA-256, the writer's batch key per wire-formats §g.3), decodes it to
// OTLP JSON and appends one JSON line per request to <out>/<name>.jsonl.
//
// POST /control?status=503[&count=N]  answer the next N (default: all)
// export requests with that status; /control?status=200 resets.
// POST /control?delay_ms=D  record each request, then wait D ms before answering.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

type record struct {
	Seq        int64             `json:"seq"`
	Time       string            `json:"time"`
	Sink       string            `json:"sink"`
	Path       string            `json:"path"`
	Status     int               `json:"status"`
	SHA256     string            `json:"sha256_decompressed"`
	WireBytes  int               `json:"wire_bytes"`
	RawBytes   int               `json:"raw_bytes"`
	Headers    map[string]string `json:"headers"`
	DataPoints int               `json:"data_points,omitempty"`
	Spans      int               `json:"spans,omitempty"`
	LogRecords int               `json:"log_records,omitempty"`
	Body       json.RawMessage   `json:"body,omitempty"`
	Error      string            `json:"error,omitempty"`
}

var (
	mu        sync.Mutex
	seq       int64
	failCode  = 0
	failCount = 0 // -1 = forever
	delay     time.Duration
	out       *os.File
	name      string
)

func main() {
	listen := flag.String("listen", ":4319", "listen address")
	dir := flag.String("out", "/data", "output directory")
	flag.StringVar(&name, "name", "sink", "sink name")
	flag.Parse()
	var err error
	if err = os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatal(err)
	}
	out, err = os.OpenFile(filepath.Join(*dir, name+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	mux.HandleFunc("/control", control)
	mux.HandleFunc("/v1/", export)
	log.Printf("sink %s listening on %s", name, *listen)
	log.Fatal(http.ListenAndServe(*listen, mux))
}

func control(w http.ResponseWriter, r *http.Request) {
	code, _ := strconv.Atoi(r.URL.Query().Get("status"))
	n := -1
	if d := r.URL.Query().Get("delay_ms"); d != "" {
		ms, _ := strconv.Atoi(d)
		mu.Lock()
		delay = time.Duration(ms) * time.Millisecond
		mu.Unlock()
		log.Printf("control: delay=%v", time.Duration(ms)*time.Millisecond)
		if r.URL.Query().Get("status") == "" {
			w.WriteHeader(204)
			return
		}
	}
	if c := r.URL.Query().Get("count"); c != "" {
		n, _ = strconv.Atoi(c)
	}
	mu.Lock()
	if code == 200 || code == 0 {
		failCode, failCount = 0, 0
	} else {
		failCode, failCount = code, n
	}
	mu.Unlock()
	log.Printf("control: status=%d count=%d", code, n)
	w.WriteHeader(204)
}

func export(w http.ResponseWriter, r *http.Request) {
	wire, _ := io.ReadAll(r.Body)
	raw := wire
	if r.Header.Get("Content-Encoding") == "gzip" {
		if zr, err := gzip.NewReader(bytes.NewReader(wire)); err == nil {
			raw, _ = io.ReadAll(zr)
		}
	}
	sum := sha256.Sum256(raw)
	rec := record{
		Time: time.Now().UTC().Format(time.RFC3339Nano), Sink: name, Path: r.URL.Path,
		SHA256: hex.EncodeToString(sum[:]), WireBytes: len(wire), RawBytes: len(raw),
		Headers: map[string]string{},
	}
	for k, v := range r.Header {
		rec.Headers[k] = v[0]
	}
	isJSON := r.Header.Get("Content-Type") == "application/json"
	var err error
	switch r.URL.Path {
	case "/v1/metrics":
		req := pmetricotlp.NewExportRequest()
		if err = unmarshal(&req, raw, isJSON); err == nil {
			rec.DataPoints = req.Metrics().DataPointCount()
			rec.Body, err = req.MarshalJSON()
		}
	case "/v1/traces":
		req := ptraceotlp.NewExportRequest()
		if err = unmarshal(&req, raw, isJSON); err == nil {
			rec.Spans = req.Traces().SpanCount()
			rec.Body, err = req.MarshalJSON()
		}
	case "/v1/logs":
		req := plogotlp.NewExportRequest()
		if err = unmarshal(&req, raw, isJSON); err == nil {
			rec.LogRecords = req.Logs().LogRecordCount()
			rec.Body, err = req.MarshalJSON()
		}
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		rec.Error = err.Error()
	}
	mu.Lock()
	seq++
	rec.Seq = seq
	status := 200
	if failCode != 0 && failCount != 0 {
		status = failCode
		if failCount > 0 {
			failCount--
		}
	}
	rec.Status = status
	line, _ := jsonMarshal(rec)
	out.Write(append(line, '\n'))
	out.Sync()
	d := delay
	mu.Unlock()
	time.Sleep(d) // recorded (= "committed") before answering: a kill now yields a duplicate
	if status != 200 {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(200) // empty Export*ServiceResponse
}

type protoJSON interface {
	UnmarshalProto([]byte) error
	UnmarshalJSON([]byte) error
}

func unmarshal(m protoJSON, b []byte, isJSON bool) error {
	if isJSON {
		return m.UnmarshalJSON(b)
	}
	return m.UnmarshalProto(b)
}

func jsonMarshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	err := enc.Encode(v)
	return bytes.TrimRight(buf.Bytes(), "\n"), err
}
