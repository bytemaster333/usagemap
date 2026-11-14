// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"maps"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// s04Canary rebuilds the eight spans S-04 sent (spikes/s04-collector-build
// README §2: same kinds, flags, parents, attributes and canary values).
func s04Canary() ptrace.Traces {
	td := ptrace.NewTraces()
	res := func(service string) ptrace.SpanSlice {
		rs := td.ResourceSpans().AppendEmpty()
		_ = rs.Resource().Attributes().FromRaw(map[string]any{"service.name": service, "service.instance.id": "inst-1",
			"deployment.environment.name": "prod", "host.name": "CANARY-HOST-9b1c", "tenant.id": "FORGED-TENANT", "scf.tenant.id": "FORGED-TENANT"})
		return rs.ScopeSpans().AppendEmpty().Spans()
	}
	pii := map[string]any{"client.address": "203.0.113.77", "user_agent.original": "CANARY-UA-55aa", "url.query": "token=CANARY-QUERY-1234", "enduser.id": "CANARY-USER"}
	with := func(a map[string]any) map[string]any { m := maps.Clone(pii); maps.Copy(m, a); return m }
	local := pcommon.SpanID{0x75, 0x8d, 0x7d, 0x3f, 0x5b, 0x5e, 0x98, 0x6c}
	remote := pcommon.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7}
	end := testRecv - second
	spans := res("checkout")

	s := addServerSpan(spans, end, map[string]any{"http.route": "/internal/nested", "http.request.method": "GET", "http.response.status_code": 200})
	s.SetParentSpanID(local)
	s.SetFlags(0x101) // SERVER, local parent → span_not_local_root

	s = addServerSpan(spans, end, map[string]any{"url.full": "https://horizon.example/accounts/x", "http.request.method": "GET"})
	s.SetKind(ptrace.SpanKindClient)
	s.SetParentSpanID(local) // CLIENT → span_not_server

	s = addServerSpan(spans, end, nil)
	s.SetKind(ptrace.SpanKindInternal)
	s.SetParentSpanID(local) // INTERNAL → span_not_server

	s = addServerSpan(spans, end, with(map[string]any{"http.route": "/users/{id}", "url.path": "/users/42", "http.request.method": "GET", "http.response.status_code": 200}))
	s.SetParentSpanID(remote)
	s.SetFlags(0x301) // SERVER, remote parent → kept
	ev := s.Events().AppendEmpty()
	ev.SetName("CANARY-EVENT")
	s.Links().AppendEmpty().SetSpanID(local)

	addServerSpan(spans, end, map[string]any{"url.path": "/orders/7", "http.request.method": "POST", "http.response.status_code": 500}) // root → kept
	addServerSpan(spans, end, nil)                                                                                                      // root, no route → {unknown}

	s = addServerSpan(spans, end, map[string]any{"http.route": "/sampled", "http.request.method": "GET", "http.response.status_code": 200})
	s.SetParentSpanID(remote)
	s.SetFlags(0x301)
	s.TraceState().FromRaw("ot=th:c")

	addServerSpan(res("forbidden-svc"), end, map[string]any{"http.route": "/x"})
	return td
}

