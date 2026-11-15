// SPDX-License-Identifier: Apache-2.0

package policy

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

const wid = "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"

var (
	edge = Identity{Node: "edge-a1", Role: RoleEdge}
	rdr  = Identity{Node: "core-a-control-plane", Role: RoleReader}
	prov = Identity{Node: "core-a-umami-reconcile", Role: RoleProvisioner}
)

func decide(t *testing.T, id Identity, method, target string, gateOpen bool) Decision {
	t.Helper()
	u, err := url.ParseRequestURI(target)
	if err != nil {
		t.Fatalf("bad test URL %q: %v", target, err)
	}
	return Decide(id, method, u, gateOpen)
}

func TestIdentityFromCertificate(t *testing.T) {
	cases := []struct {
		cn      string
		ou      []string
		want    Identity
		wantErr bool
	}{
		{"edge-a1", []string{"edge"}, Identity{"edge-a1", RoleEdge}, false},
		{"core-a-control-plane", []string{"reader"}, Identity{"core-a-control-plane", RoleReader}, false},
		{"core-b-jobs", []string{"reader"}, Identity{"core-b-jobs", RoleReader}, false},
		{"core-a-umami-reconcile", []string{"provisioner"}, Identity{"core-a-umami-reconcile", RoleProvisioner}, false},
		{"core-a", []string{"edge"}, Identity{}, true},                 // edge role needs an edge-* node name (§c.5)
		{"edge-a1", nil, Identity{}, true},                             // no role
		{"edge-a1", []string{"edge", "provisioner"}, Identity{}, true}, // ambiguous
		{"edge-a1", []string{"admin"}, Identity{}, true},               // unknown role
		{"", []string{"reader"}, Identity{}, true},                     // no node name
		{"Edge A1", []string{"edge"}, Identity{}, true},                // not a node name
		// C-114: one node-name pattern everywhere, ^[a-z0-9][a-z0-9-]{1,31}$ (2 … 32 characters).
		{"r", []string{"reader"}, Identity{}, true},                                                                         // too short
		{"r1", []string{"reader"}, Identity{"r1", RoleReader}, false},                                                       // shortest
		{"-reader", []string{"reader"}, Identity{}, true},                                                                   // leading hyphen
		{"edge-" + strings.Repeat("a", 27), []string{"edge"}, Identity{"edge-" + strings.Repeat("a", 27), RoleEdge}, false}, // 32
		{"edge-" + strings.Repeat("a", 28), []string{"edge"}, Identity{}, true},                                             // 33 characters
		{"core-a-" + strings.Repeat("x", 40), []string{"reader"}, Identity{}, true},                                         // allowed by the old pattern
	}
	for _, c := range cases {
		cert := &x509.Certificate{Subject: pkix.Name{CommonName: c.cn, OrganizationalUnit: c.ou}}
		got, err := IdentityFromCert(cert)
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("IdentityFromCert(cn=%q ou=%v) = %+v, %v; want %+v, err=%v", c.cn, c.ou, got, err, c.want, c.wantErr)
		}
	}
	if _, err := IdentityFromCert(nil); err == nil {
		t.Error("nil certificate accepted")
	}
}

func TestEdgeAllowList(t *testing.T) {
	allowed := []struct{ m, u string }{
		{"POST", "/api/send"},
		{"GET", "/internal/v1/edge/snapshot"},
		{"POST", "/internal/v1/edge/counters"},
	}
	for _, a := range allowed {
		if d := decide(t, edge, a.m, a.u, true); !d.Allowed {
			t.Errorf("edge %s %s refused: %+v", a.m, a.u, d)
		}
	}
	refused := []struct{ m, u string }{
		{"GET", "/api/send"},
		{"POST", "/api/send?x=1"},
		{"GET", "/api/heartbeat"},
		{"GET", "/api/websites/" + wid + "/stats?startAt=1&endAt=2&timezone=UTC"},
		{"POST", "/api/auth/login"},
		{"POST", "/api/websites"},
		{"DELETE", "/internal/v1/visit-tokens/websites/" + wid},
		{"POST", "/internal/v1/edge/snapshot"},
		{"GET", "/internal/v1/edge/other"},
		{"GET", "/"},
	}
	for _, r := range refused {
		if d := decide(t, edge, r.m, r.u, true); d.Allowed || d.Status != http.StatusForbidden {
			t.Errorf("edge %s %s = %+v, want 403", r.m, r.u, d)
		}
	}
}

func TestEdgeTargets(t *testing.T) {
	if d := decide(t, edge, "POST", "/api/send", true); d.Target != TargetSend || d.Route != "POST /api/send" {
		t.Errorf("send decision = %+v", d)
	}
	if d := decide(t, edge, "GET", "/internal/v1/edge/snapshot", true); d.Target != TargetControlPlane {
		t.Errorf("snapshot decision = %+v", d)
	}
}

