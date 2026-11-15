// SPDX-License-Identifier: Apache-2.0

// Package keys holds the three edge key kinds of wire-formats §n (C-04, C-68) — K_day (visitor surrogate, daily),
// K_mult (multiplicity cells, daily) and K_chal (challenge tokens, hourly) — in locked memory, and exchanges them with
// the other gateway nodes over mutual TLS (protocol `scf-keyx/1`). Keys are never logged and never written to disk.
package keys

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/secmem"
)

// Kind is a key kind.
type Kind string

const (
	Day  Kind = "day"
	Mult Kind = "mult"
	Chal Kind = "chal"
)

// Kinds lists all kinds.
var Kinds = []Kind{Day, Mult, Chal}

// DayID is the id of a daily key: the UTC date.
func DayID(t time.Time) string { return t.UTC().Format("2006-01-02") }

// ChalID is the id of an hourly key: floor(unix/3600).
func ChalID(t time.Time) string { return strconv.FormatInt(t.Unix()/3600, 10) }

// ID returns the id of kind k at time t.
func ID(k Kind, t time.Time) string {
	if k == Chal {
		return ChalID(t)
	}
	return DayID(t)
}

// wanted returns the ids of kind k this node keeps at time t: day/mult — current and next day; chal — previous,
// current and next hour.
func wanted(k Kind, t time.Time) []string {
	if k == Chal {
		return []string{ChalID(t.Add(-time.Hour)), ChalID(t), ChalID(t.Add(time.Hour))}
	}
	return []string{DayID(t), DayID(t.Add(24 * time.Hour))}
}

var (
	reDay  = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	reChal = regexp.MustCompile(`^[0-9]{1,10}$`)
)

func validID(k Kind, id string) bool {
	switch k {
	case Day, Mult:
		return reDay.MatchString(id)
	case Chal:
		return reChal.MatchString(id)
	}
	return false
}

// PublicFingerprint is a domain-separated, truncated hash of a key, safe to export as a metric label (C-124): the
// first 16 hex characters of SHA-256("scf-key-fp/1" ‖ kind ‖ key). It reveals nothing usable about the key and differs
// from the exchange fingerprint.
func PublicFingerprint(k Kind, key []byte) string {
	h := sha256.New()
	h.Write([]byte("scf-key-fp/1"))
	h.Write([]byte(k))
	h.Write(key)
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// PublicFingerprintOf returns PublicFingerprint of the held key (kind k, id), or "" when absent.
func (r *Ring) PublicFingerprintOf(k Kind, id string) string {
	var fp string
	r.With(k, id, func(key []byte) {
		if key != nil {
			fp = PublicFingerprint(k, key)
		}
	})
	return fp
}

// Fingerprint is hex SHA-256 of a key.
func Fingerprint(key []byte) string {
	h := sha256.Sum256(key)
	return hex.EncodeToString(h[:])
}

type entry struct {
	slot *secmem.Slot
	fp   string
	// generated is when this node created the key itself (zero when adopted from a peer).
	generated time.Time
}

// Ring is the node's key store.
type Ring struct {
	mu        sync.RWMutex
	slab      *secmem.Slab
	keys      map[Kind]map[string]*entry
	conflicts map[Kind]int
	now       func() time.Time
	onRotate  func(k Kind, id string) // called after a key of a kind is destroyed (e.g. drop multiplicity cells)
}

// NewRing allocates the locked slab. now is injectable for tests.
func NewRing(now func() time.Time) (*Ring, error) {
	slab, err := secmem.New(32)
	if err != nil {
		return nil, err
	}
	if now == nil {
		now = time.Now
	}
	return &Ring{slab: slab, keys: map[Kind]map[string]*entry{Day: {}, Mult: {}, Chal: {}}, conflicts: map[Kind]int{}, now: now}, nil
}

// Locked reports whether the key memory is mlock'ed.
func (r *Ring) Locked() bool { return r.slab.Locked() }

// OnDestroy registers a callback run after keys are destroyed.
func (r *Ring) OnDestroy(fn func(k Kind, id string)) { r.onRotate = fn }

// With calls fn with the key of kind k and id (nil if absent). The slice is valid only during fn.
func (r *Ring) With(k Kind, id string, fn func(key []byte)) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if e := r.keys[k][id]; e != nil {
		fn(e.slot.Bytes())
		return
	}
	fn(nil)
}

// Has reports whether the ring holds kind k, id.
func (r *Ring) Has(k Kind, id string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.keys[k][id] != nil
}

// Copy returns a heap copy of a key (for HMAC computations that outlive the lock; callers keep it on the stack of
// one request only). nil if absent.
func (r *Ring) Copy(k Kind, id string) []byte {
	var out []byte
	r.With(k, id, func(key []byte) {
		if key != nil {
			out = append([]byte(nil), key...)
		}
	})
	return out
}

