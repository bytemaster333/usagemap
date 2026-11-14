// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"math"
	"slices"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

func TestCombineBuckets(t *testing.T) {
	tests := []struct {
		off     int32
		counts  []uint64
		by      int32
		wantOff int32
		want    []uint64
	}{
		{off: 0, counts: []uint64{1, 2, 3, 4}, by: 1, wantOff: 0, want: []uint64{3, 7}},
		{off: 1, counts: []uint64{1, 2, 3, 4}, by: 1, wantOff: 0, want: []uint64{1, 5, 4}},
		{off: -3, counts: []uint64{1, 2, 3}, by: 1, wantOff: -2, want: []uint64{1, 5}},
		{off: -1, counts: []uint64{5}, by: 4, wantOff: -1, want: []uint64{5}},
		{off: 7, counts: []uint64{1, 1}, by: 2, wantOff: 1, want: []uint64{1, 1}},
		{off: 5, counts: []uint64{9}, by: 0, wantOff: 5, want: []uint64{9}},
	}
	empty := pmetric.NewExponentialHistogramDataPointBuckets()
	for i, tc := range tests {
		b := pmetric.NewExponentialHistogramDataPointBuckets()
		b.SetOffset(tc.off)
		b.BucketCounts().FromRaw(tc.counts)
		off, got, ok := combineBuckets(0, tc.by, b, 0, empty)
		if !ok || off != tc.wantOff || !slices.Equal(got, tc.want) {
			t.Errorf("%d: got off %d %v, want off %d %v", i, off, got, tc.wantOff, tc.want)
		}
	}
	t.Run("span cap refuses without allocating", func(t *testing.T) {
		a := pmetric.NewExponentialHistogramDataPointBuckets()
		a.BucketCounts().FromRaw([]uint64{1})
		b := pmetric.NewExponentialHistogramDataPointBuckets()
		b.SetOffset(maxMergeSpan)
		b.BucketCounts().FromRaw([]uint64{1})
		if _, _, ok := combineBuckets(0, 0, a, 0, b); ok {
			t.Fatal("merged beyond the span cap")
		}
		b.SetOffset(maxMergeSpan - 1)
		if _, got, ok := combineBuckets(0, 0, a, 0, b); !ok || len(got) != maxMergeSpan {
			t.Fatalf("ok %v len %d", ok, len(got))
		}
	})
	t.Run("count overflow refuses", func(t *testing.T) {
		a := pmetric.NewExponentialHistogramDataPointBuckets()
		a.BucketCounts().FromRaw([]uint64{math.MaxUint64})
		if _, _, ok := combineBuckets(0, 0, a, 0, a); ok {
			t.Fatal("overflowed")
		}
	})
}

func expPoint(scale, off int32, counts []uint64, zero uint64) pmetric.ExponentialHistogramDataPoint {
	dp := pmetric.NewExponentialHistogramDataPoint()
	dp.SetScale(scale)
	dp.Positive().SetOffset(off)
	dp.Positive().BucketCounts().FromRaw(counts)
	dp.SetZeroCount(zero)
	var n uint64
	for _, c := range counts {
		n += c
	}
	dp.SetCount(n + zero)
	dp.SetSum(float64(n))
	dp.SetTimestamp(pcommon.Timestamp(testRecv))
	return dp
}

func TestMergeExpHistogramDifferentScales(t *testing.T) {
	dst := expPoint(3, 10, []uint64{1, 1, 1, 1}, 1)
	src := expPoint(2, 3, []uint64{2, 2}, 0)
	if !mergeExpHistogram(dst, src) {
		t.Fatal("not merged")
	}
	// dst at scale 2: indexes 10..13 → 5,5,6,6 → offset 5 [2,2]; src offset 3 [2,2] → 3..4
	if dst.Scale() != 2 || dst.Positive().Offset() != 3 || !slices.Equal(dst.Positive().BucketCounts().AsRaw(), []uint64{2, 2, 2, 2}) {
		t.Fatalf("scale %d off %d %v", dst.Scale(), dst.Positive().Offset(), dst.Positive().BucketCounts().AsRaw())
	}
	if dst.Count() != 9 || dst.ZeroCount() != 1 || dst.Sum() != 8 {
		t.Fatalf("count %d zero %d sum %v", dst.Count(), dst.ZeroCount(), dst.Sum())
	}
	if !validExpHistogram(dst) {
		t.Fatal("merged point invalid")
	}
}

