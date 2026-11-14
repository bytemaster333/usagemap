// SPDX-License-Identifier: Apache-2.0

package rules

import (
	"os"
	"regexp"
	"testing"
)

func TestRankKeyAndScopePriority(t *testing.T) {
	cases := map[string]string{
		"@opentelemetry/instrumentation-express":                        "1|010|@opentelemetry/instrumentation-express",
		"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp": "1|050|go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp",
		"io.opentelemetry.tomcat-10.0":                                  "1|050|io.opentelemetry.tomcat-10.0",
		"Microsoft.AspNetCore.Hosting":                                  "1|010|Microsoft.AspNetCore.Hosting",
		StoredConnectorScope:                                            "1|100|scf/signal_to_metrics",
	}
	for scope, want := range cases {
		if got := RankKey(1, scope); got != want {
			t.Errorf("%s: %s, want %s", scope, got, want)
		}
	}
	if StoredScopeName(ConnectorScope) != StoredConnectorScope || StoredScopeName("x") != "x" {
		t.Fatal("connector scope mapping")
	}
}

func TestMethodStatusRPC(t *testing.T) {
	if MethodCode("") != 0 || MethodCode("_OTHER") != 0 || MethodCode("GET") != 1 || MethodCode("QUERY") != 10 {
		t.Fatal("method codes")
	}
	if StatusCode(0, false) != 0 || StatusCode(99, true) != 0 || StatusCode(600, true) != 0 || StatusCode(404, true) != 404 {
		t.Fatal("status codes")
	}
	if RPCMethod(false, "getHealth", true) != "" || RPCMethod(true, "getHealth", true) != "getHealth" ||
		RPCMethod(true, "drop_table", true) != "_OTHER" || RPCMethod(true, "", false) != "" {
		t.Fatal("rpc methods")
	}
}

func TestRoutePrefixes(t *testing.T) {
	for r, want := range map[string]string{"/a/b/c": "/a/b", "/a": "/", "/": "", RouteUnknown: "", RouteOverflow: ""} {
		if got := ParentPrefix(r); got != want {
			t.Errorf("ParentPrefix(%q) = %q, want %q", r, got, want)
		}
	}
	if SiblingOverflow("/") != "/{overflow}" || SiblingOverflow("/a") != "/a/{overflow}" {
		t.Fatal("sibling overflow")
	}
	if !GuardExempt("/a/{overflow}") || !GuardExempt(RouteUnknown) || GuardExempt("/a") {
		t.Fatal("exempt")
	}
	if LiteralChild("/a/{id}") || !LiteralChild("/a/b") {
		t.Fatal("literal child")
	}
	if !ValidRoute("/x") || ValidRoute("x") || ValidRoute("") || !ValidRoute(RouteUnknown) {
		t.Fatal("valid route")
	}
	if ValidServiceName("has space") || ValidServiceName("") || !ValidServiceName("{redacted}") {
		t.Fatal("service name")
	}
}

// Every reason the Collector's sanitise step emits as scf.ingest.dropped is one the writer stores (wire-formats §h.3);
// a new Collector reason without a writer entry would be silently ignored. ReasonNoTenant is the Collector's own
// self-metric only.
func TestKnowsEveryCollectorReason(t *testing.T) {
	src, err := os.ReadFile("../../../../collector/processor/scfsanitizeprocessor/reasons.go")
	if err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, m := range regexp.MustCompile(`(?m)^\s*(Reason\w+)\s*=\s*"([a-z0-9_]+)"`).FindAllStringSubmatch(string(src), -1) {
		if m[1] == "ReasonNoTenant" {
			continue
		}
		found++
		if !KnownReason(m[2]) {
			t.Errorf("collector reason %s = %q is not a known writer reason", m[1], m[2])
		}
	}
	if found < 10 {
		t.Fatalf("parsed only %d collector reasons", found)
	}
	if !KnownReason("route_seed_redacted") {
		t.Fatal("route_seed_redacted is not a known reason")
	}
}
