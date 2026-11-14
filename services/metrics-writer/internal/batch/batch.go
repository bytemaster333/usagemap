// SPDX-License-Identifier: Apache-2.0

// Package batch decodes one Collector → writer request (wire-formats §g.1–§g.2) into per-tenant parts: the batch
// key (SHA-256 of the decompressed body, §g.3), histogram points with their stream keys (§g.4), the Collector's
// scf.ingest.dropped counters, and the drops the writer decides before touching the database (receipt age, malformed
// points). It is pure apart from the clock passed in.
package batch

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// Resource and point attributes of the payload contract (§g.2).
const (
	AttrTenantID       = "scf.tenant.id"
	AttrReceivedAt     = "scf.received_at_unix_nano"
	AttrStreamInstance = "scf.stream.instance"
	AttrTenantLevel    = "scf.tenant.level" // optional; see README "Contract changes" (L0 caps)
	AttrServiceName    = "service.name"
	AttrRoute          = "scf.route"
	AttrRulesVersion   = "scf.rules_version"
	AttrMethod         = "http.request.method"
	AttrStatus         = "http.response.status_code"
	AttrRPCMethod      = "rpc.method"
	AttrMetricOverflow = "otel.metric.overflow"
	AttrReason         = "scf.reason"

	NoInstance     = "_"
	UnknownService = "unknown_service"
	// MaxReceiptAge is the 72-hour cap enforced by receipt age (C-112(8)).
	MaxReceiptAge = 72 * time.Hour
)

var rulesVersionRE = regexp.MustCompile(`^scf-path-rules/[0-9]+\.[0-9]+\.[0-9]+$`)

// ErrUndecodable is returned for a body that is not an OTLP ExportMetricsServiceRequest.
var ErrUndecodable = errors.New("undecodable OTLP metrics request")

// Point is one histogram data point, attributed to a tenant and service.
type Point struct {
	Service      string
	Metric       string
	Kind         string // scf.stream_kind
	Source       string // scf.metric_source
	KindRank     int
	Scope        string // stored scope name
	Route        string
	RulesVersion string
	Method       int16
	Status       int16
	RPCMethod    string
	HasRPC       bool
	Overflow     bool // otel.metric.overflow = true → {overflow}
	Cumulative   bool
	StreamKey    [32]byte // cumulative only
	SourceKey    [32]byte // cumulative only: the stream's source (C-122), see sourceKey
	Snap         cumul.Snapshot
	Min, Max     *float64 // delta points only, when the SDK sent them

	attrKV []string // "k=v" of every data-point attribute, sorted by key (stream key input)
}

// Counter is one scf.ingest.dropped data point.
type Counter struct {
	Service string // service.name of the point; "{not_allowed}" or unknown → not attributable
	Reason  string
	Count   int64
	Time    int64 // unix ns
}

// DropKey identifies a writer-side drop counter: the service name ("" = not attributable) and the reason.
type DropKey struct{ Service, Reason string }

// TenantPart is the part of a request that belongs to one tenant; it is applied in one transaction.
type TenantPart struct {
	Tenant   string // canonical lower-case UUID
	Level    int    // verification level from scf.tenant.level, −1 when absent
	Points   []Point
	Counters []Counter
	Drops    map[DropKey]int64
	Stellar  []StellarPoint // Stellar client metrics (C-153), stored apart from the API metrics
	// Integration client metrics (partner, payments, anchors; §g.8, 0085), stored apart from both
	Integration []IntegrationPoint
	Total       int // data points of this tenant in the request (ledger "points")
}

// Drop adds n to a writer-side drop counter.
func (p *TenantPart) Drop(service, reason string, n int64) {
	if n <= 0 {
		return
	}
	if p.Drops == nil {
		p.Drops = map[DropKey]int64{}
	}
	p.Drops[DropKey{service, reason}] += n
}

// Batch is a decoded request.
type Batch struct {
	Key      [32]byte
	Parts    []*TenantPart // sorted by tenant
	NoTenant int           // data points without a usable scf.tenant.id (counted in the writer's metrics only)
	Points   int           // all data points
}

