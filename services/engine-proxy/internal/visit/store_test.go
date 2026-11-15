// SPDX-License-Identifier: Apache-2.0

package visit

import (
	"fmt"
	"testing"
	"time"
)

const (
	siteA = "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
	siteB = "6a1d2d3f-9b8c-4a9f-8e66-2d8f1e0c3b52"
	surr1 = "2001:db8:5c1f:9a2e:77d0:13ab:e4c2:b9f"
	surr2 = "2001:db8::77"
)

// fakeClock is a controllable wall clock.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestStore(t *testing.T, max int) (*Store, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	s := New(Config{MaxEntries: max, Now: clk.now})
	return s, clk
}

// ts returns Unix seconds for hh:mm on the test day.
func ts(hh, mm int) int64 {
	return time.Date(2026, 11, 12, hh, mm, 0, 0, time.UTC).Unix()
}

func mustLookup(t *testing.T, s *Store, site, sur string, at int64, wantTok string, wantRes Result) {
	t.Helper()
	tok, res := s.Lookup(site, sur, at)
	if tok != wantTok || res != wantRes {
		t.Fatalf("Lookup(%s,%s,%d) = (%q,%v), want (%q,%v)", site, sur, at, tok, res, wantTok, wantRes)
	}
}

func TestFirstEventHasNoToken(t *testing.T) {
	s, _ := newTestStore(t, 10)
	mustLookup(t, s, siteA, surr1, ts(10, 55), "", Miss)
}

func TestReplayWithinThirtyMinutesAcrossClockHour(t *testing.T) {
	s, _ := newTestStore(t, 10)
	s.Store(siteA, surr1, "tok1", ts(10, 55))
	// 11:05 is in another clock hour but 10 minutes later: the token is replayed (one visit).
	mustLookup(t, s, siteA, surr1, ts(11, 5), "tok1", Hit)
}

func TestExactlyThirtyMinutesIsReplayedThirtyOneIsNot(t *testing.T) {
	s, _ := newTestStore(t, 10)
	s.Store(siteA, surr1, "tok1", ts(10, 0))
	mustLookup(t, s, siteA, surr1, ts(10, 30), "tok1", Hit) // |Δ| = 1800 s
	mustLookup(t, s, siteA, surr1, ts(10, 30)+1, "", RefusedWindow)
	mustLookup(t, s, siteA, surr1, ts(10, 31), "", RefusedWindow)
}

func TestNewVisitTokenIsStoredAfterGap(t *testing.T) {
	s, _ := newTestStore(t, 10)
	s.Store(siteA, surr1, "tok1", ts(10, 0))
	mustLookup(t, s, siteA, surr1, ts(10, 31), "", RefusedWindow)
	// Umami starts a new visit and returns a new cache token: always stored (C-112(9)).
	if r := s.Store(siteA, surr1, "tok2", ts(10, 31)); r != Stored {
		t.Fatalf("store after gap = %v, want Stored", r)
	}
	mustLookup(t, s, siteA, surr1, ts(10, 40), "tok2", Hit)
}

func TestLastEventIsMaxOfPreviousAndEvent(t *testing.T) {
	s, _ := newTestStore(t, 10)
	s.Store(siteA, surr1, "tok1", ts(11, 20))
	// A slightly older backlog event (inside the window) is replayed and does not move last_event_ts backwards.
	mustLookup(t, s, siteA, surr1, ts(11, 0), "tok1", Hit)
	s.Store(siteA, surr1, "tok1", ts(11, 0))
	if got := s.lastEvent(siteA, surr1); got != ts(11, 20) {
		t.Fatalf("last_event_ts = %d, want %d (max)", got, ts(11, 20))
	}
	// 11:49 is 29 min after 11:20 (the max), so still the same visit; had last moved to 11:00 it would be 49 min.
	mustLookup(t, s, siteA, surr1, ts(11, 49), "tok1", Hit)
}

