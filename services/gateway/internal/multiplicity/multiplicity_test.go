// SPDX-License-Identifier: Apache-2.0

package multiplicity

import (
	"encoding/binary"
	"math"
	"testing"
	"time"
)

var th = Thresholds{
	"exact_ip": {"datacenter": 3, "eyeball_fixed": 6, "unknown": 6},
	"subnet":   {"datacenter": 6, "eyeball_fixed": 24, "unknown": 24},
}

func k(i int) Key {
	var x Key
	binary.BigEndian.PutUint64(x[:], uint64(i))
	return x
}

var t0 = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

func TestBucketsByDistinctSurrogates(t *testing.T) {
	s := New()
	var r Result
	// 7 distinct surrogates behind one address (T exact_ip unknown = 6) → high; all with proofs → not low engagement.
	for i := 0; i < 7; i++ {
		r = s.Observe(t0, k(1), k(2), Load{Surrogate: uint64(i), Identified: true, ProofOK: true, Standard: true}, true, "unknown", th)
	}
	if r.Bucket != High || r.High {
		t.Fatalf("got %+v, want bucket high without the reason (engaged)", r)
	}
	// Same surrogate repeatedly → one.
	s2 := New()
	for i := 0; i < 50; i++ {
		r = s2.Observe(t0, k(3), k(4), Load{Surrogate: 42, Identified: true, ProofOK: true}, true, "unknown", th)
	}
	if r.Bucket != One {
		t.Fatalf("one visitor reloading: %+v", r)
	}
	// Low / mid boundaries: T=6 → m=3 low, m=6 mid.
	s3 := New()
	for i := 0; i < 3; i++ {
		r = s3.Observe(t0, k(5), k(6), Load{Surrogate: uint64(i), Identified: true, ProofOK: true}, true, "unknown", th)
	}
	if r.Bucket != Low {
		t.Fatalf("m=3: %+v", r)
	}
	for i := 3; i < 6; i++ {
		r = s3.Observe(t0, k(5), k(6), Load{Surrogate: uint64(i), Identified: true, ProofOK: true}, true, "unknown", th)
	}
	if r.Bucket != Mid {
		t.Fatalf("m=6: %+v", r)
	}
}

func TestMultiplicityHighNeedsLowEngagement(t *testing.T) {
	cases := map[string]struct {
		l    Load
		want bool
	}{
		"no proofs":        {Load{Identified: true, Standard: true}, true},
		"zero activation":  {Load{Identified: true, Standard: true, ProofOK: true, ZeroActivation: true}, true},
		"automation flags": {Load{Identified: true, Standard: true, ProofOK: true, AutoFlag: true}, true},
		"engaged":          {Load{Identified: true, Standard: true, ProofOK: true}, false},
		"strict: proofs only, zero activation ignored": {Load{Identified: true, Standard: false, ProofOK: true, ZeroActivation: true}, false},
	}
	for name, c := range cases {
		s := New()
		var r Result
		for i := 0; i < 10; i++ {
			l := c.l
			l.Surrogate = uint64(i)
			r = s.Observe(t0, k(1), k(2), l, true, "datacenter", th)
		}
		if r.Bucket != High || r.High != c.want {
			t.Errorf("%s: %+v, want high=%v", name, r, c.want)
		}
	}
}

func TestRelayExempt(t *testing.T) {
	s := New()
	var r Result
	for i := 0; i < 100; i++ {
		r = s.Observe(t0, k(1), k(2), Load{Surrogate: uint64(i), Identified: true}, true, "relay", th)
	}
	if r.Bucket != One || r.High {
		t.Fatalf("relay must be exempt: %+v", r)
	}
}

func TestUnidentifiedCountsLoads(t *testing.T) {
	s := New()
	ev := Thresholds{"exact_ip": {"unknown": 60}, "subnet": {"unknown": 240}}
	var r Result
	for i := 0; i < 61; i++ {
		r = s.Observe(t0, k(1), k(2), Load{Identified: false}, true, "unknown", ev)
	}
	if r.Bucket != High || !r.High {
		t.Fatalf("61 loads without proofs, T=60: %+v", r)
	}
}

func TestLaterEventsOnlyRead(t *testing.T) {
	s := New()
	s.Observe(t0, k(1), k(2), Load{Surrogate: 1, Identified: true}, true, "unknown", th)
	for i := 0; i < 100; i++ {
		s.Observe(t0, k(1), k(2), Load{Surrogate: uint64(100 + i), Identified: true}, false, "unknown", th)
	}
	if r := s.Observe(t0, k(1), k(2), Load{Identified: true}, false, "unknown", th); r.Bucket != One {
		t.Fatalf("reads must not count: %+v", r)
	}
	// A read of a missing cell does not create it.
	s.Observe(t0, k(9), k(10), Load{}, false, "unknown", th)
	if s.Len() != 2 {
		t.Fatalf("cells %d", s.Len())
	}
}

