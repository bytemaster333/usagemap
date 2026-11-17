// SPDX-License-Identifier: Apache-2.0

// Package dns is the provider interface through which the health controller maintains the ingest and portal A/AAAA
// record sets (C-27, C-92) at each DNS provider, plus two implementations: an in-memory provider for unit tests and an
// HTTP/JSON adapter that speaks the reference provider API (served by cmd/fake-dns-provider in tests and Compose).
// Real provider adapters (Azure DNS, Hetzner DNS, deSEC, …) implement the same three methods; see README.
package dns

import (
	"context"
	"errors"
	"net/netip"
	"slices"
)

// Type is a record type the controller owns.
type Type string

// The two record types the controller writes.
const (
	A    Type = "A"
	AAAA Type = "AAAA"
)

// ErrNotFound means the record set does not exist (an empty set).
var ErrNotFound = errors.New("record set not found")

// Provider is one DNS provider. Each call is one record set: zone + fully qualified name + type. SetRecords replaces
// the whole set atomically (every provider API we target has a "replace RRset" operation); an empty addrs is never
// passed — the controller never empties a set (C-92).
type Provider interface {
	Name() string
	GetRecords(ctx context.Context, zone, name string, t Type) ([]netip.Addr, error)
	SetRecords(ctx context.Context, zone, name string, t Type, ttl int, addrs []netip.Addr) error
}

// Normalize sorts and de-duplicates a set so two sets can be compared.
func Normalize(in []netip.Addr) []netip.Addr {
	out := slices.Clone(in)
	slices.SortFunc(out, func(a, b netip.Addr) int { return a.Compare(b) })
	return slices.Compact(out)
}

// Equal compares two sets.
func Equal(a, b []netip.Addr) bool { return slices.Equal(Normalize(a), Normalize(b)) }