func TestReaderAllowListWithExactParameters(t *testing.T) {
	base := "/api/websites/" + wid
	r := "startAt=1794441600000&endAt=1794527999999&timezone=UTC"
	allowed := []string{
		base + "/stats?" + r,
		base + "/stats?" + r + "&tag=v",
		base + "/pageviews?" + r + "&unit=hour",
		base + "/pageviews?" + r + "&unit=day&tag=v",
		base + "/metrics?" + r + "&type=event&limit=500",
		base + "/metrics?" + r + "&type=event",
		base + "/metrics/expanded?" + r + "&type=referrer&limit=100",
		base + "/metrics/expanded?" + r + "&type=country&limit=500&tag=v",
		base + "/metrics/expanded?" + r + "&type=device",
		base + "/metrics/expanded?" + r + "&type=browser",
		base + "/metrics/expanded?" + r + "&type=os",
		base + "/metrics/expanded?" + r + "&type=path",
		"/api/heartbeat",
		// R6–R8 (report reads)
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape(`[{"type":"path","value":"/"},{"type":"event","value":"signup"}]`),
		base + "/funnels/stats?" + r + "&tag=v&window=1440&steps=" + url.QueryEscape(`[{"type":"path","value":"/a/*"},{"type":"path","value":"/b"}]`),
		base + "/goals/stats?" + r + "&type=path&value=" + url.QueryEscape("/docs/*"),
		base + "/goals/stats?" + r + "&tag=v&type=event&value=signup",
		base + "/journeys?" + r + "&steps=2",
		base + "/journeys?" + r + "&tag=v&steps=7&startStep=%2F&endStep=signup",
	}
	for _, u := range allowed {
		if d := decide(t, rdr, "GET", u, true); !d.Allowed {
			t.Errorf("reader GET %s refused: %+v", u, d)
		}
	}
	refused := []string{
		base + "/stats",                                         // no range
		base + "/stats?" + r + "&tag=s",                         // only tag=v is ever used
		base + "/stats?" + r + "&tag=v,s",                       // raw = no tag parameter
		base + "/stats?startAt=1&endAt=2&timezone=Europe/Paris", // timezone=UTC always
		base + "/stats?" + r + "&period=day",                    // never sent with an explicit range
		base + "/stats?" + r + "&url=/x",                        // no other filters
		base + "/stats?" + r + "&startAt=5",                     // duplicate parameter
		base + "/stats?startAt=abc&endAt=2&timezone=UTC",        // not a number
		base + "/pageviews?" + r + "&unit=month",                // §j.3: hour or day
		base + "/pageviews?" + r,                                // unit required
		base + "/metrics?" + r + "&type=url&limit=10",           // R3 is type=event only
		base + "/metrics?" + r + "&type=event&limit=501",        // limit ≤ 500
		base + "/metrics?" + r + "&type=event&limit=0",
		base + "/metrics/expanded?" + r + "&type=event", // not an expanded type
		base + "/metrics/expanded?" + r + "&type=query",
		base + "/funnels/stats?" + r + "&steps=" + url.QueryEscape(`[{"type":"path","value":"/"},{"type":"path","value":"/b"}]`), // window required
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape(`[{"type":"path","value":"/"}]`),                    // ≥ 2 steps
		base + "/funnels/stats?" + r + "&window=0&steps=" + url.QueryEscape(`[{"type":"path","value":"/"},{"type":"path","value":"/b"}]`),
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape(`[{"type":"url","value":"/"},{"type":"path","value":"/b"}]`),
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape(`[{"type":"event","value":"x","filters":[{"property":"a","operator":"eq","value":"b"}]},{"type":"path","value":"/b"}]`), // no step filters
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape(`[{"type":"path","value":""},{"type":"path","value":"/b"}]`),
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape(`[{"type":"path","value":"/"},{"type":"path","value":"/b"}] x`),
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape(`[{"type":"path","value":"/"},{"type":"path","value":"/b"}]`) + "&path=/x", // no filters
		base + "/funnels/stats?" + r + "&window=60&steps=" + url.QueryEscape("["+strings.Repeat(`{"type":"path","value":"/"},`, 8)+`{"type":"path","value":"/"}]`),
		base + "/goals/stats?" + r + "&type=url&value=/",
		base + "/goals/stats?" + r + "&type=path",
		base + "/goals/stats?" + r + "&type=path&value=" + url.QueryEscape("/a\nb"),
		base + "/goals/stats?" + r + "&type=path&value=" + strings.Repeat("a", 501),
		base + "/journeys?" + r,              // steps required
		base + "/journeys?" + r + "&steps=8", // 2–7
		base + "/journeys?" + r + "&steps=3&eventType=1",
		base + "/funnels?" + r, // stored definitions: never
		base + "/goals?" + r,
		base + "/retention?" + r,
		base + "/utm/metrics?" + r + "&type=utm_source",
		base + "/sessions?" + r,
		base + "/events?" + r,
		base + "/active",
		base + "/realtime",
		"/api/websites/not-a-uuid/stats?" + r,
		"/api/websites",
		"/api/me",
		"/api/admin/websites",
	}
	for _, u := range refused {
		if d := decide(t, rdr, "GET", u, true); d.Allowed || d.Status != http.StatusForbidden {
			t.Errorf("reader GET %s = %+v, want 403", u, d)
		}
	}
	for _, m := range []string{"POST", "DELETE", "PUT"} {
		if d := decide(t, rdr, m, base+"/stats?"+r, true); d.Allowed {
			t.Errorf("reader %s stats allowed", m)
		}
	}
	if d := decide(t, rdr, "POST", "/api/send", true); d.Allowed {
		t.Error("reader may not send events")
	}
}

