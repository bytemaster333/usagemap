// SPDX-License-Identifier: Apache-2.0

package cumul

import (
	"slices"
	"testing"
)

var bounds = []float64{0.1, 1}

func ex(start, t int64, buckets ...uint64) Snapshot {
	var n uint64
	for _, b := range buckets {
		n += b
	}
	return Snapshot{Start: start, Time: t, Count: n, Sum: float64(n) * 0.05, Bounds: bounds, Buckets: buckets}
}

const minute = int64(60e9)

// C-122: the first point of a stream is counted in full when its source was already delivering (a new route, the
// first 404 of a running process) or when the stream started within FreshWindow of the point (a fresh process);
// otherwise it only seeds.
func TestFirstPointSeedsOrCountsInFull(t *testing.T) {
	const now = 100_000 * minute
	// unseen source, long-running process (started 2 h before its first export to us) → seed only
	d, next, out := Step(nil, ex(now-120*minute, now, 3, 1, 0), false)
	if out != FirstSeed || d != nil || next.Count != 4 {
		t.Fatalf("long-running: %v %v %+v", out, d, next)
	}
	// unseen source, fresh process (brand-new service or restart without instance id) → counted in full
	d, next, out = Step(nil, ex(now-minute, now, 3, 1, 0), false)
	if out != FirstFull || d == nil || d.Count != 4 || !slices.Equal(d.Buckets, []uint64{3, 1, 0}) || next.Time != now {
		t.Fatalf("fresh: %v %+v %+v", out, d, next)
	}
	// the window is inclusive; one nanosecond more seeds
	if _, _, out = Step(nil, ex(now-FreshWindow, now, 1, 0, 0), false); out != FirstFull {
		t.Fatalf("at the window: %v", out)
	}
	if _, _, out = Step(nil, ex(now-FreshWindow-1, now, 1, 0, 0), false); out != FirstSeed {
		t.Fatalf("beyond the window: %v", out)
	}
	// known source: a new route of a process that has run for 30 days → everything in it is new to us
	d, _, out = Step(nil, ex(now-30*1440*minute, now, 0, 0, 1), true)
	if out != FirstFull || d.Count != 1 {
		t.Fatalf("new route on a known source: %v %+v", out, d)
	}
	// missing start time never counts in full
	if _, _, out = Step(nil, ex(0, now, 1, 0, 0), true); out != FirstSeed {
		t.Fatalf("start 0: %v", out)
	}
}

// The first 404 ever of a running process: its stream appears at the source's next export with the process start
// time; the source is known, so the 404 is counted, and the 200 stream continues by delta.
func TestFirst404OnKnownSourceIsCounted(t *testing.T) {
	const start, t1, t2 = 1 * minute, 500 * minute, 501 * minute
	_, ok200, out := Step(nil, ex(start, t1, 10, 0, 0), false) // first export of a long-running process: seeds
	if out != FirstSeed {
		t.Fatalf("seed %v", out)
	}
	d200, _, _ := Step(ok200, ex(start, t2, 12, 0, 0), true)
	d404, _, out := Step(nil, ex(start, t2, 1, 0, 0), true)
	if out != FirstFull || d200.Count != 2 || d404.Count != 1 {
		t.Fatalf("404 %v; deltas %d %d", out, d200.Count, d404.Count)
	}
}

// A queue replay of a stream's earlier point after its first (counted) point is stale and never counted twice.
func TestReplayAfterFirstFullPointIsStale(t *testing.T) {
	const start = 10 * minute
	d1, st, _ := Step(nil, ex(start, start+2*minute, 4, 0, 0), true)
	d2, st2, out := Step(st, ex(start, start+minute, 1, 0, 0), true)
	if d1.Count != 4 || out != Stale || d2 != nil || st2 != st {
		t.Fatalf("replay: %v %+v", out, d2)
	}
}

func TestDeltaAndStaleReplay(t *testing.T) {
	s1 := ex(100, 200, 1, 1, 0)
	_, st, _ := Step(nil, s1, false)
	d, st2, out := Step(st, ex(100, 300, 4, 2, 1), false)
	if out != Delta || d.Count != 5 || !slices.Equal(d.Buckets, []uint64{3, 1, 1}) {
		t.Fatalf("delta %v %+v", out, d)
	}
	// replay of the first point after the newer one: dropped, state unchanged
	d, st3, out := Step(st2, s1, false)
	if out != Stale || d != nil || st3 != st2 {
		t.Fatalf("stale %v %+v", out, d)
	}
	// same time again (byte-identical point in another request): stale
	if _, _, out = Step(st2, ex(100, 300, 4, 2, 1), false); out != Stale {
		t.Fatalf("same time: %v", out)
	}
	// idle stream: no delta, state advances
	d, st4, out := Step(st2, ex(100, 400, 4, 2, 1), false)
	if out != Delta || d != nil || st4.Time != 400 {
		t.Fatalf("idle %v %+v %+v", out, d, st4)
	}
}

