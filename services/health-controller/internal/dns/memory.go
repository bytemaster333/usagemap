// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"context"
	"errors"
	"net/netip"
	"sync"
)

// ErrUnavailable is returned by a provider that has been switched off (tests).
var ErrUnavailable = errors.New("provider unavailable")

// Change is one recorded write.
type Change struct {
	Zone, Name string
	Type       Type
	Addrs      []netip.Addr
}

// Memory is an in-memory provider with failure injection.
type Memory struct {
	name string
	mu   sync.Mutex
	sets map[string][]netip.Addr
	down bool
	log  []Change
}

// NewMemory returns an empty provider.
func NewMemory(name string) *Memory { return &Memory{name: name, sets: map[string][]netip.Addr{}} }

func key(zone, name string, t Type) string { return zone + "|" + name + "|" + string(t) }

// Name of the provider.
func (m *Memory) Name() string { return m.name }

// SetDown switches the provider's API off or on.
func (m *Memory) SetDown(down bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.down = down
}

// GetRecords returns a copy of the set.
func (m *Memory) GetRecords(_ context.Context, zone, name string, t Type) ([]netip.Addr, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.down {
		return nil, ErrUnavailable
	}
	s, ok := m.sets[key(zone, name, t)]
	if !ok {
		return nil, ErrNotFound
	}
	return Normalize(s), nil
}

// SetRecords replaces the set.
func (m *Memory) SetRecords(_ context.Context, zone, name string, t Type, _ int, addrs []netip.Addr) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.down {
		return ErrUnavailable
	}
	if len(addrs) == 0 {
		return errors.New("refusing to write an empty record set")
	}
	m.sets[key(zone, name, t)] = Normalize(addrs)
	m.log = append(m.log, Change{zone, name, t, Normalize(addrs)})
	return nil
}

// Seed writes a set without logging it (test setup).
func (m *Memory) Seed(zone, name string, t Type, addrs ...netip.Addr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sets[key(zone, name, t)] = Normalize(addrs)
}

// Changes returns the write log.
func (m *Memory) Changes() []Change {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Change(nil), m.log...)
}
