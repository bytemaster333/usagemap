// SPDX-License-Identifier: Apache-2.0

// Package limits holds the gateway's node-local, memory-only counters: per-site and per-(site, subnet) rate limits
// (C-90, §a.6 step 2), the per-tenant daily verified-event quota share (step 7), the per-event-id de-duplication
// window (C-37), the per-nonce event counter (§b.3), the per-site rate history for `rate_anomaly` (§h.2) and the
// adaptive proof-of-work multiplier (§b.2).
package limits

import (
	"container/list"
	"math"
	"sort"
	"sync"
	"time"
)

// Window is a sliding one-minute rate limiter (two fixed windows, weighted).
type Window struct {
	mu   sync.Mutex
	m    map[string]*win
	last time.Time
}

type win struct {
	start      time.Time
	cur, prev  int
	lastAccess time.Time
}

// NewWindow creates a limiter.
func NewWindow() *Window { return &Window{m: map[string]*win{}} }

// Allow counts one request for key and reports whether it is within limit per minute. When refused it returns the
// seconds after which a retry may succeed (1…60).
func (w *Window) Allow(key string, limit int, now time.Time) (bool, int) {
	return w.AllowN(key, 1, limit, now)
}

// AllowN counts n units (e.g. events of a batch) for key and reports whether all of them fit within limit per
// minute; a refused call counts nothing.
func (w *Window) AllowN(key string, n, limit int, now time.Time) (bool, int) {
	if n < 1 {
		n = 1
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if now.Sub(w.last) > time.Minute {
		for k, v := range w.m {
			if now.Sub(v.lastAccess) > 2*time.Minute {
				delete(w.m, k)
			}
		}
		w.last = now
	}
	start := now.Truncate(time.Minute)
	x := w.m[key]
	if x == nil {
		x = &win{start: start}
		w.m[key] = x
	}
	switch {
	case x.start.Equal(start):
	case x.start.Equal(start.Add(-time.Minute)):
		x.prev, x.cur, x.start = x.cur, 0, start
	default:
		x.prev, x.cur, x.start = 0, 0, start
	}
	x.lastAccess = now
	elapsed := now.Sub(start).Seconds() / 60
	est := float64(x.prev)*(1-elapsed) + float64(x.cur)
	if limit < 1 {
		limit = 1
	}
	if est+float64(n) > float64(limit) {
		retry := int(math.Ceil((1 - elapsed) * 60))
		if x.cur+n > limit {
			retry = int(math.Ceil(start.Add(time.Minute).Sub(now).Seconds()))
		}
		return false, clamp(retry, 1, 60)
	}
	x.cur += n
	return true, 0
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// Share is ceil(total / nodes), at least 1 (C-90: each node enforces its share).
func Share(total, nodes int) int {
	if nodes < 1 {
		nodes = 1
	}
	s := (total + nodes - 1) / nodes
	if s < 1 {
		s = 1
	}
	return s
}

// Quota counts verified events per tenant and UTC day on this node.
type Quota struct {
	mu  sync.Mutex
	day string
	n   map[string]int
}

// NewQuota creates a counter.
func NewQuota() *Quota { return &Quota{n: map[string]int{}} }

// Over reports whether adding k verified events would exceed share for the tenant today.
func (q *Quota) Over(tenant string, k, share int, now time.Time) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.roll(now)
	return q.n[tenant]+k > share
}

// Add records k verified events.
func (q *Quota) Add(tenant string, k int, now time.Time) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.roll(now)
	q.n[tenant] += k
}

func (q *Quota) roll(now time.Time) {
	d := now.UTC().Format("2006-01-02")
	if d != q.day {
		q.day, q.n = d, map[string]int{}
	}
}

// SecondsToMidnight is the Retry-After of a quota 429: seconds to 00:00 UTC, at most 3600 (§a.5).
func SecondsToMidnight(now time.Time) int {
	u := now.UTC()
	next := time.Date(u.Year(), u.Month(), u.Day()+1, 0, 0, 0, 0, time.UTC)
	return clamp(int(math.Ceil(next.Sub(u).Seconds())), 1, 3600)
}

// TTLSet is an LRU set with a time-to-live, used for event ids (10 min) and nonces (35 min).
type TTLSet struct {
	mu  sync.Mutex
	ttl time.Duration
	max int
	m   map[string]*list.Element
	l   *list.List
}

type ttlEntry struct {
	key   string
	at    time.Time
	count int
}

// NewTTLSet creates a set holding at most max keys for ttl.
func NewTTLSet(ttl time.Duration, max int) *TTLSet {
	return &TTLSet{ttl: ttl, max: max, m: map[string]*list.Element{}, l: list.New()}
}

func (s *TTLSet) expire(now time.Time) {
	for e := s.l.Back(); e != nil; {
		x := e.Value.(*ttlEntry)
		if now.Sub(x.at) <= s.ttl && s.l.Len() <= s.max {
			break
		}
		prev := e.Prev()
		s.l.Remove(e)
		delete(s.m, x.key)
		e = prev
	}
}

