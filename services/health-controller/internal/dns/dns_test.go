// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"context"
	"errors"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestHTTPAdapterAgainstFakeServer(t *testing.T) {
	f := NewFakeServer("s3cret")
	srv := httptest.NewServer(f)
	defer srv.Close()
	p := NewHTTP("dns-a", srv.URL, "s3cret", nil)
	ctx := context.Background()

	if _, err := p.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing set: %v", err)
	}
	want := []netip.Addr{netip.MustParseAddr("192.0.2.2"), netip.MustParseAddr("192.0.2.1")}
	if err := p.SetRecords(ctx, "domain-a.test", "in.domain-a.test", A, 60, want); err != nil {
		t.Fatal(err)
	}
	got, err := p.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A)
	if err != nil || !Equal(got, want) {
		t.Fatalf("got %v %v", got, err)
	}
	if err := p.SetRecords(ctx, "domain-a.test", "in.domain-a.test", A, 60, nil); err == nil {
		t.Fatal("empty set accepted by the adapter")
	}
	if err := p.SetRecords(ctx, "domain-a.test", "in.domain-a.test", A, 60, []netip.Addr{netip.MustParseAddr("2001:db8::1")}); err == nil {
		t.Fatal("AAAA address in an A set accepted")
	}
	f.SetDown(true)
	if _, err := p.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("down provider: %v", err)
	}
	f.SetDown(false)
	bad := NewHTTP("dns-a", srv.URL, "wrong", nil)
	if _, err := bad.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); err == nil {
		t.Fatal("wrong token accepted")
	}
}

func TestMemoryRefusesEmptySet(t *testing.T) {
	m := NewMemory("x")
	if err := m.SetRecords(context.Background(), "z", "n", A, 60, nil); err == nil {
		t.Fatal("empty set accepted")
	}
}
