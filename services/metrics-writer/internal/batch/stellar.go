// SPDX-License-Identifier: Apache-2.0

package batch

import (
	"math"
	"regexp"
	"strconv"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// StellarPoint is one Stellar client-metric point (wire-formats §f.5 step 4a, §g.7; C-153): an outbound call of a
// tenant backend to Stellar RPC or Horizon (histogram), or a transaction submission, poll or simulation (counter).
// Its dimensions are the closed sets the Collector applied; it never becomes API usage.
type StellarPoint struct {
	Service    string
	Metric     string // one of rules.StellarMetrics
	Network    string
	Operation  string
	Variant    string
	Outcome    string
	Histogram  bool
	Cumulative bool
	StreamKey  [32]byte // cumulative only
	SourceKey  [32]byte // cumulative only: tenant, service, explicit instance (or none), scope
	// Snap holds the point. A counter is a one-bucket explicit layout without bounds: Count = Buckets[0] = value,
	// so cumulative counters take the same cumulative → delta rules as histograms (§9.4).
	Snap     cumul.Snapshot
	Min, Max *float64 // delta histogram points only
}

// Attribute keys of the Stellar client metrics (packages/stellar-otel, wire-formats §f.5 step 4a).
const (
	attrNetwork     = "stellar.network"
	attrErrorType   = "error.type"
	attrURLTemplate = "url.template"
	attrVia         = "stellar.tx.via"
	attrTxStatus    = "stellar.tx.status"
	attrResultClass = "stellar.tx.result_class"
	attrSimOutcome  = "stellar.sim.outcome"
	attrSimError    = "stellar.sim.error_class"
)

var (
	// Storage backstops (the Collector already reduced every value to its closed set): the character classes of
	// migration 0080's checks. Nothing else (a URL, an address, an error text) can pass.
	operationRE = regexp.MustCompile(`^[A-Za-z0-9_./{}-]{1,64}$`)
	variantRE   = regexp.MustCompile(`^[A-Za-z0-9_]{1,32}$`)
	outcomeRE   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	networks    = map[string]bool{"mainnet": true, "testnet": true, "futurenet": true, "local": true, "unknown": true}
)

// stellar decodes the points of one Stellar client metric.
func (d *decoder) stellar(m pmetric.Metric) {
	d.clientPoints(m, rules.StellarHistogram(m.Name()), func(a pcommon.Map, start, ts pcommon.Timestamp, cum bool,
		snap cumul.Snapshot, minV, maxV *float64, layout string) bool {
		p, ok := d.stellarPoint(a, start, ts, cum)
		if !ok {
			return false
		}
		snap.Start, snap.Time = p.Snap.Start, p.Snap.Time
		p.Snap, p.Min, p.Max = snap, minV, maxV
		d.emitStellar(p, layout)
		return true
	})
}

// clientPoint receives one decoded client-metric point (a histogram snapshot in seconds, or a counter as a one-bucket
// layout without bounds: Count = Buckets[0] = value) and its layout tag; false counts it malformed_point.
type clientPoint func(a pcommon.Map, start, ts pcommon.Timestamp, cum bool, snap cumul.Snapshot, minV, maxV *float64,
	layout string) bool

// clientPoints decodes the points of a client metric of a known shape: a duration histogram (explicit or
// exponential, unit s or ms) or a monotonic counter. Anything else is malformed_point.
func (d *decoder) clientPoints(m pmetric.Metric, hist bool, each clientPoint) {
	factor := 1.0
	if hist {
		f, ok := unitFactor(m.Unit())
		if !ok {
			d.malformed(metricPoints(m))
			return
		}
		factor = f
	}
	switch {
	case hist && m.Type() == pmetric.MetricTypeHistogram:
		cum, ok := temporality(m.Histogram().AggregationTemporality())
		if !ok {
			d.malformed(metricPoints(m))
			return
		}
		for _, dp := range m.Histogram().DataPoints().All() {
			if dp.Flags()&flagNoRecordedValue != 0 {
				continue
			}
			snap, minV, maxV, ok := explicitSnapshot(dp, cum, factor)
			if !ok || dp.Timestamp() == 0 || !each(dp.Attributes(), dp.StartTimestamp(), dp.Timestamp(), cum, snap, minV, maxV,
				"x:"+formatBounds(snap.Bounds)) {
				d.malformed(1)
			}
		}
	case hist && m.Type() == pmetric.MetricTypeExponentialHistogram:
		cum, ok := temporality(m.ExponentialHistogram().AggregationTemporality())
		if !ok {
			d.malformed(metricPoints(m))
			return
		}
		for _, dp := range m.ExponentialHistogram().DataPoints().All() {
			if dp.Flags()&flagNoRecordedValue != 0 {
				continue
			}
			snap, minV, maxV, ok := exponentialSnapshot(dp, cum, factor)
			if !ok || dp.Timestamp() == 0 || !each(dp.Attributes(), dp.StartTimestamp(), dp.Timestamp(), cum, snap, minV, maxV, "e") {
				d.malformed(1)
			}
		}
	case !hist && m.Type() == pmetric.MetricTypeSum && m.Sum().IsMonotonic():
		cum, ok := temporality(m.Sum().AggregationTemporality())
		if !ok {
			d.malformed(metricPoints(m))
			return
		}
		for _, dp := range m.Sum().DataPoints().All() {
			if dp.Flags()&flagNoRecordedValue != 0 {
				continue
			}
			v, ok := counterValue(dp)
			if !ok || dp.Timestamp() == 0 || !each(dp.Attributes(), dp.StartTimestamp(), dp.Timestamp(), cum,
				cumul.Snapshot{Count: v, Buckets: []uint64{v}}, nil, nil, "c") {
				d.malformed(1)
			}
		}
	default:
		d.malformed(metricPoints(m))
	}
}

// counterValue is a non-negative integer value: an int, or an integral double ≤ 2^53.
func counterValue(dp pmetric.NumberDataPoint) (uint64, bool) {
	switch dp.ValueType() {
	case pmetric.NumberDataPointValueTypeInt:
		if dp.IntValue() >= 0 {
			return uint64(dp.IntValue()), true
		}
	case pmetric.NumberDataPointValueTypeDouble:
		if f := dp.DoubleValue(); f >= 0 && f <= 1<<53 && f == math.Trunc(f) {
			return uint64(f), true
		}
	}
	return 0, false
}

// stellarPoint maps the attributes to the stored dimensions (migration 0080's table header) and returns false for a
// point that cannot be stored.
func (d *decoder) stellarPoint(a pcommon.Map, start, ts pcommon.Timestamp, cum bool) (StellarPoint, bool) {
	p := StellarPoint{Service: d.service, Metric: d.metric, Histogram: rules.StellarHistogram(d.metric), Cumulative: cum}
	if ts == 0 {
		return p, false
	}
	p.Snap.Start, p.Snap.Time = tsNano(start), tsNano(ts)
	p.Network = strAttr(a, attrNetwork)
	if !networks[p.Network] {
		return p, false
	}
	opt := func(k string) string { return strAttr(a, k) }
	switch d.metric {
	case rules.MetricStellarRPC:
		p.Operation, p.Outcome = opt(AttrRPCMethod), opt(attrErrorType)
	case rules.MetricStellarHTTP:
		p.Operation, p.Variant = opt(attrURLTemplate), opt(AttrMethod)
		if v, ok := a.Get(AttrStatus); ok && v.Type() == pcommon.ValueTypeInt && v.Int() >= 100 && v.Int() <= 599 {
			p.Outcome = strconv.FormatInt(v.Int(), 10)
		} else {
			p.Outcome = opt(attrErrorType)
		}
	case rules.MetricStellarSubmissions, rules.MetricStellarPolls:
		p.Operation, p.Variant, p.Outcome = opt(attrVia), opt(attrTxStatus), opt(attrResultClass)
	case rules.MetricStellarSimulations:
		p.Variant, p.Outcome = opt(attrSimOutcome), opt(attrSimError)
	}
	// Required: the operation of the two duration metrics and the status / outcome of the counters.
	switch d.metric {
	case rules.MetricStellarRPC, rules.MetricStellarHTTP:
		if p.Operation == "" {
			return p, false
		}
	default:
		if p.Variant == "" {
			return p, false
		}
	}
	if (p.Operation != "" && !operationRE.MatchString(p.Operation)) ||
		(p.Variant != "" && !variantRE.MatchString(p.Variant)) ||
		(p.Outcome != "" && !outcomeRE.MatchString(p.Outcome)) {
		return p, false
	}
	return p, true
}

func (d *decoder) emitStellar(p StellarPoint, layout string) {
	if p.Cumulative {
		inst := d.instance
		if inst == NoInstance {
			inst = "st:" + strconv.FormatInt(p.Snap.Start, 10)
		}
		parts := append([]string{d.tenant, d.service, inst, d.scopeName, d.scopeVersion, d.metric},
			"stellar.network="+p.Network, "op="+p.Operation, "variant="+p.Variant, "outcome="+p.Outcome, "{layout}="+layout)
		p.StreamKey = lpHash("scf-stellar-stream-v1", parts...)
		// The source (C-122): without service.instance.id every series of a JS process has its own start time, so
		// the source is the service (and its explicit instance) — a service that already delivers Stellar client
		// metrics (any of the five: one MeterProvider exports them together) has a new stream counted in full; a process
		// restart's first points hold only post-restart calls.
		src := d.instance
		if src == NoInstance {
			src = ""
		}
		p.SourceKey = lpHash("scf-stellar-source-v1", d.tenant, d.service, src, d.scopeName)
	}
	d.part.Stellar = append(d.part.Stellar, p)
}