// Seen reports whether key was recorded within the TTL (without recording it).
func (s *TTLSet) Seen(key string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire(now)
	_, ok := s.m[key]
	return ok
}

// Add records key (refreshing nothing: the TTL runs from the first sighting).
func (s *TTLSet) Add(key string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire(now)
	if _, ok := s.m[key]; ok {
		return
	}
	s.m[key] = s.l.PushFront(&ttlEntry{key: key, at: now})
	s.expire(now)
}

// Incr adds n to key's counter and returns the counter before and after (0 before = first sighting).
func (s *TTLSet) Incr(key string, n int, now time.Time) (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire(now)
	e, ok := s.m[key]
	if !ok {
		e = s.l.PushFront(&ttlEntry{key: key, at: now})
		s.m[key] = e
		s.expire(now)
	}
	x := e.Value.(*ttlEntry)
	before := x.count
	x.count += n
	return before, x.count
}

// Len is the number of keys.
func (s *TTLSet) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.l.Len()
}

// RateHistory keeps per-site event counts in 10-minute buckets for 28 days, in memory (lost on restart), to detect
// `rate_anomaly`: the last 10 minutes > 10 × the site's 28-day p99 of 10-minute counts. It never fires with less
// than one day of history (stated: a fresh node cannot raise it).
type RateHistory struct {
	mu    sync.Mutex
	sites map[string]*siteRate
}

type siteRate struct {
	buckets []uint32 // ring of 4032 ten-minute buckets
	lastIdx int64    // absolute bucket index of the newest bucket
	filled  int
	p99     float64
	p99At   int64
}

const (
	bucketDur = 10 * time.Minute
	ring      = 28 * 24 * 6
	minFilled = 24 * 6
)

// NewRateHistory creates the tracker.
func NewRateHistory() *RateHistory { return &RateHistory{sites: map[string]*siteRate{}} }

// Add counts n events for a site at now and reports whether the site is in a rate anomaly.
func (r *RateHistory) Add(site string, n int, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sites[site]
	idx := now.UnixNano() / int64(bucketDur)
	if s == nil {
		s = &siteRate{buckets: make([]uint32, ring), lastIdx: idx, filled: 1}
		r.sites[site] = s
	}
	for s.lastIdx < idx {
		s.lastIdx++
		s.buckets[s.lastIdx%ring] = 0
		if s.filled < ring {
			s.filled++
		}
	}
	s.buckets[idx%ring] += uint32(n)
	// Exact sliding 10-minute count from timestamps would cost memory; the current bucket plus the previous one
	// weighted by overlap approximates it.
	cur := float64(s.buckets[idx%ring])
	prev := float64(s.buckets[(idx-1+ring)%ring])
	frac := float64(now.UnixNano()%int64(bucketDur)) / float64(bucketDur)
	last10 := cur + prev*(1-frac)
	if s.filled < minFilled {
		return false
	}
	if s.p99At != idx {
		vals := make([]float64, 0, s.filled)
		for i := 1; i < s.filled; i++ { // completed buckets only
			vals = append(vals, float64(s.buckets[(idx-int64(i)+ring)%ring]))
		}
		sort.Float64s(vals)
		s.p99 = vals[int(math.Ceil(0.99*float64(len(vals))))-1]
		s.p99At = idx
	}
	return s.p99 > 0 && last10 > 10*s.p99
}

// Difficulty is the adaptive proof-of-work multiplier per (site, net) pair: each trigger doubles it (max), and it
// halves for every 10 minutes without a trigger (§b.2).
type Difficulty struct {
	mu sync.Mutex
	m  map[string]*diff
	n  int
}

type diff struct {
	level int
	at    time.Time
}

// NewDifficulty creates the table.
func NewDifficulty() *Difficulty { return &Difficulty{m: map[string]*diff{}} }

func (d *Difficulty) decay(x *diff, now time.Time) {
	steps := int(now.Sub(x.at) / (10 * time.Minute))
	if steps > 0 {
		x.level -= steps
		if x.level < 0 {
			x.level = 0
		}
		x.at = x.at.Add(time.Duration(steps) * 10 * time.Minute)
	}
}

// Trigger doubles the pair's multiplier (bounded by maxMult).
func (d *Difficulty) Trigger(key string, maxMult int, now time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.m) > 100_000 {
		for k, v := range d.m {
			if now.Sub(v.at) > time.Hour {
				delete(d.m, k)
			}
		}
	}
	x := d.m[key]
	if x == nil {
		x = &diff{at: now}
		d.m[key] = x
	}
	d.decay(x, now)
	maxLevel := int(math.Log2(float64(max(1, maxMult))))
	if x.level < maxLevel {
		x.level++
	}
	x.at = now
}

// Multiplier returns 1, 2, 4 or 8 for the pair.
func (d *Difficulty) Multiplier(key string, now time.Time) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	x := d.m[key]
	if x == nil {
		return 1
	}
	d.decay(x, now)
	return 1 << x.level
}
