// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

var update = flag.Bool("update", false, "rewrite testdata/golden from the current output")

// Real SDK payloads from spikes S-06a/S-06b (testdata/sdk, see
// testdata/README.md). For each: the sanitised output equals the reviewed
// golden file, and the invariants below hold.

func fixtureRecv(maxTS int64) meta {
	m := defaultMeta()
	// The gateway received the request one minute after the newest point.
	m.receivedAt = strconv.FormatInt(maxTS+minute, 10)
	// The gateway sends the tenant's level from the snapshot (C-116).
	m.level = "L1"
	return m
}

func TestSDKFixturesMetrics(t *testing.T) {
	files, _ := filepath.Glob("testdata/sdk/*.metrics.json")
	if len(files) < 8 {
		t.Fatalf("expected the S-06 metric fixtures, found %d", len(files))
	}
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".metrics.json")
		t.Run(name, func(t *testing.T) {
			in, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(readFile(t, f))
			if err != nil {
				t.Fatal(err)
			}
			var maxTS int64
			forEachPoint(in, func(ts int64) { maxTS = max(maxTS, ts) })
			h := newHarness(t)
			out := h.runMetrics(fixtureRecv(maxTS), in)
			checkMetricInvariants(t, out)
			assertProtoAllowListMetrics(t, out, func(string, string) {})
			b := marshalMetrics(t, out)
			assertNoLeak(t, name, b, false)
			assertNoLeak(t, name, routesRemoved(b), true)
			golden(t, "testdata/golden/"+name+".metrics.json", b)
		})
	}
}

func TestSDKFixturesTraces(t *testing.T) {
	files, _ := filepath.Glob("testdata/sdk/*.traces.json")
	if len(files) < 10 {
		t.Fatalf("expected the S-06 trace fixtures, found %d", len(files))
	}
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".traces.json")
		t.Run(name, func(t *testing.T) {
			in, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(readFile(t, f))
			if err != nil {
				t.Fatal(err)
			}
			var maxTS int64
			for _, rs := range in.ResourceSpans().All() {
				for _, ss := range rs.ScopeSpans().All() {
					for _, sp := range ss.Spans().All() {
						maxTS = max(maxTS, int64(sp.EndTimestamp()))
					}
				}
			}
			h := newHarness(t)
			out := h.runTraces(fixtureRecv(maxTS), in)
			checkTraceInvariants(t, out)
			assertProtoAllowListTraces(t, out, func(string, string) {})
			b := marshalTraces(t, out)
			assertNoLeak(t, name, b, false)
			assertNoLeak(t, name, routesRemoved(b), true)
			golden(t, "testdata/golden/"+name+".traces.json", b)
		})
	}
}

// Expectations per fixture that the golden files must keep (C-102, C-105).
func TestSDKFixtureSpecifics(t *testing.T) {
	routes := func(t *testing.T, name string) map[string]int {
		t.Helper()
		b := readFile(t, "testdata/golden/"+name+".traces.json")
		td, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(b)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]int{}
		for _, rs := range td.ResourceSpans().All() {
			for _, ss := range rs.ScopeSpans().All() {
				for _, sp := range ss.Spans().All() {
					if r, ok := sp.Attributes().Get(AttrRoute); ok {
						out[r.Str()]++
					}
				}
			}
		}
		return out
	}
	tests := []struct {
		fixture string
		want    []string // routes that must appear
		absent  []string // routes that must not appear
	}{
		{"nextjs", []string{"/accounts/{id}", "/assets/{code}/{issuer}"}, []string{"/accounts/[id]"}},
		{"node-express", []string{"/accounts/{id}", "/assets/{code}/{issuer}"}, nil},
		{"python-default", []string{"/accounts/{account_id}"}, nil},
		// http.route "" on unmatched paths counts as absent: url.path is used (C-105).
		{"rust-tower", []string{"/does-not-exist/1CANARY", "/accounts/{id}"}, []string{""}},
		{"java-agent", []string{"/accounts/{id}"}, []string{"/**"}},
		// Go spans carry url.path only; the spike's made-up G… ids fail the StrKey checksum → {id}.
		{"go-otelhttp", []string{"/accounts/{id}", "/assets/USDC/{id}", "/health"}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			got := routes(t, tc.fixture)
			for _, r := range tc.want {
				if got[r] == 0 {
					t.Errorf("route %q missing; have %v", r, got)
				}
			}
			for _, r := range tc.absent {
				if got[r] != 0 {
					t.Errorf("route %q present", r)
				}
			}
		})
	}

	// Python's legacy ms histogram arrives in seconds with the legacy name.
	b := readFile(t, "testdata/golden/python-default.metrics.json")
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(b)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range md.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() == MetricServerDurationLegacy {
					found = true
					if m.Unit() != "s" || m.Histogram().DataPoints().At(0).ExplicitBounds().At(1) != 0.005 {
						t.Errorf("legacy metric not converted: unit %s", m.Unit())
					}
				}
			}
		}
	}
	if !found {
		t.Error("python-default lost http.server.duration")
	}
}

