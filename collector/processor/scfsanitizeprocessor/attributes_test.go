// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"fmt"
	"maps"
	"slices"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"

	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

func TestSanitizePointAttrsRoutes(t *testing.T) {
	seed := testSeed(1)
	tests := []struct {
		name      string
		mode      attrMode
		in        map[string]any
		route     string
		redacted  bool
		wantOther map[string]any // other attributes expected besides scf.route/scf.rules_version
	}{
		{name: "span route wins over path", mode: modeSpan, in: map[string]any{"http.route": "/users/{id}", "url.path": "/users/42"}, route: "/users/{id}"},
		{name: "span express placeholder", mode: modeSpan, in: map[string]any{"http.route": "/accounts/:id"}, route: "/accounts/{id}"},
		{name: "span next.js bracket route (C-102)", mode: modeSpan, in: map[string]any{"http.route": "/accounts/[id]", "http.target": "/accounts/GA7Q?x=1"}, route: "/accounts/{id}"},
		{name: "span next.js catch-all bracket", mode: modeSpan, in: map[string]any{"http.route": "/docs/[...slug]"}, route: "/docs/{slug}"},
		{name: "span empty route is absent (Rust, C-105)", mode: modeSpan, in: map[string]any{"http.route": "", "url.path": "/accounts/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"}, route: "/accounts/{account}"},
		{name: "span /** route is absent (Spring, C-105)", mode: modeSpan, in: map[string]any{"http.route": "/**", "url.path": "/nope/unmatched-canary-path"}, route: "/nope/unmatched-canary-path"},
		{name: "span /** without path is unknown", mode: modeSpan, in: map[string]any{"http.route": "/**"}, route: "{unknown}"},
		{name: "span empty route without path is unknown", mode: modeSpan, in: map[string]any{"http.route": ""}, route: "{unknown}"},
		{name: "span nothing is unknown", mode: modeSpan, in: map[string]any{"http.request.method": "GET"}, route: "{unknown}", wantOther: map[string]any{"http.request.method": "GET"}},
		{name: "span legacy target with query (next.js raw path, C-102)", mode: modeSpan,
			in:    map[string]any{"http.target": "/accounts/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H?cursor=canary-cursor-91&email=canary%40example.com"},
			route: "/accounts/{account}"}, // the query is dropped; pathnorm counts only secrets found in it
		{name: "span seed in a query is dropped and counted", mode: modeSpan,
			in: map[string]any{"http.target": "/login?key=" + seed}, route: "/login", redacted: true},
		{name: "span url.full path", mode: modeSpan, in: map[string]any{"url.full": "https://horizon.example/accounts/x?token=CANARY"}, route: "/accounts/x"},
		{name: "span legacy http.url path", mode: modeSpan, in: map[string]any{"http.url": "http://127.0.0.1:18543/health"}, route: "/health"},
		{name: "span seed in path is redacted", mode: modeSpan, in: map[string]any{"url.path": "/keys/" + seed}, route: "/keys/{redacted}", redacted: true},
		{name: "span seed literal in route is redacted", mode: modeSpan, in: map[string]any{"http.route": "/keys/" + seed + "/{id}"}, route: "/keys/{redacted}/{id}", redacted: true},
		{name: "span e-mail in path is redacted", mode: modeSpan, in: map[string]any{"url.path": "/users/alice@example.com/orders"}, route: "/users/{redacted}/orders", redacted: true},
		{name: "span client sends {unknown} literally", mode: modeSpan, in: map[string]any{"http.route": "/{unknown}"}, route: "/{id}"},
		{name: "metric route", mode: modeMetric, in: map[string]any{"http.route": "/assets/{code}/{issuer}"}, route: "/assets/{code}/{issuer}"},
		{name: "metric legacy target is the route template (Python, C-102)", mode: modeMetric, in: map[string]any{"http.target": "/accounts/{account_id}"}, route: "/accounts/{account_id}"},
		{name: "metric route preferred over target", mode: modeMetric, in: map[string]any{"http.route": "/a/{id}", "http.target": "/b"}, route: "/a/{id}"},
		{name: "metric /** route falls back to target", mode: modeMetric, in: map[string]any{"http.route": "/**", "http.target": "/b"}, route: "/b"},
		{name: "metric url.path is not a metric input", mode: modeMetric, in: map[string]any{"url.path": "/users/42"}, route: "{unknown}"},
		{name: "metric nothing is unknown", mode: modeMetric, in: map[string]any{}, route: "{unknown}"},
		{name: "metric overflow flag kept", mode: modeMetric, in: map[string]any{"otel.metric.overflow": true}, route: "{unknown}", wantOther: map[string]any{"otel.metric.overflow": true}},
		{name: "metric overflow false dropped", mode: modeMetric, in: map[string]any{"otel.metric.overflow": false}, route: "{unknown}"},
		{name: "span overflow flag not kept", mode: modeSpan, in: map[string]any{"otel.metric.overflow": true}, route: "{unknown}"},
		{name: "rpc attributes kept", mode: modeSpan, in: map[string]any{"rpc.method": "GetAccount", "rpc.system": "grpc", "rpc.system.name": "grpc"}, route: "{unknown}",
			wantOther: map[string]any{"rpc.method": "GetAccount", "rpc.system": "grpc", "rpc.system.name": "grpc"}},
		{name: "never-kept attributes are removed", mode: modeSpan, in: map[string]any{
			"http.route": "/x", "client.address": "203.0.113.77", "user_agent.original": "CANARY-UA", "url.query": "token=CANARY",
			"enduser.id": "CANARY-USER", "server.address": "api.example", "server.port": 8443, "network.peer.address": "127.0.0.1",
			"http.host": "127.0.0.1:18542", "error.type": "Error", "tenant.id": "FORGED-TENANT", "scf.tenant.id": "FORGED-TENANT",
			"scf.route": "/forged", "scf.marker": "ingest.dropped", "exception.message": "boom", "http.request.header.authorization": []any{"Bearer x"},
		}, route: "/x"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := pcommon.NewMap()
			if err := m.FromRaw(tc.in); err != nil {
				t.Fatal(err)
			}
			dst := pcommon.NewMap()
			res := sanitizePointAttrs(m, dst, tc.mode).path
			got := dst.AsRaw()
			if got[AttrRoute] != tc.route {
				t.Errorf("scf.route = %v, want %q", got[AttrRoute], tc.route)
			}
			if got[AttrRulesVersion] != pathnorm.RuleSetVersion {
				t.Errorf("scf.rules_version = %v", got[AttrRulesVersion])
			}
			if (res.Redactions.Total() > 0) != tc.redacted {
				t.Errorf("redacted = %v, want %v", res.Redactions.Total() > 0, tc.redacted)
			}
			delete(got, AttrRoute)
			delete(got, AttrRulesVersion)
			want := tc.wantOther
			if want == nil {
				want = map[string]any{}
			}
			if !maps.EqualFunc(got, want, func(a, b any) bool { return a == b }) {
				t.Errorf("other attributes = %v, want %v", got, want)
			}
		})
	}
}

