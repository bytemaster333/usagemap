// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

// Replicas whose service.instance.id looks like an IP address or host:port used to
// all become scf.stream.instance = "{redacted}" and share one cumulative stream key in the writer, which read their
// alternating exports as resets (100 of 900 requests counted). A redacted instance id now yields "_" — the writer's
// start-time identity (C-105) — while service.instance.id itself stays "{redacted}"; nothing derived from the address
// leaves the step.
func TestRedactedInstanceIDIsNoStreamIdentity(t *testing.T) {
	h := newHarness(t)
	for _, id := range []string{"10.0.3.7:8080", "10.0.3.7", "2001:db8::1", "[2001:db8::1]:443", "pod-10.0.3.7",
		"ops@example.com"} {
		t.Run(id, func(t *testing.T) {
			md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
			md.ResourceMetrics().At(0).Resource().Attributes().PutStr(keyServiceInstance, id)
			addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"})
			out := h.runMetrics(defaultMeta(), md)
			res := out.ResourceMetrics().At(0).Resource().Attributes()
			if got, _ := res.Get(AttrStreamInstance); got.Str() != NoInstance {
				t.Fatalf("scf.stream.instance = %q, want %q", got.Str(), NoInstance)
			}
			if got, _ := res.Get(keyServiceInstance); got.Str() != Redacted {
				t.Fatalf("service.instance.id = %q, want %q", got.Str(), Redacted)
			}
			if b := marshalMetrics(t, out); strings.Contains(string(b), "10.0.3") || strings.Contains(string(b), "2001:db8") ||
				strings.Contains(string(b), "example.com") {
				t.Fatalf("instance value leaked: %s", b)
			}
		})
	}
}

// Two replicas with IP-style instance ids in one request: their cumulative points keep their own start times (they
// are merged only when the start times are equal, as for resources without an instance id), so the writer keeps two
// streams.
func TestRedactedReplicasKeepSeparateStartTimes(t *testing.T) {
	h := newHarness(t)
	md := pmetric.NewMetrics()
	for i, id := range []string{"10.0.3.7:8080", "10.0.3.8:8080"} {
		one, dps := newHistMetrics("checkout", MetricServerDuration, "s")
		one.ResourceMetrics().At(0).Resource().Attributes().PutStr(keyServiceInstance, id)
		dp := addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"})
		dp.SetStartTimestamp(dp.StartTimestamp() - pcommon.Timestamp(int64(i)*minute))
		one.ResourceMetrics().MoveAndAppendTo(md.ResourceMetrics())
	}
	out := h.runMetrics(defaultMeta(), md)
	starts := map[uint64]bool{}
	for _, rm := range out.ResourceMetrics().All() {
		for _, sm := range rm.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				for _, dp := range m.Histogram().DataPoints().All() {
					starts[uint64(dp.StartTimestamp())] = true
				}
			}
		}
	}
	if len(starts) != 2 {
		t.Fatalf("%d distinct start times, want 2 (the replicas were merged)", len(starts))
	}
}

// A real (non-sensitive) instance id is still the stream identity.
func TestPlainInstanceIDIsTheStreamIdentity(t *testing.T) {
	h := newHarness(t)
	md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
	md.ResourceMetrics().At(0).Resource().Attributes().PutStr(keyServiceInstance, "checkout-7f9c-x2")
	addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"})
	out := h.runMetrics(defaultMeta(), md)
	if got, _ := out.ResourceMetrics().At(0).Resource().Attributes().Get(AttrStreamInstance); got.Str() != "checkout-7f9c-x2" {
		t.Fatalf("scf.stream.instance = %q", got.Str())
	}
}

// Finding 8: a "v"-prefixed four-part version is not an IPv4 address; real addresses, also embedded, still are.
func TestVersionTokensAreNotIPv4(t *testing.T) {
	for _, v := range []string{"v1.2.3.4", "V10.0.3.7", "release-v1.2.3.4", "lib v2.0.0.1"} {
		if sensitiveValue(v) {
			t.Errorf("%q redacted", v)
		}
	}
	for _, v := range []string{"10.0.3.7", "node-10.0.3.7", "1.2.3.4", "release-1.2.3.4", "x10.0.3.7", "10.0.3.7:8080"} {
		if !sensitiveValue(v) {
			t.Errorf("%q kept", v)
		}
	}
}
