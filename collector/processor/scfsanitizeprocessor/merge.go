// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	"math/bits"
	"slices"
	"strconv"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

// The sanitised output is built from scratch (C-114): new resources, scopes,
// metrics and points into which only allow-listed fields are copied. The
// builder folds what became identical once the non-allow-listed parts were
// gone — resources with the same attributes, scopes with the same name and
// version, metrics with the same identity — and remembers, for every point,
// a digest of its ORIGINAL attribute set for the merge rule below.

// Merge limits (C-114): points of one metric beyond maxMergePoints are passed
// on unmerged, and a merge key holds at most maxMergeCandidates points that
// others may merge into, so merging is linear in the request size.
const (
	maxMergePoints     = 10_000
	maxMergeCandidates = 4
)

type metricsBuilder struct {
	out       pmetric.Metrics
	resources map[string]*resourceBuilder
	all       []*outMetric
}

type resourceBuilder struct {
	b      *metricsBuilder
	attrs  pcommon.Map // the output attributes, kept until the resource is created
	rm     pmetric.ResourceMetrics
	exists bool
	scopes map[string]*scopeBuilder
	inst   bool // scf.stream.instance is a real service.instance.id
}

type scopeBuilder struct {
	r       *resourceBuilder
	scope   cleanScope
	sm      pmetric.ScopeMetrics
	exists  bool
	metrics map[string]*outMetric
}

// outMetric is one output metric and, per data point (same order), the
// digest of the point's original attribute set.
type outMetric struct {
	m          pmetric.Metric
	orig       []origDigest
	noInstance bool
}

type origDigest [sha256.Size]byte

func origKey(m pcommon.Map) origDigest { return sha256.Sum256([]byte(mapKey(m))) }

func newMetricsBuilder() *metricsBuilder {
	return &metricsBuilder{out: pmetric.NewMetrics(), resources: map[string]*resourceBuilder{}}
}

// resource returns the builder of the output resource with c's attributes;
// the resource itself is created with its first point.
func (b *metricsBuilder) resource(rm *requestMeta, c *cleanResource) *resourceBuilder {
	attrs := pcommon.NewMap()
	rm.writeResource(attrs, c)
	k := mapKey(attrs)
	if r, ok := b.resources[k]; ok {
		return r
	}
	r := &resourceBuilder{b: b, attrs: attrs, scopes: map[string]*scopeBuilder{}, inst: c.hasInstance && !c.instanceRedacted}
	b.resources[k] = r
	return r
}

func (r *resourceBuilder) scope(c *cleanScope) *scopeBuilder {
	k := c.key()
	if s, ok := r.scopes[k]; ok {
		return s
	}
	s := &scopeBuilder{r: r, scope: *c, metrics: map[string]*outMetric{}}
	r.scopes[k] = s
	return s
}

// metric returns the output metric (creating resource, scope and metric on
// first use, in input order, so the output is deterministic).
func (s *scopeBuilder) metric(name string, typ pmetric.MetricType, temp pmetric.AggregationTemporality) *outMetric {
	return s.metricOf(name, "s", typ, temp)
}

// metricOf is metric with an explicit unit; a Sum is created monotonic (the
// only sums kept are the Stellar counters of step 4a).
func (s *scopeBuilder) metricOf(name, unit string, typ pmetric.MetricType, temp pmetric.AggregationTemporality) *outMetric {
	k := lp(name) + strconv.Itoa(int(typ)) + "/" + strconv.Itoa(int(temp))
	if m, ok := s.metrics[k]; ok {
		return m
	}
	r := s.r
	if !r.exists {
		r.rm = r.b.out.ResourceMetrics().AppendEmpty()
		r.attrs.CopyTo(r.rm.Resource().Attributes())
		r.exists = true
	}
	if !s.exists {
		s.sm = r.rm.ScopeMetrics().AppendEmpty()
		s.sm.Scope().SetName(s.scope.name)
		s.sm.Scope().SetVersion(s.scope.version)
		s.exists = true
	}
	om := &outMetric{m: s.sm.Metrics().AppendEmpty(), noInstance: !r.inst}
	om.m.SetName(name)
	om.m.SetUnit(unit)
	switch typ {
	case pmetric.MetricTypeHistogram:
		om.m.SetEmptyHistogram().SetAggregationTemporality(temp)
	case pmetric.MetricTypeExponentialHistogram:
		om.m.SetEmptyExponentialHistogram().SetAggregationTemporality(temp)
	case pmetric.MetricTypeSum:
		sum := om.m.SetEmptySum()
		sum.SetAggregationTemporality(temp)
		sum.SetIsMonotonic(true)
	}
	s.metrics[k] = om
	r.b.all = append(r.b.all, om)
	return om
}

