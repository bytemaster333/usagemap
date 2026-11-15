// SPDX-License-Identifier: Apache-2.0

// Package visit is the engine proxy's visit-token memory (wire-formats §c.5, C-74, C-99, C-110(7), C-112(9)).
//
// Umami 3.5.0 keeps a replayed cache token's visit open for ever when the request carries a timestamp, and without a
// token it starts a new visit every UTC clock hour. The engine proxy is therefore the 30-minute inactivity rule: per
// (website, surrogate) it keeps {token, last_event_ts} and replays the token only when the new event's timestamp is
// within 1,800 s of last_event_ts. last_event_ts only moves forward (max), which also handles out-of-order backlog.
//
// State is memory only: never written to disk or logs, emptied at 00:00 UTC (surrogates rotate daily, ADR-0007),
// bounded by an LRU of MaxEntries and a 30-minute wall-clock idle TTL (memory bounds only; the visit rule is the
// event-timestamp test). Deleted websites are remembered for 72 hours so no token is ever replayed into them.
package visit

import (
	"container/list"
	"net/netip"
	"strings"
	"sync"
	"time"
)

const (
	// WindowSeconds is the inactivity rule: replay only when |event − last_event_ts| ≤ 1800 s (C-99).
	WindowSeconds = 1800
	// DefaultMaxEntries is the per-core bound of §c.5.
	DefaultMaxEntries = 500_000
	// DefaultIdleTTL is the wall-clock idle bound of §c.5.
	DefaultIdleTTL = 30 * time.Minute
	// DefaultDeletedTTL is how long a deleted website id is remembered (C-110(8)).
	DefaultDeletedTTL = 72 * time.Hour
	// MaxTokenBytes bounds one stored token (Umami's cache JWT is ~300 bytes).
	MaxTokenBytes = 2048
	// sweepPerStore bounds the expired entries removed inline by one Store call.
	sweepPerStore = 32
)

// Result is the outcome of a Lookup.
type Result int

const (
	// Miss: no entry (first event of the visitor on this core, restart, eviction, expiry).
	Miss Result = iota
	// Hit: the token is replayed.
	Hit
	// RefusedWindow: an entry exists but the event is more than 1,800 s from last_event_ts (new visit).
	RefusedWindow
	// Deleted: the website was deleted within the last 72 hours; no token is ever replayed.
	Deleted
)

func (r Result) String() string {
	switch r {
	case Miss:
		return "miss"
	case Hit:
		return "hit"
	case RefusedWindow:
		return "refused_window"
	case Deleted:
		return "deleted"
	}
	return "unknown"
}

// StoreResult is the outcome of a Store.
type StoreResult int

const (
	// Stored: the token is kept and last_event_ts updated.
	Stored StoreResult = iota
	// SkippedDeleted: the website is on the deleted list.
	SkippedDeleted
	// SkippedBacklog: the event is more than 1,800 s older than last_event_ts; the current visit's token is kept.
	SkippedBacklog
	// Rejected: empty or oversized token, or an unparseable surrogate.
	Rejected
)

func (r StoreResult) String() string {
	switch r {
	case Stored:
		return "stored"
	case SkippedDeleted:
		return "skipped_deleted"
	case SkippedBacklog:
		return "skipped_backlog"
	case Rejected:
		return "rejected"
	}
	return "unknown"
}

// Stats are counters for the metrics endpoint. They never contain keys.
type Stats struct {
	Size            int
	Hits            uint64
	Misses          uint64
	RefusedWindow   uint64
	DeletedLookups  uint64
	Stored          uint64
	SkippedBacklog  uint64
	SkippedDeleted  uint64
	Rejected        uint64
	Evictions       uint64
	Expired         uint64
	Purges          uint64
	PurgedEntries   uint64
	DailyResets     uint64
	DeletedWebsites int
}

// Config configures a Store. Zero values take the defaults.
type Config struct {
	MaxEntries int
	IdleTTL    time.Duration
	DeletedTTL time.Duration
	Now        func() time.Time
}