func forEachPoint(md pmetric.Metrics, fn func(ts int64)) {
	for _, r := range md.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				switch m.Type() {
				case pmetric.MetricTypeHistogram:
					for _, dp := range m.Histogram().DataPoints().All() {
						fn(int64(dp.Timestamp()))
					}
				case pmetric.MetricTypeExponentialHistogram:
					for _, dp := range m.ExponentialHistogram().DataPoints().All() {
						fn(int64(dp.Timestamp()))
					}
				case pmetric.MetricTypeSum:
					for _, dp := range m.Sum().DataPoints().All() {
						fn(int64(dp.Timestamp()))
					}
				case pmetric.MetricTypeGauge:
					for _, dp := range m.Gauge().DataPoints().All() {
						fn(int64(dp.Timestamp()))
					}
				}
			}
		}
	}
}

var (
	allowedResourceOut = map[string]bool{keyServiceName: true, keyServiceInstance: true, keyServiceNamespace: true, keyDeployEnvName: true,
		AttrTenantID: true, AttrReceivedAt: true, AttrStreamInstance: true, AttrTenantLevel: true}
	allowedPointOut = map[string]bool{AttrRoute: true, AttrRulesVersion: true, keyMethod: true, keyStatus: true,
		keyRPCMethod: true, keyRPCSystem: true, keyRPCSystemName: true, keyMetricOverflow: true}
	allowedCounterOut = map[string]bool{AttrReason: true, keyServiceName: true}
	allowedMarkerOut  = map[string]bool{AttrMarker: true, AttrReason: true, keyServiceName: true, AttrDroppedCount: true}
)

func checkMetricInvariants(t *testing.T, md pmetric.Metrics) {
	t.Helper()
	for _, r := range md.ResourceMetrics().All() {
		for k := range r.Resource().Attributes().All() {
			if !allowedResourceOut[k] {
				t.Errorf("resource attribute %q kept", k)
			}
		}
		if v, _ := r.Resource().Attributes().Get(AttrTenantID); v.Str() != testTenant {
			t.Errorf("tenant = %q", v.Str())
		}
		for _, sm := range r.ScopeMetrics().All() {
			if sm.Scope().Attributes().Len() != 0 {
				t.Error("scope attributes kept")
			}
			for _, m := range sm.Metrics().All() {
				switch m.Name() {
				case MetricIngestDropped:
					for _, dp := range m.Sum().DataPoints().All() {
						for k := range dp.Attributes().All() {
							if !allowedCounterOut[k] {
								t.Errorf("counter attribute %q", k)
							}
						}
					}
					continue
				case MetricServerDuration, MetricServerDurationLegacy:
				default:
					t.Errorf("metric %q kept", m.Name())
				}
				if m.Unit() != "s" || m.Description() != "" {
					t.Errorf("%s unit %q description %q", m.Name(), m.Unit(), m.Description())
				}
				for _, dp := range m.Histogram().DataPoints().All() {
					if dp.Exemplars().Len() != 0 {
						t.Error("exemplars kept")
					}
					for k := range dp.Attributes().All() {
						if !allowedPointOut[k] {
							t.Errorf("point attribute %q kept", k)
						}
					}
					if _, ok := dp.Attributes().Get(AttrRoute); !ok {
						t.Error("point without scf.route")
					}
				}
			}
		}
	}
}

func checkTraceInvariants(t *testing.T, td ptrace.Traces) {
	t.Helper()
	for _, rs := range td.ResourceSpans().All() {
		for k := range rs.Resource().Attributes().All() {
			if !allowedResourceOut[k] {
				t.Errorf("resource attribute %q kept", k)
			}
		}
		for _, ss := range rs.ScopeSpans().All() {
			marker := ss.Scope().Name() == ScopeName
			for _, sp := range ss.Spans().All() {
				allowed := allowedPointOut
				if marker {
					allowed = allowedMarkerOut
				} else if sp.Kind() != ptrace.SpanKindServer || sp.Name() != "" || sp.Events().Len() != 0 || sp.Links().Len() != 0 {
					t.Errorf("span not reduced: kind %v name %q", sp.Kind(), sp.Name())
				}
				for k := range sp.Attributes().All() {
					if !allowed[k] || (!marker && k == keyMetricOverflow) {
						t.Errorf("span attribute %q kept", k)
					}
				}
			}
		}
	}
}

// routesRemoved blanks scf.route values: the spikes named some request paths
// "…canary…" (e.g. /nope/unmatched-canary-path), and a path segment that is
// no identifier stays literal by design (pathnorm). Every other value must be
// free of canaries.
func routesRemoved(b []byte) []byte {
	return routeValue.ReplaceAll(b, []byte(`"key":"scf.route","value":{"stringValue":""}`))
}

var routeValue = regexp.MustCompile(`"key":"scf.route","value":\{"stringValue":"[^"]*"\}`)

// golden compares b (pretty-printed) with the file, or rewrites it with -update.
func golden(t *testing.T, path string, b []byte) {
	t.Helper()
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, b, "", " "); err != nil {
		t.Fatal(err)
	}
	pretty.WriteByte('\n')
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, pretty.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -run TestSDKFixtures -update and review the diff)", err)
	}
	if !bytes.Equal(want, pretty.Bytes()) {
		t.Fatalf("%s differs from the sanitised output; run go test -run TestSDKFixtures -update and review the diff", path)
	}
}
