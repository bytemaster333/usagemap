// SPDX-License-Identifier: Apache-2.0

// Package multiplicity implements the per-node, memory-only multiplicity counting of wire-formats §b.4 (ADR-0008 L6,
// C-68, C-80b, C-89): two cells per page load (exact address and truncated subnet, keyed by HMAC under K_mult),
// a 10-minute sliding window of two 5-minute halves, an exact set of up to 32 surrogate digests then HyperLogLog
// p = 10, a hard cap of 200,000 cells with LRU eviction and a 20-minute idle eviction, and the bucket rule.
package multiplicity

import (
	"container/list"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"math"
	"math/bits"
	"sync"
	"time"
)

const (
	// MaxCells is the hard cap per node.
	MaxCells = 200_000
	half     = 5 * time.Minute
	idle     = 20 * time.Minute
	exactMax = 32
	hllP     = 10
	hllM     = 1 << hllP
)

// Key of a cell: 8 bytes of HMAC.
type Key [8]byte

// KeyIP is HMAC-SHA-256(K_mult, "mip1" ‖ site_id(16) ‖ ip(4|16))[0..8].
func KeyIP(kmult []byte, siteID [16]byte, ip []byte) Key {
	return mac(kmult, "mip1", siteID, ip)
}

// KeyNet is HMAC-SHA-256(K_mult, "mnet1" ‖ site_id(16) ‖ net)[0..8].
func KeyNet(kmult []byte, siteID [16]byte, net []byte) Key {
	return mac(kmult, "mnet1", siteID, net)
}

func mac(k []byte, label string, site [16]byte, b []byte) Key {
	m := hmac.New(sha256.New, k)
	m.Write([]byte(label))
	m.Write(site[:])
	m.Write(b)
	var out Key
	copy(out[:], m.Sum(nil))
	return out
}

// sketch counts distinct 8-byte digests: exact up to 32, then HLL p=10.
type sketch struct {
	exact map[uint64]struct{}
	hll   []uint8 // nil while exact
}

func (s *sketch) add(d uint64) {
	if s.hll == nil {
		if s.exact == nil {
			s.exact = map[uint64]struct{}{}
		}
		s.exact[d] = struct{}{}
		if len(s.exact) <= exactMax {
			return
		}
		s.hll = make([]uint8, hllM)
		for x := range s.exact {
			hllAdd(s.hll, x)
		}
		s.exact = nil
		return
	}
	hllAdd(s.hll, d)
}

func mix(x uint64) uint64 { // splitmix64 finaliser: digests are already HMAC output, this only decorrelates bits
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	return x ^ x>>31
}

func hllAdd(r []uint8, d uint64) {
	h := mix(d)
	idx := h >> (64 - hllP)
	rest := h<<hllP | 1<<(hllP-1)
	rank := uint8(bits.LeadingZeros64(rest)) + 1
	if rank > r[idx] {
		r[idx] = rank
	}
}

func hllEstimate(r []uint8) float64 {
	sum, zeros := 0.0, 0
	for _, v := range r {
		sum += math.Ldexp(1, -int(v))
		if v == 0 {
			zeros++
		}
	}
	m := float64(hllM)
	est := 0.7213 / (1 + 1.079/m) * m * m / sum
	if est <= 2.5*m && zeros > 0 {
		est = m * math.Log(m/float64(zeros))
	}
	return est
}

// union estimates the distinct count over two sketches.
func union(a, b *sketch) float64 {
	if a.hll == nil && b.hll == nil {
		n := len(a.exact)
		for x := range b.exact {
			if _, ok := a.exact[x]; !ok {
				n++
			}
		}
		return float64(n)
	}
	r := make([]uint8, hllM)
	for _, s := range []*sketch{a, b} {
		if s.hll != nil {
			for i, v := range s.hll {
				if v > r[i] {
					r[i] = v
				}
			}
		} else {
			for x := range s.exact {
				hllAdd(r, x)
			}
		}
	}
	return hllEstimate(r)
}

type halfWindow struct {
	start          time.Time
	loads          uint32
	zeroActivation uint32
	proofsOK       uint32
	autoFlags      uint32
	distinct       sketch
}

type cell struct {
	key      Key
	cur, old halfWindow
	lastUse  time.Time
	elem     *list.Element
}

func (c *cell) roll(now time.Time) {
	start := now.Truncate(half)
	switch {
	case c.cur.start.Equal(start):
	case c.cur.start.Equal(start.Add(-half)):
		c.old = c.cur
		c.cur = halfWindow{start: start}
	default:
		c.old = halfWindow{}
		c.cur = halfWindow{start: start}
	}
}

// Load is one page load (the first event of a challenge nonce on this node).
type Load struct {
	Surrogate      uint64 // digest of the surrogate (identified sites only)
	Identified     bool
	Standard       bool // standard profile: client signals present
	ZeroActivation bool // sg.act = 0
	AutoFlag       bool // sg.wd = 1 or sg.vis ∈ {h, p}
	ProofOK        bool
}

// Bucket labels (data-model §8.9 `multiplicity`).
const (
	One  = "one"
	Low  = "low"
	Mid  = "mid"
	High = "high"
)

var rank = map[string]int{One: 0, Low: 1, Mid: 2, High: 3}

// Result of an observation.
type Result struct {
	Bucket string
	// High is the `multiplicity_high` reason: bucket high and low engagement in the cell that is high.
	High bool
	// SubnetBucket is the subnet cell's bucket alone (adaptive PoW difficulty, §b.2).
	SubnetBucket string
}