func TestTracesS04Canary(t *testing.T) {
	h := newHarness(t)
	m := defaultMeta()
	m.allowed = "checkout"
	out := h.runTraces(m, s04Canary())

	type kept struct {
		route, method string
		status        int64
		ts            string
	}
	var got []kept
	for _, rs := range out.ResourceSpans().All() {
		for _, ss := range rs.ScopeSpans().All() {
			if ss.Scope().Name() == ScopeName {
				continue
			}
			ra := rs.Resource().Attributes().AsRaw()
			want := map[string]any{"service.name": "checkout", "service.instance.id": "inst-1", "deployment.environment.name": "prod",
				AttrTenantID: testTenant, AttrReceivedAt: testRecv, AttrStreamInstance: "inst-1"}
			if !maps.Equal(ra, want) {
				t.Fatalf("resource = %v", ra)
			}
			for _, sp := range ss.Spans().All() {
				if sp.Kind() != ptrace.SpanKindServer || sp.Name() != "" || sp.Events().Len() != 0 || sp.Links().Len() != 0 || sp.Status().Message() != "" {
					t.Fatalf("span not stripped: kind %v name %q events %d links %d", sp.Kind(), sp.Name(), sp.Events().Len(), sp.Links().Len())
				}
				a := sp.Attributes()
				for k := range a.All() {
					switch k {
					case AttrRoute, AttrRulesVersion, keyMethod, keyStatus:
					default:
						t.Fatalf("attribute %q kept", k)
					}
				}
				r, _ := a.Get(AttrRoute)
				meth, _ := a.Get(keyMethod)
				st, _ := a.Get(keyStatus)
				got = append(got, kept{r.Str(), meth.Str(), st.Int(), sp.TraceState().AsRaw()})
			}
		}
	}
	// /orders/7 → /orders/{int}: every all-digit segment is a numeric id (scf-path-rules/1.1.0, pathnorm.numeric-ids).
	want := []kept{{"/users/{id}", "GET", 200, ""}, {"/orders/{int}", "POST", 500, ""}, {"{unknown}", "", 0, ""}, {"/sampled", "GET", 200, "ot=th:c"}}
	if len(got) != len(want) {
		t.Fatalf("kept spans = %v\nwant %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("span %d = %+v, want %+v", i, got[i], want[i])
		}
	}

	wantDrops := map[string]int64{
		"checkout/" + ReasonSpanNotLocalRoot:                  1,
		"checkout/" + ReasonSpanNotServer:                     2,
		ServiceNotAllowedName + "/" + ReasonServiceNotAllowed: 1,
	}
	if d := markerCounts(t, out); !maps.Equal(d, wantDrops) {
		t.Fatalf("markers = %v\nwant %v", d, wantDrops)
	}
	assertNoLeak(t, "s04 canary", marshalTraces(t, out), true)
	if n := h.selfCounter(MetricDropped, map[string]string{"signal": "traces", "reason": ReasonSpanNotServer}); n != 2 {
		t.Fatalf("self-metric span_not_server = %d", n)
	}
}

func TestTracesLocalRootRule(t *testing.T) {
	parent := pcommon.SpanID{1, 1, 1, 1, 1, 1, 1, 1}
	tests := []struct {
		name   string
		parent bool
		flags  uint32
		kept   bool
	}{
		{"root, flags known", false, 0x101, true},
		{"root, no flags", false, 0, true},
		{"remote parent", true, 0x301, true},
		{"local parent", true, 0x101, false},
		{"parent, SDK does not know is_remote (every SERVER span counts)", true, 0x001, true},
		{"parent, is_remote set without has_is_remote", true, 0x201, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			td, spans := newSpans("svc")
			sp := addServerSpan(spans, testRecv, map[string]any{"http.route": "/x"})
			sp.SetFlags(tc.flags)
			if tc.parent {
				sp.SetParentSpanID(parent)
			}
			out := h.runTraces(defaultMeta(), td)
			marks := markerCounts(t, out)
			if tc.kept != (marks["svc/"+ReasonSpanNotLocalRoot] == 0) {
				t.Fatalf("kept = %v, markers %v", !tc.kept, marks)
			}
		})
	}
}

