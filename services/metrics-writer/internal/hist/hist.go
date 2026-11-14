// SPDX-License-Identifier: Apache-2.0

// Package hist converts OpenTelemetry histogram buckets into the two stored layouts of docs/data-model.md §9:
// explicit15 (the 14 OpenTelemetry default HTTP duration bounds, in seconds) and exp3 (base-2 exponential at
// scale 3 with an underflow and an overflow element). It is pure: no I/O, no clock.
package hist

import (
	"errors"
	"math"
	"slices"
)

// Kind is scf.hist_kind.
type Kind uint8

const (
	KindExplicit15 Kind = iota // scf.hist_kind 'explicit15'
	KindExp3                   // scf.hist_kind 'exp3'
)

func (k Kind) String() string {
	if k == KindExp3 {
		return "exp3"
	}
	return "explicit15"
}

// Len returns the number of stored elements of the layout.
func (k Kind) Len() int {
	if k == KindExp3 {
		return Exp3Len
	}
	return Explicit15Len
}

// Quality is api_metrics_*.hist_quality: 0 exact, 1 approximated (explicit layout split by width or kinds mixed),
// 2 coarse (exponential scale < 3).
type Quality int16

const (
	QualityExact  Quality = 0
	QualityApprox Quality = 1
	QualityCoarse Quality = 2
)

const (
	Explicit15Len = 15
	Exp3Len       = 194
	// exp3: element k (1-based) holds OTLP scale-3 index i = k − 114, i ∈ [−112, 79]; 1 = underflow, 194 = overflow.
	exp3IndexOffset = 114
	exp3MinIndex    = -112
	exp3MaxIndex    = 79
	// MaxInt4 is the largest count a stored bucket may hold (int4[], C-103, C-112(1)).
	MaxInt4 = math.MaxInt32
)

// Explicit15Bounds are the upper-inclusive bounds of explicit15 in seconds (§9.1).
var Explicit15Bounds = [14]float64{0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10}

// ErrCountOverflow is returned when a bucket of the converted histogram exceeds int4 (counted count_overflow).
var ErrCountOverflow = errors.New("histogram bucket count exceeds int4")

// ErrMalformed is returned for a layout the conversion cannot interpret (counted malformed_point).
var ErrMalformed = errors.New("malformed histogram layout")

// Row is a histogram in one of the stored layouts; Counts has Kind.Len() elements (0-based here, 1-based in SQL).
type Row struct {
	Kind    Kind
	Counts  []int64
	Quality Quality
}

// Total returns the sum of the buckets.
func (r Row) Total() int64 {
	var n int64
	for _, c := range r.Counts {
		n += c
	}
	return n
}

// CheckInt4 reports ErrCountOverflow when any bucket does not fit int4.
func (r Row) CheckInt4() error {
	for _, c := range r.Counts {
		if c > MaxInt4 || c < 0 {
			return ErrCountOverflow
		}
	}
	return nil
}

// Add adds o (same kind) element-wise into r and keeps the worse quality. It refuses (false, r unchanged) when a
// bucket would leave int4.
func (r *Row) Add(o Row) bool {
	if r.Kind != o.Kind || len(r.Counts) != len(o.Counts) {
		return false
	}
	for i := range r.Counts {
		if r.Counts[i]+o.Counts[i] > MaxInt4 {
			return false
		}
	}
	for i := range r.Counts {
		r.Counts[i] += o.Counts[i]
	}
	r.Quality = max(r.Quality, o.Quality)
	return true
}

// idxExplicit15 is §9.1's idx(v) = 1 + |{b ∈ B : b < v}| (1-based): the bucket holding v, upper bound inclusive.
func idxExplicit15(v float64) int {
	n := 0
	for _, b := range Explicit15Bounds {
		if b < v {
			n++
		}
	}
	return n + 1
}

// lowerExplicit15 / upperExplicit15 return the bounds of explicit15 bucket j (1-based); ±Inf at the ends.
func lowerExplicit15(j int) float64 {
	if j <= 1 {
		return math.Inf(-1)
	}
	return Explicit15Bounds[j-2]
}

func upperExplicit15(j int) float64 {
	if j >= Explicit15Len {
		return math.Inf(1)
	}
	return Explicit15Bounds[j-1]
}