func TestOutOfOrderBacklogKeepsOneVisit(t *testing.T) {
	// S-01 case B': 11:20 arrives first, then 10:50 with that token -> one visit. |Δ| = 30 min.
	s, _ := newTestStore(t, 10)
	mustLookup(t, s, siteA, surr1, ts(11, 20), "", Miss)
	s.Store(siteA, surr1, "tokV", ts(11, 20))
	mustLookup(t, s, siteA, surr1, ts(10, 50), "tokV", Hit)
	s.Store(siteA, surr1, "tokV", ts(10, 50))
	mustLookup(t, s, siteA, surr1, ts(11, 45), "tokV", Hit)
}

func TestOldBacklogOutsideWindowDoesNotHijackCurrentVisit(t *testing.T) {
	// A long-delayed event (08:00) arrives while a live visit is at 12:00. It gets no token (new hour-bucket visit
	// in Umami). The token Umami returns for that old visit must not replace the live visit's token, otherwise the
	// next live event (12:10) would be merged into the 08:00 visit (a refinement of the wire contract).
	s, _ := newTestStore(t, 10)
	s.Store(siteA, surr1, "tokLive", ts(12, 0))
	mustLookup(t, s, siteA, surr1, ts(8, 0), "", RefusedWindow)
	if r := s.Store(siteA, surr1, "tokOld", ts(8, 0)); r != SkippedBacklog {
		t.Fatalf("store of old backlog = %v, want SkippedBacklog", r)
	}
	mustLookup(t, s, siteA, surr1, ts(12, 10), "tokLive", Hit)
}

func TestKeysAreSeparatedBySiteAndSurrogate(t *testing.T) {
	s, _ := newTestStore(t, 10)
	s.Store(siteA, surr1, "a1", ts(10, 0))
	mustLookup(t, s, siteB, surr1, ts(10, 1), "", Miss)
	mustLookup(t, s, siteA, surr2, ts(10, 1), "", Miss)
	mustLookup(t, s, siteA, surr1, ts(10, 1), "a1", Hit)
}

func TestSurrogateSpellingsAreTheSameKey(t *testing.T) {
	s, _ := newTestStore(t, 10)
	s.Store(siteA, "2001:0db8:0000:0000:0000:0000:0000:0077", "a1", ts(10, 0))
	mustLookup(t, s, siteA, "2001:db8::77", ts(10, 1), "a1", Hit)
	mustLookup(t, s, "5F0C1C2E-8A7B-4F8E-9D55-1C7E0D9B2A41", "2001:db8::77", ts(10, 1), "a1", Hit)
}

func TestPurgeWebsiteDropsTokensAndRemembersFor72Hours(t *testing.T) {
	s, clk := newTestStore(t, 10)
	s.Store(siteA, surr1, "a1", ts(10, 0))
	s.Store(siteA, surr2, "a2", ts(10, 0))
	s.Store(siteB, surr1, "b1", ts(10, 0))
	if n := s.PurgeWebsite(siteA); n != 2 {
		t.Fatalf("purged %d entries, want 2", n)
	}
	mustLookup(t, s, siteA, surr1, ts(10, 1), "", Deleted)
	mustLookup(t, s, siteB, surr1, ts(10, 1), "b1", Hit)
	// A late answer for the deleted website must not re-create an entry.
	if r := s.Store(siteA, surr1, "a3", ts(10, 2)); r != SkippedDeleted {
		t.Fatalf("store for deleted website = %v, want SkippedDeleted", r)
	}
	clk.advance(71 * time.Hour)
	if !s.IsDeleted(siteA) {
		t.Fatal("website forgotten before 72 h")
	}
	clk.advance(time.Hour + time.Second)
	if s.IsDeleted(siteA) {
		t.Fatal("website still remembered after 72 h")
	}
}

func TestIdleTTLIsAMemoryBoundOnly(t *testing.T) {
	s, clk := newTestStore(t, 10)
	s.Store(siteA, surr1, "a1", ts(10, 0))
	clk.advance(29 * time.Minute)
	mustLookup(t, s, siteA, surr1, ts(10, 1), "a1", Hit) // lookup touches the entry
	clk.advance(30*time.Minute + time.Second)
	mustLookup(t, s, siteA, surr1, ts(10, 2), "", Miss)
	if st := s.Stats(); st.Expired != 1 || st.Size != 0 {
		t.Fatalf("stats after expiry = %+v", st)
	}
}