func TestProvisionerAllowList(t *testing.T) {
	allowed := []struct{ m, u string }{
		{"POST", "/api/auth/login"},                        // B1, B5, P1, P5
		{"POST", "/api/users"},                             // B3, P2
		{"DELETE", "/api/users/" + wid},                    // B4, P11
		{"POST", "/api/teams"},                             // P3
		{"POST", "/api/teams/" + wid + "/users"},           // P4
		{"POST", "/api/me/api-keys"},                       // P6
		{"DELETE", "/api/me/api-keys/" + wid},              // P10
		{"POST", "/api/websites"},                          // P7, P7t
		{"POST", "/api/websites/" + wid},                   // P8
		{"DELETE", "/api/websites/" + wid},                 // P9
		{"DELETE", "/api/teams/" + wid},                    // P11
		{"GET", "/api/admin/websites?page=1&pageSize=100"}, // P12
		{"GET", "/api/admin/websites"},
		{"GET", "/api/heartbeat"},
		{"DELETE", "/internal/v1/visit-tokens/websites/" + wid},
	}
	for _, a := range allowed {
		if d := decide(t, prov, a.m, a.u, true); !d.Allowed {
			t.Errorf("provisioner %s %s refused: %+v", a.m, a.u, d)
		}
	}
	refused := []struct{ m, u string }{
		{"POST", "/api/send"},
		{"GET", "/internal/v1/edge/snapshot"},
		{"GET", "/api/users"},
		{"GET", "/api/users/" + wid + "/websites"},
		{"POST", "/api/users/" + wid},
		{"GET", "/api/admin/users"},
		{"GET", "/api/admin/websites?page=1&search=x"},
		{"POST", "/api/websites/" + wid + "/transfer"},
		{"GET", "/api/websites/" + wid + "/stats?startAt=1&endAt=2&timezone=UTC"},
		{"POST", "/api/auth/logout"},
		{"POST", "/api/auth/verify"},
		{"POST", "/api/auth/login?x=1"},
		{"DELETE", "/internal/v1/visit-tokens/websites/not-a-uuid"},
		{"POST", "/api/me/password"}, // only while the bootstrap gate is closed
	}
	for _, r := range refused {
		if d := decide(t, prov, r.m, r.u, true); d.Allowed || d.Status != http.StatusForbidden {
			t.Errorf("provisioner %s %s = %+v, want 403", r.m, r.u, d)
		}
	}
}

func TestProvisionerTargets(t *testing.T) {
	d := decide(t, prov, "DELETE", "/internal/v1/visit-tokens/websites/"+wid, true)
	if d.Target != TargetPurge || d.WebsiteID != wid {
		t.Errorf("purge decision = %+v", d)
	}
	d = decide(t, prov, "DELETE", "/api/websites/"+wid, true)
	if d.Target != TargetUmami || d.WebsiteID != wid || !d.PurgeAfter {
		t.Errorf("P9 decision = %+v", d)
	}
	d = decide(t, prov, "POST", "/api/auth/login", false)
	if !d.Allowed || !d.Login {
		t.Errorf("login decision = %+v", d)
	}
}