// Generate creates a random key for (k, id) if absent and returns whether it created one.
func (r *Ring) Generate(k Kind, id string) (bool, error) {
	var buf [secmem.KeySize]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return false, err
	}
	defer clear(buf[:])
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.keys[k][id] != nil {
		return false, nil
	}
	if err := r.storeLocked(k, id, buf[:]); err != nil {
		return false, err
	}
	r.keys[k][id].generated = r.now()
	return true, nil
}

// GeneratedAt returns when this node generated the key (kind k, id) itself; zero when it was adopted from a peer,
// replaced by a peer's key after a conflict, or is absent.
func (r *Ring) GeneratedAt(k Kind, id string) time.Time {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if e := r.keys[k][id]; e != nil {
		return e.generated
	}
	return time.Time{}
}

func (r *Ring) storeLocked(k Kind, id string, key []byte) error {
	s, err := r.slab.Alloc()
	if err != nil {
		return err
	}
	copy(s.Bytes(), key)
	r.keys[k][id] = &entry{slot: s, fp: Fingerprint(key)}
	return nil
}

// Result of Put.
type Result int

const (
	Unchanged Result = iota // same key already held, or refused (out of window)
	Adopted                 // new key stored
	Conflict                // a different key was held; the smaller fingerprint was kept
)

// Put offers a key received from a peer. Only ids inside this node's retention window are accepted. On a conflict
// (two keys for one kind and id after a partition) the key with the smaller fingerprint wins (§n).
func (r *Ring) Put(k Kind, id string, key []byte) (Result, error) {
	if len(key) != secmem.KeySize || !validID(k, id) {
		return Unchanged, fmt.Errorf("keys: malformed %s key", k)
	}
	inWindow := false
	for _, w := range wanted(k, r.now()) {
		if w == id {
			inWindow = true
		}
	}
	if !inWindow {
		return Unchanged, nil
	}
	fp := Fingerprint(key)
	r.mu.Lock()
	defer r.mu.Unlock()
	cur := r.keys[k][id]
	switch {
	case cur == nil:
		return Adopted, r.storeLocked(k, id, key)
	case cur.fp == fp:
		return Unchanged, nil
	case fp < cur.fp:
		copy(cur.slot.Bytes(), key)
		cur.fp = fp
		cur.generated = time.Time{}
		r.conflicts[k]++
		return Conflict, nil
	default:
		r.conflicts[k]++
		return Conflict, nil
	}
}

// Conflicts returns the number of conflicts seen for a kind.
func (r *Ring) Conflicts(k Kind) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.conflicts[k]
}

// Wire is one key in a keyx message.
type Wire struct {
	Kind Kind   `json:"kind"`
	ID   string `json:"id"`
	Key  []byte `json:"key"` // base64url in JSON via custom marshalling in keyx.go
	FP   string `json:"fp"`
}

// Export returns copies of every held key inside the retention window (for GET /keyx/v1/keys and pushes). The
// returned buffers must be cleared by the caller after use.
func (r *Ring) Export() []Wire {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []Wire
	for _, k := range Kinds {
		for _, id := range wanted(k, r.now()) {
			if e := r.keys[k][id]; e != nil {
				out = append(out, Wire{Kind: k, ID: id, Key: append([]byte(nil), e.slot.Bytes()...), FP: e.fp})
			}
		}
	}
	return out
}

// Prune destroys (zeroes and frees) every key outside the retention window.
func (r *Ring) Prune() {
	type gone struct {
		k  Kind
		id string
	}
	var destroyed []gone
	r.mu.Lock()
	for _, k := range Kinds {
		keep := map[string]bool{}
		for _, id := range wanted(k, r.now()) {
			keep[id] = true
		}
		for id, e := range r.keys[k] {
			if !keep[id] {
				e.slot.Free()
				delete(r.keys[k], id)
				destroyed = append(destroyed, gone{k, id})
			}
		}
	}
	r.mu.Unlock()
	if r.onRotate != nil {
		for _, g := range destroyed {
			r.onRotate(g.k, g.id)
		}
	}
}

// Missing lists the (kind, id) pairs of the retention window this node lacks.
func (r *Ring) Missing() [][2]string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out [][2]string
	for _, k := range Kinds {
		for _, id := range wanted(k, r.now()) {
			if r.keys[k][id] == nil {
				out = append(out, [2]string{string(k), id})
			}
		}
	}
	return out
}

// HasCurrent reports whether every key needed right now (today's day/mult, this hour's chal) is held.
func (r *Ring) HasCurrent() bool {
	now := r.now()
	return r.Has(Day, DayID(now)) && r.Has(Mult, DayID(now)) && r.Has(Chal, ChalID(now))
}

// Count returns the number of held keys.
func (r *Ring) Count() int { return r.slab.InUse() }