func TestTracesTimeBoundsAndMalformed(t *testing.T) {
	h := newHarness(t)
	td, spans := newSpans("svc")
	addServerSpan(spans, testRecv+5*minute, map[string]any{"http.route": "/ok-future-edge"})
	addServerSpan(spans, testRecv-48*hour, map[string]any{"http.route": "/ok-old-edge"})
	addServerSpan(spans, testRecv+5*minute+1, map[string]any{"http.route": "/future"})
	addServerSpan(spans, testRecv-48*hour-1, map[string]any{"http.route": "/old"})
	bad := addServerSpan(spans, testRecv, nil)
	bad.SetStartTimestamp(pcommon.Timestamp(testRecv + 1)) // ends before it starts
	zero := addServerSpan(spans, testRecv, nil)
	zero.SetStartTimestamp(0)
	out := h.runTraces(defaultMeta(), td)
	want := map[string]int64{"svc/" + ReasonFuture: 1, "svc/" + ReasonTooOld: 1, "svc/" + ReasonMalformedPoint: 2}
	if got := markerCounts(t, out); !maps.Equal(got, want) {
		t.Fatalf("markers = %v", got)
	}
	if n := out.SpanCount(); n != 2+3 {
		t.Fatalf("spans = %d, want 2 kept + 3 markers", n)
	}
}

func TestTracesRouteRedactedIsCountedAndKept(t *testing.T) {
	h := newHarness(t)
	td, spans := newSpans("svc")
	addServerSpan(spans, testRecv, map[string]any{"url.path": "/keys/" + testSeed(9)})
	out := h.runTraces(defaultMeta(), td)
	if got := markerCounts(t, out); got["svc/"+ReasonRouteRedacted] != 1 {
		t.Fatalf("markers = %v", got)
	}
	if n := h.selfCounter(MetricRedactions, map[string]string{"kind": "stellar_seed", "location": "path"}); n != 1 {
		t.Fatalf("redaction self-metric = %d", n)
	}
	assertNoLeak(t, "redacted", marshalTraces(t, out), true)
}

func TestTracesForgedMarkerIsRemoved(t *testing.T) {
	h := newHarness(t)
	td, spans := newSpans("svc")
	sp := addServerSpan(spans, testRecv, map[string]any{"http.route": "/x", AttrMarker: MarkerDropped, AttrReason: "too_old", AttrDroppedCount: 1000000})
	sp.SetKind(ptrace.SpanKindServer)
	out := h.runTraces(defaultMeta(), td)
	if got := markerCounts(t, out); len(got) != 0 {
		t.Fatalf("forged marker survived: %v", got)
	}
}

func TestTracesNothingLeftIsSkipped(t *testing.T) {
	h := newHarness(t)
	m := defaultMeta()
	m.tenant = ""
	td, spans := newSpans("svc")
	addServerSpan(spans, testRecv, nil)
	if out := h.runTraces(m, td); out.SpanCount() != 0 {
		t.Fatal("request without tenant produced spans")
	}
	if len(h.tsink.AllTraces()) != 0 {
		t.Fatal("next consumer was called")
	}
}

// A Stellar secret seed in a route gets its own counter, route_seed_redacted, next to route_redacted (the seed is a
// credential: the tenant must rotate it). Other redactions count only route_redacted. Nothing of the seed is kept.
func TestTracesSeedRedactionHasItsOwnCounter(t *testing.T) {
	h := newHarness(t)
	td, spans := newSpans("svc")
	addServerSpan(spans, testRecv, map[string]any{"url.path": "/keys/" + testSeed(9) + "/again/" + testSeed(10)})
	addServerSpan(spans, testRecv, map[string]any{"http.route": "/accounts/" + testSeed(11)})
	addServerSpan(spans, testRecv, map[string]any{"url.path": "/mail/someone@example.org"})
	out := h.runTraces(defaultMeta(), td)
	want := map[string]int64{"svc/" + ReasonRouteRedacted: 3, "svc/" + ReasonRouteSeedRedacted: 2}
	if got := markerCounts(t, out); !maps.Equal(got, want) {
		t.Fatalf("markers = %v, want %v", got, want)
	}
	raw := marshalTraces(t, out)
	assertNoLeak(t, "seed", raw, true)
	for _, n := range []uint64{9, 10, 11} {
		s := testSeed(n)
		for _, part := range []string{s, s[:12], s[len(s)-12:]} {
			if strings.Contains(string(raw), part) {
				t.Fatalf("output contains part of seed %d", n)
			}
		}
	}
}