// Decode decodes the decompressed body. now is the writer's clock for the receipt-age cap.
func Decode(body []byte, now time.Time) (*Batch, error) {
	md, err := (&pmetric.ProtoUnmarshaler{}).UnmarshalMetrics(body)
	if err != nil {
		return nil, ErrUndecodable
	}
	b := &Batch{Key: sha256.Sum256(body)}
	parts := map[string]*TenantPart{}
	for _, rm := range md.ResourceMetrics().All() {
		res := rm.Resource().Attributes()
		n := resourcePoints(rm)
		b.Points += n
		tenant, ok := tenantID(res)
		if !ok {
			b.NoTenant += n
			continue
		}
		part := parts[tenant]
		if part == nil {
			part = &TenantPart{Tenant: tenant, Level: -1}
			parts[tenant] = part
		}
		part.Total += n
		if lv, ok := res.Get(AttrTenantLevel); ok && lv.Type() == pcommon.ValueTypeInt && lv.Int() >= 0 && lv.Int() <= 4 {
			part.Level = int(lv.Int())
		}
		service := UnknownService
		if v, ok := res.Get(AttrServiceName); ok && v.Type() == pcommon.ValueTypeStr && v.Str() != "" {
			service = v.Str()
		}
		if v, ok := res.Get(AttrReceivedAt); ok && v.Type() == pcommon.ValueTypeInt && now.Sub(time.Unix(0, v.Int())) > MaxReceiptAge {
			dropResource(part, rm, service, rules.ReasonUndeliverable72h)
			continue
		}
		instance := NoInstance
		if v, ok := res.Get(AttrStreamInstance); ok && v.Type() == pcommon.ValueTypeStr && v.Str() != "" {
			instance = v.Str()
		}
		for _, sm := range rm.ScopeMetrics().All() {
			scope := sm.Scope()
			for _, m := range sm.Metrics().All() {
				if m.Name() == rules.MetricDropped {
					decodeCounters(part, m)
					continue
				}
				if rules.StellarMetric(m.Name()) {
					d := decoder{part: part, tenant: tenant, service: service, instance: instance,
						scopeName: scope.Name(), scopeVersion: scope.Version(), metric: m.Name()}
					d.stellar(m)
					continue
				}
				if rules.IntegrationMetric(m.Name()) {
					d := decoder{part: part, tenant: tenant, service: service, instance: instance,
						scopeName: scope.Name(), scopeVersion: scope.Version(), metric: m.Name()}
					d.integration(m)
					continue
				}
				kind, source, rank, ok := rules.GroupKind(m.Name())
				if !ok {
					part.Drop(service, rules.ReasonMetricNotAllowed, int64(metricPoints(m)))
					continue
				}
				d := decoder{part: part, tenant: tenant, service: service, instance: instance,
					scopeName: scope.Name(), scopeVersion: scope.Version(), metric: m.Name(),
					tmpl: Point{Service: service, Metric: m.Name(), Kind: kind, Source: source, KindRank: rank,
						Scope: rules.StoredScopeName(scope.Name())}}
				d.metric_(m)
			}
		}
	}
	for _, p := range parts {
		b.Parts = append(b.Parts, p)
	}
	slices.SortFunc(b.Parts, func(x, y *TenantPart) int { return strings.Compare(x.Tenant, y.Tenant) })
	return b, nil
}

func tenantID(res pcommon.Map) (string, bool) {
	v, ok := res.Get(AttrTenantID)
	if !ok || v.Type() != pcommon.ValueTypeStr {
		return "", false
	}
	return canonicalUUID(v.Str())
}

// canonicalUUID validates a textual UUID (8-4-4-4-12 hex) and returns it in lower case.
func canonicalUUID(s string) (string, bool) {
	if len(s) != 36 {
		return "", false
	}
	for i := 0; i < 36; i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return "", false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return "", false
			}
		}
	}
	return strings.ToLower(s), true
}

func metricPoints(m pmetric.Metric) int {
	switch m.Type() {
	case pmetric.MetricTypeHistogram:
		return m.Histogram().DataPoints().Len()
	case pmetric.MetricTypeExponentialHistogram:
		return m.ExponentialHistogram().DataPoints().Len()
	case pmetric.MetricTypeSum:
		return m.Sum().DataPoints().Len()
	case pmetric.MetricTypeGauge:
		return m.Gauge().DataPoints().Len()
	case pmetric.MetricTypeSummary:
		return m.Summary().DataPoints().Len()
	}
	return 0
}

func resourcePoints(rm pmetric.ResourceMetrics) int {
	n := 0
	for _, sm := range rm.ScopeMetrics().All() {
		for _, m := range sm.Metrics().All() {
			n += metricPoints(m)
		}
	}
	return n
}

// dropResource counts every point of a resource under reason; counter points are attributed to their own
// service.name attribute.
func dropResource(part *TenantPart, rm pmetric.ResourceMetrics, service, reason string) {
	for _, sm := range rm.ScopeMetrics().All() {
		for _, m := range sm.Metrics().All() {
			if m.Name() == rules.MetricDropped && m.Type() == pmetric.MetricTypeSum {
				for _, dp := range m.Sum().DataPoints().All() {
					part.Drop(strAttr(dp.Attributes(), AttrServiceName), reason, 1)
				}
				continue
			}
			part.Drop(service, reason, int64(metricPoints(m)))
		}
	}
}

