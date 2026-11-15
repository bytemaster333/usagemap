// SPDX-License-Identifier: Apache-2.0

// Package policy decides, per caller certificate, which requests the engine proxy forwards
// (wire-formats §c.5, §j.2, §j.3; C-60, C-104, C-110(10), C-112(7), C-112(11)).
//
// Order of checks: caller identity (certificate) → path hygiene → the single deny-list (every caller) → the caller's
// allow-list (method, path and exact query parameters) → the bootstrap gate (non-provisioning callers wait for B5).
package policy

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Role is the caller class encoded in the node certificate.
type Role string

const (
	// RoleEdge: edge forwarders (`edge-*` nodes): POST /api/send and the internal edge API.
	RoleEdge Role = "edge"
	// RoleReader: control plane and jobs: the Umami read calls of §j.3 and the heartbeat.
	RoleReader Role = "reader"
	// RoleProvisioner: the provisioning worker (job umami_reconcile): §j.2 incl. bootstrap B1–B5, token purge.
	RoleProvisioner Role = "provisioner"
)

// Identity is the authenticated caller.
type Identity struct {
	Node string // certificate CommonName, a node or service name such as edge-a1
	Role Role   // from the certificate's single OrganizationalUnit
}

// nodeName is the one node-name pattern of the platform (C-114): 2 … 32 characters, lower-case letters, digits and
// hyphens, not starting with a hyphen. The control plane and the edge ledger use the same pattern.
var nodeName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,31}$`)

// IdentityFromCert maps a verified client certificate to a caller identity. The role is the certificate's single
// OrganizationalUnit (edge, reader or provisioner); the node name is its CommonName. An edge certificate must name an
// `edge-*` node (§c.5).
func IdentityFromCert(c *x509.Certificate) (Identity, error) {
	if c == nil {
		return Identity{}, errors.New("no client certificate")
	}
	cn := c.Subject.CommonName
	if !nodeName.MatchString(cn) {
		return Identity{}, errors.New("certificate CommonName is not a node name")
	}
	if len(c.Subject.OrganizationalUnit) != 1 {
		return Identity{}, errors.New("certificate must carry exactly one role (OU)")
	}
	r := Role(c.Subject.OrganizationalUnit[0])
	switch r {
	case RoleEdge:
		if !strings.HasPrefix(cn, "edge-") {
			return Identity{}, errors.New("edge role requires an edge-* node name")
		}
	case RoleReader, RoleProvisioner:
	default:
		return Identity{}, errors.New("unknown role")
	}
	return Identity{Node: cn, Role: r}, nil
}

// Target is where an allowed request goes.
type Target int

const (
	TargetNone         Target = iota
	TargetSend                // POST /api/send with the visit rule (§c.5)
	TargetUmami               // plain forward to Umami
	TargetControlPlane        // internal edge API on the local control plane
	TargetPurge               // handled by the proxy: visit-token purge
)

// Refusal reasons (metrics label values; closed set).
const (
	ReasonDenyList   = "deny_list"
	ReasonNotAllowed = "not_allowed"
	ReasonBadQuery   = "bad_query"
	ReasonBadPath    = "bad_path"
	ReasonGateClosed = "gate_closed"
)

// Decision is the outcome for one request.
type Decision struct {
	Allowed    bool
	Status     int    // HTTP status for a refusal
	Reason     string // refusal reason
	Route      string // route template for logs and metrics ("denied" for refusals); never a raw path or query
	Target     Target
	WebsiteID  string // website id for TargetPurge and P9
	PurgeAfter bool   // P9: drop the website's tokens again after Umami deleted it
	Login      bool   // POST /api/auth/login (the B5 check is recognised on it)
}

func refuse(status int, reason string) Decision {
	return Decision{Status: status, Reason: reason, Route: "denied"}
}

const uuidRe = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

// ---------------------------------------------------------------- the one deny-list (§c.5)

var denyPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^/api/batch(/|$)`),
	regexp.MustCompile(`^/api/record(/|$)`),
	regexp.MustCompile(`^/api/websites/[^/]+/(recorder|export|reset|shares)(/|$)`),
	regexp.MustCompile(`^/q(/|$)`),
	regexp.MustCompile(`^/p(/|$)`),
	regexp.MustCompile(`^/mcp(/|$)`),
	regexp.MustCompile(`^/share(/|$)`),
	regexp.MustCompile(`^/api/share`), // /api/share, /api/share/*, /api/shares …
	regexp.MustCompile(`^/api/teams/join(/|$)`),
	regexp.MustCompile(`^/(script|recorder|telemetry)\.js$`),
	regexp.MustCompile(`^/api/scripts(/|$)`),
	regexp.MustCompile(`^/openapi\.json$`),
	regexp.MustCompile(`^/_next/image(/|$)`),
	regexp.MustCompile(`^/login(/|$)`),
	regexp.MustCompile(`(^|/)2fa(/|$)`),      // /api/2fa/*, /api/admin/2fa/*, /api/admin/{users,teams}/*/2fa
	regexp.MustCompile(`^/api/reports(/|$)`), // report routes
	regexp.MustCompile(`^/api/websites/[^/]+/reports(/|$)`),
	regexp.MustCompile(`^/compat(/|$)`), // compat routes
}

