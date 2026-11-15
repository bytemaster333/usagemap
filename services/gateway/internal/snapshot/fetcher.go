// SPDX-License-Identifier: Apache-2.0

package snapshot

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"time"
)

// Core is one core node's engine proxy.
type Core struct {
	ID  string
	URL string // https://engine-proxy:8443
}

// Fetcher polls GET /internal/v1/edge/snapshot through the cores' engine proxies (§e.1): every Interval ± Jitter,
// with If-None-Match, trying the cores in turn (either core answers, C-07).
type Fetcher struct {
	Store    *Store
	Cores    []Core
	Client   *http.Client // mTLS with the edge node certificate
	Interval time.Duration
	Jitter   time.Duration
	Log      *slog.Logger
	Now      func() time.Time
}

func (f *Fetcher) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

// FetchOnce tries every core once, starting at a random one. It returns nil after a 200 (applied or same) or 304.
func (f *Fetcher) FetchOnce(ctx context.Context) error {
	if len(f.Cores) == 0 {
		return errors.New("snapshot: no cores configured")
	}
	start := rand.IntN(len(f.Cores))
	var last error
	for i := range f.Cores {
		c := f.Cores[(start+i)%len(f.Cores)]
		err := f.fetch(ctx, c)
		if err == nil {
			return nil
		}
		last = err
	}
	return last
}

func (f *Fetcher) fetch(ctx context.Context, c Core) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+"/internal/v1/edge/snapshot", nil)
	if err != nil {
		return err
	}
	if seq := f.Store.Sequence(); seq > 0 {
		req.Header.Set("If-None-Match", `"`+strconv.FormatInt(seq, 10)+`"`)
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNotModified:
		f.Store.MarkFresh(f.now())
		return nil
	case http.StatusOK:
		raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxEnvelope+1))
		if err != nil {
			return err
		}
		err = f.Store.Apply(raw)
		switch {
		case err == nil:
			f.Log.Info("edge snapshot applied", "sequence", f.Store.Sequence(), "core", c.ID)
			f.Store.MarkFresh(f.now())
			return nil
		case errors.Is(err, ErrSame):
			f.Store.MarkFresh(f.now())
			return nil
		case errors.Is(err, ErrRollback):
			// A core serving an older sequence than we hold: refuse and alert (metric); do not count as fresh.
			f.Log.Error("edge snapshot with an older sequence refused", "core", c.ID, "current", f.Store.Sequence())
			return err
		default:
			f.Log.Error("edge snapshot refused", "core", c.ID, "reason", err.Error())
			return err
		}
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("snapshot: core %s answered %d", c.ID, resp.StatusCode)
	}
}

// Run polls until ctx ends. The first fetch happens at once.
func (f *Fetcher) Run(ctx context.Context) {
	for {
		if err := f.FetchOnce(ctx); err != nil && ctx.Err() == nil {
			f.Log.Warn("edge snapshot fetch failed", "error_kind", errorKind(err))
		}
		d := f.Interval
		if f.Jitter > 0 {
			d += time.Duration(rand.Int64N(int64(2*f.Jitter))) - f.Jitter
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(d):
		}
	}
}

// errorKind maps an error to a closed set (Go's transport errors embed URLs and addresses; never logged).
func errorKind(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, ErrRollback):
		return "rollback"
	case errors.Is(err, ErrSignature), errors.Is(err, ErrKid), errors.Is(err, ErrFormat), errors.Is(err, ErrMalformed):
		return "verify"
	default:
		return "transport_or_status"
	}
}
