// SPDX-License-Identifier: Apache-2.0

package spool

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Regression tests for the hardening of the spool.

// sealedSegment writes n event records into one segment, seals it (a newer segment exists) and returns the segment's
// path, its pending positions and the spool directory.
func sealedSegment(t *testing.T, n int) (string, []Pending, string) {
	t.Helper()
	dir := t.TempDir()
	s := open(t, dir)
	now := time.Now().UnixMilli()
	for i := 0; i < n; i++ {
		if err := s.Append(context.Background(), []Record{ev("/p", now)}); err != nil {
			t.Fatal(err)
		}
	}
	p := s.PendingAfter(Start, 100)
	s.mu.Lock()
	_ = s.newActive() // seal
	s.mu.Unlock()
	_ = s.Append(context.Background(), []Record{ev("/newer", now)})
	s.Close()
	return filepath.Join(dir, segName(p[0].Pos.Seg)), p, dir
}

// One flipped payload byte in a sealed segment loses exactly that frame; every later fsync'd record
// survives, the file is not truncated, and acknowledgements stay aligned.
func TestCorruptFrameInSealedSegmentLosesOnlyThatFrame(t *testing.T) {
	path, p, dir := sealedSegment(t, 5)
	s := open(t, dir)
	_ = s.Ack(p[2].Pos, OutStored)
	_ = s.Ack(p[3].Pos, OutStored)
	s.Close()
	raw, _ := os.ReadFile(path)
	raw[8+20] ^= 0xff // inside frame 0's payload
	_ = os.WriteFile(path, raw, 0o600)
	before := len(raw)

	s2 := open(t, dir)
	defer s2.Close()
	after, _ := os.Stat(path)
	if after.Size() != int64(before) {
		t.Fatalf("sealed segment truncated: %d → %d", before, after.Size())
	}
	var got []Position
	for _, q := range s2.PendingAfter(Start, 100) {
		if q.Pos.Seg == p[0].Pos.Seg {
			got = append(got, q.Pos)
		}
	}
	if len(got) != 2 || got[0] != p[1].Pos || got[1] != p[4].Pos {
		t.Fatalf("pending in the sealed segment %v, want %v and %v (acks aligned)", got, p[1].Pos, p[4].Pos)
	}
	if st := s2.Stats(); st.Corrupt != 1 || st.CorruptBytes == 0 {
		t.Fatalf("corrupt %d bytes %d", st.Corrupt, st.CorruptBytes)
	}
	// The placeholder is never readable or sent.
	if _, err := s2.Read(p[0].Pos); !errors.Is(err, ErrGone) {
		t.Fatalf("placeholder readable: %v", err)
	}
}

// A corrupt length field is skipped to the next valid frame; nothing after it is lost.
func TestCorruptLengthResyncs(t *testing.T) {
	path, p, dir := sealedSegment(t, 5)
	raw, _ := os.ReadFile(path)
	binary.LittleEndian.PutUint32(raw[0:4], 0xfffffff0)
	_ = os.WriteFile(path, raw, 0o600)
	s := open(t, dir)
	defer s.Close()
	n := 0
	for _, q := range s.PendingAfter(Start, 100) {
		if q.Pos.Seg == p[0].Pos.Seg {
			if _, err := s.Read(q.Pos); err != nil {
				t.Fatalf("record after resync unreadable: %v", err)
			}
			n++
		}
	}
	if n != 4 || s.Stats().Corrupt != 1 {
		t.Fatalf("records after a corrupt length: %d (corrupt %d)", n, s.Stats().Corrupt)
	}
}

// In the newest segment, a corrupt frame followed by valid frames is corruption, not a torn tail.
func TestCorruptFrameInNewestSegmentKeepsLaterRecords(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	now := time.Now().UnixMilli()
	for i := 0; i < 4; i++ {
		_ = s.Append(context.Background(), []Record{ev("/p", now)})
	}
	p := s.PendingAfter(Start, 10)
	s.Close()
	path := filepath.Join(dir, segName(p[0].Pos.Seg))
	raw, _ := os.ReadFile(path)
	raw[8+20] ^= 0xff
	_ = os.WriteFile(path, raw, 0o600)
	s2 := open(t, dir)
	defer s2.Close()
	if q := s2.PendingAfter(Start, 10); len(q) != 3 || q[0].Pos != p[1].Pos {
		t.Fatalf("pending %v", q)
	}
}