// merge applies §f.5 step 8 to every output metric and returns the number of
// points merged away.
func (b *metricsBuilder) merge() int {
	n := 0
	for _, om := range b.all {
		switch om.m.Type() {
		case pmetric.MetricTypeHistogram:
			h := om.m.Histogram()
			byStart := h.AggregationTemporality() == pmetric.AggregationTemporalityCumulative && om.noInstance
			n += mergePoints(h.DataPoints(), om.orig, byStart, histLayout, mergeHistogram)
		case pmetric.MetricTypeExponentialHistogram:
			h := om.m.ExponentialHistogram()
			byStart := h.AggregationTemporality() == pmetric.AggregationTemporalityCumulative && om.noInstance
			n += mergePoints(h.DataPoints(), om.orig, byStart, expLayout, mergeExpHistogram)
		case pmetric.MetricTypeSum:
			sum := om.m.Sum()
			byStart := sum.AggregationTemporality() == pmetric.AggregationTemporalityCumulative && om.noInstance
			n += mergePoints(sum.DataPoints(), om.orig, byStart, func(pmetric.NumberDataPoint) string { return "" }, mergeSum)
		}
	}
	return n
}

// mergeSum adds two integer counts (the Stellar counters of step 4a); false on
// int64 overflow.
func mergeSum(dst, src pmetric.NumberDataPoint) bool {
	if src.Flags().NoRecordedValue() {
		return true
	}
	if dst.Flags().NoRecordedValue() {
		src.CopyTo(dst)
		return true
	}
	a, b := dst.IntValue(), src.IntValue()
	if a > math.MaxInt64-b {
		return false
	}
	dst.SetIntValue(a + b)
	dst.SetStartTimestamp(mergeStart(dst.StartTimestamp(), src.StartTimestamp()))
	return true
}

type removable[E any] interface {
	RemoveIf(func(E) bool)
	Len() int
}

func removeMarked[E any](s removable[E], drop []bool) {
	if !slices.Contains(drop, true) {
		return
	}
	i := 0
	s.RemoveIf(func(E) bool {
		d := drop[i]
		i++
		return d
	})
}

type point interface {
	Attributes() pcommon.Map
	StartTimestamp() pcommon.Timestamp
	Timestamp() pcommon.Timestamp
}

type pointSlice[P point] interface {
	removable[P]
	At(int) P
}