// IsExplicit15Bounds reports whether bounds are exactly the explicit15 bounds.
func IsExplicit15Bounds(bounds []float64) bool { return slices.Equal(bounds, Explicit15Bounds[:]) }

// FromExplicit maps an explicit-bucket histogram (len(counts) = len(bounds)+1, bounds strictly increasing, in
// seconds) into explicit15 without a known sum; see FromExplicitSum.
func FromExplicit(bounds []float64, counts []uint64, minV, maxV *float64) (Row, error) {
	return FromExplicitSum(bounds, counts, minV, maxV, 0)
}

// FromExplicitSum maps an explicit-bucket histogram (len(counts) = len(bounds)+1, bounds strictly increasing, in
// seconds) into explicit15. A source bucket inside one target bucket is added exactly; a straddling one is split
// linearly by width (quality 1, counted hist_layout_approx by the caller). The open first and last source buckets
// use the point's min / max as their outer edge when known; otherwise the first starts at 0 (durations are not
// negative). The open last bucket without max is spread uniformly over (lo, 2·m − lo], where m is its mean
// estimated from the point's sum minus the other buckets at their midpoints (putting it whole just above lo biased p95/p99 low); without a usable sum (sum ≤ 0 means unknown) it goes whole
// into the target bucket just above lo.
func FromExplicitSum(bounds []float64, counts []uint64, minV, maxV *float64, sum float64) (Row, error) {
	if len(counts) != len(bounds)+1 {
		return Row{}, ErrMalformed
	}
	for i, b := range bounds {
		if math.IsNaN(b) || math.IsInf(b, 0) || (i > 0 && b <= bounds[i-1]) {
			return Row{}, ErrMalformed
		}
	}
	row := Row{Kind: KindExplicit15, Counts: make([]int64, Explicit15Len)}
	add := func(j int, n uint64) error {
		v := row.Counts[j-1] + int64(n)
		if n > MaxInt4 || v > MaxInt4 {
			return ErrCountOverflow
		}
		row.Counts[j-1] = v
		return nil
	}
	for i, n := range counts {
		if n == 0 {
			continue
		}
		lo, hi := math.Inf(-1), math.Inf(1)
		if i > 0 {
			lo = bounds[i-1]
		}
		if i < len(bounds) {
			hi = bounds[i]
		}
		j := idxExplicit15(hi)
		if lo >= lowerExplicit15(j) {
			if err := add(j, n); err != nil {
				return Row{}, err
			}
			continue
		}
		// The source bucket straddles at least one explicit15 bound.
		row.Quality = QualityApprox
		if math.IsInf(lo, -1) {
			lo = 0
			if minV != nil && *minV < hi {
				lo = max(*minV, 0)
			}
		}
		if math.IsInf(hi, 1) {
			switch {
			case maxV != nil && *maxV > lo:
				hi = *maxV
			default:
				m, ok := openBucketMean(bounds, counts, minV, sum)
				if !ok || m <= lo {
					if err := add(idxAbove(lo), n); err != nil {
						return Row{}, err
					}
					continue
				}
				hi = 2*m - lo
			}
		}
		if hi <= lo {
			if err := add(idxExplicit15(hi), n); err != nil {
				return Row{}, err
			}
			continue
		}
		if err := splitLinear(add, n, lo, hi); err != nil {
			return Row{}, err
		}
	}
	return row, nil
}

// splitLinear adds n spread uniformly over (lo, hi] to the explicit15 buckets it covers.
func splitLinear(add func(int, uint64) error, n uint64, lo, hi float64) error {
	first, last := idxAbove(lo), idxExplicit15(hi)
	weights := make([]float64, last-first+1)
	for t := first; t <= last; t++ {
		weights[t-first] = math.Min(hi, upperExplicit15(t)) - math.Max(lo, lowerExplicit15(t))
	}
	for t, part := range splitLargestRemainder(n, weights) {
		if err := add(first+t, part); err != nil {
			return err
		}
	}
	return nil
}

