// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bytes"
	"context"
	"errors"
	"log"
	"log/slog"
	"net"
	"os"
	"syscall"
)

// Privacy rule for every log line of this service (docs/privacy, hardening.md, wire-formats §c.5): never an IP address,
// surrogate, cache token, session or visit id, User-Agent, request header value, request body, raw path or query
// string. Log lines carry only: caller node name and role (from our own certificates), method, route template,
// status, duration, closed-set reasons and error kinds.

// ErrorKind maps a transport error to a closed set. Go's error strings embed URLs (with query strings) and peer
// addresses, so they are never logged.
func ErrorKind(err error) string {
	if err == nil {
		return "none"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "connection_refused"
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return "connection_reset"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns"
	}
	return "other"
}

// serverErrorWriter receives net/http's internal error log (TLS handshake failures, malformed requests …), whose
// lines contain the peer address. It logs only a classified kind.
type serverErrorWriter struct{ l *slog.Logger }

func (w serverErrorWriter) Write(p []byte) (int, error) {
	kind := "other"
	switch {
	case bytes.Contains(p, []byte("TLS handshake error")):
		kind = "tls_handshake"
	case bytes.Contains(p, []byte("panic")):
		kind = "panic"
	}
	w.l.Warn("http_server_error", "kind", kind)
	return len(p), nil
}

// ServerErrorLog returns a *log.Logger for http.Server.ErrorLog that never prints peer addresses.
func ServerErrorLog(l *slog.Logger) *log.Logger {
	return log.New(serverErrorWriter{l}, "", 0)
}

// NewLogger returns the JSON logger used by the service.
func NewLogger(level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
}