// mergePoints merges points of one metric whose sanitised attribute sets,
// timestamps and bucket layouts are equal (and, with byStart, start times —
// the writer's stream identity without service.instance.id, §g.4) — but only
// when their ORIGINAL attribute sets differed (C-114): two points with the
// same original attributes are two snapshots of one stream and are never
// added up. A point is merged into a candidate only if none of the points
// already merged into it had the same original attributes.
func mergePoints[P point](ps pointSlice[P], orig []origDigest, byStart bool, layout func(P) string, merge func(dst, src P) bool) int {
	if ps.Len() < 2 || ps.Len() > maxMergePoints || len(orig) != ps.Len() {
		return 0
	}
	type candidate struct {
		idx   int
		origs []origDigest
	}
	seen := map[string][]*candidate{}
	drop := make([]bool, ps.Len())
	n := 0
	for i := range ps.Len() {
		p := ps.At(i)
		k := mapKey(p.Attributes()) + "|" + strconv.FormatUint(uint64(p.Timestamp()), 10) + "|" + layout(p)
		if byStart {
			k += "|" + strconv.FormatUint(uint64(p.StartTimestamp()), 10)
		}
		done := false
		for _, c := range seen[k] {
			if slices.Contains(c.origs, orig[i]) {
				continue
			}
			if merge(ps.At(c.idx), p) {
				c.origs = append(c.origs, orig[i])
				drop[i] = true
				done = true
				n++
				break
			}
		}
		if !done && len(seen[k]) < maxMergeCandidates {
			seen[k] = append(seen[k], &candidate{idx: i, origs: []origDigest{orig[i]}})
		}
	}
	removeMarked(ps, drop)
	return n
}

// histLayout: explicit points merge only with equal bounds and bucket count.
func histLayout(p pmetric.HistogramDataPoint) string {
	b := make([]byte, 0, 8*p.ExplicitBounds().Len()+4)
	b = binary.AppendUvarint(b, uint64(p.BucketCounts().Len()))
	for _, v := range p.ExplicitBounds().All() {
		b = binary.BigEndian.AppendUint64(b, math.Float64bits(v))
	}
	return string(b)
}

// expLayout: exponential points of any scale merge (at the smaller scale)
// when their zero thresholds are equal.
func expLayout(p pmetric.ExponentialHistogramDataPoint) string {
	return strconv.FormatUint(math.Float64bits(p.ZeroThreshold()), 16)
}

// mergeStart: the merged point covers the earliest start (timestamps are equal).
func mergeStart(dst, src pcommon.Timestamp) pcommon.Timestamp {
	if src != 0 && (dst == 0 || src < dst) {
		return src
	}
	return dst
}

func mergeHistogram(dst, src pmetric.HistogramDataPoint) bool {
	if !slices.Equal(dst.ExplicitBounds().AsRaw(), src.ExplicitBounds().AsRaw()) ||
		dst.BucketCounts().Len() != src.BucketCounts().Len() {
		return false
	}
	if src.Flags().NoRecordedValue() {
		return true
	}
	if dst.Flags().NoRecordedValue() {
		src.CopyTo(dst)
		return true
	}
	count, carry := bits.Add64(dst.Count(), src.Count(), 0)
	if carry != 0 {
		return false
	}
	counts := dst.BucketCounts().AsRaw()
	for i, c := range src.BucketCounts().All() {
		if counts[i], carry = bits.Add64(counts[i], c, 0); carry != 0 {
			return false
		}
	}
	dst.SetStartTimestamp(mergeStart(dst.StartTimestamp(), src.StartTimestamp()))
	dst.BucketCounts().FromRaw(counts)
	dst.SetCount(count)
	mergeSumMinMax(dst, src)
	return true
}

func mergeExpHistogram(dst, src pmetric.ExponentialHistogramDataPoint) bool {
	if dst.ZeroThreshold() != src.ZeroThreshold() {
		return false
	}
	if src.Flags().NoRecordedValue() {
		return true
	}
	if dst.Flags().NoRecordedValue() {
		src.CopyTo(dst)
		return true
	}
	scale := min(dst.Scale(), src.Scale())
	pOff, pos, ok := combineBuckets(scale, dst.Scale(), dst.Positive(), src.Scale(), src.Positive())
	if !ok {
		return false
	}
	nOff, neg, ok := combineBuckets(scale, dst.Scale(), dst.Negative(), src.Scale(), src.Negative())
	if !ok {
		return false
	}
	count, c1 := bits.Add64(dst.Count(), src.Count(), 0)
	zero, c2 := bits.Add64(dst.ZeroCount(), src.ZeroCount(), 0)
	if c1 != 0 || c2 != 0 {
		return false
	}
	dst.SetStartTimestamp(mergeStart(dst.StartTimestamp(), src.StartTimestamp()))
	dst.SetScale(scale)
	setBuckets(dst.Positive(), pOff, pos)
	setBuckets(dst.Negative(), nOff, neg)
	dst.SetZeroCount(zero)
	dst.SetCount(count)
	mergeSumMinMax(dst, src)
	return true
}