// openBucketMean estimates the mean of the open last bucket from the point's sum: sum minus every other bucket at
// its midpoint (the first bucket from max(min, 0) to its bound), divided by the bucket's count. ok is false without a
// usable sum.
func openBucketMean(bounds []float64, counts []uint64, minV *float64, sum float64) (float64, bool) {
	last := counts[len(counts)-1]
	if sum <= 0 || math.IsNaN(sum) || math.IsInf(sum, 0) || last == 0 || len(bounds) == 0 {
		return 0, false
	}
	rest := 0.0
	for i := 0; i < len(bounds); i++ {
		if counts[i] == 0 {
			continue
		}
		hi := bounds[i]
		lo := 0.0
		if i > 0 {
			lo = bounds[i-1]
		} else if minV != nil && *minV < hi {
			lo = max(*minV, 0)
		}
		lo = min(max(lo, 0), max(hi, 0))
		rest += float64(counts[i]) * (lo + max(hi, 0)) / 2
	}
	m := (sum - rest) / float64(last)
	if m <= 0 || math.IsNaN(m) || math.IsInf(m, 0) {
		return 0, false
	}
	return m, true
}

// MsDefaultBounds are the OpenTelemetry SDK default explicit bounds (designed for milliseconds). An SDK that ignores
// the semantic conventions' advisory seconds bounds sends them with unit "s" (research
// otel-semconv-sdk-dual-export §3.3, "bucket hazard").
var MsDefaultBounds = [15]float64{0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000}

// IsMsDefaultBounds reports whether bounds (already in seconds) are the millisecond default layout taken as seconds.
func IsMsDefaultBounds(bounds []float64) bool { return slices.Equal(bounds, MsDefaultBounds[:]) }

// msLayoutLow is the upper bound (seconds) of the low region of the millisecond layout taken as seconds: its first
// two buckets, (−∞, 0] and (0, 5].
const msLayoutLow = 5.0

// MsLayoutIsMilliseconds reports whether a point on the millisecond default layout under unit "s" holds
// milliseconds labelled "s": most of its requests lie above 5 "seconds", which is not plausible for HTTP server
// durations, while it is exactly what millisecond values look like. Otherwise (most requests at or below 5) the
// values are taken as seconds measured by an SDK that ignored the advisory seconds bounds — the documented hazard.
func MsLayoutIsMilliseconds(counts []uint64) bool {
	if len(counts) != len(MsDefaultBounds)+1 {
		return false
	}
	var total uint64
	for _, c := range counts {
		total += c
	}
	low := counts[0] + counts[1]
	return total > 0 && 2*low < total
}

// FromMsDefaultUnderSeconds maps a point whose unit says seconds but whose bounds are the millisecond default layout.
// Width-splitting its first bucket (0, 5] s would put p50 near 2.5 s for an
// API that answers in milliseconds. Instead:
//   - most requests above 5 (MsLayoutIsMilliseconds): the values are milliseconds labelled "s" — bounds, sum, min and
//     max are divided by 1000, which nests into explicit15 exactly;
//   - otherwise, with a usable sum (sum ≤ 0 means unknown), the values are seconds at a useless resolution — the
//     mass at or below 5 s is spread uniformly over (0, min(2·m, 5)], m being its mean estimated from the sum minus
//     the higher buckets at their midpoints;
//   - otherwise the plain width split.
//
// The result always has quality 2 (accuracy class "coarse") and the caller counts hist_unit_suspect, so the tenant
// sees why the percentiles are approximate.
func FromMsDefaultUnderSeconds(counts []uint64, sum float64, minV, maxV *float64) (Row, error) {
	if len(counts) != len(MsDefaultBounds)+1 {
		return Row{}, ErrMalformed
	}
	usable := sum > 0 && !math.IsNaN(sum) && !math.IsInf(sum, 0)
	var row Row
	var err error
	switch {
	case MsLayoutIsMilliseconds(counts):
		b := make([]float64, len(MsDefaultBounds))
		for i, v := range MsDefaultBounds {
			b[i] = v / 1000
		}
		row, err = FromExplicitSum(b, counts, scaled(minV), scaled(maxV), max(sum, 0)/1000)
	case usable:
		row, err = fromMsLayoutSeconds(counts, sum, minV, maxV)
	default:
		row, err = FromExplicitSum(MsDefaultBounds[:], counts, minV, maxV, 0)
	}
	if err != nil {
		return Row{}, err
	}
	row.Quality = QualityCoarse
	return row, nil
}

func scaled(v *float64) *float64 {
	if v == nil {
		return nil
	}
	x := *v / 1000
	return &x
}

