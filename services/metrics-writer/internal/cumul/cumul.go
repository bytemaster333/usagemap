// SPDX-License-Identifier: Apache-2.0

// Package cumul turns cumulative histogram points into deltas (docs/data-model.md §9.4, wire-formats §g.4,
// C-105, C-122). It is pure: the caller loads and stores the state row (scf.api_stream_state, locked FOR UPDATE).
//
// Rules, per stream key:
//   - first point (no state), C-122: counted in full when its source (tenant, service, instance, scope, metric,
//     rules version — the stream key without the data-point dimensions) was already delivering to us — the SDK
//     exports every stream of a source at every interval, so a stream that was absent before (a new route, the
//     first 404) holds only requests we have never counted; for a source we have not seen, counted in full when
//     the stream started at most FreshWindow before the point (a fresh process: a brand-new service or a restart
//     without service.instance.id), otherwise it only seeds state (cumulative_first_point) — the first export of a
//     long-running process, or of one whose state aged out, never imports history; a point without a start time
//     only seeds;
//   - stale replay (same start time, time ≤ last time): dropped, state unchanged — a Collector replays queued
//     requests after newer ones (S-04), so nothing assumes arrival order;
//   - a changed start time, a layout the previous state cannot be brought to, or any decreasing count is a reset
//     (cumulative_reset): the delta is the whole point when its start time ≥ the state's last time, else the point
//     is dropped — never a subtraction across a reset;
//   - an exponential point whose scale fell (the SDK re-scaled as its range grew) is not a reset: the previous
//     buckets are down-scaled exactly to the new scale and subtracted;
//   - the state only moves forward: it is replaced only by a point newer than the state's last time.
package cumul

import (
	"slices"
	"time"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
)

// Snapshot is one cumulative histogram point in its source layout, or a delta computed from two of them.
type Snapshot struct {
	Start, Time int64 // unix ns
	Count       uint64
	Sum         float64

	Exponential bool
	Bounds      []float64 // explicit: the bounds; Buckets has len(Bounds)+1 counts
	Scale       int32     // exponential
	Offset      int32     // exponential: index of Buckets[0]
	Buckets     []uint64  // explicit counts or exponential positive counts
	Zero        uint64    // exponential zero count
	Negative    uint64    // exponential: total of the negative buckets
}

// Outcome says what happened to a point.
type Outcome uint8

const (
	FirstSeed  Outcome = iota // first point, only seeds state (cumulative_first_point)
	FirstFull                 // first point, counted in full (C-122)
	Delta                     // ordinary delta
	Stale                     // stale replay: dropped, state unchanged
	ResetDelta                // reset; the whole point is the delta (cumulative_reset)
	ResetDrop                 // reset; the point is dropped (cumulative_reset)
)

// FreshWindow is how long before its first point a stream of an unseen source may have started and still be
// counted in full (C-122). It covers an export interval (60 s by default in every SDK) with room for slow first
// exports, and equals the writer's backfill bound (registered_at − 10 min), so a brand-new service's first point
// holds nothing older than what the backfill bound admits.
const FreshWindow = int64(10 * time.Minute)

// Step applies cur to the stream whose state is prev (nil: none yet). sourceKnown says whether the stream's source
// had delivered points before the current transaction (C-122). It returns the delta to record (nil when nothing is
// recorded or the delta is empty), the new state (prev itself when unchanged) and the outcome.
func Step(prev *Snapshot, cur Snapshot, sourceKnown bool) (*Snapshot, *Snapshot, Outcome) {
	if prev == nil {
		next := clone(cur)
		if cur.Start > 0 && (sourceKnown || cur.Time-cur.Start <= FreshWindow) {
			return nonEmpty(clone(cur)), next, FirstFull
		}
		return nil, next, FirstSeed
	}
	if cur.Start == prev.Start && cur.Time <= prev.Time {
		return nil, prev, Stale
	}
	if cur.Start == prev.Start {
		if d, ok := subtract(prev, &cur); ok {
			return nonEmpty(d), clone(cur), Delta
		}
	}
	// Reset.
	next := prev
	if cur.Time > prev.Time {
		next = clone(cur)
	}
	if cur.Start >= prev.Time {
		return nonEmpty(clone(cur)), next, ResetDelta
	}
	return nil, next, ResetDrop
}

func nonEmpty(d *Snapshot) *Snapshot {
	if d == nil || d.Count == 0 {
		return nil
	}
	return d
}

func clone(s Snapshot) *Snapshot {
	c := s
	c.Bounds = slices.Clone(s.Bounds)
	c.Buckets = slices.Clone(s.Buckets)
	return &c
}

// subtract returns cur − prev, or false when that is not a valid delta (layout mismatch or a decreasing count).
func subtract(prev, cur *Snapshot) (*Snapshot, bool) {
	if prev.Exponential != cur.Exponential || cur.Count < prev.Count {
		return nil, false
	}
	d := &Snapshot{Start: cur.Start, Time: cur.Time, Count: cur.Count - prev.Count, Sum: max(cur.Sum-prev.Sum, 0),
		Exponential: cur.Exponential, Scale: cur.Scale}
	if !cur.Exponential {
		if !slices.Equal(prev.Bounds, cur.Bounds) || len(prev.Buckets) != len(cur.Buckets) {
			return nil, false
		}
		d.Bounds = slices.Clone(cur.Bounds)
		d.Buckets = make([]uint64, len(cur.Buckets))
		for i := range cur.Buckets {
			if cur.Buckets[i] < prev.Buckets[i] {
				return nil, false
			}
			d.Buckets[i] = cur.Buckets[i] - prev.Buckets[i]
		}
		return d, true
	}
	if cur.Scale > prev.Scale || cur.Zero < prev.Zero || cur.Negative < prev.Negative {
		return nil, false
	}
	pOff, pB := hist.Downscale(prev.Offset, prev.Buckets, prev.Scale, cur.Scale)
	d.Zero, d.Negative = cur.Zero-prev.Zero, cur.Negative-prev.Negative
	d.Offset = cur.Offset
	d.Buckets = slices.Clone(cur.Buckets)
	for j, n := range pB {
		if n == 0 {
			continue
		}
		pos := int64(pOff) + int64(j) - int64(cur.Offset)
		if pos < 0 || pos >= int64(len(cur.Buckets)) || d.Buckets[pos] < n {
			return nil, false
		}
		d.Buckets[pos] -= n
	}
	return d, true
}
