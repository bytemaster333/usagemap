// SPDX-License-Identifier: Apache-2.0

// Package election decides which health-controller instance writes DNS (C-27, C-92: two instances, leader by an
// etcd lease). The etcd elector speaks etcd's v3 JSON gateway (/v3/lease/grant, /v3/kv/txn, /v3/lease/keepalive,
// /v3/kv/range, /v3/kv/deleterange) with the standard library only, so the controller links no etcd client.
package election

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Elector reports leadership.
type Elector interface {
	// Run campaigns until ctx ends; it releases leadership on return.
	Run(ctx context.Context)
	IsLeader() bool
}

// Static is a fixed role: a single-instance deployment (always leader) or a passive instance (never).
type Static struct{ Leader bool }

// Run blocks until ctx ends.
func (s Static) Run(ctx context.Context) { <-ctx.Done() }

// IsLeader returns the fixed role.
func (s Static) IsLeader() bool { return s.Leader }

// Etcd is a lease-based elector: the key holds the instance name and is bound to a lease kept alive every TTL/3.
// Losing the keepalive (etcd unreachable, partition) drops leadership locally after the lease TTL at the latest, so
// two instances never both believe they lead for longer than the clock skew allows: the local view expires at
// grant/keepalive time + TTL − margin, before etcd itself expires the lease.
type Etcd struct {
	Endpoints []string // e.g. https://etcd-1:2379
	Client    *http.Client
	Key       string // e.g. /scf/health-controller/leader
	Instance  string
	TTL       time.Duration
	Log       *slog.Logger

	leaderUntil atomic.Int64 // unix nanos until which we may act as leader
	ep          atomic.Int32
}

// IsLeader reports whether this instance holds the lease right now.
func (e *Etcd) IsLeader() bool { return time.Now().UnixNano() < e.leaderUntil.Load() }

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func (e *Etcd) call(ctx context.Context, path string, body, out any) error {
	b, _ := json.Marshal(body)
	var lastErr error
	for i := 0; i < len(e.Endpoints); i++ {
		idx := (int(e.ep.Load()) + i) % len(e.Endpoints)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(e.Endpoints[idx], "/")+path, bytes.NewReader(b))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := e.Client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("etcd %s answered %d", path, resp.StatusCode)
			continue
		}
		e.ep.Store(int32(idx))
		// The keepalive endpoint streams {"result":{…}} objects; the first one is enough.
		if dec := json.NewDecoder(bytes.NewReader(rb)); out != nil {
			if err := dec.Decode(out); err != nil {
				return fmt.Errorf("etcd %s: %w", path, err)
			}
		}
		return nil
	}
	return lastErr
}

type grantResp struct {
	ID  string `json:"ID"`
	TTL string `json:"TTL"`
}

type txnResp struct {
	Succeeded bool `json:"succeeded"`
}

type keepaliveResp struct {
	Result struct {
		ID  string `json:"ID"`
		TTL string `json:"TTL"`
	} `json:"result"`
}

// Run campaigns: grant a lease, try to create the key with it, keep it alive while held, retry otherwise.
func (e *Etcd) Run(ctx context.Context) {
	if e.TTL == 0 {
		e.TTL = 15 * time.Second
	}
	if e.Log == nil {
		e.Log = slog.Default()
	}
	step := e.TTL / 3
	for ctx.Err() == nil {
		lease, err := e.campaign(ctx)
		if err != nil || lease == "" {
			if err != nil {
				e.Log.Warn("election: campaign failed", "error_class", errClass(err))
			}
			sleep(ctx, step)
			continue
		}
		e.Log.Info("election: became leader", "instance", e.Instance)
		e.hold(ctx, lease, step)
		e.leaderUntil.Store(0)
		e.Log.Info("election: leadership ended", "instance", e.Instance)
		// Best effort: revoke so the peer takes over at once on a clean shutdown.
		rctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = e.call(rctx, "/v3/lease/revoke", map[string]string{"ID": lease}, nil)
		cancel()
	}
}

// campaign returns the lease id when the key was created by us.
func (e *Etcd) campaign(ctx context.Context) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, e.TTL/3)
	defer cancel()
	start := time.Now()
	var g grantResp
	if err := e.call(cctx, "/v3/lease/grant", map[string]any{"TTL": int64(e.TTL / time.Second)}, &g); err != nil {
		return "", err
	}
	if g.ID == "" {
		return "", errors.New("etcd: no lease id")
	}
	var t txnResp
	err := e.call(cctx, "/v3/kv/txn", map[string]any{
		"compare": []any{map[string]any{"key": b64(e.Key), "target": "CREATE", "result": "EQUAL", "create_revision": "0"}},
		"success": []any{map[string]any{"request_put": map[string]any{"key": b64(e.Key), "value": b64(e.Instance), "lease": g.ID}}},
	}, &t)
	if err != nil || !t.Succeeded {
		_ = e.call(cctx, "/v3/lease/revoke", map[string]string{"ID": g.ID}, nil)
		return "", err
	}
	e.leaderUntil.Store(start.Add(e.TTL - e.TTL/5).UnixNano())
	return g.ID, nil
}

func (e *Etcd) hold(ctx context.Context, lease string, step time.Duration) {
	for {
		if !sleep(ctx, step) {
			return
		}
		start := time.Now()
		kctx, cancel := context.WithTimeout(ctx, step)
		var k keepaliveResp
		err := e.call(kctx, "/v3/lease/keepalive", map[string]string{"ID": lease}, &k)
		cancel()
		if err != nil || k.Result.TTL == "" || k.Result.TTL == "0" {
			// Keep acting only until the last confirmed deadline; then give up and campaign again.
			if time.Now().UnixNano() >= e.leaderUntil.Load() {
				return
			}
			continue
		}
		e.leaderUntil.Store(start.Add(e.TTL - e.TTL/5).UnixNano())
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func errClass(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case err == nil:
		return "none"
	default:
		return "unavailable"
	}
}