func TestResetRules(t *testing.T) {
	_, st, _ := Step(nil, ex(100, 300, 5, 5, 5), false)
	// counter went down with the same start time; new start not ≥ last time → drop, adopt as baseline
	d, st2, out := Step(st, ex(100, 400, 1, 0, 0), false)
	if out != ResetDrop || d != nil || st2.Count != 1 || st2.Time != 400 {
		t.Fatalf("decrease: %v %+v %+v", out, d, st2)
	}
	// a new start time ≥ last time (the SDK restarted the stream): the whole point is the delta
	d, st3, out := Step(st2, ex(450, 500, 2, 1, 0), false)
	if out != ResetDelta || d.Count != 3 || st3.Start != 450 {
		t.Fatalf("restart: %v %+v", out, d)
	}
	// an old point of a previous incarnation (start differs, time older) never subtracts or moves the state back
	d, st4, out := Step(st3, ex(100, 350, 9, 9, 9), false)
	if out != ResetDrop || d != nil || st4 != st3 {
		t.Fatalf("old incarnation: %v %+v", out, d)
	}
	// layout change (different bounds): reset, never subtract
	other := Snapshot{Start: 450, Time: 600, Count: 10, Bounds: []float64{0.5}, Buckets: []uint64{4, 6}}
	if _, _, out = Step(st3, other, false); out == Delta {
		t.Fatal("subtracted across a layout change")
	}
}

func expSnap(start, t int64, scale, off int32, zero uint64, b ...uint64) Snapshot {
	n := zero
	for _, x := range b {
		n += x
	}
	return Snapshot{Start: start, Time: t, Count: n, Exponential: true, Scale: scale, Offset: off, Zero: zero, Buckets: b}
}

func TestExponentialScaleDropIsNotAReset(t *testing.T) {
	_, st, _ := Step(nil, expSnap(1, 10, 4, 6, 1, 2, 3, 4), false) // indexes 6,7,8 at scale 4
	// at scale 3 the old buckets are 6,7→3 and 8→4: [5, 4] at offset 3; the new point adds 1 at index 3 and 2 at 4
	d, _, out := Step(st, expSnap(1, 20, 3, 3, 2, 6, 6), false)
	if out != Delta {
		t.Fatalf("outcome %v", out)
	}
	if d.Count != 4 || d.Zero != 1 || d.Offset != 3 || !slices.Equal(d.Buckets, []uint64{1, 2}) {
		t.Fatalf("delta %+v", d)
	}
	// scale going up with the same start time cannot be a continuation → reset
	_, st, _ = Step(nil, expSnap(1, 10, 3, 3, 0, 5), false)
	if _, _, out := Step(st, expSnap(1, 20, 4, 6, 0, 3, 3), false); out == Delta {
		t.Fatal("scale increase treated as a delta")
	}
	// offset moved down (new lower bucket) at the same scale
	_, st, _ = Step(nil, expSnap(1, 10, 3, 5, 0, 2), false)
	d, _, out = Step(st, expSnap(1, 20, 3, 4, 0, 1, 2), false)
	if out != Delta || d.Offset != 4 || !slices.Equal(d.Buckets, []uint64{1, 0}) {
		t.Fatalf("offset move: %v %+v", out, d)
	}
}

// A process restarted mid-hour without service.instance.id has a new start time, hence a new stream key (C-105);
// its source (instance "st:<start>") is new, but it started within FreshWindow of its first point, so that point is
// counted in full: nothing is lost (C-122).
func TestRestartWithoutInstanceIDLosesNothing(t *testing.T) {
	// process 1 (stream key A): started long before its first export to us → seeded, then 3 + 4 more requests
	_, a, _ := Step(nil, ex(10*minute, 100*minute, 2, 0, 0), false)
	d1, a, _ := Step(a, ex(10*minute, 101*minute, 5, 0, 0), true)
	d2, _, _ := Step(a, ex(10*minute, 102*minute, 9, 0, 0), true)
	// restart: stream key B (new start time), 6 requests before its first export one minute later
	d3, b, out := Step(nil, ex(103*minute, 104*minute, 6, 0, 0), false)
	d4, _, _ := Step(b, ex(103*minute, 105*minute, 8, 0, 0), true)
	if out != FirstFull {
		t.Fatalf("restart outcome %v", out)
	}
	if got := d1.Count + d2.Count + d3.Count + d4.Count; got != 3+4+6+2 {
		t.Fatalf("counted %d requests after the first export, want 15", got)
	}
}