func TestCanonicalMethodAndStatus(t *testing.T) {
	tests := []struct {
		in         map[string]any
		method     any
		status     any
		noMethod   bool
		noStatusOK bool
	}{
		{in: map[string]any{"http.request.method": "GET", "http.response.status_code": 200}, method: "GET", status: int64(200)},
		{in: map[string]any{"http.method": "post", "http.status_code": "201"}, method: "POST", status: int64(201)},
		{in: map[string]any{"http.method": "PROPFIND", "http.status_code": 404.0}, method: "_OTHER", status: int64(404)},
		{in: map[string]any{"http.request.method": "_OTHER", "http.response.status_code": 99}, method: "_OTHER", noStatusOK: true},
		{in: map[string]any{"http.request.method": "GETGETGETGETGETGETGET", "http.response.status_code": "abc"}, method: "_OTHER", noStatusOK: true},
		{in: map[string]any{"http.response.status_code": 200.5}, noMethod: true, noStatusOK: true},
		{in: map[string]any{"http.request.method": "Query", "http.response.status_code": 600}, method: "QUERY", noStatusOK: true},
		{in: map[string]any{"http.request.method": 7, "http.response.status_code": true}, noMethod: true, noStatusOK: true},
	}
	for i, tc := range tests {
		m := pcommon.NewMap()
		_ = m.FromRaw(tc.in)
		dst := pcommon.NewMap()
		sanitizePointAttrs(m, dst, modeMetric)
		got := dst.AsRaw()
		if v, ok := got[keyMethod]; tc.noMethod == ok || (!tc.noMethod && v != tc.method) {
			t.Errorf("%d: method = %v (present %v), want %v", i, v, ok, tc.method)
		}
		if v, ok := got[keyStatus]; tc.noStatusOK == ok || (!tc.noStatusOK && v != tc.status) {
			t.Errorf("%d: status = %v (present %v), want %v", i, v, ok, tc.status)
		}
		for _, legacy := range []string{keyMethodLegacy, keyStatusLegacy} {
			if _, ok := got[legacy]; ok {
				t.Errorf("%d: legacy %s kept", i, legacy)
			}
		}
	}
}

