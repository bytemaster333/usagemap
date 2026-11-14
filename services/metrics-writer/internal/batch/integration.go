// SPDX-License-Identifier: Apache-2.0

package batch

import (
	"regexp"
	"strconv"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// IntegrationDims is the number of ordered dimension columns d1 … d7 of scf.integration_metrics_* (migration 0085).
const IntegrationDims = 7

// IntegrationPoint is one integration client-metric point (wire-formats §f.5 steps 4b–4d, §g.8; migration 0085): a
// partner-API call or anchor request (duration histogram), an anchor transfer duration (count and sum only), or a
// payment / anchor event (counter). Its dimensions are the closed sets the Collector applied; it never becomes API
// usage and never a Stellar client metric.
type IntegrationPoint struct {
	Service    string
	Metric     string // rules.IntegrationMetric
	Network    string
	Dims       [IntegrationDims]string // d1 … d7 of the metric's row in migration 0085's table header; "" = absent
	Histogram  bool                    // a duration (explicit15 unless Long)
	Long       bool                    // a long duration: count and sum only
	Cumulative bool
	StreamKey  [32]byte // cumulative only
	SourceKey  [32]byte // cumulative only: tenant, service, explicit instance (or none), scope
	Snap       cumul.Snapshot
	Min, Max   *float64 // delta histogram points only
}

// Attribute keys of the integration metrics (collector partner.go, payments.go, anchors.go).
const (
	attrPartner          = "stellar.partner"
	attrPartnerOperation = "stellar.partner.operation"
	attrPartnerOutcome   = "stellar.partner.outcome"
	attrPayProtocol      = "payment.protocol"
	attrPayStage         = "payment.stage"
	attrPayScheme        = "payment.scheme"
	attrPayMethod        = "payment.method"
	attrPayIntent        = "payment.intent"
	attrPayNetwork       = "payment.network"
	attrPayAsset         = "payment.asset"
	attrPayAmountBucket  = "payment.amount_bucket"
	attrPayReasonClass   = "payment.reason_class"
	attrSep              = "stellar.sep"
	attrAnchorStep       = "stellar.anchor.step"
	attrAnchorOutcome    = "stellar.anchor.outcome"
	attrAnchorHomeDomain = "stellar.anchor.home_domain"
	attrAnchorEvent      = "stellar.anchor.event"
	attrAnchorKind       = "stellar.anchor.kind"
	attrAnchorStatus     = "stellar.anchor.status"
	attrAnchorStatusFrom = "stellar.anchor.status_from"
	attrAnchorClient     = "stellar.anchor.client"
)

// integrationLayout maps a metric's dimension columns to attribute keys ("" = unused) and lists the required ones
// (0-based). Payments are mapped by payDims (two columns depend on the protocol and the stage).
type integrationLayout struct {
	keys     [IntegrationDims]string
	required []int
}

var integrationLayouts = map[string]integrationLayout{
	rules.MetricPartnerDuration: {[7]string{attrPartner, attrPartnerOperation, attrPartnerOutcome}, []int{0, 1, 2}},
	rules.MetricAnchorRequestDuration: {[7]string{attrSep, attrAnchorStep, attrAnchorOutcome, attrAnchorHomeDomain},
		[]int{0, 1, 2}},
	rules.MetricAnchorEvents:          {[7]string{attrAnchorEvent, attrSep, attrAnchorHomeDomain}, []int{0}},
	rules.MetricAnchorTransferCreated: {[7]string{attrSep, attrAnchorKind, "", "", attrAnchorClient}, []int{0, 1, 4}},
	rules.MetricAnchorTransitions: {[7]string{attrSep, attrAnchorKind, attrAnchorStatusFrom, attrAnchorStatus},
		[]int{0, 1, 2, 3}},
	rules.MetricAnchorStatusDuration:   {[7]string{attrSep, attrAnchorKind, "", attrAnchorStatus}, []int{0, 1, 3}},
	rules.MetricAnchorTransferDuration: {[7]string{attrSep, attrAnchorKind, "", attrAnchorStatus}, []int{0, 1, 3}},
	rules.MetricAnchorCustomerUpdates:  {[7]string{"", "", "", attrAnchorStatus, attrAnchorClient}, []int{3, 4}},
	rules.MetricAnchorQuotesCreated:    {[7]string{"", "", "", "", attrAnchorClient}, []int{4}},
}

var (
	// Storage backstops: the character classes and lengths of migration 0085's checks. d3 … d5 may hold an anchor's
	// public home domain or client name (≤ 253); no column holds a key-like run.
	dimShortRE = regexp.MustCompile(`^[A-Za-z0-9_./{}:-]{1,64}$`)
	dimLongRE  = regexp.MustCompile(`^[A-Za-z0-9_./{}:-]{1,253}$`)
	keyRunRE   = regexp.MustCompile(`(?i)[a-z2-7]{52}`)
	payNets    = map[string]bool{"stellar:pubnet": true, "stellar:testnet": true, "other": true, "unknown": true}
)

// payDims: protocol | stage | scheme (x402) or method (MPP) | intent | asset | amount_bucket or reason_class |
// error.type. Both of a column's sources present (never from the Collector) is malformed.
func payDims(a pcommon.Map) (d [IntegrationDims]string, ok bool) {
	d[0], d[1] = strAttr(a, attrPayProtocol), strAttr(a, attrPayStage)
	scheme, method := strAttr(a, attrPayScheme), strAttr(a, attrPayMethod)
	amount, reason := strAttr(a, attrPayAmountBucket), strAttr(a, attrPayReasonClass)
	if (scheme != "" && method != "") || (amount != "" && reason != "") {
		return d, false
	}
	d[2] = scheme + method
	d[3], d[4] = strAttr(a, attrPayIntent), strAttr(a, attrPayAsset)
	d[5] = amount + reason
	d[6] = strAttr(a, attrErrorType)
	return d, d[0] != "" && d[1] != ""
}

// integration decodes the points of one integration client metric.
func (d *decoder) integration(m pmetric.Metric) {
	name := m.Name()
	hist := rules.IntegrationDuration(name)
	d.clientPoints(m, hist, func(a pcommon.Map, start, ts pcommon.Timestamp, cum bool, snap cumul.Snapshot,
		minV, maxV *float64, layout string) bool {
		p := IntegrationPoint{Service: d.service, Metric: name, Histogram: hist,
			Long: rules.IntegrationLongDuration(name), Cumulative: cum}
		if !integrationDims(&p, a) {
			return false
		}
		snap.Start, snap.Time = tsNano(start), tsNano(ts)
		p.Snap, p.Min, p.Max = snap, minV, maxV
		d.emitIntegration(p, layout)
		return true
	})
}

// integrationDims fills network and d1 … d7 and returns false for a point that cannot be stored.
func integrationDims(p *IntegrationPoint, a pcommon.Map) bool {
	if p.Metric == rules.MetricPaymentEvents {
		p.Network = strAttr(a, attrPayNetwork)
		if !payNets[p.Network] {
			return false
		}
		dims, ok := payDims(a)
		if !ok {
			return false
		}
		p.Dims = dims
	} else {
		p.Network = strAttr(a, attrNetwork)
		if !networks[p.Network] {
			return false
		}
		l, ok := integrationLayouts[p.Metric]
		if !ok {
			return false
		}
		for i, k := range l.keys {
			if k != "" {
				p.Dims[i] = strAttr(a, k)
			}
		}
		for _, i := range l.required {
			if p.Dims[i] == "" {
				return false
			}
		}
	}
	for i, v := range p.Dims {
		if v == "" {
			continue
		}
		if keyRunRE.MatchString(v) {
			return false
		}
		if i >= 2 && i <= 4 {
			if !dimLongRE.MatchString(v) {
				return false
			}
		} else if !dimShortRE.MatchString(v) {
			return false
		}
	}
	return true
}

func (d *decoder) emitIntegration(p IntegrationPoint, layout string) {
	if p.Cumulative {
		inst := d.instance
		if inst == NoInstance {
			inst = "st:" + strconv.FormatInt(p.Snap.Start, 10)
		}
		parts := []string{d.tenant, d.service, inst, d.scopeName, d.scopeVersion, d.metric, "network=" + p.Network}
		for i, v := range p.Dims {
			parts = append(parts, "d"+strconv.Itoa(i+1)+"="+v)
		}
		p.StreamKey = lpHash("scf-integration-stream-v1", append(parts, "{layout}="+layout)...)
		// The source (C-122), as for the Stellar client metrics: the service (and its explicit instance) and scope —
		// one package's MeterProvider exports its metrics together.
		src := d.instance
		if src == NoInstance {
			src = ""
		}
		p.SourceKey = lpHash("scf-integration-source-v1", d.tenant, d.service, src, d.scopeName)
	}
	d.part.Integration = append(d.part.Integration, p)
}
