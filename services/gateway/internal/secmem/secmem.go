// SPDX-License-Identifier: Apache-2.0

// Package secmem holds the edge keys (K_day, K_mult, K_chal; wire-formats §n, C-04, C-68) in memory that is locked
// (never swapped), outside the Go heap (never moved or copied by the garbage collector), excluded from core dumps,
// and zeroed when a key is destroyed. The process also disables core dumps entirely (DisableCoreDumps).
package secmem

import (
	"errors"
	"sync"
)

// KeySize is the size of every edge key.
const KeySize = 32

// Slab is a fixed pool of KeySize slots in one locked page.
type Slab struct {
	mu     sync.Mutex
	mem    []byte
	used   []bool
	locked bool
}

// ErrFull means every slot is in use.
var ErrFull = errors.New("secmem: no free key slot")

// New allocates a slab of n slots. Locked reports whether mlock succeeded (the gateway exports it as a metric and
// refuses to start without it unless explicitly allowed for development).
func New(n int) (*Slab, error) {
	mem, locked, err := alloc(n * KeySize)
	if err != nil {
		return nil, err
	}
	return &Slab{mem: mem, used: make([]bool, n), locked: locked}, nil
}

// Locked reports whether the slab's memory is locked against swapping.
func (s *Slab) Locked() bool { return s.locked }

// Slot is one key's memory. Bytes returns the live slice; callers must not retain it after Free.
type Slot struct {
	s *Slab
	i int
}

// Alloc returns a zeroed slot.
func (s *Slab) Alloc() (*Slot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, u := range s.used {
		if !u {
			s.used[i] = true
			return &Slot{s: s, i: i}, nil
		}
	}
	return nil, ErrFull
}

// Bytes is the slot's memory.
func (k *Slot) Bytes() []byte { return k.s.mem[k.i*KeySize : (k.i+1)*KeySize : (k.i+1)*KeySize] }

// Free zeroes the slot and returns it to the slab.
func (k *Slot) Free() {
	b := k.Bytes()
	for i := range b {
		b[i] = 0
	}
	k.s.mu.Lock()
	k.s.used[k.i] = false
	k.s.mu.Unlock()
}

// InUse counts allocated slots.
func (s *Slab) InUse() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, u := range s.used {
		if u {
			n++
		}
	}
	return n
}