var (
	authRoute     = regexp.MustCompile(`^/api/auth(/|$)`)
	passwordRoute = regexp.MustCompile(`^/api/me/password(/|$)`)
)

// denied applies the deny-list. /api/auth/* is denied except POST /api/auth/login for the provisioning identity;
// /api/me/password except POST for the provisioning identity while the bootstrap gate is closed (B2).
func denied(id Identity, method, p string, gateOpen bool) bool {
	lp := strings.ToLower(p)
	for _, re := range denyPatterns {
		if re.MatchString(lp) {
			return true
		}
	}
	if authRoute.MatchString(lp) {
		return !(id.Role == RoleProvisioner && method == http.MethodPost && p == "/api/auth/login")
	}
	if passwordRoute.MatchString(lp) {
		return !(id.Role == RoleProvisioner && method == http.MethodPost && p == "/api/me/password" && !gateOpen)
	}
	return false
}

// ---------------------------------------------------------------- allow-lists

type paramRule struct {
	required bool
	valid    func(string) bool
}

func oneOf(vals ...string) func(string) bool {
	return func(s string) bool {
		for _, v := range vals {
			if s == v {
				return true
			}
		}
		return false
	}
}

var digits = regexp.MustCompile(`^[0-9]{1,15}$`)

func unixMillis(s string) bool { return digits.MatchString(s) }

func intRange(lo, hi int) func(string) bool {
	return func(s string) bool {
		if !digits.MatchString(s) {
			return false
		}
		n, err := strconv.Atoi(s)
		return err == nil && n >= lo && n <= hi
	}
}

type route struct {
	method   string
	re       *regexp.Regexp
	template string
	target   Target
	params   map[string]paramRule // nil: no query string allowed
	purge    bool                 // capture group 1 is a website id to purge after success (P9)
	purgeNow bool                 // capture group 1 is a website id; the proxy purges itself
}

func r(method, pattern, template string, target Target, params map[string]paramRule) route {
	return route{method: method, re: regexp.MustCompile("^" + pattern + "$"), template: method + " " + template, target: target, params: params}
}

