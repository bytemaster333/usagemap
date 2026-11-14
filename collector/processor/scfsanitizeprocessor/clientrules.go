// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"fmt"
	"slices"

	"go.opentelemetry.io/collector/pdata/pcommon"
)

// Strict allow-list steps for client-side metrics (wire-formats §f.5 step 4a
// and later steps 4b…). Each step is a compiled-in rule per metric name: the
// output name, unit and shape are constants of the rule, the point is kept only
// when it carries the rule's marker, and its attributes are rebuilt from closed
// sets (values outside them become "_OTHER" or a fixed default; any other key is
// never copied). Steps are off unless named in Config.ClientMetricSets (step 4a
// keeps its own switch, stellar_client_metrics), so a Collector never accepts a
// metric its writer cannot store. Adding a step is a contract change: a rule
// here, a set in clientMetricSets, the writer's mapping and wire-formats §f.5.
type clientRule interface {
	name() string
	unit() string
	// histogram: a duration histogram (unit s or ms, converted to s); else a
	// monotonic counter (int, or integral double ≤ 2^53).
	histogram() bool
	// marked reports whether a point belongs to this rule's instrumentation.
	marked(src pcommon.Map) bool
	// attrs writes the closed attribute set of src into dst (an empty map).
	attrs(src, dst pcommon.Map)
	// unmarkedReason is the drop reason of a point without the marker (step
	// 4a: client_metric_ignored, as any other client metric; later steps, whose
	// names are ours: metric_not_allowed).
	unmarkedReason() string
	// wrongShapeReason is the drop reason of a duration metric that is not a
	// histogram (step 4a: client_metric_ignored; later steps: malformed_point).
	wrongShapeReason() string
}

// stellarKind (step 4a) implements clientRule. Its counters carry no marker
// (stellar.network defaults to "unknown"), as before the framework existed.
func (k stellarKind) marked(src pcommon.Map) bool {
	return !k.histogram() || stellarMarked(k, src)
}
func (k stellarKind) attrs(src, dst pcommon.Map) { stellarAttrs(k, src, dst) }
func (stellarKind) unmarkedReason() string       { return ReasonClientMetric }
func (stellarKind) wrongShapeReason() string     { return ReasonClientMetric }

// clientMetricSets are the named sets Config.ClientMetricSets may enable,
// each mapping metric names to their rule.
var clientMetricSets = map[string]map[string]clientRule{
	ClientSetPartner:  {MetricPartnerDuration: partnerRule{}},
	ClientSetPayments: {MetricPaymentEvents: paymentRule{}},
}

// knownClientSets lists the names Validate accepts, sorted.
func knownClientSets() []string {
	out := make([]string, 0, len(clientMetricSets))
	for k := range clientMetricSets {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func validateClientSets(names []string) error {
	seen := map[string]bool{}
	for _, n := range names {
		if _, ok := clientMetricSets[n]; !ok {
			return fmt.Errorf("client_metric_sets: unknown set %q (known: %v)", n, knownClientSets())
		}
		if seen[n] {
			return fmt.Errorf("client_metric_sets: %q listed twice", n)
		}
		seen[n] = true
	}
	return nil
}

// clientRuleOf returns the rule for a metric name among the enabled sets.
func (s *sanitizer) clientRuleOf(name string) (clientRule, bool) {
	for _, set := range s.cfg.ClientMetricSets {
		if r, ok := clientMetricSets[set][name]; ok {
			return r, true
		}
	}
	return nil, false
}