// fromMsLayoutSeconds: the buckets above 5 s map as usual; the low mass (≤ 0 and (0, 5]) is spread over
// (0, min(2·m, 5)].
func fromMsLayoutSeconds(counts []uint64, sum float64, minV, maxV *float64) (Row, error) {
	high := slices.Clone(counts)
	low := high[0] + high[1]
	high[0], high[1] = 0, 0
	rest := 0.0
	for i := 2; i < len(high); i++ {
		if high[i] == 0 {
			continue
		}
		lo := MsDefaultBounds[i-1]
		hi := lo
		if i < len(MsDefaultBounds) {
			hi = MsDefaultBounds[i]
		} else if maxV != nil && *maxV > lo {
			hi = *maxV
		}
		rest += float64(high[i]) * (lo + hi) / 2
	}
	row, err := FromExplicitSum(MsDefaultBounds[:], high, nil, maxV, 0)
	if err != nil {
		return Row{}, err
	}
	if low == 0 {
		return row, nil
	}
	m := (sum - rest) / float64(low)
	lo := 0.0
	if minV != nil && *minV > 0 && *minV < msLayoutLow {
		lo = *minV
	}
	hi := msLayoutLow
	if m > lo && !math.IsInf(m, 0) && !math.IsNaN(m) {
		hi = min(2*m-lo, msLayoutLow)
	}
	add := func(j int, n uint64) error {
		v := row.Counts[j-1] + int64(n)
		if n > MaxInt4 || v > MaxInt4 {
			return ErrCountOverflow
		}
		row.Counts[j-1] = v
		return nil
	}
	if hi <= lo {
		return row, add(idxExplicit15(hi), low)
	}
	return row, splitLinear(add, low, lo, hi)
}

// idxAbove returns the explicit15 bucket holding values just above v (1 + |{b ∈ B : b ≤ v}|).
func idxAbove(v float64) int {
	n := 0
	for _, b := range Explicit15Bounds {
		if b <= v {
			n++
		}
	}
	return n + 1
}

// Exponential is the exponential-histogram input in seconds: buckets (base^i, base^(i+1)] with base = 2^(2^−scale)
// and i = Offset + position; Zero holds values within the zero threshold; Negative is the total of the negative
// buckets (stored in the underflow element and counted negative_value by the caller).
type Exponential struct {
	Scale    int32
	Zero     uint64
	Offset   int32
	Positive []uint64
	Negative uint64
}

// FromExponential maps an exponential histogram: scale ≥ 3 → exp3 exactly (i3 = i_s >> (s − 3), clamped to the
// underflow / overflow elements); scale < 3 → explicit15 by a log-uniform split of every source bucket across every
// explicit bound it straddles (quality 2, "coarse", C-23, C-103).
func FromExponential(e Exponential) (Row, error) {
	if e.Scale < -10 || e.Scale > 20 {
		return Row{}, ErrMalformed
	}
	if e.Scale >= 3 {
		return toExp3(e)
	}
	return coarse(e)
}

// FromExponentialExplicit15 maps an exponential histogram into explicit15 at any scale (the log-uniform split of
// FromExponential's scale < 3 branch, quality 2): for tables that keep one layout only (the Stellar client metrics,
// C-153).
func FromExponentialExplicit15(e Exponential) (Row, error) {
	if e.Scale < -10 || e.Scale > 20 {
		return Row{}, ErrMalformed
	}
	return coarse(e)
}

func toExp3(e Exponential) (Row, error) {
	row := Row{Kind: KindExp3, Counts: make([]int64, Exp3Len)}
	shift := uint(e.Scale - 3)
	acc := func(k int, n uint64) error {
		v := row.Counts[k-1] + int64(n)
		if n > MaxInt4 || v > MaxInt4 {
			return ErrCountOverflow
		}
		row.Counts[k-1] = v
		return nil
	}
	if err := acc(1, e.Zero); err != nil {
		return Row{}, err
	}
	if err := acc(1, e.Negative); err != nil {
		return Row{}, err
	}
	for j, n := range e.Positive {
		if n == 0 {
			continue
		}
		i := int64(e.Offset) + int64(j)
		i3 := i >> shift // arithmetic shift: floor for negative indexes
		k := 1
		switch {
		case i3 < exp3MinIndex:
			k = 1
		case i3 > exp3MaxIndex:
			k = Exp3Len
		default:
			k = int(i3) + exp3IndexOffset
		}
		if err := acc(k, n); err != nil {
			return Row{}, err
		}
	}
	return row, nil
}

