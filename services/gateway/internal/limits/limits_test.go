// SPDX-License-Identifier: Apache-2.0

package limits

import (
	"strconv"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

func TestWindow(t *testing.T) {
	w := NewWindow()
	for i := 0; i < 10; i++ {
		if ok, _ := w.Allow("s", 10, t0.Add(time.Duration(i)*time.Second)); !ok {
			t.Fatalf("request %d refused", i)
		}
	}
	ok, retry := w.Allow("s", 10, t0.Add(11*time.Second))
	if ok || retry < 1 || retry > 60 {
		t.Fatalf("11th request: ok=%v retry=%d", ok, retry)
	}
	if ok, _ := w.Allow("other", 10, t0.Add(11*time.Second)); !ok {
		t.Fatal("keys are independent")
	}
	// Two minutes later the window is empty.
	if ok, _ := w.Allow("s", 10, t0.Add(2*time.Minute+time.Second)); !ok {
		t.Fatal("window did not slide")
	}
}

func TestShare(t *testing.T) {
	if Share(6000, 4) != 1500 || Share(5, 4) != 2 || Share(1, 8) != 1 || Share(10, 0) != 10 {
		t.Fatal("share")
	}
}

func TestQuota(t *testing.T) {
	q := NewQuota()
	q.Add("t", 9, t0)
	if q.Over("t", 1, 10, t0) || !q.Over("t", 2, 10, t0) {
		t.Fatal("quota boundary")
	}
	if q.Over("t", 2, 10, t0.Add(24*time.Hour)) {
		t.Fatal("quota resets at 00:00 UTC")
	}
	if SecondsToMidnight(time.Date(2026, 11, 12, 23, 59, 30, 0, time.UTC)) != 30 || SecondsToMidnight(t0) != 3600 {
		t.Fatal("Retry-After for quota")
	}
}

func TestTTLSet(t *testing.T) {
	s := NewTTLSet(10*time.Minute, 3)
	s.Add("a", t0)
	if !s.Seen("a", t0.Add(9*time.Minute)) || s.Seen("a", t0.Add(11*time.Minute)) {
		t.Fatal("ttl")
	}
	for i := 0; i < 5; i++ {
		s.Add(strconv.Itoa(i), t0)
	}
	if s.Len() > 3 {
		t.Fatal("cap")
	}
	b, a := s.Incr("n", 1, t0)
	if b != 0 || a != 1 {
		t.Fatal("first incr")
	}
	b, a = s.Incr("n", 5, t0)
	if b != 1 || a != 6 {
		t.Fatal("second incr")
	}
}

func TestRateAnomaly(t *testing.T) {
	r := NewRateHistory()
	// Two days of 10 events per 10 minutes.
	for i := 0; i < 2*24*6; i++ {
		if r.Add("s", 10, t0.Add(time.Duration(i)*10*time.Minute)) {
			t.Fatal("steady traffic flagged")
		}
	}
	now := t0.Add(2 * 24 * time.Hour)
	fired := false
	for i := 0; i < 150; i++ {
		fired = r.Add("s", 1, now.Add(time.Duration(i)*time.Second))
	}
	if !fired {
		t.Fatal("150 events in 10 minutes against a p99 of 10 not flagged")
	}
	fresh := NewRateHistory()
	if fresh.Add("x", 100000, t0) {
		t.Fatal("must not fire without a day of history")
	}
}

func TestDifficulty(t *testing.T) {
	d := NewDifficulty()
	if d.Multiplier("k", t0) != 1 {
		t.Fatal("default 1")
	}
	for i := 0; i < 5; i++ {
		d.Trigger("k", 8, t0)
	}
	if d.Multiplier("k", t0) != 8 {
		t.Fatal("capped at 8")
	}
	if d.Multiplier("k", t0.Add(21*time.Minute)) != 2 {
		t.Fatalf("decay: %d", d.Multiplier("k", t0.Add(21*time.Minute)))
	}
	d.Trigger("j", 4, t0)
	d.Trigger("j", 4, t0)
	d.Trigger("j", 4, t0)
	if d.Multiplier("j", t0) != 4 {
		t.Fatal("pow_max_multiplier bound")
	}
}