func TestSampledTraceState(t *testing.T) {
	tests := map[string]string{
		"":                                 "",
		"ot=th:c":                          "ot=th:c",
		"vendor=abc,ot=rv:1234;th:8,x=y":   "ot=th:8",
		"ot=th:C":                          "",
		"ot=th:0123456789abcde":            "",
		"ot=th:80000000000000":             "ot=th:8",
		"ot=th:ffffffffffffff":             MaxSamplingThreshold,
		"ot=th:0":                          "ot=th:0",
		"ot=th:00":                         "ot=th:0",
		"ot=rv:abcd":                       "",
		"congo=t61rcWkgMzE, rojo=00f067aa": "",
		" ot=th:fd ":                       "ot=th:fd",
	}
	for in, want := range tests {
		if got := sampledTraceState(in); got != want {
			t.Errorf("sampledTraceState(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeResource(t *testing.T) {
	rm := requestMeta{tenant: testTenant, allowAll: true, receivedAt: testRecv}
	tests := []struct {
		name   string
		in     map[string]any
		meta   requestMeta
		reason string
		want   map[string]any
	}{
		{
			name: "allow-list, overwrite tenant, stamp receipt and stream instance",
			in: map[string]any{"service.name": "checkout", "service.instance.id": "inst-1", "service.namespace": "shop",
				"deployment.environment.name": "prod", "host.name": "CANARY-HOST", "tenant.id": "FORGED-TENANT", "scf.tenant.id": "FORGED-TENANT",
				"scf.received_at_unix_nano": 1, "scf.stream.instance": "forged", "scf.tenant.level": 3, "process.command_args": []any{"node", "app.js"},
				"telemetry.sdk.language": "go", "container.id": "abc", "os.type": "linux"},
			meta: rm,
			want: map[string]any{"service.name": "checkout", "service.instance.id": "inst-1", "service.namespace": "shop",
				"deployment.environment.name": "prod", AttrTenantID: testTenant, AttrReceivedAt: testRecv, AttrStreamInstance: "inst-1"},
		},
		{
			name: "tenant level stamped from the metadata, a forged one replaced (C-116)",
			in:   map[string]any{"service.name": "checkout", "scf.tenant.level": 3},
			meta: requestMeta{tenant: testTenant, allowAll: true, receivedAt: testRecv, level: 0, hasLevel: true},
			want: map[string]any{"service.name": "checkout", AttrTenantID: testTenant, AttrReceivedAt: testRecv,
				AttrStreamInstance: NoInstance, AttrTenantLevel: int64(0)},
		},
		{
			name: "legacy deployment.environment renamed, no instance",
			in:   map[string]any{"service.name": "checkout", "deployment.environment": "staging"},
			meta: rm,
			want: map[string]any{"service.name": "checkout", "deployment.environment.name": "staging", AttrTenantID: testTenant,
				AttrReceivedAt: testRecv, AttrStreamInstance: NoInstance},
		},
		{
			name: "missing service.name becomes unknown_service",
			in:   map[string]any{"service.instance.id": 12},
			meta: rm,
			want: map[string]any{"service.name": UnknownService, AttrTenantID: testTenant, AttrReceivedAt: testRecv, AttrStreamInstance: NoInstance},
		},
		{
			name: "control characters in an optional value drop it",
			in:   map[string]any{"service.name": "checkout", "service.namespace": "a\x00b"},
			meta: rm,
			want: map[string]any{"service.name": "checkout", AttrTenantID: testTenant, AttrReceivedAt: testRecv, AttrStreamInstance: NoInstance},
		},
		{
			// A redacted instance id is no stream identity: "_" (start-time identity).
			name: "free-text values are classified (C-114)",
			in:   map[string]any{"service.name": "checkout", "service.namespace": "alice@example.com", "service.instance.id": "203.0.113.77:8080"},
			meta: rm,
			want: map[string]any{"service.name": "checkout", "service.namespace": Redacted, "service.instance.id": Redacted,
				AttrTenantID: testTenant, AttrReceivedAt: testRecv, AttrStreamInstance: NoInstance},
		},
		{name: "service not allowed", in: map[string]any{"service.name": "forbidden-svc"}, meta: requestMeta{tenant: testTenant, allowed: map[string]struct{}{"checkout": {}}}, reason: ReasonServiceNotAllowed},
		{name: "service name with NUL is malformed", in: map[string]any{"service.name": "a\x00"}, meta: rm, reason: ReasonMalformedPoint},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := pcommon.NewResource()
			_ = res.Attributes().FromRaw(tc.in)
			before := res.Attributes().AsRaw()
			out := tc.meta.sanitizeResource(res)
			if !maps.EqualFunc(before, res.Attributes().AsRaw(), func(a, b any) bool { return fmt.Sprint(a) == fmt.Sprint(b) }) {
				t.Fatal("input resource modified")
			}
			if out.reason != tc.reason {
				t.Fatalf("reason = %q, want %q", out.reason, tc.reason)
			}
			if tc.reason != "" {
				return
			}
			dst := pcommon.NewResource()
			tc.meta.writeResource(dst.Attributes(), &out.clean)
			res = dst
			got := res.Attributes().AsRaw()
			if !maps.EqualFunc(got, tc.want, func(a, b any) bool { return a == b }) {
				t.Errorf("attributes = %v\nwant %v", got, tc.want)
			}
			// Deterministic order, so equal input yields equal bytes.
			keys := slices.Collect(maps.Keys(got))
			if len(keys) != res.Attributes().Len() {
				t.Errorf("duplicate keys")
			}
		})
	}
}