// The single deny-list of wire-formats §c.5 applies to every caller, before the allow-lists.
func TestDenyListAppliesToEveryCaller(t *testing.T) {
	denied := []struct{ m, u string }{
		{"POST", "/api/batch"},
		{"POST", "/api/record"},
		{"GET", "/api/record"},
		{"POST", "/api/websites/" + wid + "/recorder"},
		{"GET", "/api/websites/" + wid + "/export"},
		{"POST", "/api/websites/" + wid + "/reset"},
		{"GET", "/api/websites/" + wid + "/shares"},
		{"POST", "/api/websites/" + wid + "/shares"},
		{"GET", "/q/abc"},
		{"GET", "/p/abc"},
		{"GET", "/mcp"},
		{"POST", "/mcp"},
		{"GET", "/share/abc"},
		{"GET", "/api/share/abc"},
		{"GET", "/api/share/id/abc"},
		{"POST", "/api/teams/join"},
		{"GET", "/script.js"},
		{"GET", "/recorder.js"},
		{"GET", "/telemetry.js"},
		{"GET", "/api/scripts/telemetry"},
		{"GET", "/openapi.json"},
		{"GET", "/_next/image?url=%2Fx&w=64&q=75"},
		{"GET", "/login"},
		{"POST", "/api/2fa/verify"},
		{"POST", "/api/2fa/setup/initiate"},
		{"POST", "/api/admin/2fa/global"},
		{"POST", "/api/admin/users/" + wid + "/2fa"},
		{"GET", "/api/reports"},
		{"GET", "/compat/api/reports"},
		{"GET", "/compat/api/websites/" + wid + "/reports"},
		{"POST", "/api/auth/logout"},
		{"POST", "/api/auth/sso"},
		{"POST", "/api/auth/verify"},
	}
	for _, id := range []Identity{edge, rdr, prov} {
		for _, gate := range []bool{true, false} {
			for _, x := range denied {
				d := decide(t, id, x.m, x.u, gate)
				if d.Allowed || d.Status != http.StatusForbidden || d.Reason != ReasonDenyList {
					t.Errorf("%s %s %s (gate=%v) = %+v, want 403 deny_list", id.Role, x.m, x.u, gate, d)
				}
			}
		}
	}
}

func TestAuthRoutesOnlyForProvisioner(t *testing.T) {
	for _, id := range []Identity{edge, rdr} {
		for _, gate := range []bool{true, false} {
			if d := decide(t, id, "POST", "/api/auth/login", gate); d.Allowed || d.Reason != ReasonDenyList {
				t.Errorf("%s login = %+v", id.Role, d)
			}
			if d := decide(t, id, "POST", "/api/me/password", gate); d.Allowed || d.Reason != ReasonDenyList {
				t.Errorf("%s password = %+v", id.Role, d)
			}
		}
	}
	if d := decide(t, prov, "POST", "/api/me/password", false); !d.Allowed {
		t.Errorf("provisioner B2 during bootstrap refused: %+v", d)
	}
	if d := decide(t, prov, "POST", "/api/me/password", true); d.Allowed || d.Reason != ReasonDenyList {
		t.Errorf("provisioner password change after bootstrap = %+v", d)
	}
}

func TestBootstrapGate(t *testing.T) {
	// Closed gate: every non-provisioning caller gets 503 for an otherwise allowed call.
	if d := decide(t, edge, "POST", "/api/send", false); d.Allowed || d.Status != http.StatusServiceUnavailable || d.Reason != ReasonGateClosed {
		t.Errorf("edge send with closed gate = %+v", d)
	}
	if d := decide(t, rdr, "GET", "/api/heartbeat", false); d.Status != http.StatusServiceUnavailable {
		t.Errorf("reader heartbeat with closed gate = %+v", d)
	}
	// The provisioning worker is never held back by the gate.
	if d := decide(t, prov, "POST", "/api/users", false); !d.Allowed {
		t.Errorf("provisioner with closed gate = %+v", d)
	}
	// A path that is not allowed stays 403 even while the gate is closed.
	if d := decide(t, edge, "GET", "/api/heartbeat", false); d.Status != http.StatusForbidden {
		t.Errorf("edge disallowed path with closed gate = %+v", d)
	}
}

func TestPathTricksAreRefused(t *testing.T) {
	tricks := []string{
		"/api/send/",
		"//api/send",
		"/api//send",
		"/api/./send",
		"/api/x/../send",
		"/api/%73end",
		"/api/send%2f",
		"/API/send",
		"/api/send;x",
		"/api/batch%00",
		"/Api/Batch",
	}
	for _, p := range tricks {
		u := &url.URL{Path: p, RawPath: p}
		d := Decide(edge, "POST", u, true)
		if d.Allowed || d.Status != http.StatusForbidden {
			t.Errorf("POST %q = %+v, want 403", p, d)
		}
	}
}

func TestRoutesAreTemplatesWithoutIDsOrQueries(t *testing.T) {
	d := decide(t, rdr, "GET", "/api/websites/"+wid+"/stats?startAt=1&endAt=2&timezone=UTC&tag=v", true)
	if d.Route != "GET /api/websites/{id}/stats" {
		t.Errorf("route = %q", d.Route)
	}
	d = decide(t, edge, "GET", "/api/websites/"+wid+"/export", true)
	if d.Route != "denied" {
		t.Errorf("denied route label = %q", d.Route)
	}
}
