// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"
	"math"
	"math/bits"
	"strings"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/processor/processorhelper"
	"go.uber.org/zap"
)

// Metric names kept by step 4 of §f.5 (and, with stellar_client_metrics, the
// Stellar client metrics of step 4a, stellar.go).
const (
	MetricServerDuration       = "http.server.request.duration"
	MetricServerDurationLegacy = "http.server.duration"
)

type metricClass uint8

const (
	classOther metricClass = iota
	classServerDuration
	classClient
)

func classifyMetric(name string) metricClass {
	switch {
	case name == MetricServerDuration, name == MetricServerDurationLegacy:
		return classServerDuration
	case strings.HasPrefix(name, "http.client."), strings.HasPrefix(name, "rpc.client."):
		return classClient
	}
	return classOther
}

// unitFactor returns the factor converting the metric's values to seconds.
func unitFactor(unit string) (float64, bool) {
	switch unit {
	case "s":
		return 1, true
	case "ms":
		return 1.0 / 1000, true
	}
	return 0, false
}

func (s *sanitizer) processMetrics(ctx context.Context, md pmetric.Metrics) (pmetric.Metrics, error) {
	rm, ok := s.meta(ctx)
	if !ok {
		s.noTenant(ctx, "metrics", int64(md.DataPointCount()))
		return md, processorhelper.ErrSkipProcessingData
	}
	out, t, red, merged, ok := s.sanitizeMetricsSafe(md, &rm)
	if !ok {
		// An internal error: drop the request, never the process (C-114).
		s.log.Error("scfsanitize: request dropped after an internal error", zap.String("signal", "metrics"))
		out, t, red, merged = pmetric.NewMetrics(), tally{}, redactionSum{}, 0
		t.add(UnknownService, ReasonMalformedPoint, int64(md.DataPointCount()))
	}
	appendDropCounters(out, &rm, &t)
	s.record(ctx, "metrics", &rm, &t, &red, merged)
	if out.ResourceMetrics().Len() == 0 {
		return out, processorhelper.ErrSkipProcessingData
	}
	return out, nil
}

// testPanicHook lets a test make the sanitise step panic.
var testPanicHook func()

// sanitizeMetricsSafe builds the sanitised copy of md; ok is false when the
// step panicked (the partial result is then discarded).
func (s *sanitizer) sanitizeMetricsSafe(md pmetric.Metrics, rm *requestMeta) (out pmetric.Metrics, t tally, red redactionSum, merged int, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	if testPanicHook != nil {
		testPanicHook()
	}
	b := newMetricsBuilder()
	for _, r := range md.ResourceMetrics().All() {
		res := rm.sanitizeResource(r.Resource())
		if res.reason != "" {
			t.add(res.service, res.reason, int64(resourcePoints(r)))
			continue
		}
		red.freeText += res.redactions
		rb := b.resource(rm, &res.clean)
		for _, sm := range r.ScopeMetrics().All() {
			sc := sanitizeScope(sm.Scope())
			red.freeText += sc.redactions
			sb := rb.scope(&sc)
			for _, m := range sm.Metrics().All() {
				s.sanitizeMetric(m, sb, res.service, rm, &t, &red)
			}
		}
	}
	merged = b.merge()
	return b.out, t, red, merged, true
}

func resourcePoints(r pmetric.ResourceMetrics) int {
	n := 0
	for _, sm := range r.ScopeMetrics().All() {
		for _, m := range sm.Metrics().All() {
			n += metricPoints(m)
		}
	}
	return n
}

func metricPoints(m pmetric.Metric) int {
	switch m.Type() {
	case pmetric.MetricTypeGauge:
		return m.Gauge().DataPoints().Len()
	case pmetric.MetricTypeSum:
		return m.Sum().DataPoints().Len()
	case pmetric.MetricTypeHistogram:
		return m.Histogram().DataPoints().Len()
	case pmetric.MetricTypeExponentialHistogram:
		return m.ExponentialHistogram().DataPoints().Len()
	case pmetric.MetricTypeSummary:
		return m.Summary().DataPoints().Len()
	}
	return 0
}

