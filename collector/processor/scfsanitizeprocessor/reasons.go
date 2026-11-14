// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"cmp"
	"slices"

	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

// Reason codes counted by the sanitise step (wire-formats §h.3). They are
// reported to the tenant as scf.ingest.dropped{scf.reason, service.name}.
// route_redacted counts points whose route had a value redacted; those points
// are kept. route_seed_redacted counts the subset of those points whose route
// held a Stellar secret seed (S…): a leaked credential the tenant must rotate,
// shown as its own warning (never the seed or any part of it).
const (
	ReasonServiceNotAllowed = "service_not_allowed"
	ReasonMetricNotAllowed  = "metric_not_allowed"
	ReasonClientMetric      = "client_metric_ignored"
	ReasonSpanNotServer     = "span_not_server"
	ReasonSpanNotLocalRoot  = "span_not_local_root"
	ReasonTooOld            = "too_old"
	ReasonFuture            = "future"
	ReasonRouteRedacted     = "route_redacted"
	ReasonRouteSeedRedacted = "route_seed_redacted"
	ReasonMalformedPoint    = "malformed_point"
)

// ReasonNoTenant is counted only in the Collector's own metrics: a request
// without a valid x-scf-tenant-id cannot be attributed to anybody.
const ReasonNoTenant = "no_tenant"

// tallyKey identifies one scf.ingest.dropped data point.
type tallyKey struct {
	service string
	reason  string
}

// tally counts drops of one request per (service.name, reason).
type tally struct {
	n map[tallyKey]int64
}

func (t *tally) add(service, reason string, n int64) {
	if n <= 0 {
		return
	}
	if t.n == nil {
		t.n = make(map[tallyKey]int64)
	}
	t.n[tallyKey{service, reason}] += n
}

func (t *tally) empty() bool { return len(t.n) == 0 }

type tallyEntry struct {
	tallyKey
	count int64
}

// entries returns the counts in a deterministic order (service, reason), so
// the same request always yields the same bytes (wire-formats §g.3 batch key).
func (t *tally) entries() []tallyEntry {
	out := make([]tallyEntry, 0, len(t.n))
	for k, v := range t.n {
		out = append(out, tallyEntry{k, v})
	}
	slices.SortFunc(out, func(a, b tallyEntry) int {
		return cmp.Or(cmp.Compare(a.service, b.service), cmp.Compare(a.reason, b.reason))
	})
	return out
}

// byReason sums the counts over services.
func (t *tally) byReason() map[string]int64 {
	out := make(map[string]int64)
	for k, v := range t.n {
		out[k.reason] += v
	}
	return out
}

// seedRedacted reports whether pathnorm redacted a Stellar secret seed from
// the route (route_seed_redacted).
func seedRedacted(r pathnorm.Result) bool { return r.Redactions.ByKind(pathnorm.KindStellarSeed) > 0 }