type key struct {
	website   string
	surrogate string
}

type entry struct {
	k         key
	token     string
	lastEvent int64
	touched   time.Time
}

// Store is safe for concurrent use.
type Store struct {
	mu         sync.Mutex
	max        int
	idleTTL    time.Duration
	deletedTTL time.Duration
	now        func() time.Time

	ll        *list.List // front = most recently touched
	items     map[key]*list.Element
	byWebsite map[string]map[string]*list.Element
	deleted   map[string]time.Time // website -> forget after
	day       int64                // UTC day number the contents belong to

	st Stats
}

// New returns an empty store.
func New(c Config) *Store {
	if c.MaxEntries <= 0 {
		c.MaxEntries = DefaultMaxEntries
	}
	if c.IdleTTL <= 0 {
		c.IdleTTL = DefaultIdleTTL
	}
	if c.DeletedTTL <= 0 {
		c.DeletedTTL = DefaultDeletedTTL
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	s := &Store{
		max:        c.MaxEntries,
		idleTTL:    c.IdleTTL,
		deletedTTL: c.DeletedTTL,
		now:        c.Now,
		ll:         list.New(),
		items:      make(map[key]*list.Element),
		byWebsite:  make(map[string]map[string]*list.Element),
		deleted:    make(map[string]time.Time),
	}
	s.day = utcDay(s.now())
	return s
}

func utcDay(t time.Time) int64 { return t.UTC().Unix() / 86400 }

// canonical returns the map key: lower-case website id and the RFC 5952 form of the surrogate.
func canonical(website, surrogate string) (key, bool) {
	a, err := netip.ParseAddr(surrogate)
	if err != nil || website == "" {
		return key{}, false
	}
	return key{website: strings.ToLower(website), surrogate: a.Unmap().String()}, true
}

// housekeeping runs under s.mu: daily reset and expiry of the deleted list.
func (s *Store) housekeeping(now time.Time) {
	if d := utcDay(now); d != s.day {
		s.day = d
		if s.ll.Len() > 0 {
			s.ll.Init()
			s.items = make(map[key]*list.Element)
			s.byWebsite = make(map[string]map[string]*list.Element)
		}
		s.st.DailyResets++
	}
	for w, until := range s.deleted {
		if !now.Before(until) {
			delete(s.deleted, w)
		}
	}
}

func (s *Store) isDeletedLocked(website string, now time.Time) bool {
	until, ok := s.deleted[website]
	return ok && now.Before(until)
}

func (s *Store) removeLocked(el *list.Element) {
	e := el.Value.(*entry)
	s.ll.Remove(el)
	delete(s.items, e.k)
	if m := s.byWebsite[e.k.website]; m != nil {
		delete(m, e.k.surrogate)
		if len(m) == 0 {
			delete(s.byWebsite, e.k.website)
		}
	}
}

func (s *Store) expiredLocked(e *entry, now time.Time) bool {
	return now.Sub(e.touched) > s.idleTTL
}

// Lookup returns the token to replay for an event of (website, surrogate) at eventTS (Unix seconds), or "".
func (s *Store) Lookup(website, surrogate string, eventTS int64) (string, Result) {
	k, ok := canonical(website, surrogate)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.housekeeping(now)
	if !ok {
		s.st.Misses++
		return "", Miss
	}
	if s.isDeletedLocked(k.website, now) {
		s.st.DeletedLookups++
		return "", Deleted
	}
	el, found := s.items[k]
	if !found {
		s.st.Misses++
		return "", Miss
	}
	e := el.Value.(*entry)
	if s.expiredLocked(e, now) {
		s.removeLocked(el)
		s.st.Expired++
		s.st.Misses++
		return "", Miss
	}
	e.touched = now
	s.ll.MoveToFront(el)
	d := eventTS - e.lastEvent
	if d < 0 {
		d = -d
	}
	if d > WindowSeconds {
		s.st.RefusedWindow++
		return "", RefusedWindow
	}
	s.st.Hits++
	return e.token, Hit
}

// Store records the cache token Umami returned for an event of (website, surrogate) at eventTS.
//
// C-112(9): the returned token is always stored and last_event_ts := max(previous, event) — with one refinement:
// when the event is more than 1,800 s OLDER than last_event_ts (a long-delayed backlog event, which was given no
// token and therefore opened its own visit in Umami), the entry is left unchanged, so the visitor's current visit
// keeps its token; storing the old visit's token would merge the next live event into the old visit.
func (s *Store) Store(website, surrogate, token string, eventTS int64) StoreResult {
	k, ok := canonical(website, surrogate)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.housekeeping(now)
	if !ok || token == "" || len(token) > MaxTokenBytes {
		s.st.Rejected++
		return Rejected
	}
	if s.isDeletedLocked(k.website, now) {
		s.st.SkippedDeleted++
		return SkippedDeleted
	}
	if el, found := s.items[k]; found {
		e := el.Value.(*entry)
		if !s.expiredLocked(e, now) && eventTS < e.lastEvent-WindowSeconds {
			e.touched = now
			s.ll.MoveToFront(el)
			s.st.SkippedBacklog++
			return SkippedBacklog
		}
		if s.expiredLocked(e, now) {
			e.lastEvent = eventTS
		} else if eventTS > e.lastEvent {
			e.lastEvent = eventTS
		}
		e.token = token
		e.touched = now
		s.ll.MoveToFront(el)
		s.st.Stored++
		s.sweepLocked(now, sweepPerStore)
		return Stored
	}
	el := s.ll.PushFront(&entry{k: k, token: token, lastEvent: eventTS, touched: now})
	s.items[k] = el
	m := s.byWebsite[k.website]
	if m == nil {
		m = make(map[string]*list.Element)
		s.byWebsite[k.website] = m
	}
	m[k.surrogate] = el
	s.st.Stored++
	s.sweepLocked(now, sweepPerStore)
	for s.ll.Len() > s.max {
		s.removeLocked(s.ll.Back())
		s.st.Evictions++
	}
	return Stored
}

// sweepLocked removes up to limit idle entries from the LRU tail (limit < 0: all).
func (s *Store) sweepLocked(now time.Time, limit int) int {
	n := 0
	for limit < 0 || n < limit {
		el := s.ll.Back()
		if el == nil || !s.expiredLocked(el.Value.(*entry), now) {
			break
		}
		s.removeLocked(el)
		s.st.Expired++
		n++
	}
	return n
}

// Sweep removes every idle entry and runs the daily reset; call it periodically.
func (s *Store) Sweep() int {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.housekeeping(now)
	return s.sweepLocked(now, -1)
}

// PurgeWebsite drops every entry of a website and remembers its id for 72 hours (C-110(8), C-112(9)).
// It returns the number of entries dropped.
func (s *Store) PurgeWebsite(website string) int {
	w := strings.ToLower(website)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.housekeeping(now)
	n := 0
	for _, el := range s.byWebsite[w] {
		s.removeLocked(el)
		n++
	}
	s.deleted[w] = now.Add(s.deletedTTL)
	s.st.Purges++
	s.st.PurgedEntries += uint64(n)
	return n
}

// IsDeleted reports whether the website id is on the 72-hour deleted list.
func (s *Store) IsDeleted(website string) bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.housekeeping(now)
	return s.isDeletedLocked(strings.ToLower(website), now)
}

// Stats returns a snapshot of the counters.
func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.st
	st.Size = s.ll.Len()
	st.DeletedWebsites = len(s.deleted)
	return st
}

// lastEvent is a test helper.
func (s *Store) lastEvent(website, surrogate string) int64 {
	k, _ := canonical(website, surrogate)
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.items[k]; ok {
		return el.Value.(*entry).lastEvent
	}
	return 0
}