// sanitizeMetric applies steps 3, 4, 6 and 7 to one metric and appends what
// is kept to the output through sb. Dropped points are counted.
func (s *sanitizer) sanitizeMetric(m pmetric.Metric, sb *scopeBuilder, service string, rm *requestMeta, t *tally, red *redactionSum) {
	var name string
	if s.cfg.StellarClientMetrics {
		if k := classifyStellar(m.Name()); k != stellarNone {
			s.sanitizeStellar(k, m, sb, service, rm, t)
			return
		}
	}
	if r, ok := s.clientRuleOf(m.Name()); ok {
		s.sanitizeStellar(r, m, sb, service, rm, t)
		return
	}
	switch classifyMetric(m.Name()) {
	case classClient:
		t.add(service, ReasonClientMetric, int64(metricPoints(m)))
		return
	case classOther:
		t.add(service, ReasonMetricNotAllowed, int64(metricPoints(m)))
		return
	}
	// The output name is our constant, never the tenant's bytes.
	if m.Name() == MetricServerDuration {
		name = MetricServerDuration
	} else {
		name = MetricServerDurationLegacy
	}
	factor, unitOK := unitFactor(m.Unit())
	if !unitOK {
		t.add(service, ReasonMalformedPoint, int64(metricPoints(m)))
		return
	}

	switch m.Type() {
	case pmetric.MetricTypeHistogram:
		h := m.Histogram()
		temp := h.AggregationTemporality()
		if !validTemporality(temp) {
			t.add(service, ReasonMalformedPoint, int64(h.DataPoints().Len()))
			return
		}
		var om *outMetric
		for _, dp := range h.DataPoints().All() {
			if !validHistogram(dp) {
				t.add(service, ReasonMalformedPoint, 1)
				continue
			}
			if r := s.timeReason(dp.Timestamp(), rm); r != "" {
				t.add(service, r, 1)
				continue
			}
			if om == nil {
				om = sb.metric(name, pmetric.MetricTypeHistogram, temp)
			}
			dst := om.m.Histogram().DataPoints().AppendEmpty()
			copyHistogram(dp, dst, factor)
			om.orig = append(om.orig, origKey(dp.Attributes()))
			s.pointAttrs(dp.Attributes(), dst.Attributes(), service, t, red)
		}
	case pmetric.MetricTypeExponentialHistogram:
		h := m.ExponentialHistogram()
		temp := h.AggregationTemporality()
		if !validTemporality(temp) {
			t.add(service, ReasonMalformedPoint, int64(h.DataPoints().Len()))
			return
		}
		var om *outMetric
		for _, dp := range h.DataPoints().All() {
			if !validExpHistogram(dp) {
				t.add(service, ReasonMalformedPoint, 1)
				continue
			}
			if r := s.timeReason(dp.Timestamp(), rm); r != "" {
				t.add(service, r, 1)
				continue
			}
			tmp := pmetric.NewExponentialHistogramDataPoint()
			if !copyExpHistogram(dp, tmp, factor) {
				// Unit conversion moved the buckets out of the representable range.
				t.add(service, ReasonMalformedPoint, 1)
				continue
			}
			if om == nil {
				om = sb.metric(name, pmetric.MetricTypeExponentialHistogram, temp)
			}
			dst := om.m.ExponentialHistogram().DataPoints().AppendEmpty()
			tmp.MoveTo(dst)
			om.orig = append(om.orig, origKey(dp.Attributes()))
			s.pointAttrs(dp.Attributes(), dst.Attributes(), service, t, red)
		}
	default:
		// A request duration must be a histogram (semantic conventions).
		t.add(service, ReasonMalformedPoint, int64(metricPoints(m)))
	}
}

func validTemporality(t pmetric.AggregationTemporality) bool {
	return t == pmetric.AggregationTemporalityDelta || t == pmetric.AggregationTemporalityCumulative
}

func (s *sanitizer) pointAttrs(src, dst pcommon.Map, service string, t *tally, red *redactionSum) {
	res := sanitizePointAttrs(src, dst, modeMetric)
	red.freeText += res.redactions
	if res.path.Redactions.Total() > 0 {
		t.add(service, ReasonRouteRedacted, 1)
		if seedRedacted(res.path) {
			t.add(service, ReasonRouteSeedRedacted, 1)
		}
		red.add(res.path.Redactions)
	}
}