var log2Explicit15 = func() (out [14]float64) {
	for i, b := range Explicit15Bounds {
		out[i] = math.Log2(b)
	}
	return out
}()

func coarse(e Exponential) (Row, error) {
	row := Row{Kind: KindExplicit15, Counts: make([]int64, Explicit15Len), Quality: QualityCoarse}
	acc := func(j int, n uint64) error {
		v := row.Counts[j-1] + int64(n)
		if n > MaxInt4 || v > MaxInt4 {
			return ErrCountOverflow
		}
		row.Counts[j-1] = v
		return nil
	}
	if err := acc(1, e.Zero); err != nil {
		return Row{}, err
	}
	if err := acc(1, e.Negative); err != nil {
		return Row{}, err
	}
	width := math.Ldexp(1, int(-e.Scale)) // log2 width of one source bucket
	for p, n := range e.Positive {
		if n == 0 {
			continue
		}
		i := float64(int64(e.Offset) + int64(p))
		llo, lhi := i*width, (i+1)*width // log2 of the bucket's bounds
		first := 1 + countBelowOrEqual(llo)
		last := 1 + countBelow(lhi)
		if first >= last {
			if err := acc(last, n); err != nil {
				return Row{}, err
			}
			continue
		}
		weights := make([]float64, last-first+1)
		for t := first; t <= last; t++ {
			lo, hi := llo, lhi
			if t > 1 {
				lo = math.Max(lo, log2Explicit15[t-2])
			}
			if t < Explicit15Len {
				hi = math.Min(hi, log2Explicit15[t-1])
			}
			weights[t-first] = hi - lo
		}
		for t, part := range splitLargestRemainder(n, weights) {
			if err := acc(first+t, part); err != nil {
				return Row{}, err
			}
		}
	}
	return row, nil
}

func countBelow(l float64) int {
	n := 0
	for _, b := range log2Explicit15 {
		if b < l {
			n++
		}
	}
	return n
}

func countBelowOrEqual(l float64) int {
	n := 0
	for _, b := range log2Explicit15 {
		if b <= l {
			n++
		}
	}
	return n
}

// splitLargestRemainder divides n into parts proportional to weights (≥ 0, not all 0) so that the parts add up to
// exactly n: floors first, then the largest remainders get one more (ties to the lower index).
func splitLargestRemainder(n uint64, weights []float64) []uint64 {
	out := make([]uint64, len(weights))
	var total float64
	for _, w := range weights {
		if w > 0 {
			total += w
		}
	}
	if total <= 0 || len(weights) == 0 {
		if len(out) > 0 {
			out[len(out)-1] = n
		}
		return out
	}
	type rem struct {
		i int
		r float64
	}
	rems := make([]rem, 0, len(weights))
	var given uint64
	for i, w := range weights {
		if w <= 0 {
			continue
		}
		exact := float64(n) * w / total
		f := math.Floor(exact)
		out[i] = uint64(f)
		given += out[i]
		rems = append(rems, rem{i, exact - f})
	}
	slices.SortStableFunc(rems, func(a, b rem) int {
		switch {
		case a.r > b.r:
			return -1
		case a.r < b.r:
			return 1
		}
		return a.i - b.i
	})
	for k := 0; given < n && len(rems) > 0; k = (k + 1) % len(rems) {
		out[rems[k].i]++
		given++
	}
	return out
}

// Downscale re-buckets exponential counts from scale `from` to the smaller scale `to` (exact: perfect subsetting).
func Downscale(offset int32, counts []uint64, from, to int32) (int32, []uint64) {
	if to >= from || len(counts) == 0 {
		return offset, slices.Clone(counts)
	}
	shift := uint(from - to)
	first := int64(offset) >> shift
	last := (int64(offset) + int64(len(counts)) - 1) >> shift
	out := make([]uint64, last-first+1)
	for j, n := range counts {
		out[((int64(offset)+int64(j))>>shift)-first] += n
	}
	return int32(first), out
}

// ShiftForUnit returns the index shift that converts exponential buckets of a metric in unit `ms` to seconds at
// the given scale (the nearest whole number of buckets, as the Collector does for legacy ms metrics).
func ShiftForUnit(factor float64, scale int32) int64 {
	return int64(math.Round(math.Log2(factor) * math.Ldexp(1, int(scale))))
}
