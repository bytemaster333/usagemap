// SPDX-License-Identifier: Apache-2.0
// Package otlpsend plays the gateway in front of the Collector in tests: it
// sends OTLP over HTTP (protobuf) and gRPC with the x-scf-* metadata of
// wire-formats §f.4.
package otlpsend

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// Meta is the gateway metadata of one request.
type Meta struct {
	Tenant     string
	Allowed    string
	ReceivedAt int64
	Extra      map[string]string // headers a gateway would never forward (canaries)
}

func (m Meta) pairs() map[string]string {
	h := map[string]string{}
	if m.Tenant != "" {
		h["x-scf-tenant-id"] = m.Tenant
	}
	if m.Allowed != "" {
		h["x-scf-allowed-services"] = m.Allowed
	}
	if m.ReceivedAt != 0 {
		h["x-scf-received-at"] = fmt.Sprint(m.ReceivedAt)
	}
	h["x-scf-node"] = "edge-test"
	for k, v := range m.Extra {
		h[k] = v
	}
	return h
}

var client = &http.Client{Timeout: 10 * time.Second}

// Post sends body to base+path and returns the status and response body.
func Post(ctx context.Context, base, path, contentType string, body []byte, m Meta) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", contentType)
	for k, v := range m.pairs() {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, nil
}

// HTTPMetrics posts metrics as protobuf; any status but 200 is an error.
func HTTPMetrics(ctx context.Context, base string, md pmetric.Metrics, m Meta) error {
	b, err := pmetricotlp.NewExportRequestFromMetrics(md).MarshalProto()
	if err != nil {
		return err
	}
	return expect200(Post(ctx, base, "/v1/metrics", "application/x-protobuf", b, m))
}

// HTTPTraces posts traces as protobuf.
func HTTPTraces(ctx context.Context, base string, td ptrace.Traces, m Meta) error {
	b, err := ptraceotlp.NewExportRequestFromTraces(td).MarshalProto()
	if err != nil {
		return err
	}
	return expect200(Post(ctx, base, "/v1/traces", "application/x-protobuf", b, m))
}

// HTTPTracesJSON posts traces as OTLP JSON.
func HTTPTracesJSON(ctx context.Context, base string, td ptrace.Traces, m Meta) error {
	b, err := ptraceotlp.NewExportRequestFromTraces(td).MarshalJSON()
	if err != nil {
		return err
	}
	return expect200(Post(ctx, base, "/v1/traces", "application/json", b, m))
}

// HTTPLogs posts logs and returns the HTTP status.
func HTTPLogs(ctx context.Context, base string, ld plog.Logs, m Meta) (int, error) {
	b, err := plogotlp.NewExportRequestFromLogs(ld).MarshalProto()
	if err != nil {
		return 0, err
	}
	st, _, err := Post(ctx, base, "/v1/logs", "application/x-protobuf", b, m)
	return st, err
}

func expect200(status int, body []byte, err error) error {
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("status %d: %s", status, body)
	}
	return nil
}

// GRPC is a gRPC connection to the Collector's OTLP receiver.
type GRPC struct{ conn *grpc.ClientConn }

// DialGRPC connects (plaintext: loopback, like the gateway).
func DialGRPC(addr string) (*GRPC, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	return &GRPC{conn: conn}, nil
}

// Close closes the connection.
func (g *GRPC) Close() error { return g.conn.Close() }

func (m Meta) outgoing(ctx context.Context) context.Context {
	var kv []string
	for k, v := range m.pairs() {
		kv = append(kv, k, v)
	}
	return metadata.AppendToOutgoingContext(ctx, kv...)
}

// Traces exports traces over gRPC.
func (g *GRPC) Traces(ctx context.Context, td ptrace.Traces, m Meta) error {
	_, err := ptraceotlp.NewGRPCClient(g.conn).Export(m.outgoing(ctx), ptraceotlp.NewExportRequestFromTraces(td))
	return err
}

// Metrics exports metrics over gRPC.
func (g *GRPC) Metrics(ctx context.Context, md pmetric.Metrics, m Meta) error {
	_, err := pmetricotlp.NewGRPCClient(g.conn).Export(m.outgoing(ctx), pmetricotlp.NewExportRequestFromMetrics(md))
	return err
}

// Logs exports logs over gRPC and returns the error (expected: Unimplemented).
func (g *GRPC) Logs(ctx context.Context, ld plog.Logs, m Meta) error {
	_, err := plogotlp.NewGRPCClient(g.conn).Export(m.outgoing(ctx), plogotlp.NewExportRequestFromLogs(ld))
	return err
}
