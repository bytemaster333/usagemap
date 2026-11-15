// SPDX-License-Identifier: Apache-2.0

package spool

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func ev(url string, recv int64) *EventRecord {
	w := "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
	return &EventRecord{RecordID: "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12", ReceivedAtMs: recv, TenantID: "t", SiteID: "s", Target: "main",
		UmamiWebsiteID: &w, Tag: "v", Surrogate: "2001:db8::1", Country: "XX", UA: "ua", Hostname: "example.org", URL: url, Kind: "pageview"}
}

func open(t *testing.T, dir string, mod ...func(*Options)) *Spool {
	t.Helper()
	o := Options{Dir: dir, Node: "edge-a1"}
	for _, m := range mod {
		m(&o)
	}
	s, err := Open(o)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAppendReadAckAccounting(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	defer s.Close()
	now := time.Now().UnixMilli()
	if err := s.Append(context.Background(), []Record{ev("/a", now), ev("/b", now)}); err != nil {
		t.Fatal(err)
	}
	if err := s.Append(context.Background(), []Record{&CounterRecord{RecordID: "x", PeriodEndMs: now}}); err != nil {
		t.Fatal(err)
	}
	p := s.PendingAfter(Start, 10)
	if len(p) != 3 || !p[0].Event || p[2].Event {
		t.Fatalf("pending %+v", p)
	}
	b, err := s.Read(p[1].Pos)
	if err != nil {
		t.Fatal(err)
	}
	var rec EventRecord
	_ = json.Unmarshal(b, &rec)
	if rec.URL != "/b" || rec.NodeID != "edge-a1" || rec.Segment != p[1].Pos.Seg || rec.Offset == 0 || rec.RV != 1 || rec.Type != "event" {
		t.Fatalf("record %+v", rec)
	}
	// offset is the frame's byte offset in the segment
	raw, _ := os.ReadFile(filepath.Join(dir, segName(rec.Segment)))
	if int(rec.Offset)+8 > len(raw) || string(raw[rec.Offset+8:rec.Offset+8+4]) != `{"rv` {
		t.Fatal("offset does not point at the frame")
	}
	if err := s.Ack(p[0].Pos, OutStored); err != nil {
		t.Fatal(err)
	}
	if err := s.Ack(p[0].Pos, OutStored); err != nil { // idempotent
		t.Fatal(err)
	}
	if err := s.Ack(p[2].Pos, OutCounter); err != nil {
		t.Fatal(err)
	}
	d := s.TakeAccounting()
	if d.Fsynced != 2 || d.AckedStored != 1 || d.Queued != 1 {
		t.Fatalf("accounting %+v", d)
	}
	if d.Fsynced != d.AckedStored+d.AckedEngineBot+d.AckedEngineRejected+d.Expired72h+d.Queued {
		t.Fatal("invariant broken")
	}
	if _, err := s.Read(p[0].Pos); !errors.Is(err, ErrGone) {
		t.Fatal("acked record still readable")
	}
	if d2 := s.TakeAccounting(); d2.Fsynced != 0 || d2.AckedStored != 0 || d2.Queued != 1 {
		t.Fatalf("second take %+v", d2)
	}
	s.Restore(d)
	if d3 := s.TakeAccounting(); d3.Fsynced != 2 {
		t.Fatal("restore")
	}
}

func TestRecoveryKeepsUnacked(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	now := time.Now().UnixMilli()
	for i := 0; i < 5; i++ {
		if err := s.Append(context.Background(), []Record{ev("/p", now)}); err != nil {
			t.Fatal(err)
		}
	}
	p := s.PendingAfter(Start, 10)
	_ = s.Ack(p[1].Pos, OutStored)
	_ = s.Ack(p[3].Pos, OutEngineBot)
	s.Close()
	s2 := open(t, dir)
	defer s2.Close()
	q := s2.PendingAfter(Start, 10)
	if len(q) != 3 || q[0].Pos != p[0].Pos || q[1].Pos != p[2].Pos || q[2].Pos != p[4].Pos {
		t.Fatalf("pending after restart %+v (before %+v)", q, p)
	}
	if st := s2.Stats(); st.Queued != 3 {
		t.Fatalf("queued gauge recomputed from segment files: %d", st.Queued)
	}
	// New records go to a new segment.
	_ = s2.Append(context.Background(), []Record{ev("/new", now)})
	r := s2.PendingAfter(Start, 10)
	if r[3].Pos.Seg <= p[4].Pos.Seg {
		t.Fatal("new records must go to a new segment")
	}
}

func TestTornTailTruncated(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	now := time.Now().UnixMilli()
	_ = s.Append(context.Background(), []Record{ev("/ok", now)})
	seg := s.PendingAfter(Start, 1)[0].Pos.Seg
	s.Close()
	path := filepath.Join(dir, segName(seg))
	f, _ := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	_, _ = f.Write([]byte{50, 0, 0, 0, 1, 2, 3, 4, '{', '"'}) // a frame that never completed
	f.Close()
	before, _ := os.Stat(path)
	s2 := open(t, dir)
	defer s2.Close()
	after, _ := os.Stat(path)
	if after.Size() >= before.Size() || len(s2.PendingAfter(Start, 10)) != 1 || s2.Stats().Corrupt != 1 {
		t.Fatalf("torn tail not truncated: %d → %d", before.Size(), after.Size())
	}
}

func TestFsyncFailureIsNotAcknowledged(t *testing.T) {
	dir := t.TempDir()
	var fail atomic.Bool
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	s := open(t, dir, func(o *Options) {
		o.Sync = func(f *os.File) error {
			if fail.Load() {
				return errors.New("EIO")
			}
			return f.Sync()
		}
		o.Now = func() time.Time { return time.UnixMilli(clock.Load()) }
	})
	defer s.Close()
	fail.Store(true)
	if err := s.Append(context.Background(), []Record{ev("/x", clock.Load())}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
	if s.Durable() || len(s.PendingAfter(Start, 10)) != 0 || s.TakeAccounting().Fsynced != 0 {
		t.Fatal("a record whose fsync failed must not exist")
	}
	fail.Store(false)
	if err := s.Append(context.Background(), []Record{ev("/y", clock.Load())}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("must refuse during the back-off")
	}
	clock.Add(6000)
	if err := s.Append(context.Background(), []Record{ev("/y", clock.Load())}); err != nil || !s.Durable() {
		t.Fatalf("recovery after back-off: %v", err)
	}
}

func TestSealDeleteAndExpire(t *testing.T) {
	dir := t.TempDir()
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC).UnixMilli())
	s := open(t, dir, func(o *Options) {
		o.SegmentMaxBytes = 600
		o.Now = func() time.Time { return time.UnixMilli(clock.Load()) }
	})
	defer s.Close()
	for i := 0; i < 6; i++ {
		_ = s.Append(context.Background(), []Record{ev("/p", clock.Load())})
	}
	if st := s.Stats(); st.Segments < 3 {
		t.Fatalf("segments not sealed by size: %d", st.Segments)
	}
	p := s.PendingAfter(Start, 100)
	first := p[0].Pos.Seg
	for _, x := range p {
		if x.Pos.Seg == first {
			_ = s.Ack(x.Pos, OutStored)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, segName(first))); !os.IsNotExist(err) {
		t.Fatal("fully acknowledged sealed segment not deleted")
	}
	// 72-hour rule.
	clock.Add((72*time.Hour + time.Minute).Milliseconds())
	seen := 0
	n := s.ExpireOld(func([]byte) { seen++ })
	d := s.TakeAccounting()
	if n == 0 || seen != n || d.Expired72h != int64(n) || d.Queued != 0 || len(s.PendingAfter(Start, 100)) != 0 {
		t.Fatalf("expiry: n=%d %+v", n, d)
	}
	if d.Fsynced != d.AckedStored+d.Expired72h+d.Queued {
		t.Fatalf("invariant %+v", d)
	}
}

func TestGroupCommitConcurrent(t *testing.T) {
	dir := t.TempDir()
	var syncs atomic.Int64
	s := open(t, dir, func(o *Options) {
		o.Sync = func(f *os.File) error { syncs.Add(1); return f.Sync() }
	})
	defer s.Close()
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Append(context.Background(), []Record{ev("/c", time.Now().UnixMilli())}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if n := len(s.PendingAfter(Start, 1000)); n != 200 {
		t.Fatalf("records %d", n)
	}
	if syncs.Load() >= 200 {
		t.Logf("no grouping observed (%d fsyncs)", syncs.Load())
	}
}

func TestMaxBytes(t *testing.T) {
	s := open(t, t.TempDir(), func(o *Options) { o.MaxBytes = 500 })
	defer s.Close()
	var err error
	for i := 0; i < 10 && err == nil; i++ {
		err = s.Append(context.Background(), []Record{ev("/p", time.Now().UnixMilli())})
	}
	if !errors.Is(err, ErrFull) {
		t.Fatalf("expected ErrFull, got %v", err)
	}
}
