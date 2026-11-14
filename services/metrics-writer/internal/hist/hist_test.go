// SPDX-License-Identifier: Apache-2.0

package hist

import (
	"errors"
	"math"
	"math/rand/v2"
	"slices"
	"testing"
)

// expIndex is the OTLP exponential bucket index of v at scale s (buckets (base^i, base^(i+1)], upper inclusive).
func expIndex(v float64, s int32) int64 {
	return int64(math.Ceil(math.Log2(v)*math.Ldexp(1, int(s)))) - 1
}

// exp3Direct is §9.2 / S-05's direct bucketing: k = clamp(ceil(log2(v)·8) − 1 + 114, 1, 194) (1-based).
func exp3Direct(v float64) int {
	k := int(expIndex(v, 3)) + exp3IndexOffset
	return min(max(k, 1), Exp3Len)
}

func bucketExp(values []float64, s int32) Exponential {
	idx := map[int64]uint64{}
	lo, hi := int64(math.MaxInt64), int64(math.MinInt64)
	for _, v := range values {
		i := expIndex(v, s)
		idx[i]++
		lo, hi = min(lo, i), max(hi, i)
	}
	e := Exponential{Scale: s, Offset: int32(lo), Positive: make([]uint64, hi-lo+1)}
	for i, n := range idx {
		e.Positive[i-lo] += n
	}
	return e
}

func sampleLognormal(r *rand.Rand, n int, median, sigma float64) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = median * math.Exp(sigma*r.NormFloat64())
	}
	return out
}

func TestExplicit15BoundsAndIndex(t *testing.T) {
	cases := map[float64]int{0: 1, 0.005: 1, 0.0050001: 2, 0.01: 2, 0.1: 6, 1: 10, 10: 14, 10.01: 15, 1e9: 15}
	for v, want := range cases {
		if got := idxExplicit15(v); got != want {
			t.Errorf("idx(%v) = %d, want %d", v, got, want)
		}
	}
}