func TestSlidingWindow(t *testing.T) {
	s := New()
	for i := 0; i < 10; i++ {
		s.Observe(t0, k(1), k(2), Load{Surrogate: uint64(i), Identified: true}, true, "unknown", th)
	}
	// 6 minutes later: previous half still counts.
	if r := s.Observe(t0.Add(6*time.Minute), k(1), k(2), Load{Identified: true}, false, "unknown", th); r.Bucket != High {
		t.Fatalf("within 10 min: %+v", r)
	}
	// 11 minutes later: both halves rolled out.
	if r := s.Observe(t0.Add(11*time.Minute), k(1), k(2), Load{Identified: true}, false, "unknown", th); r.Bucket != One {
		t.Fatalf("after 10 min: %+v", r)
	}
}

func TestIdleEvictionAndReset(t *testing.T) {
	s := New()
	s.Observe(t0, k(1), k(2), Load{Surrogate: 1, Identified: true}, true, "unknown", th)
	s.Sweep(t0.Add(21 * time.Minute))
	if s.Len() != 0 {
		t.Fatal("idle cells must be evicted")
	}
	s.Observe(t0, k(1), k(2), Load{Surrogate: 1, Identified: true}, true, "unknown", th)
	s.Reset("2026-11-13")
	if s.Len() != 0 {
		t.Fatal("reset at K_mult rotation must drop every cell")
	}
}

func TestCapEvictsLRU(t *testing.T) {
	s := New()
	for i := 0; i < MaxCells/2+10; i++ {
		s.Observe(t0, k(2*i), k(2*i+1), Load{Identified: true, Surrogate: 1}, true, "unknown", th)
	}
	if s.Len() != MaxCells {
		t.Fatalf("cells %d, cap %d", s.Len(), MaxCells)
	}
	if s.Evicted() != 20 {
		t.Fatalf("evicted %d", s.Evicted())
	}
}

func TestHLLAccuracy(t *testing.T) {
	var a, b sketch
	for i := 0; i < 5000; i++ {
		a.add(uint64(i) * 0x9e3779b97f4a7c15)
	}
	for i := 2500; i < 7500; i++ {
		b.add(uint64(i) * 0x9e3779b97f4a7c15)
	}
	est := union(&a, &b)
	if math.Abs(est-7500)/7500 > 0.1 {
		t.Fatalf("HLL union estimate %f for 7500", est)
	}
	var c, d sketch
	for i := 0; i < 20; i++ {
		c.add(uint64(i))
		d.add(uint64(i + 10))
	}
	if union(&c, &d) != 30 {
		t.Fatal("exact union")
	}
}

// C-124 (F19): `unknown` uses the larger of its own and the eyeball_mobile threshold; other classes keep theirs;
// classes without an entry fall back to that unknown figure.
func TestThresholdUnknownLikeMobile(t *testing.T) {
	def := Thresholds{ // the platform defaults (db/migrations/0006_settings.sql)
		"exact_ip": {"datacenter": 3, "vpn": 4, "tor": 3, "eyeball_fixed": 6, "eyeball_mobile": 40, "unknown": 6},
		"subnet":   {"datacenter": 6, "vpn": 8, "tor": 6, "eyeball_fixed": 24, "eyeball_mobile": 160, "unknown": 24},
	}
	for _, c := range []struct {
		kind, class string
		want        int
	}{
		{"exact_ip", "unknown", 40}, {"subnet", "unknown", 160}, {"exact_ip", "eyeball_fixed", 6}, {"exact_ip", "datacenter", 3},
		{"subnet", "vpn", 8}, {"exact_ip", "relay", 40},
	} {
		if got := Threshold(def, c.kind, c.class); got != c.want {
			t.Errorf("Threshold(%s,%s) = %d, want %d", c.kind, c.class, got, c.want)
		}
	}
	// An operator may still set unknown above mobile.
	if got := Threshold(Thresholds{"exact_ip": {"unknown": 90, "eyeball_mobile": 40}}, "exact_ip", "unknown"); got != 90 {
		t.Fatalf("unknown above mobile: %d", got)
	}
	// Carrier-NAT audience: 30 distinct engaged-looking-but-unactivated visitors behind one unclassified address
	// stay below `high` with the defaults (they were `high` + multiplicity_high under the old exact_ip/unknown = 6).
	s := New()
	var r Result
	for i := 0; i < 30; i++ {
		r = s.Observe(t0, k(1), k(2), Load{Surrogate: uint64(i), Identified: true, ProofOK: true, Standard: true, ZeroActivation: true}, true, "unknown", def)
	}
	if r.Bucket == High || r.High {
		t.Fatalf("30 visitors behind one CGNAT address: %+v", r)
	}
}