// timeReason applies the time bounds of step 7 against the receipt time.
func (s *sanitizer) timeReason(ts pcommon.Timestamp, rm *requestMeta) string {
	v := int64(ts)
	if v <= 0 {
		return ReasonMalformedPoint
	}
	if v > rm.receivedAt+int64(s.cfg.MaxFuture) {
		return ReasonFuture
	}
	if v < rm.receivedAt-int64(s.cfg.MaxAge) {
		return ReasonTooOld
	}
	return ""
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// Bounds of exponential histograms (C-114). OTLP scales are −10…20; at
// scale s every finite float64 has a bucket index within ±expIndexLimit(s)
// (2^-1074 … 2^1024), so offsets outside that range are not real data. 320
// buckets per side is twice the largest max_size we know of (S-04's 160).
const (
	minExpScale    = -10
	maxExpScale    = 20
	maxExpBuckets  = 320
	maxMergeSpan   = 2 * maxExpBuckets // no merge creates more buckets than this per side
	expRangeLimit  = 1075
	pointFlagsMask = uint32(1) // FLAG_NO_RECORDED_VALUE, the only defined data-point flag
)

func expIndexLimit(scale int32) int64 {
	if scale >= 0 {
		return expRangeLimit << scale
	}
	d := int64(1) << -scale
	return (expRangeLimit + d - 1) / d
}

// sumCounts adds counts; ok is false on uint64 overflow.
func sumCounts(acc uint64, counts pcommon.UInt64Slice) (uint64, bool) {
	for _, c := range counts.All() {
		var carry uint64
		acc, carry = bits.Add64(acc, c, 0)
		if carry != 0 {
			return 0, false
		}
	}
	return acc, true
}

// validHistogram checks the layout the writer relies on: bucket counts match
// the bounds, bounds strictly increase, buckets add up to the count.
func validHistogram(dp pmetric.HistogramDataPoint) bool {
	bounds := dp.ExplicitBounds()
	counts := dp.BucketCounts()
	if counts.Len() != 0 && counts.Len() != bounds.Len()+1 {
		return false
	}
	for i := range bounds.Len() {
		b := bounds.At(i)
		if !finite(b) || (i > 0 && b <= bounds.At(i-1)) {
			return false
		}
	}
	if counts.Len() > 0 {
		sum, ok := sumCounts(0, counts)
		if !ok || sum != dp.Count() {
			return false
		}
	}
	if dp.HasSum() && !finite(dp.Sum()) || dp.HasMin() && !finite(dp.Min()) || dp.HasMax() && !finite(dp.Max()) {
		return false
	}
	return true
}

// validExpBuckets: at most maxExpBuckets, indexes within the scale's range
// (64-bit arithmetic: offset + len − 1 cannot wrap).
func validExpBuckets(b pmetric.ExponentialHistogramDataPointBuckets, scale int32) bool {
	n := b.BucketCounts().Len()
	if n == 0 {
		return true
	}
	if n > maxExpBuckets {
		return false
	}
	lim := expIndexLimit(scale)
	lo := int64(b.Offset())
	hi := lo + int64(n) - 1
	return lo >= -lim && hi <= lim
}

func validExpHistogram(dp pmetric.ExponentialHistogramDataPoint) bool {
	scale := dp.Scale()
	if scale < minExpScale || scale > maxExpScale {
		return false
	}
	if !validExpBuckets(dp.Positive(), scale) || !validExpBuckets(dp.Negative(), scale) {
		return false
	}
	sum, ok := sumCounts(dp.ZeroCount(), dp.Positive().BucketCounts())
	if ok {
		sum, ok = sumCounts(sum, dp.Negative().BucketCounts())
	}
	if !ok || sum != dp.Count() {
		return false
	}
	if !finite(dp.ZeroThreshold()) || dp.ZeroThreshold() < 0 {
		return false
	}
	if dp.HasSum() && !finite(dp.Sum()) || dp.HasMin() && !finite(dp.Min()) || dp.HasMax() && !finite(dp.Max()) {
		return false
	}
	return true
}

// copyHistogram writes the allow-listed fields of src into dst (new), in
// seconds (step 4: ms → s, values and bounds ×0.001; division by 1000 keeps
// 5 ms → 0.005 exact). Exemplars are not copied; flags are masked.
func copyHistogram(src, dst pmetric.HistogramDataPoint, factor float64) {
	div := 1 / factor
	dst.SetStartTimestamp(src.StartTimestamp())
	dst.SetTimestamp(src.Timestamp())
	dst.SetCount(src.Count())
	dst.BucketCounts().FromRaw(src.BucketCounts().AsRaw())
	bounds := src.ExplicitBounds().AsRaw()
	if factor != 1 {
		for i := range bounds {
			bounds[i] /= div
		}
	}
	dst.ExplicitBounds().FromRaw(bounds)
	if src.HasSum() {
		dst.SetSum(src.Sum() / div)
	}
	if src.HasMin() {
		dst.SetMin(src.Min() / div)
	}
	if src.HasMax() {
		dst.SetMax(src.Max() / div)
	}
	dst.SetFlags(pmetric.DataPointFlags(uint32(src.Flags()) & pointFlagsMask))
}

// copyExpHistogram writes the allow-listed fields of src into dst (new), in
// seconds. ×0.001 is not a power of the base, so the bucket index is shifted
// by the nearest whole number of buckets (error ≤ half a bucket width; the
// writer down-scales to scale 3 anyway). Sum, min, max and zero threshold are
// exact. false: the shifted buckets left the representable range.
func copyExpHistogram(src, dst pmetric.ExponentialHistogramDataPoint, factor float64) bool {
	div := 1 / factor
	scale := src.Scale()
	shift := int64(0)
	if factor != 1 {
		shift = int64(math.Round(math.Log2(factor) * math.Ldexp(1, int(scale))))
	}
	dst.SetStartTimestamp(src.StartTimestamp())
	dst.SetTimestamp(src.Timestamp())
	dst.SetCount(src.Count())
	dst.SetScale(scale)
	dst.SetZeroCount(src.ZeroCount())
	dst.SetZeroThreshold(src.ZeroThreshold() / div)
	for _, side := range [...][2]pmetric.ExponentialHistogramDataPointBuckets{{src.Positive(), dst.Positive()}, {src.Negative(), dst.Negative()}} {
		in, out := side[0], side[1]
		if in.BucketCounts().Len() == 0 {
			continue
		}
		off := int64(in.Offset()) + shift
		out.SetOffset(int32(off))
		out.BucketCounts().FromRaw(in.BucketCounts().AsRaw())
		if lim := expIndexLimit(scale); off < -lim || off+int64(in.BucketCounts().Len())-1 > lim {
			return false
		}
	}
	if src.HasSum() {
		dst.SetSum(src.Sum() / div)
	}
	if src.HasMin() {
		dst.SetMin(src.Min() / div)
	}
	if src.HasMax() {
		dst.SetMax(src.Max() / div)
	}
	dst.SetFlags(pmetric.DataPointFlags(uint32(src.Flags()) & pointFlagsMask))
	return true
}

// appendDropCounters adds the tenant-visible scf.ingest.dropped delta sum
// (§f.5 step 8, §g.2) as its own resource of the same request.
func appendDropCounters(md pmetric.Metrics, rm *requestMeta, t *tally) {
	if t.empty() {
		return
	}
	r := md.ResourceMetrics().AppendEmpty()
	rm.stamp(r.Resource().Attributes())
	r.Resource().Attributes().PutStr(AttrStreamInstance, NoInstance)
	sm := r.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName(ScopeName)
	sm.Scope().SetVersion(ScopeVersion)
	m := sm.Metrics().AppendEmpty()
	m.SetName(MetricIngestDropped)
	m.SetUnit("{point}")
	sum := m.SetEmptySum()
	sum.SetIsMonotonic(true)
	sum.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	ts := pcommon.Timestamp(rm.receivedAt)
	for _, e := range t.entries() {
		dp := sum.DataPoints().AppendEmpty()
		dp.SetStartTimestamp(ts)
		dp.SetTimestamp(ts)
		dp.SetIntValue(e.count)
		dp.Attributes().PutStr(AttrReason, e.reason)
		dp.Attributes().PutStr(keyServiceName, e.service)
	}
}

// record reports one request to the Collector's own metrics and debug log.
func (s *sanitizer) record(ctx context.Context, signal string, rm *requestMeta, t *tally, red *redactionSum, merged int) {
	byReason := t.byReason()
	s.tel.recordDrops(ctx, signal, byReason)
	s.tel.recordRedactionSum(ctx, red)
	if merged > 0 {
		s.tel.merged.Add(ctx, int64(merged))
	}
	if rm.receivedAtFallback {
		s.tel.fallback.Add(ctx, 1)
	}
	s.tel.recordLevel(ctx, rm)
	if ce := s.log.Check(zap.DebugLevel, "scfsanitize request"); ce != nil {
		fields := []zap.Field{zap.String("signal", signal), zap.Int("merged_points", merged)}
		for reason, n := range byReason {
			fields = append(fields, zap.Int64("dropped."+reason, n))
		}
		ce.Write(fields...)
	}
}