func TestFromExplicitSameBoundsIsExact(t *testing.T) {
	counts := []uint64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	row, err := FromExplicit(Explicit15Bounds[:], counts, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if row.Kind != KindExplicit15 || row.Quality != QualityExact {
		t.Fatalf("kind/quality = %v/%v", row.Kind, row.Quality)
	}
	for i, c := range counts {
		if row.Counts[i] != int64(c) {
			t.Fatalf("bucket %d = %d, want %d", i+1, row.Counts[i], c)
		}
	}
}

// The legacy ms SDK defaults ÷ 1000 ([0, 0.005, …, 10], 15 bounds) nest into explicit15 exactly (§9.1).
func TestFromExplicitLegacyMsDefaultsNestExactly(t *testing.T) {
	bounds := append([]float64{0}, Explicit15Bounds[:]...)
	counts := []uint64{2, 0, 3, 6, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 4}
	row, err := FromExplicit(bounds, counts, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if row.Quality != QualityExact {
		t.Fatalf("quality = %d, want exact", row.Quality)
	}
	want := []int64{2, 3, 6, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 4}
	if !slices.Equal(row.Counts, want) {
		t.Fatalf("counts = %v, want %v", row.Counts, want)
	}
}

func TestFromExplicitStraddlingSplitsByWidth(t *testing.T) {
	// one bucket (0.02, 0.06] straddles 0.025 and 0.05: widths 0.005, 0.025, 0.01 of 0.04
	row, err := FromExplicit([]float64{0.02, 0.06}, []uint64{0, 40, 0}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if row.Quality != QualityApprox {
		t.Fatalf("quality = %d, want approx", row.Quality)
	}
	want := make([]int64, 15)
	want[2], want[3], want[4] = 5, 25, 10
	if !slices.Equal(row.Counts, want) {
		t.Fatalf("counts = %v, want %v", row.Counts, want)
	}
	if row.Total() != 40 {
		t.Fatalf("total = %d", row.Total())
	}
}

func TestFromExplicitOpenEnds(t *testing.T) {
	// first bucket (−∞, 0.02] with min 0.004 → (0.004, 0.02]; last (0.3, +∞) without max → whole into (0.25, 0.5]
	row, err := FromExplicit([]float64{0.02, 0.3}, []uint64{16, 0, 7}, new(0.004), nil)
	if err != nil {
		t.Fatal(err)
	}
	if row.Total() != 23 || row.Counts[7] != 7 {
		t.Fatalf("counts = %v", row.Counts)
	}
	// (0.004, 0.005] 1/16, (0.005, 0.01] 5/16, (0.01, 0.02] 10/16
	if row.Counts[0] != 1 || row.Counts[1] != 5 || row.Counts[2] != 10 {
		t.Fatalf("first bucket split = %v", row.Counts[:3])
	}
	// with max: (0.3, 0.8] → (0.3,0.5] 2/5, (0.5,0.75] 2.5/5, (0.75,0.8] 0.5/5 of 10
	row, err = FromExplicit([]float64{0.3}, []uint64{0, 10}, nil, new(0.8))
	if err != nil {
		t.Fatal(err)
	}
	if row.Counts[7]+row.Counts[8]+row.Counts[9] != 10 || row.Counts[7] != 4 {
		t.Fatalf("last bucket split = %v", row.Counts[7:10])
	}
}

func TestFromExplicitMalformed(t *testing.T) {
	for _, c := range []struct {
		b []float64
		n []uint64
	}{
		{[]float64{1, 2}, []uint64{1, 2}},
		{[]float64{2, 1}, []uint64{1, 2, 3}},
		{[]float64{math.NaN()}, []uint64{1, 2}},
		{[]float64{math.Inf(1)}, []uint64{1, 2}},
	} {
		if _, err := FromExplicit(c.b, c.n, nil, nil); !errors.Is(err, ErrMalformed) {
			t.Errorf("%v/%v: err = %v", c.b, c.n, err)
		}
	}
}

func TestInt4Overflow(t *testing.T) {
	if _, err := FromExplicit(Explicit15Bounds[:], []uint64{MaxInt4 + 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, nil, nil); !errors.Is(err, ErrCountOverflow) {
		t.Fatalf("err = %v", err)
	}
	// two source buckets that land in one target bucket and together exceed int4
	if _, err := FromExplicit([]float64{0.001, 0.005}, []uint64{MaxInt4, 1, 0}, nil, nil); !errors.Is(err, ErrCountOverflow) {
		t.Fatalf("err = %v", err)
	}
	if _, err := FromExponential(Exponential{Scale: 5, Positive: []uint64{MaxInt4, MaxInt4}}); !errors.Is(err, ErrCountOverflow) {
		t.Fatalf("err = %v", err)
	}
	r := Row{Kind: KindExplicit15, Counts: make([]int64, 15)}
	r.Counts[0] = MaxInt4
	o := Row{Kind: KindExplicit15, Counts: make([]int64, 15)}
	o.Counts[0] = 1
	if r.Add(o) {
		t.Fatal("Add accepted an int4 overflow")
	}
	if r.Counts[0] != MaxInt4 {
		t.Fatal("Add changed the row on refusal")
	}
}

// Down-scaling from scales 3…20 is exact against direct scale-3 bucketing (S-05: 0 mismatches on 10^6 values).
func TestFromExponentialDownscaleExact(t *testing.T) {
	r := rand.New(rand.NewPCG(20261112, 5))
	values := append(sampleLognormal(r, 50_000, 0.082, 0.8), sampleLognormal(r, 50_000, 0.0003, 0.6)...)
	values = append(values, 2000, 1e-6, 1024, math.Ldexp(1, -14)) // overflow, underflow and the exact edges
	want := make([]int64, Exp3Len)
	for _, v := range values {
		want[exp3Direct(v)-1]++
	}
	for _, s := range []int32{3, 4, 5, 6, 8, 12, 20} {
		row, err := FromExponential(bucketExp(values, s))
		if err != nil {
			t.Fatal(err)
		}
		if row.Kind != KindExp3 || row.Quality != QualityExact {
			t.Fatalf("scale %d: kind/quality %v/%v", s, row.Kind, row.Quality)
		}
		if !slices.Equal(row.Counts, want) {
			mism := 0
			for i := range want {
				if want[i] != row.Counts[i] {
					mism++
				}
			}
			t.Fatalf("scale %d: %d elements differ from direct exp3 bucketing", s, mism)
		}
	}
}

func TestFromExponentialZeroAndNegativeGoToUnderflow(t *testing.T) {
	row, err := FromExponential(Exponential{Scale: 4, Zero: 3, Negative: 2, Offset: 0, Positive: []uint64{5}})
	if err != nil {
		t.Fatal(err)
	}
	if row.Counts[0] != 5 || row.Total() != 10 {
		t.Fatalf("underflow = %d, total %d", row.Counts[0], row.Total())
	}
	// index 0 at scale 4 = (1, 2^(1/16)] → scale 3 index 0 → element 114
	if row.Counts[113] != 5 {
		t.Fatalf("element 114 = %d", row.Counts[113])
	}
}

// Scale < 3 → explicit15 coarse; a scale-0 bucket (0.0625, 0.125] straddles 0.075 and 0.1 and is split across both
// bounds in proportion to log-width (C-103).
func TestFromExponentialCoarseMultiBoundSplit(t *testing.T) {
	// scale 0: index −4 is (2^−4, 2^−3] = (0.0625, 0.125]
	row, err := FromExponential(Exponential{Scale: 0, Offset: -4, Positive: []uint64{1000}})
	if err != nil {
		t.Fatal(err)
	}
	if row.Kind != KindExplicit15 || row.Quality != QualityCoarse {
		t.Fatalf("kind/quality %v/%v", row.Kind, row.Quality)
	}
	lw := func(a, b float64) float64 { return math.Log2(b) - math.Log2(a) }
	total := lw(0.0625, 0.125)
	exp := []float64{lw(0.0625, 0.075) / total * 1000, lw(0.075, 0.1) / total * 1000, lw(0.1, 0.125) / total * 1000}
	got := []int64{row.Counts[4], row.Counts[5], row.Counts[6]} // (0.05,0.075], (0.075,0.1], (0.1,0.25]
	for i := range exp {
		if math.Abs(float64(got[i])-exp[i]) > 1 {
			t.Fatalf("split = %v, want ≈ %v", got, exp)
		}
	}
	if row.Total() != 1000 {
		t.Fatalf("total = %d", row.Total())
	}
	// extreme negative scale: one bucket spans everything; total preserved, no NaN/Inf trouble
	row, err = FromExponential(Exponential{Scale: -10, Offset: -1, Positive: []uint64{7, 9}})
	if err != nil {
		t.Fatal(err)
	}
	if row.Total() != 16 {
		t.Fatalf("total = %d", row.Total())
	}
}

func TestFromExponentialScaleRange(t *testing.T) {
	for _, s := range []int32{-11, 21} {
		if _, err := FromExponential(Exponential{Scale: s}); !errors.Is(err, ErrMalformed) {
			t.Fatalf("scale %d: err = %v", s, err)
		}
	}
}

func TestSplitLargestRemainderPreservesTotal(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range 2000 {
		n := uint64(r.IntN(10_000))
		w := make([]float64, 1+r.IntN(6))
		for i := range w {
			w[i] = r.Float64()
		}
		var s uint64
		for _, p := range splitLargestRemainder(n, w) {
			s += p
		}
		if s != n {
			t.Fatalf("sum %d != %d", s, n)
		}
	}
}

func TestDownscale(t *testing.T) {
	off, c := Downscale(-3, []uint64{1, 2, 3, 4, 5}, 5, 4) // indexes −3…1 → −2,−1,−1,0,0
	if off != -2 || !slices.Equal(c, []uint64{1, 5, 9}) {
		t.Fatalf("got %d %v", off, c)
	}
	off, c = Downscale(7, []uint64{1}, 3, 3)
	if off != 7 || !slices.Equal(c, []uint64{1}) {
		t.Fatalf("no-op got %d %v", off, c)
	}
}

// An open last bucket without max used to be put whole just above its lower
// bound, so 90 requests > 1 s all landed in (1, 2.5] and p95/p99 were biased low. With the sum, the bucket is spread
// over (lo, 2·m − lo] where m is its estimated mean.
func TestFromExplicitSumOpenLastBucketUsesTheMean(t *testing.T) {
	bounds := []float64{0.1, 1}
	counts := []uint64{10, 0, 90}
	sum := 10*0.05 + 90*4.0 // the slow requests average 4 s
	row, err := FromExplicitSum(bounds, counts, nil, nil, sum)
	if err != nil {
		t.Fatal(err)
	}
	if row.Total() != 100 {
		t.Fatalf("total %d", row.Total())
	}
	// (1, 7]: (1, 2.5] 1.5/6, (2.5, 5] 2.5/6, (5, 7.5] 2/6 of 90 → 22/23, 37/38, 30
	if row.Counts[10]+row.Counts[11]+row.Counts[12] != 90 || row.Counts[12] != 30 {
		t.Fatalf("open bucket spread = %v", row.Counts[10:13])
	}
	if row.Quality != QualityApprox {
		t.Fatalf("quality %d", row.Quality)
	}
	// Without a sum the old placement stays (and is still approx).
	row, _ = FromExplicitSum(bounds, counts, nil, nil, 0)
	if row.Counts[10] != 90 {
		t.Fatalf("without sum: %v", row.Counts)
	}
	// A sum that leaves no room above lo (inconsistent) also falls back.
	row, _ = FromExplicitSum(bounds, counts, nil, nil, 1)
	if row.Counts[10] != 90 {
		t.Fatalf("inconsistent sum: %v", row.Counts)
	}
}

func p50Bucket(row Row) int {
	half := (row.Total() + 1) / 2
	var acc int64
	for i, c := range row.Counts {
		acc += c
		if acc >= half {
			return i + 1
		}
	}
	return len(row.Counts)
}

// Unit "s" with the OpenTelemetry millisecond default bounds. An API that answers in ~40 ms, measured
// in seconds by an SDK that ignores the advisory bounds, has every request in (0, 5] s; the width split put p50 at
// ≈ 2.5 s ("[1 1 3 5 5 5 30 50 50 50 300 500 0 0 0]").
func TestMsDefaultLayoutUnderSecondsIsEstimatedFromTheMean(t *testing.T) {
	counts := make([]uint64, 16)
	counts[1] = 1000 // (0, 5] s
	old, err := FromExplicit(MsDefaultBounds[:], counts, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if b := p50Bucket(old); b != 11 && b != 12 {
		t.Fatalf("precondition: the width split puts p50 in bucket %d", b)
	}
	row, err := FromMsDefaultUnderSeconds(counts, 1000*0.04, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if row.Quality != QualityCoarse || row.Total() != 1000 {
		t.Fatalf("quality %d total %d", row.Quality, row.Total())
	}
	// Spread over (0, 0.08]: everything at or below 0.1 s, p50 in (0.025, 0.05].
	for i := 6; i < len(row.Counts); i++ {
		if row.Counts[i] != 0 {
			t.Fatalf("mass above 0.1 s: %v", row.Counts)
		}
	}
	if b := p50Bucket(row); b != 4 {
		t.Fatalf("p50 in bucket %d (%v), want 4 = (0.025, 0.05]", b, row.Counts)
	}
	// Requests above 5 s keep their exact buckets.
	counts[13] = 10 // (5000, 7500] "s" → > 10 s
	row, _ = FromMsDefaultUnderSeconds(counts, 1000*0.04+10*6250, nil, nil)
	if row.Counts[14] != 10 || row.Total() != 1010 {
		t.Fatalf("high buckets: %v", row.Counts)
	}
}

// Milliseconds labelled "s" (mean far above 5 "seconds"): bounds and sum are divided by 1000 and nest exactly.
func TestMsDefaultLayoutWithMillisecondValuesIsRescaled(t *testing.T) {
	counts := make([]uint64, 16)
	counts[4], counts[5] = 60, 40 // (25, 50] and (50, 75] "s" = ms
	row, err := FromMsDefaultUnderSeconds(counts, 60*40+40*60, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]int64, 15)
	want[3], want[4] = 60, 40
	if !slices.Equal(row.Counts, want) || row.Quality != QualityCoarse {
		t.Fatalf("counts %v quality %d", row.Counts, row.Quality)
	}
}

func TestMsDefaultLayoutWithoutSumStaysVisible(t *testing.T) {
	counts := make([]uint64, 16)
	counts[1] = 10
	row, err := FromMsDefaultUnderSeconds(counts, 0, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if row.Quality != QualityCoarse || row.Total() != 10 {
		t.Fatalf("quality %d total %d", row.Quality, row.Total())
	}
	if _, err := FromMsDefaultUnderSeconds(make([]uint64, 3), 1, nil, nil); !errors.Is(err, ErrMalformed) {
		t.Fatal("wrong bucket count accepted")
	}
	if !IsMsDefaultBounds(MsDefaultBounds[:]) || IsMsDefaultBounds(Explicit15Bounds[:]) {
		t.Fatal("IsMsDefaultBounds")
	}
}

// Milliseconds labelled "s" are recognised by the bucket mass alone, so a point without a sum is rescaled too, and a
// few slow outliers do not flip a seconds point into the millisecond reading.
func TestMsLayoutIsMillisecondsByMass(t *testing.T) {
	ms := make([]uint64, 16)
	ms[3], ms[6] = 30, 70 // (10, 25] and (75, 100] "s": milliseconds
	if !MsLayoutIsMilliseconds(ms) {
		t.Fatal("millisecond mass not recognised")
	}
	row, err := FromMsDefaultUnderSeconds(ms, 0, nil, nil)
	if err != nil || row.Counts[2] != 30 || row.Counts[5] != 70 || row.Quality != QualityCoarse {
		t.Fatalf("rescaled without sum: %v %v", row.Counts, err)
	}
	secs := make([]uint64, 16)
	secs[1], secs[13] = 990, 10
	if MsLayoutIsMilliseconds(secs) || MsLayoutIsMilliseconds(make([]uint64, 16)) || MsLayoutIsMilliseconds(nil) {
		t.Fatal("seconds (or empty) read as milliseconds")
	}
}