func TestMergeExpHistogramZeroThresholdMismatch(t *testing.T) {
	dst := expPoint(3, 0, []uint64{1}, 0)
	src := expPoint(3, 0, []uint64{1}, 0)
	src.SetZeroThreshold(0.001)
	if mergeExpHistogram(dst, src) {
		t.Fatal("merged despite different zero thresholds")
	}
}

func TestMergeHistogramRules(t *testing.T) {
	h := newHarness(t)
	mk := func(instance bool) (pmetric.Metrics, pmetric.HistogramDataPointSlice) {
		md, dps := newHistMetrics("svc", MetricServerDuration, "s")
		if instance {
			md.ResourceMetrics().At(0).Resource().Attributes().PutStr("service.instance.id", "i")
		}
		return md, dps
	}
	merged := func(md pmetric.Metrics) int64 {
		before := h.selfCounter(MetricMergedPoints, nil)
		h.runMetrics(defaultMeta(), md)
		return h.selfCounter(MetricMergedPoints, nil) - before
	}
	t.Run("different bounds are not merged", func(t *testing.T) {
		md, dps := mk(true)
		addHistPoint(dps, testRecv, map[string]any{"a": "1"})
		p := addHistPoint(dps, testRecv, map[string]any{"a": "2"})
		p.ExplicitBounds().FromRaw([]float64{0.2, 1})
		if n := merged(md); n != 0 {
			t.Fatalf("merged %d", n)
		}
	})
	t.Run("cumulative without instance and different start are separate streams", func(t *testing.T) {
		md, dps := mk(false)
		addHistPoint(dps, testRecv, map[string]any{"a": "1"})
		p := addHistPoint(dps, testRecv, map[string]any{"a": "2"})
		p.SetStartTimestamp(p.StartTimestamp() + 1)
		if n := merged(md); n != 0 {
			t.Fatalf("merged %d", n)
		}
	})
	t.Run("cumulative without instance and same start merge", func(t *testing.T) {
		md, dps := mk(false)
		addHistPoint(dps, testRecv, map[string]any{"a": "1"})
		addHistPoint(dps, testRecv, map[string]any{"a": "2"})
		if n := merged(md); n != 1 {
			t.Fatalf("merged %d", n)
		}
	})
	t.Run("no-recorded-value point is absorbed", func(t *testing.T) {
		md, dps := mk(true)
		p := addHistPoint(dps, testRecv, map[string]any{"a": "1"})
		p.SetFlags(pmetric.DefaultDataPointFlags.WithNoRecordedValue(true))
		addHistPoint(dps, testRecv, map[string]any{"a": "2"})
		out := h.runMetrics(defaultMeta(), md)
		got := onlyPoint(t, out, MetricServerDuration)
		if got.Flags().NoRecordedValue() || got.Count() != 3 {
			t.Fatalf("flags %v count %d", got.Flags(), got.Count())
		}
	})
	t.Run("duplicate resources and scopes are folded", func(t *testing.T) {
		md, dps := mk(false)
		addHistPoint(dps, testRecv, map[string]any{"http.route": "/a"})
		md.ResourceMetrics().At(0).CopyTo(md.ResourceMetrics().AppendEmpty())
		md.ResourceMetrics().At(1).Resource().Attributes().PutStr("host.name", "other") // removed by sanitising
		md.ResourceMetrics().At(1).ScopeMetrics().At(0).Metrics().At(0).Histogram().DataPoints().At(0).Attributes().PutStr("http.route", "/b")
		out := h.runMetrics(defaultMeta(), md)
		if out.ResourceMetrics().Len() != 1 || out.ResourceMetrics().At(0).ScopeMetrics().Len() != 1 ||
			out.ResourceMetrics().At(0).ScopeMetrics().At(0).Metrics().Len() != 1 || out.DataPointCount() != 2 {
			t.Fatalf("resources %d points %d", out.ResourceMetrics().Len(), out.DataPointCount())
		}
	})
	t.Run("more points than the merge cap pass unmerged", func(t *testing.T) {
		md, dps := mk(true)
		for i := range maxMergePoints + 1 {
			addHistPoint(dps, testRecv, map[string]any{"a": i})
		}
		if n := merged(md); n != 0 {
			t.Fatalf("merged %d", n)
		}
	})
}