func strAttr(m pcommon.Map, k string) string {
	if v, ok := m.Get(k); ok && v.Type() == pcommon.ValueTypeStr {
		return v.Str()
	}
	return ""
}

func decodeCounters(part *TenantPart, m pmetric.Metric) {
	if m.Type() != pmetric.MetricTypeSum || m.Sum().AggregationTemporality() != pmetric.AggregationTemporalityDelta {
		part.Drop("", rules.ReasonMalformedPoint, int64(metricPoints(m)))
		return
	}
	for _, dp := range m.Sum().DataPoints().All() {
		reason := strAttr(dp.Attributes(), AttrReason)
		var n int64
		switch dp.ValueType() {
		case pmetric.NumberDataPointValueTypeInt:
			n = dp.IntValue()
		case pmetric.NumberDataPointValueTypeDouble:
			if f := dp.DoubleValue(); f >= 0 && f < math.MaxInt64 && f == math.Trunc(f) {
				n = int64(f)
			} else {
				n = -1
			}
		default:
			n = -1
		}
		if n < 0 || !rules.KnownReason(reason) {
			part.Drop("", rules.ReasonMalformedPoint, 1)
			continue
		}
		if n == 0 {
			continue
		}
		part.Counters = append(part.Counters, Counter{Service: strAttr(dp.Attributes(), AttrServiceName),
			Reason: reason, Count: n, Time: tsNano(dp.Timestamp())})
	}
}

func tsNano(t pcommon.Timestamp) int64 {
	if uint64(t) > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(t)
}

type decoder struct {
	part                            *TenantPart
	tenant, service, instance       string
	scopeName, scopeVersion, metric string
	tmpl                            Point
}

func unitFactor(unit string) (float64, bool) {
	switch unit {
	case "s":
		return 1, true
	case "ms": // the Collector converts legacy ms metrics; kept here in case one arrives unconverted
		return 0.001, true
	}
	return 0, false
}

func (d *decoder) malformed(n int) { d.part.Drop(d.service, rules.ReasonMalformedPoint, int64(n)) }

func (d *decoder) metric_(m pmetric.Metric) {
	factor, ok := unitFactor(m.Unit())
	if !ok {
		d.malformed(metricPoints(m))
		return
	}
	switch m.Type() {
	case pmetric.MetricTypeHistogram:
		h := m.Histogram()
		cum, ok := temporality(h.AggregationTemporality())
		if !ok {
			d.malformed(h.DataPoints().Len())
			return
		}
		for _, dp := range h.DataPoints().All() {
			d.explicit(dp, cum, factor)
		}
	case pmetric.MetricTypeExponentialHistogram:
		h := m.ExponentialHistogram()
		cum, ok := temporality(h.AggregationTemporality())
		if !ok {
			d.malformed(h.DataPoints().Len())
			return
		}
		for _, dp := range h.DataPoints().All() {
			d.exponential(dp, cum, factor)
		}
	default:
		d.malformed(metricPoints(m))
	}
}

