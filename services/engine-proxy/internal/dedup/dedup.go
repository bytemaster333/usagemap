// SPDX-License-Identifier: Apache-2.0

// Package dedup is the engine proxy's event-key memory (wire-formats §c.5): it forwards the first copy
// of an event to Umami and answers later copies of the same key without forwarding them.
//
// A browser event can reach Umami twice: the tracker gives up waiting after 3 s and resends the same event (same
// event id) to the other ingest host, while the first host still spools and forwards it; or the forwarder retries
// after an ambiguous failure. Both copies carry the same event key (derived by the gateway from the site and the
// per-event id) and — because the key also fixes the surrogate of unidentified events, and an identified visitor's
// surrogate is the same on every node — the same core. This memory removes the second copy.
//
// The window is bounded: a key is remembered for Window after its first successful forward, and at most MaxEntries
// keys are kept (oldest evicted first, counted). Copies further apart than that, copies split by a core failover,
// and copies around a proxy restart are not recognised (stated, at-least-once). Keys are never logged or exported.
package dedup

import (
	"container/list"
	"context"
	"sync"
	"time"
)

const (
	// DefaultWindow is how long a delivered key is remembered.
	DefaultWindow = time.Hour
	// DefaultMaxEntries bounds the memory (about 100 bytes per key).
	DefaultMaxEntries = 500_000
)

// Outcome of a delivered event, replayed to later copies.
type Outcome uint8

const (
	// Stored: Umami answered 200 with a stored event (`{}` after stripping).
	Stored Outcome = iota + 1
	// Bot: Umami answered 200 {"beep":"boop"} (its bot check dropped the event).
	Bot
)

type entry struct {
	key  [16]byte
	at   time.Time
	out  Outcome // 0 while the first copy is in flight
	done chan struct{}
	elem *list.Element
}

// Memory is safe for concurrent use.
type Memory struct {
	mu      sync.Mutex
	window  time.Duration
	max     int
	now     func() time.Time
	m       map[[16]byte]*entry
	order   *list.List // delivered entries, oldest at the back
	evicted int64
	dups    int64
}

// Config of a Memory.
type Config struct {
	Window     time.Duration
	MaxEntries int
	Now        func() time.Time
}

// New returns a Memory.
func New(c Config) *Memory {
	if c.Window <= 0 {
		c.Window = DefaultWindow
	}
	if c.MaxEntries <= 0 {
		c.MaxEntries = DefaultMaxEntries
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return &Memory{window: c.Window, max: c.MaxEntries, now: c.Now, m: map[[16]byte]*entry{}, order: list.New()}
}

// Begin claims key. If an earlier copy was delivered within the window it returns that outcome (dup = true) and the
// caller answers without forwarding. If a copy is in flight it waits for it (or for ctx). Otherwise the caller owns
// the key and must call Finish exactly once.
func (d *Memory) Begin(ctx context.Context, key [16]byte) (out Outcome, dup bool, err error) {
	for {
		d.mu.Lock()
		d.expire()
		e := d.m[key]
		switch {
		case e == nil:
			d.m[key] = &entry{key: key, done: make(chan struct{})}
			d.mu.Unlock()
			return 0, false, nil
		case e.out != 0:
			d.dups++
			d.mu.Unlock()
			return e.out, true, nil
		}
		wait := e.done
		d.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return 0, false, ctx.Err()
		}
	}
}

// Finish records the owner's result: a delivered outcome is remembered for the window; out = 0 (not delivered:
// upstream error, 4xx/5xx) releases the key so a retry may forward it.
func (d *Memory) Finish(key [16]byte, out Outcome) {
	d.mu.Lock()
	defer d.mu.Unlock()
	e := d.m[key]
	if e == nil || e.out != 0 {
		return
	}
	close(e.done)
	if out == 0 {
		delete(d.m, key)
		return
	}
	e.out, e.at = out, d.now()
	e.elem = d.order.PushFront(e)
	for d.order.Len() > d.max {
		old := d.order.Back().Value.(*entry)
		d.order.Remove(old.elem)
		delete(d.m, old.key)
		d.evicted++
	}
}

func (d *Memory) expire() {
	cut := d.now().Add(-d.window)
	for el := d.order.Back(); el != nil; el = d.order.Back() {
		e := el.Value.(*entry)
		if e.at.After(cut) {
			return
		}
		d.order.Remove(el)
		delete(d.m, e.key)
	}
}

// Stats for metrics: remembered keys, evictions before the window ended, duplicates answered.
func (d *Memory) Stats() (size int, evicted, dups int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.order.Len(), d.evicted, d.dups
}
