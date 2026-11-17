// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"context"
	"errors"
	"net/netip"
	"testing"
)

// contract is the behaviour every adapter must show (README "Provider adapters"): a missing set reads as
// ErrNotFound, a written set reads back equal (order-insensitive), a replacement replaces the whole set, an empty set
// and an address of the wrong family are refused without a write, and A and AAAA sets of one name are independent.
func contract(t *testing.T, p Provider, zone, name string) {
	t.Helper()
	ctx := context.Background()
	if _, err := p.GetRecords(ctx, zone, name, A); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing set: %v", err)
	}
	want := []netip.Addr{netip.MustParseAddr("192.0.2.2"), netip.MustParseAddr("192.0.2.1")}
	if err := p.SetRecords(ctx, zone, name, A, 60, want); err != nil {
		t.Fatal(err)
	}
	got, err := p.GetRecords(ctx, zone, name, A)
	if err != nil || !Equal(got, want) {
		t.Fatalf("got %v %v", got, err)
	}
	// replace: one removed, one added
	next := []netip.Addr{netip.MustParseAddr("192.0.2.1"), netip.MustParseAddr("192.0.2.3")}
	if err := p.SetRecords(ctx, zone, name, A, 60, next); err != nil {
		t.Fatal(err)
	}
	if got, err = p.GetRecords(ctx, zone, name, A); err != nil || !Equal(got, next) {
		t.Fatalf("after replace: %v %v", got, err)
	}
	// idempotent
	if err := p.SetRecords(ctx, zone, name, A, 60, next); err != nil {
		t.Fatal(err)
	}
	if err := p.SetRecords(ctx, zone, name, A, 60, nil); err == nil {
		t.Fatal("empty set accepted by the adapter")
	}
	if err := p.SetRecords(ctx, zone, name, A, 60, []netip.Addr{netip.MustParseAddr("2001:db8::1")}); err == nil {
		t.Fatal("AAAA address in an A set accepted")
	}
	if got, err = p.GetRecords(ctx, zone, name, A); err != nil || !Equal(got, next) {
		t.Fatalf("a refused write changed the set: %v %v", got, err)
	}
	// AAAA is its own set
	if _, err := p.GetRecords(ctx, zone, name, AAAA); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing AAAA set: %v", err)
	}
	six := []netip.Addr{netip.MustParseAddr("2001:db8::2"), netip.MustParseAddr("2001:db8::1")}
	if err := p.SetRecords(ctx, zone, name, AAAA, 60, six); err != nil {
		t.Fatal(err)
	}
	if got, err = p.GetRecords(ctx, zone, name, AAAA); err != nil || !Equal(got, six) {
		t.Fatalf("AAAA: %v %v", got, err)
	}
	if got, err = p.GetRecords(ctx, zone, name, A); err != nil || !Equal(got, next) {
		t.Fatalf("A changed by the AAAA write: %v %v", got, err)
	}
}

func TestContractHTTPAdapter(t *testing.T) {
	f := NewFakeServer("s3cret")
	srv := newServer(t, f)
	contract(t, NewHTTP("dns-a", srv.URL, "s3cret", nil), "domain-a.test", "in.domain-a.test")
}

func TestContractAzure(t *testing.T) {
	f := newFakeAzure(t)
	contract(t, f.adapter(), "domain-a.test", "in.domain-a.test")
}

func TestContractAzureApex(t *testing.T) {
	f := newFakeAzure(t)
	contract(t, f.adapter(), "domain-a.test", "domain-a.test")
	if _, ok := f.sets["A/@"]; !ok {
		t.Fatalf("apex not written as @: %v", f.keys())
	}
}

func TestContractCloudflare(t *testing.T) {
	f := newFakeCloudflare(t)
	contract(t, f.adapter(), "domain-a.test", "in.domain-a.test")
}