func temporality(t pmetric.AggregationTemporality) (cumulative, ok bool) {
	switch t {
	case pmetric.AggregationTemporalityCumulative:
		return true, true
	case pmetric.AggregationTemporalityDelta:
		return false, true
	}
	return false, false
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// attrs fills the point's dimensions and returns false for a point that cannot be stored.
func (d *decoder) attrs(p *Point, a pcommon.Map) bool {
	p.Route = rules.RouteUnknown
	if v, ok := a.Get(AttrRoute); ok {
		if v.Type() != pcommon.ValueTypeStr || !rules.ValidRoute(v.Str()) {
			return false
		}
		p.Route = v.Str()
	}
	p.RulesVersion = strAttr(a, AttrRulesVersion)
	if !rulesVersionRE.MatchString(p.RulesVersion) {
		return false
	}
	p.Method = rules.MethodCode(strAttr(a, AttrMethod))
	if v, ok := a.Get(AttrStatus); ok {
		switch v.Type() {
		case pcommon.ValueTypeInt:
			p.Status = rules.StatusCode(v.Int(), true)
		case pcommon.ValueTypeStr:
			n, err := strconv.ParseInt(v.Str(), 10, 64)
			p.Status = rules.StatusCode(n, err == nil)
		case pcommon.ValueTypeDouble:
			f := v.Double()
			p.Status = rules.StatusCode(int64(f), f == math.Trunc(f))
		}
	}
	if v, ok := a.Get(AttrRPCMethod); ok && v.Type() == pcommon.ValueTypeStr {
		p.RPCMethod, p.HasRPC = v.Str(), true
	}
	if v, ok := a.Get(AttrMetricOverflow); ok && v.Type() == pcommon.ValueTypeBool && v.Bool() {
		p.Overflow = true
	}
	return true
}

// sortedKV renders every attribute as "key=value" (strings as is, ints in decimal, bools true/false, doubles in
// shortest form), sorted by key.
func sortedKV(a pcommon.Map) []string {
	keys := make([]string, 0, a.Len())
	for k := range a.All() {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	out := make([]string, len(keys))
	for i, k := range keys {
		v, _ := a.Get(k)
		out[i] = k + "=" + v.AsString()
	}
	return out
}

func (d *decoder) newPoint(a pcommon.Map, start, ts pcommon.Timestamp, cum bool) (Point, bool) {
	p := d.tmpl
	if !d.attrs(&p, a) || ts == 0 {
		return p, false
	}
	p.Cumulative = cum
	p.Snap.Start, p.Snap.Time = tsNano(start), tsNano(ts)
	if cum {
		p.attrKV = sortedKV(a)
	}
	return p, true
}

const flagNoRecordedValue = pmetric.DataPointFlags(1)

func (d *decoder) explicit(dp pmetric.HistogramDataPoint, cum bool, factor float64) {
	if dp.Flags()&flagNoRecordedValue != 0 {
		return
	}
	p, ok := d.newPoint(dp.Attributes(), dp.StartTimestamp(), dp.Timestamp(), cum)
	if !ok {
		d.malformed(1)
		return
	}
	snap, minV, maxV, ok := explicitSnapshot(dp, cum, factor)
	if !ok {
		d.malformed(1)
		return
	}
	snap.Start, snap.Time = p.Snap.Start, p.Snap.Time
	p.Snap, p.Min, p.Max = snap, minV, maxV
	d.emit(p, "x:"+formatBounds(snap.Bounds))
}

// explicitSnapshot validates an explicit-bucket point (bounds increasing and finite, counts adding up to count,
// finite sum) in seconds; min/max only for delta points. Start and Time are left to the caller.
func explicitSnapshot(dp pmetric.HistogramDataPoint, cum bool, factor float64) (s cumul.Snapshot, minV, maxV *float64, ok bool) {
	bounds := dp.ExplicitBounds().AsRaw()
	counts := dp.BucketCounts().AsRaw()
	if len(counts) == 0 && dp.Count() == 0 {
		counts = []uint64{0}
		bounds = nil
	}
	if len(counts) != len(bounds)+1 {
		return s, nil, nil, false
	}
	var total uint64
	for _, c := range counts {
		if total+c < total {
			return s, nil, nil, false
		}
		total += c
	}
	if total != dp.Count() {
		return s, nil, nil, false
	}
	for i := range bounds {
		bounds[i] *= factor
		if !finite(bounds[i]) || (i > 0 && bounds[i] <= bounds[i-1]) {
			return s, nil, nil, false
		}
	}
	s.Count = total
	s.Bounds, s.Buckets = bounds, counts
	if dp.HasSum() {
		if !finite(dp.Sum()) {
			return s, nil, nil, false
		}
		s.Sum = dp.Sum() * factor
	}
	if !cum {
		minV, maxV = optF(dp.HasMin(), dp.Min(), factor), optF(dp.HasMax(), dp.Max(), factor)
	}
	return s, minV, maxV, true
}

func optF(has bool, v, factor float64) *float64 {
	if !has || !finite(v) {
		return nil
	}
	x := v * factor
	return &x
}

func formatBounds(b []float64) string {
	var sb strings.Builder
	for i, v := range b {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(strconv.FormatFloat(v, 'g', -1, 64))
	}
	return sb.String()
}

func (d *decoder) exponential(dp pmetric.ExponentialHistogramDataPoint, cum bool, factor float64) {
	if dp.Flags()&flagNoRecordedValue != 0 {
		return
	}
	p, ok := d.newPoint(dp.Attributes(), dp.StartTimestamp(), dp.Timestamp(), cum)
	if !ok {
		d.malformed(1)
		return
	}
	snap, minV, maxV, ok := exponentialSnapshot(dp, cum, factor)
	if !ok {
		d.malformed(1)
		return
	}
	snap.Start, snap.Time = p.Snap.Start, p.Snap.Time
	p.Snap, p.Min, p.Max = snap, minV, maxV
	d.emit(p, "e")
}

// exponentialSnapshot validates an exponential point (scale −10…20, at most 640 positive buckets, an index range
// within float64 after the unit shift, finite sum) in seconds; min/max only for delta points.
func exponentialSnapshot(dp pmetric.ExponentialHistogramDataPoint, cum bool, factor float64) (s cumul.Snapshot, minV, maxV *float64, ok bool) {
	if dp.Scale() < -10 || dp.Scale() > 20 {
		return s, nil, nil, false
	}
	pos := dp.Positive().BucketCounts().AsRaw()
	if len(pos) > 640 {
		return s, nil, nil, false
	}
	var neg, total uint64
	for _, c := range dp.Negative().BucketCounts().All() {
		neg += c
	}
	total = neg + dp.ZeroCount()
	for _, c := range pos {
		total += c
	}
	off := int64(dp.Positive().Offset())
	if factor != 1 {
		off += hist.ShiftForUnit(factor, dp.Scale())
	}
	if lim := int64(1075) << max(dp.Scale(), 0); off < -lim || off+int64(len(pos)) > lim+1 || off < math.MinInt32 || off > math.MaxInt32 {
		return s, nil, nil, false
	}
	s.Exponential = true
	s.Scale, s.Offset = dp.Scale(), int32(off)
	s.Buckets, s.Zero, s.Negative, s.Count = pos, dp.ZeroCount(), neg, total
	if dp.HasSum() {
		if !finite(dp.Sum()) {
			return s, nil, nil, false
		}
		s.Sum = dp.Sum() * factor
	}
	if !cum {
		minV, maxV = optF(dp.HasMin(), dp.Min(), factor), optF(dp.HasMax(), dp.Max(), factor)
	}
	return s, minV, maxV, true
}

func (d *decoder) emit(p Point, layout string) {
	if p.Cumulative {
		p.StreamKey = d.streamKey(p, layout)
		p.SourceKey = d.sourceKey(p)
	}
	d.part.Points = append(d.part.Points, p)
}

// streamKey is wire-formats §g.4's key: SHA-256("scf-stream-v1" ‖ lp(tenant) ‖ lp(service) ‖ lp(instance) ‖
// lp(scope name) ‖ lp(scope version) ‖ lp(metric) ‖ lp(k=v)… sorted by key), where instance is scf.stream.instance
// unless "_", else "st:" ‖ start time in decimal (C-105). The writer appends lp("{layout}=" ‖ layout) — "x:" and the
// explicit bounds, or "e" for exponential — so that points of one stream key with different explicit bounds in one
// request (§g.2, C-113) keep separate cumulative state instead of resetting each other (§g.6).
func (d *decoder) streamKey(p Point, layout string) [32]byte {
	parts := append([]string{d.tenant, d.service, d.instanceOf(p), d.scopeName, d.scopeVersion, d.metric}, p.attrKV...)
	return lpHash("scf-stream-v1", append(parts, "{layout}="+layout)...)
}

// sourceKey identifies the source of a cumulative stream (C-122): SHA-256("scf-source-v1" ‖ lp(tenant) ‖
// lp(service) ‖ lp(instance) ‖ lp(scope name) ‖ lp(scope version) ‖ lp(metric) ‖ lp(rules version)) — the stream key
// without the data-point dimensions and the layout. An SDK exports every stream of a source at every interval, so a
// stream that first appears on a source we already receive holds only requests we have never counted. The rules
// version is part of the source because a new path-rule set renders existing routes anew (new stream keys whose
// history we have counted under the old keys); the instance is "st:<start>" without service.instance.id, as in the
// stream key. The domain prefix differs from the stream key's, so the two never collide.
func (d *decoder) sourceKey(p Point) [32]byte {
	return lpHash("scf-source-v1", d.tenant, d.service, d.instanceOf(p), d.scopeName, d.scopeVersion, d.metric,
		p.RulesVersion)
}

func (d *decoder) instanceOf(p Point) string {
	if d.instance == NoInstance {
		return "st:" + strconv.FormatInt(p.Snap.Start, 10)
	}
	return d.instance
}

// lpHash is SHA-256(prefix ‖ lp(part)…), lp(x) = uint32 BE byte length ‖ bytes.
func lpHash(prefix string, parts ...string) [32]byte {
	h := sha256.New()
	h.Write([]byte(prefix))
	var n [4]byte
	for _, s := range parts {
		binary.BigEndian.PutUint32(n[:], uint32(len(s)))
		h.Write(n[:])
		h.Write([]byte(s))
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
