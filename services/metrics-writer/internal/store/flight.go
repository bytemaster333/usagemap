// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"sync"
	"time"
)

// flightKey identifies one tenant part of one request: the ledger key (tenant, batch key).
type flightKey struct {
	tenant string
	key    [32]byte
}

// flights lets only one transaction per (tenant, batch key) run in this process. A Collector retry of a request that
// is still being applied waits for the first attempt instead of opening a second transaction that would only block on
// the uncommitted ledger row while holding a pooled connection. After the wait it
// runs normally: the ledger turns it into a duplicate when the first attempt committed.
type flights struct {
	mu sync.Mutex
	m  map[flightKey]chan struct{}
}

// acquire waits until no other transaction of k is in flight in this process and claims k. It fails only when ctx
// ends first; release must be called exactly once after a successful acquire.
func (f *flights) acquire(ctx context.Context, k flightKey) (release func(), err error) {
	for {
		f.mu.Lock()
		if f.m == nil {
			f.m = map[flightKey]chan struct{}{}
		}
		ch, busy := f.m[k]
		if !busy {
			ch = make(chan struct{})
			f.m[k] = ch
			f.mu.Unlock()
			return func() {
				f.mu.Lock()
				delete(f.m, k)
				f.mu.Unlock()
				close(ch)
			}, nil
		}
		f.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Poison-message bounds: a tenant part whose transaction times out at least
// DefaultPoisonAttempts times over at least DefaultPoisonWindow is treated as deterministic — counted
// tenant_write_error and acknowledged — instead of being retried by the Collector for 72 hours.
const (
	DefaultPoisonAttempts = 5
	DefaultPoisonWindow   = 10 * time.Minute
	attemptsTTL           = time.Hour // a key not seen for this long is forgotten
	attemptsCapacity      = 10000     // bound of the tracker's memory; the oldest entries go first
)

type attemptEntry struct {
	n           int
	first, last time.Time
}

// attemptTracker counts timed-out transactions per (tenant, batch key) in this process. It is deliberately in
// memory: a poison request is answered 503 until it has timed out Options.PoisonAttempts times over at least
// Options.PoisonWindow on this writer, then dropped; a writer restart only restarts the count.
type attemptTracker struct {
	attempts int           // timed-out attempts before a key is poison
	window   time.Duration // minimum time between the first timed-out attempt and the poison verdict
	mu       sync.Mutex
	m        map[flightKey]*attemptEntry
}

// timedOut records a timed-out attempt at now and reports whether the key is now poison.
func (a *attemptTracker) timedOut(k flightKey, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.m == nil {
		a.m = map[flightKey]*attemptEntry{}
	}
	a.pruneLocked(now)
	e := a.m[k]
	if e == nil {
		e = &attemptEntry{first: now}
		a.m[k] = e
	}
	e.n++
	e.last = now
	return e.n >= a.attempts && now.Sub(e.first) >= a.window
}

// forget drops the key (its transaction committed, or it was dropped as poison).
func (a *attemptTracker) forget(k flightKey) {
	a.mu.Lock()
	delete(a.m, k)
	a.mu.Unlock()
}

// pruneLocked runs only when the tracker is full: idle entries go first, then the oldest.
func (a *attemptTracker) pruneLocked(now time.Time) {
	if len(a.m) < attemptsCapacity {
		return
	}
	for k, e := range a.m {
		if now.Sub(e.last) > attemptsTTL {
			delete(a.m, k)
		}
	}
	for len(a.m) >= attemptsCapacity {
		var oldest flightKey
		var at time.Time
		for k, e := range a.m {
			if at.IsZero() || e.last.Before(at) {
				oldest, at = k, e.last
			}
		}
		delete(a.m, oldest)
	}
}

func (a *attemptTracker) len() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.m)
}