// An ack whose fsync fails is reported as failed and rolled back: the record stays pending, nothing is
// counted, and the segment is not deleted.
func TestAckFsyncFailureRollsBack(t *testing.T) {
	var failAck atomic.Bool
	s := open(t, t.TempDir(), func(o *Options) {
		o.Sync = func(f *os.File) error {
			if failAck.Load() && strings.HasSuffix(f.Name(), ".ack") {
				return errors.New("EIO")
			}
			return f.Sync()
		}
	})
	defer s.Close()
	now := time.Now().UnixMilli()
	_ = s.Append(context.Background(), []Record{ev("/a", now)})
	p := s.PendingAfter(Start, 10)
	failAck.Store(true)
	if err := s.Ack(p[0].Pos, OutStored); err == nil {
		t.Fatal("ack with failed fsync reported success")
	}
	st := s.Stats()
	if st.Queued != 1 || st.Pending != 1 || st.Totals.AckedStored != 0 || len(s.PendingAfter(Start, 10)) != 1 {
		t.Fatalf("not rolled back: %+v", st)
	}
	failAck.Store(false)
	if err := s.Ack(p[0].Pos, OutStored); err != nil {
		t.Fatal(err)
	}
	if st := s.Stats(); st.Queued != 0 || st.Pending != 0 || st.Totals.AckedStored != 1 {
		t.Fatalf("after retry: %+v", st)
	}
}

// Stats is maintained incrementally (pending count, oldest pending receipt time), also across restarts.
func TestStatsIncremental(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, func(o *Options) { o.SegmentMaxBytes = 2000 })
	base := time.Now().UnixMilli()
	for i := 0; i < 20; i++ {
		_ = s.Append(context.Background(), []Record{ev("/p", base+int64(i))})
	}
	_ = s.Append(context.Background(), []Record{&CounterRecord{RecordID: "c", PeriodEndMs: base + 100}})
	p := s.PendingAfter(Start, 100)
	for i := 0; i < 7; i++ {
		_ = s.Ack(p[i].Pos, OutStored)
	}
	st := s.Stats()
	if st.Pending != 14 || st.Queued != 13 || st.OldestMs != base+7 || st.Segments < 2 {
		t.Fatalf("stats %+v", st)
	}
	s.Close()
	s2 := open(t, dir)
	defer s2.Close()
	if st2 := s2.Stats(); st2.Pending != 14 || st2.Queued != 13 || st2.OldestMs != base+7 {
		t.Fatalf("stats after restart %+v", st2)
	}
}

// A record the writer fsync'd is never answered with an error, however Close races with Append.
func TestCloseNeverFailsADurableAppend(t *testing.T) {
	for round := 0; round < 30; round++ {
		dir := t.TempDir()
		s := open(t, dir)
		var ok atomic.Int64
		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 20; j++ {
					if err := s.Append(context.Background(), []Record{ev("/r", time.Now().UnixMilli())}); err == nil {
						ok.Add(1)
					}
				}
			}()
		}
		time.Sleep(time.Duration(round%5) * time.Millisecond)
		s.Close()
		wg.Wait()
		s2 := open(t, dir)
		n := len(s2.PendingAfter(Start, 1000))
		s2.Close()
		if int64(n) != ok.Load() {
			t.Fatalf("round %d: %d records durable, %d appends answered success", round, n, ok.Load())
		}
	}
}

// One site cannot take more than its share of the spool; other sites keep being accepted, and the site
// is accepted again once its records are delivered.
func TestPerSiteSpoolShare(t *testing.T) {
	s := open(t, t.TempDir(), func(o *Options) { o.SiteShare = 2000 })
	defer s.Close()
	now := time.Now().UnixMilli()
	site := func(id string) *EventRecord { r := ev("/p", now); r.SiteID = id; return r }
	var err error
	n := 0
	for ; n < 100; n++ {
		if err = s.Append(context.Background(), []Record{site("flood")}); err != nil {
			break
		}
	}
	if !errors.Is(err, ErrSiteFull) || n == 0 {
		t.Fatalf("flooding site: %d accepted, err %v", n, err)
	}
	if err := s.Append(context.Background(), []Record{site("quiet")}); err != nil {
		t.Fatalf("another site refused: %v", err)
	}
	for _, q := range s.PendingAfter(Start, 1000) {
		_ = s.Ack(q.Pos, OutStored)
	}
	if err := s.Append(context.Background(), []Record{site("flood")}); err != nil {
		t.Fatalf("after delivery: %v", err)
	}
}

// A commit barrier fails like a data commit when the spool is not durable, and takes about as long as a
// data commit.
func TestCommitBarrier(t *testing.T) {
	var slow, fail atomic.Bool
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	s := open(t, t.TempDir(), func(o *Options) {
		o.Sync = func(f *os.File) error {
			if fail.Load() {
				return errors.New("EIO")
			}
			if slow.Load() {
				time.Sleep(40 * time.Millisecond)
			}
			return f.Sync()
		}
		o.Now = func() time.Time { return time.UnixMilli(clock.Load()) }
	})
	defer s.Close()
	slow.Store(true)
	for i := 0; i < 3; i++ {
		_ = s.Append(context.Background(), []Record{ev("/d", clock.Load())})
	}
	slow.Store(false) // the barrier's own fsync is fast; the delay must come from the padding
	start := time.Now()
	if err := s.Append(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took < 30*time.Millisecond {
		t.Fatalf("barrier answered in %v; a data commit takes ~40ms", took)
	}
	fail.Store(true)
	if err := s.Append(context.Background(), nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("barrier on a failing spool: %v", err)
	}
	fail.Store(false)
	if err := s.Append(context.Background(), nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("barrier during the back-off: %v", err)
	}
}