func TestSweepRemovesIdleEntries(t *testing.T) {
	s, clk := newTestStore(t, 10)
	s.Store(siteA, surr1, "a1", ts(10, 0))
	clk.advance(10 * time.Minute)
	s.Store(siteA, surr2, "a2", ts(10, 10))
	clk.advance(21 * time.Minute) // first entry idle 31 min, second 21 min
	if n := s.Sweep(); n != 1 {
		t.Fatalf("swept %d, want 1", n)
	}
	if st := s.Stats(); st.Size != 1 {
		t.Fatalf("size = %d, want 1", st.Size)
	}
}

func TestLRUEvictionAtCapacity(t *testing.T) {
	s, _ := newTestStore(t, 3)
	for i := range 3 {
		s.Store(siteA, fmt.Sprintf("2001:db8::%d", i+1), fmt.Sprintf("t%d", i+1), ts(10, 0))
	}
	// Touch ::1 so that ::2 is the least recently used.
	mustLookup(t, s, siteA, "2001:db8::1", ts(10, 1), "t1", Hit)
	s.Store(siteA, "2001:db8::4", "t4", ts(10, 1))
	mustLookup(t, s, siteA, "2001:db8::2", ts(10, 1), "", Miss)
	mustLookup(t, s, siteA, "2001:db8::1", ts(10, 1), "t1", Hit)
	st := s.Stats()
	if st.Size != 3 || st.Evictions != 1 {
		t.Fatalf("stats = %+v, want size 3, evictions 1", st)
	}
}

func TestEmptiedAtMidnightUTC(t *testing.T) {
	s, clk := newTestStore(t, 10)
	clk.t = time.Date(2026, 11, 12, 23, 50, 0, 0, time.UTC)
	s.Store(siteA, surr1, "a1", ts(23, 50))
	s.PurgeWebsite(siteB)
	clk.t = time.Date(2026, 11, 13, 0, 0, 1, 0, time.UTC)
	mustLookup(t, s, siteA, surr1, ts(23, 55), "", Miss)
	if st := s.Stats(); st.DailyResets != 1 || st.Size != 0 {
		t.Fatalf("stats = %+v", st)
	}
	if !s.IsDeleted(siteB) {
		t.Fatal("deleted-website list must survive the daily reset (72 h)")
	}
}

func TestRejectsUnusableTokens(t *testing.T) {
	s, _ := newTestStore(t, 10)
	if r := s.Store(siteA, surr1, "", ts(10, 0)); r != Rejected {
		t.Fatalf("empty token = %v", r)
	}
	long := make([]byte, MaxTokenBytes+1)
	for i := range long {
		long[i] = 'a'
	}
	if r := s.Store(siteA, surr1, string(long), ts(10, 0)); r != Rejected {
		t.Fatalf("oversized token = %v", r)
	}
	if r := s.Store(siteA, "not-an-ip", "x", ts(10, 0)); r != Rejected {
		t.Fatalf("bad surrogate = %v", r)
	}
	if st := s.Stats(); st.Size != 0 {
		t.Fatalf("size = %d", st.Size)
	}
}

func TestStatsCounters(t *testing.T) {
	s, _ := newTestStore(t, 10)
	s.Lookup(siteA, surr1, ts(10, 0))
	s.Store(siteA, surr1, "a1", ts(10, 0))
	s.Lookup(siteA, surr1, ts(10, 10))
	s.Lookup(siteA, surr1, ts(11, 0))
	s.PurgeWebsite(siteA)
	s.Lookup(siteA, surr1, ts(11, 1))
	st := s.Stats()
	want := Stats{Size: 0, Hits: 1, Misses: 1, Stored: 1, RefusedWindow: 1, DeletedLookups: 1, Purges: 1, PurgedEntries: 1, DeletedWebsites: 1}
	if st != want {
		t.Fatalf("stats = %+v\nwant    %+v", st, want)
	}
}
