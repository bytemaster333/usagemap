// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// failClass is what a failed tenant transaction means for the request (wire-formats §g.3). Only failData is acknowledged with 200; every other class is answered 503 so the
// Collector retries from its persistent queue.
type failClass uint8

const (
	// failData: the batch itself (constraint violation, numeric overflow, invalid text) or a bug in the writer —
	// rolled back, counted tenant_write_error, acknowledged so it is not retried for ever (C-112(1)).
	failData failClass = iota
	// failLost: the connection to PostgreSQL or PgBouncer is gone (class 08, admin/crash shutdown, network errors).
	// 503 and the listener closes until the probe succeeds again (C-107).
	failLost
	// failUnavailable: the database answers but cannot write — read-only transaction during a switchover (class 25),
	// insufficient resources such as disk full or out of memory (53), operator intervention (57), system/I/O error
	// (58), data corruption (XX001/XX002) or a missing privilege after a deployment (42501). These are conditions of
	// the infrastructure, not of the batch: 503 and the listener closes like failLost.
	failUnavailable
	// failTimeout: the tenant transaction ran out of time (its deadline, statement timeout, lock timeout) or kept
	// conflicting (deadlock / serialisation failure after the in-transaction retries). 503 without closing the
	// listener; the attempt is counted, and a batch key that keeps timing out is eventually treated as failData
	// (poison message, attemptTracker).
	failTimeout
	// failBusy: the transaction never started — no pooled connection, or no turn behind an in-flight transaction of
	// the same batch key, within the budget. 503 without closing the listener and without counting an attempt: it
	// says nothing about the batch.
	failBusy
)

func (c failClass) String() string {
	switch c {
	case failLost:
		return "lost"
	case failUnavailable:
		return "unavailable"
	case failTimeout:
		return "timeout"
	case failBusy:
		return "busy"
	}
	return "data"
}

// errNotStarted marks a failure before the transaction began (pool acquisition, waiting for the same batch key).
var errNotStarted = errors.New("tenant transaction not started")

// classify maps an error of a tenant transaction to its failClass.
func classify(err error) failClass {
	if err == nil {
		return failData
	}
	if errors.Is(err, ErrUnavailable) {
		return failLost
	}
	if errors.Is(err, errNotStarted) || errors.Is(err, ErrBusy) {
		return failBusy
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return classifySQLState(pgErr.Code)
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || pgconn.Timeout(err) {
		return failTimeout
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return failLost
	}
	var ce *pgconn.ConnectError
	if errors.As(err, &ce) {
		return failLost
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return failLost
	}
	if pgconn.SafeToRetry(err) {
		return failLost
	}
	// pgx reports a connection that died mid-statement as a plain error with these texts.
	msg := err.Error()
	if strings.Contains(msg, "conn closed") || strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "broken pipe") || strings.Contains(msg, "failed to connect") ||
		strings.Contains(msg, "unexpected EOF") {
		return failLost
	}
	return failData
}

// classifySQLState classifies a PostgreSQL error code (Appendix A of the PostgreSQL manual).
func classifySQLState(code string) failClass {
	switch code {
	case "57P01", "57P02", "57P03": // admin_shutdown, crash_shutdown, cannot_connect_now
		return failLost
	case "57014", "55P03", "40001", "40P01": // query_canceled (timeouts), lock_not_available, serialisation, deadlock
		return failTimeout
	case "XX001", "XX002", "42501": // data_corrupted, index_corrupted, insufficient_privilege (deployment)
		return failUnavailable
	}
	if len(code) != 5 {
		return failData
	}
	switch code[:2] {
	case "08": // connection exception
		return failLost
	case "25", "53", "57", "58": // invalid transaction state (read-only), insufficient resources, operator, system
		return failUnavailable
	}
	return failData
}

// IsConnectionLoss reports whether err means the database (or PgBouncer) connection is gone or the database cannot
// write: the classes that close the listener (wire-formats §g.3).
func IsConnectionLoss(err error) bool {
	if err == nil {
		return false
	}
	c := classify(err)
	return c == failLost || c == failUnavailable
}

func isRetryable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001")
}