func setBuckets(b pmetric.ExponentialHistogramDataPointBuckets, off int32, counts []uint64) {
	if len(counts) == 0 {
		b.SetOffset(0)
		b.BucketCounts().FromRaw(nil)
		return
	}
	b.SetOffset(off)
	b.BucketCounts().FromRaw(counts)
}

// combineBuckets down-scales the buckets a (at scale sa) and b (at sb) to
// scale and adds them. Index arithmetic is 64-bit; ok is false — nothing is
// allocated — when the result would span more than maxMergeSpan buckets, and
// on count overflow.
func combineBuckets(scale, sa int32, a pmetric.ExponentialHistogramDataPointBuckets, sb int32, b pmetric.ExponentialHistogramDataPointBuckets) (int32, []uint64, bool) {
	type side struct {
		off    int64
		counts pcommon.UInt64Slice
		by     int32
	}
	sides := [2]side{{int64(a.Offset()), a.BucketCounts(), sa - scale}, {int64(b.Offset()), b.BucketCounts(), sb - scale}}
	lo, hi := int64(math.MaxInt64), int64(math.MinInt64)
	for _, s := range sides {
		if s.counts.Len() == 0 {
			continue
		}
		lo = min(lo, s.off>>s.by)
		hi = max(hi, (s.off+int64(s.counts.Len())-1)>>s.by)
	}
	if hi < lo {
		return 0, nil, true // both empty
	}
	if hi-lo+1 > maxMergeSpan || lo < math.MinInt32 || hi > math.MaxInt32 {
		return 0, nil, false
	}
	out := make([]uint64, hi-lo+1)
	for _, s := range sides {
		for i, c := range s.counts.All() {
			j := ((s.off + int64(i)) >> s.by) - lo
			var carry uint64
			if out[j], carry = bits.Add64(out[j], c, 0); carry != 0 {
				return 0, nil, false
			}
		}
	}
	return int32(lo), out, true
}

type sumMinMax interface {
	HasSum() bool
	Sum() float64
	SetSum(float64)
	RemoveSum()
	HasMin() bool
	Min() float64
	SetMin(float64)
	RemoveMin()
	HasMax() bool
	Max() float64
	SetMax(float64)
	RemoveMax()
}

func mergeSumMinMax(dst, src sumMinMax) {
	if dst.HasSum() && src.HasSum() {
		dst.SetSum(dst.Sum() + src.Sum())
	} else {
		dst.RemoveSum()
	}
	if dst.HasMin() && src.HasMin() {
		dst.SetMin(math.Min(dst.Min(), src.Min()))
	} else {
		dst.RemoveMin()
	}
	if dst.HasMax() && src.HasMax() {
		dst.SetMax(math.Max(dst.Max(), src.Max()))
	} else {
		dst.RemoveMax()
	}
}

// mapKey is an unambiguous canonical encoding of an attribute map: keys
// sorted, each key and typed value length-prefixed.
func mapKey(m pcommon.Map) string {
	keys := make([]string, 0, m.Len())
	for k := range m.All() {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	var b []byte
	for _, k := range keys {
		v, _ := m.Get(k)
		b = binary.AppendUvarint(b, uint64(len(k)))
		b = append(b, k...)
		b = append(b, byte(v.Type()))
		s := v.AsString()
		b = binary.AppendUvarint(b, uint64(len(s)))
		b = append(b, s...)
	}
	return string(b)
}

// lp is a length-prefixed string for composite keys.
func lp(s string) string {
	return strconv.Itoa(len(s)) + ":" + s
}