// Thresholds: T[cell kind ("exact_ip" | "subnet")][ASN class].
type Thresholds map[string]map[string]int

// Store is the node's cell table.
type Store struct {
	mu      sync.Mutex
	cells   map[Key]*cell
	lru     *list.List
	evicted uint64
	day     string
}

// New creates an empty store.
func New() *Store { return &Store{cells: map[Key]*cell{}, lru: list.New()} }

// Reset drops every cell (at the daily K_mult rotation).
func (s *Store) Reset(day string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cells = map[Key]*cell{}
	s.lru.Init()
	s.day = day
}

// Len is the number of cells.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cells)
}

// Evicted counts cells evicted by the cap.
func (s *Store) Evicted() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.evicted
}

func (s *Store) get(k Key, now time.Time, create bool) *cell {
	c := s.cells[k]
	if c != nil && now.Sub(c.lastUse) > idle {
		s.lru.Remove(c.elem)
		delete(s.cells, k)
		c = nil
	}
	if c == nil {
		if !create {
			return nil
		}
		for len(s.cells) >= MaxCells {
			back := s.lru.Back()
			old := back.Value.(*cell)
			s.lru.Remove(back)
			delete(s.cells, old.key)
			s.evicted++
		}
		c = &cell{key: k}
		c.elem = s.lru.PushFront(c)
		s.cells[k] = c
	}
	c.lastUse = now
	s.lru.MoveToFront(c.elem)
	c.roll(now)
	return c
}

// Sweep removes idle cells (call periodically).
func (s *Store) Sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for e := s.lru.Back(); e != nil; {
		c := e.Value.(*cell)
		if now.Sub(c.lastUse) <= idle {
			break
		}
		prev := e.Prev()
		s.lru.Remove(e)
		delete(s.cells, c.key)
		e = prev
	}
}

type measure struct {
	m                                   float64
	loads, zeroAct, proofsOK, autoFlags uint32
}

func (c *cell) measure(identified bool) measure {
	var ms measure
	ms.loads = c.cur.loads + c.old.loads
	ms.zeroAct = c.cur.zeroActivation + c.old.zeroActivation
	ms.proofsOK = c.cur.proofsOK + c.old.proofsOK
	ms.autoFlags = c.cur.autoFlags + c.old.autoFlags
	if identified {
		ms.m = union(&c.cur.distinct, &c.old.distinct)
	} else {
		ms.m = float64(ms.loads)
	}
	return ms
}

func bucket(m float64, t int) string {
	switch {
	case m <= 1:
		return One
	case m <= float64(t)/2:
		return Low
	case m <= float64(t):
		return Mid
	default:
		return High
	}
}

func lowEngagement(ms measure, standard bool) bool {
	if ms.loads == 0 {
		return false
	}
	l := float64(ms.loads)
	if float64(ms.proofsOK)/l < 0.5 {
		return true
	}
	return standard && (float64(ms.zeroAct)/l > 0.7 || float64(ms.autoFlags)/l > 0.2)
}

// Observe updates (first event of a nonce: firstLoad = true) or only reads (later events) the two cells and returns
// the bucket. asnClass `relay` is exempt (bucket one). thresholds are `multiplicity_thresholds` for identified
// events and `multiplicity_event_thresholds` for unidentified ones (the caller passes the right set).
func (s *Store) Observe(now time.Time, ip, net Key, l Load, firstLoad bool, asnClass string, thresholds Thresholds) Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	res := Result{Bucket: One, SubnetBucket: One}
	for i, k := range []Key{ip, net} {
		c := s.get(k, now, firstLoad)
		if c == nil {
			continue // evicted or missing: bucket one
		}
		if firstLoad {
			c.cur.loads++
			if l.Identified {
				c.cur.distinct.add(l.Surrogate)
			}
			if l.ProofOK {
				c.cur.proofsOK++
			}
			if l.Standard && l.ZeroActivation {
				c.cur.zeroActivation++
			}
			if l.Standard && l.AutoFlag {
				c.cur.autoFlags++
			}
		}
		if asnClass == "relay" {
			continue
		}
		kind := "exact_ip"
		if i == 1 {
			kind = "subnet"
		}
		t := Threshold(thresholds, kind, asnClass)
		if t <= 0 {
			continue // no threshold configured: never high
		}
		ms := c.measure(l.Identified)
		b := bucket(ms.m, t)
		if i == 1 {
			res.SubnetBucket = b
		}
		if rank[b] > rank[res.Bucket] {
			res.Bucket = b
		}
		if b == High && lowEngagement(ms, l.Standard) {
			res.High = true
		}
	}
	return res
}

// Threshold returns T for a cell kind and network class. A class without its own threshold falls back to `unknown`.
// `unknown` — every address in none of the configured range lists, which without eyeball lists is nearly every
// visitor — uses the larger of its own threshold and `eyeball_mobile`'s (C-124, F19): an unclassified address may be
// a carrier-grade NAT or campus gateway shared by many people, and a too-low threshold marks real audiences suspect.
func Threshold(th Thresholds, kind, class string) int {
	t := th[kind][class]
	if t <= 0 || class == "unknown" {
		t = max(th[kind]["unknown"], th[kind]["eyeball_mobile"])
	}
	return t
}

// Digest reduces a surrogate's 96-bit suffix to the 8-byte digest kept in the exact set.
func Digest(suffix []byte) uint64 {
	if len(suffix) >= 8 {
		return binary.BigEndian.Uint64(suffix[:8])
	}
	var b [8]byte
	copy(b[:], suffix)
	return binary.BigEndian.Uint64(b[:])
}