// Common parameters of every §j.3 read: startAt, endAt (Unix ms), timezone=UTC; optional tag=v.
func readParams(extra map[string]paramRule) map[string]paramRule {
	p := map[string]paramRule{
		"startAt":  {true, unixMillis},
		"endAt":    {true, unixMillis},
		"timezone": {true, oneOf("UTC")},
		"tag":      {false, oneOf("v")},
	}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

var limit500 = paramRule{false, intRange(1, 500)}

// Report reads R6–R8 (§j.3; Umami 3.5.0's ad-hoc GET routes, nothing stored in Umami): bounded step values.
const reportValueMax = 500

// reportValue: 1–500 bytes of valid UTF-8 without control characters (a page path or a custom event name).
func reportValue(s string) bool {
	if s == "" || len(s) > reportValueMax || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// funnelSteps: a JSON array of 2–8 objects with exactly `type` (path|event) and `value` — no step filters (event
// data properties are not a filter we use).
func funnelSteps(s string) bool {
	if len(s) > 8*(reportValueMax+64) {
		return false
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.DisallowUnknownFields()
	var steps []struct {
		Type  *string `json:"type"`
		Value *string `json:"value"`
	}
	if err := dec.Decode(&steps); err != nil || dec.More() {
		return false
	}
	if len(steps) < 2 || len(steps) > 8 {
		return false
	}
	for _, st := range steps {
		if st.Type == nil || st.Value == nil || (*st.Type != "path" && *st.Type != "event") || !reportValue(*st.Value) {
			return false
		}
	}
	return true
}

var allow = map[Role][]route{
	RoleEdge: {
		r("POST", `/api/send`, "/api/send", TargetSend, nil),
		r("GET", `/internal/v1/edge/snapshot`, "/internal/v1/edge/snapshot", TargetControlPlane, nil),
		r("POST", `/internal/v1/edge/counters`, "/internal/v1/edge/counters", TargetControlPlane, nil),
	},
	RoleReader: {
		r("GET", `/api/websites/(`+uuidRe+`)/stats`, "/api/websites/{id}/stats", TargetUmami, readParams(nil)),
		r("GET", `/api/websites/(`+uuidRe+`)/pageviews`, "/api/websites/{id}/pageviews", TargetUmami,
			readParams(map[string]paramRule{"unit": {true, oneOf("hour", "day")}})),
		r("GET", `/api/websites/(`+uuidRe+`)/metrics`, "/api/websites/{id}/metrics", TargetUmami,
			readParams(map[string]paramRule{"type": {true, oneOf("event")}, "limit": limit500})),
		r("GET", `/api/websites/(`+uuidRe+`)/metrics/expanded`, "/api/websites/{id}/metrics/expanded", TargetUmami,
			readParams(map[string]paramRule{
				"type":  {true, oneOf("referrer", "country", "device", "browser", "os", "path")},
				"limit": limit500,
			})),
		r("GET", `/api/websites/(`+uuidRe+`)/funnels/stats`, "/api/websites/{id}/funnels/stats", TargetUmami, // R6
			readParams(map[string]paramRule{
				"window": {true, intRange(1, 1440)},
				"steps":  {true, funnelSteps},
			})),
		r("GET", `/api/websites/(`+uuidRe+`)/goals/stats`, "/api/websites/{id}/goals/stats", TargetUmami, // R7
			readParams(map[string]paramRule{
				"type":  {true, oneOf("path", "event")},
				"value": {true, reportValue},
			})),
		r("GET", `/api/websites/(`+uuidRe+`)/journeys`, "/api/websites/{id}/journeys", TargetUmami, // R8
			readParams(map[string]paramRule{
				"steps":     {true, intRange(2, 7)},
				"startStep": {false, reportValue},
				"endStep":   {false, reportValue},
			})),
		r("GET", `/api/heartbeat`, "/api/heartbeat", TargetUmami, nil),
	},
	RoleProvisioner: {
		r("POST", `/api/auth/login`, "/api/auth/login", TargetUmami, nil),                       // B1, B5, P1, P5
		r("POST", `/api/me/password`, "/api/me/password", TargetUmami, nil),                     // B2 (deny-list limits it to the bootstrap)
		r("POST", `/api/users`, "/api/users", TargetUmami, nil),                                 // B3, P2
		r("DELETE", `/api/users/(`+uuidRe+`)`, "/api/users/{id}", TargetUmami, nil),             // B4, P11
		r("POST", `/api/teams`, "/api/teams", TargetUmami, nil),                                 // P3
		r("POST", `/api/teams/(`+uuidRe+`)/users`, "/api/teams/{id}/users", TargetUmami, nil),   // P4
		r("DELETE", `/api/teams/(`+uuidRe+`)`, "/api/teams/{id}", TargetUmami, nil),             // P11
		r("POST", `/api/me/api-keys`, "/api/me/api-keys", TargetUmami, nil),                     // P6
		r("DELETE", `/api/me/api-keys/(`+uuidRe+`)`, "/api/me/api-keys/{id}", TargetUmami, nil), // P10
		r("POST", `/api/websites`, "/api/websites", TargetUmami, nil),                           // P7, P7t
		r("POST", `/api/websites/(`+uuidRe+`)`, "/api/websites/{id}", TargetUmami, nil),         // P8
		{method: "DELETE", re: regexp.MustCompile(`^/api/websites/(` + uuidRe + `)$`), // P9
			template: "DELETE /api/websites/{id}", target: TargetUmami, purge: true},
		r("GET", `/api/users/(`+uuidRe+`)`, "/api/users/{id}", TargetUmami, nil),       // P13 (lookup before DELETE)
		r("GET", `/api/teams/(`+uuidRe+`)`, "/api/teams/{id}", TargetUmami, nil),       // P13
		r("GET", `/api/websites/(`+uuidRe+`)`, "/api/websites/{id}", TargetUmami, nil), // P13
		r("GET", `/api/admin/websites`, "/api/admin/websites", TargetUmami, map[string]paramRule{ // P12
			"page":     {false, intRange(1, 1_000_000)},
			"pageSize": {false, intRange(1, 1000)},
		}),
		r("GET", `/api/heartbeat`, "/api/heartbeat", TargetUmami, nil),
		{method: "DELETE", re: regexp.MustCompile(`^/internal/v1/visit-tokens/websites/(` + uuidRe + `)$`),
			template: "DELETE /internal/v1/visit-tokens/websites/{id}", target: TargetPurge, purgeNow: true},
	},
}

func queryOK(rawQuery string, rules map[string]paramRule) bool {
	if rules == nil {
		return rawQuery == ""
	}
	if rawQuery == "" {
		for _, pr := range rules {
			if pr.required {
				return false
			}
		}
		return true
	}
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return false
	}
	for k, vs := range q {
		pr, ok := rules[k]
		if !ok || len(vs) != 1 || !pr.valid(vs[0]) {
			return false
		}
	}
	for k, pr := range rules {
		if pr.required {
			if _, ok := q[k]; !ok {
				return false
			}
		}
	}
	return true
}

// cleanPath returns the request path if it is in canonical form: ASCII, no percent-encoding, no empty, "." or ".."
// segments, no trailing slash, no ';' or '\'. Anything else is refused rather than normalised.
func cleanPath(u *url.URL) (string, bool) {
	p := u.EscapedPath()
	if p == "" || p[0] != '/' || p != u.Path {
		return "", false
	}
	if len(p) > 1 && strings.HasSuffix(p, "/") {
		return "", false
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c < 0x21 || c > 0x7e || c == '%' || c == ';' || c == '\\' {
			return "", false
		}
	}
	for _, seg := range strings.Split(p[1:], "/") {
		if seg == "" && p != "/" || seg == "." || seg == ".." {
			return "", false
		}
	}
	return p, true
}

// Decide applies identity-specific policy to one request.
func Decide(id Identity, method string, u *url.URL, gateOpen bool) Decision {
	p, ok := cleanPath(u)
	if !ok {
		return refuse(http.StatusForbidden, ReasonBadPath)
	}
	if p != strings.ToLower(p) {
		// No allowed route or id contains upper case; case variants are refused, never guessed at.
		return refuse(http.StatusForbidden, ReasonBadPath)
	}
	if denied(id, method, p, gateOpen) {
		return refuse(http.StatusForbidden, ReasonDenyList)
	}
	for _, rt := range allow[id.Role] {
		m := rt.re.FindStringSubmatch(p)
		if m == nil || rt.method != method {
			continue
		}
		if !queryOK(u.RawQuery, rt.params) {
			return refuse(http.StatusForbidden, ReasonBadQuery)
		}
		if !gateOpen && id.Role != RoleProvisioner {
			return refuse(http.StatusServiceUnavailable, ReasonGateClosed)
		}
		d := Decision{Allowed: true, Route: rt.template, Target: rt.target, Login: rt.template == "POST /api/auth/login"}
		if rt.purge || rt.purgeNow {
			d.WebsiteID = m[1]
			d.PurgeAfter = rt.purge
		}
		return d
	}
	return refuse(http.StatusForbidden, ReasonNotAllowed)
}
