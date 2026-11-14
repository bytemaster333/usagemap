// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"go.opentelemetry.io/collector/pdata/pcommon"

	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

// Attribute keys written by the sanitise step (wire-formats §f.5, §g.2).
const (
	AttrTenantID       = "scf.tenant.id"
	AttrReceivedAt     = "scf.received_at_unix_nano"
	AttrTenantLevel    = "scf.tenant.level" // int 0…3 from x-scf-tenant-level; absent when not valid (C-116)
	AttrStreamInstance = "scf.stream.instance"
	AttrRoute          = "scf.route"
	AttrRulesVersion   = "scf.rules_version"
	AttrReason         = "scf.reason"

	// Marker spans that carry the traces pipeline's drop counts to
	// signal_to_metrics (they never leave the Collector as spans).
	AttrMarker       = "scf.marker"
	AttrDroppedCount = "scf.dropped_count"
	MarkerDropped    = "ingest.dropped"

	// MetricIngestDropped is the tenant-visible drop counter (§g.2).
	MetricIngestDropped = "scf.ingest.dropped"
	// ScopeName is the instrumentation scope of everything the step itself creates.
	ScopeName = "scf/scfsanitize"
	// ScopeVersion is the version of the sanitise rules; bump it with any
	// change to the output for the same input.
	ScopeVersion = "1.3.0"

	// UnknownService replaces a missing or empty service.name (the OTel SDK default).
	UnknownService = "unknown_service"
	// NoInstance is scf.stream.instance when service.instance.id is absent or was redacted (§g.2): the writer then
	// tells streams apart by their start time (C-105).
	NoInstance = "_"
)

// Semantic-convention keys read by the step.
const (
	keyServiceName      = "service.name"
	keyServiceInstance  = "service.instance.id"
	keyServiceNamespace = "service.namespace"
	keyDeployEnvName    = "deployment.environment.name"
	keyDeployEnvLegacy  = "deployment.environment"

	keyHTTPRoute        = "http.route"
	keyURLPath          = "url.path"
	keyHTTPTarget       = "http.target"
	keyURLFull          = "url.full"
	keyHTTPURL          = "http.url"
	keyMethod           = "http.request.method"
	keyMethodLegacy     = "http.method"
	keyStatus           = "http.response.status_code"
	keyStatusLegacy     = "http.status_code"
	keyRPCMethod        = "rpc.method"
	keyRPCSystem        = "rpc.system"
	keyRPCSystemName    = "rpc.system.name"
	keyMetricOverflow   = "otel.metric.overflow"
	maxResourceValueLen = 256
	maxRPCValueLen      = 128
)

// knownMethods are the HTTP methods of the semantic conventions; anything
// else becomes _OTHER.
var knownMethods = map[string]struct{}{
	"CONNECT": {}, "DELETE": {}, "GET": {}, "HEAD": {}, "OPTIONS": {},
	"PATCH": {}, "POST": {}, "PUT": {}, "TRACE": {}, "QUERY": {},
}

// MethodOther is the canonical value of an unknown HTTP method.
const MethodOther = "_OTHER"

// cleanString returns s if it is valid UTF-8 without control characters
// (PostgreSQL text rejects NUL; the others have no place in an identifier)
// and at most maxLen bytes long.
func cleanString(s string, maxLen int) (string, bool) {
	if s == "" || len(s) > maxLen || !utf8.ValidString(s) {
		return "", false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return "", false
		}
	}
	return s, true
}

// strAttr returns the attribute's value if it is a string.
func strAttr(m pcommon.Map, key string) (string, bool) {
	v, ok := m.Get(key)
	if !ok || v.Type() != pcommon.ValueTypeStr {
		return "", false
	}
	return v.Str(), true
}

// ServiceNotAllowedName is the service.name under which drops of a
// non-allowed service are reported (C-114): the tenant-sent name is never
// echoed into the counters.
const ServiceNotAllowedName = "{not_allowed}"

// cleanResource holds the allow-listed resource values after sanitising.
type cleanResource struct {
	service          string
	namespace        string
	instance         string
	env              string
	hasNamespace     bool
	hasInstance      bool
	instanceRedacted bool
	hasEnv           bool
}

// resourceResult is the outcome of sanitising one resource.
type resourceResult struct {
	service    string // service.name after defaulting and classifying; used for drop counts
	reason     string // non-empty: drop the resource with this reason
	clean      cleanResource
	redactions int // free-text values replaced by Redacted
}

// sanitizeResource applies §f.5 steps 1–3 to a resource without modifying
// it: service check, allow-list, free-text classification (C-114). The output
// attributes are written by writeResource into a new resource, so nothing
// outside the allow-list (other attributes, dropped count, entity references)
// can pass.
func (rm *requestMeta) sanitizeResource(res pcommon.Resource) resourceResult {
	attrs := res.Attributes()
	raw, _ := strAttr(attrs, keyServiceName)
	if raw == "" {
		raw = UnknownService
	}
	if _, ok := cleanString(raw, maxResourceValueLen); !ok {
		// Never echo an unusable name back into the counters.
		return resourceResult{service: UnknownService, reason: ReasonMalformedPoint}
	}
	if !rm.serviceAllowed(raw) {
		return resourceResult{service: ServiceNotAllowedName, reason: ReasonServiceNotAllowed}
	}
	var out resourceResult
	var c cleanResource
	count := func(redacted bool) {
		if redacted {
			out.redactions++
		}
	}
	var red bool
	c.service, _, red = freeText(raw, maxResourceValueLen)
	count(red)
	optional := func(key string) (string, bool, bool) {
		s, ok := strAttr(attrs, key)
		if !ok {
			return "", false, false
		}
		v, ok, red := freeText(s, maxResourceValueLen)
		count(red)
		return v, ok, red
	}
	c.namespace, c.hasNamespace, _ = optional(keyServiceNamespace)
	c.instance, c.hasInstance, c.instanceRedacted = optional(keyServiceInstance)
	c.env, c.hasEnv, _ = optional(keyDeployEnvName)
	if !c.hasEnv {
		c.env, c.hasEnv, _ = optional(keyDeployEnvLegacy)
	}
	out.service = c.service
	out.clean = c
	return out
}

// writeResource writes the allow-listed attributes of c and the request
// stamps into dst (an empty map), in a fixed order.
func (rm *requestMeta) writeResource(dst pcommon.Map, c *cleanResource) {
	dst.EnsureCapacity(7)
	dst.PutStr(keyServiceName, c.service)
	if c.hasNamespace {
		dst.PutStr(keyServiceNamespace, c.namespace)
	}
	if c.hasInstance {
		dst.PutStr(keyServiceInstance, c.instance)
	}
	if c.hasEnv {
		dst.PutStr(keyDeployEnvName, c.env)
	}
	rm.stamp(dst)
	// A redacted instance id (an IP address or host:port — common for replicas — or anything else the classifier
	// replaced) would be the same "{redacted}" for every replica, so their cumulative streams would share one key and
	// read each other's exports as resets. It becomes "_" instead: the
	// writer then keys the streams by their start time (C-105), which separates the replicas without anything
	// derived from the address leaving this step.
	if c.hasInstance && !c.instanceRedacted {
		dst.PutStr(AttrStreamInstance, c.instance)
	} else {
		dst.PutStr(AttrStreamInstance, NoInstance)
	}
}

// stamp writes the attributes taken from the request metadata.
func (rm *requestMeta) stamp(attrs pcommon.Map) {
	attrs.PutStr(AttrTenantID, rm.tenant)
	attrs.PutInt(AttrReceivedAt, rm.receivedAt)
	if rm.hasLevel {
		attrs.PutInt(AttrTenantLevel, rm.level)
	}
}

// cleanScope is the allow-listed part of an instrumentation scope.
type cleanScope struct {
	name, version string
	redactions    int
}

// sanitizeScope returns the scope's name and version, classified like every
// kept free-text value (C-114); unusable values become "".
func sanitizeScope(sc pcommon.InstrumentationScope) cleanScope {
	var c cleanScope
	var red bool
	var ok bool
	if c.name, ok, red = freeText(sc.Name(), maxResourceValueLen); !ok {
		c.name = ""
	}
	if red {
		c.redactions++
	}
	if c.version, ok, red = freeText(sc.Version(), maxResourceValueLen); !ok {
		c.version = ""
	}
	if red {
		c.redactions++
	}
	return c
}

func (c *cleanScope) key() string { return lp(c.name) + lp(c.version) }

// attrMode selects the route inputs of §f.5 step 6.
type attrMode uint8

const (
	modeSpan   attrMode = iota // http.route → url.path → http.target → url.full/http.url
	modeMetric                 // http.route → http.target (legacy route template, C-102)
)

// routeInput reads http.route, treating "" (Rust on unmatched paths) and
// "/**" (Spring catch-all) as absent (C-105).
func routeInput(m pcommon.Map) string {
	r, _ := strAttr(m, keyHTTPRoute)
	if r == "/**" {
		return ""
	}
	return r
}

// pointResult is the outcome of sanitising one span's or point's attributes.
type pointResult struct {
	path       pathnorm.Result // pathnorm's result, for the redaction counts
	redactions int             // rpc.* values replaced by Redacted
}

// sanitizePointAttrs writes the allow-listed attributes of a span or data
// point into dst (an empty map of the new output object): scf.route +
// scf.rules_version from pathnorm, canonical method and status, rpc.* (strict
// character set, classified) and (metrics only) otel.metric.overflow. src is
// only read, so no other attribute — and no raw path input — can reach dst.
func sanitizePointAttrs(src, dst pcommon.Map, mode attrMode) pointResult {
	var out pointResult
	route := routeInput(src)
	target, _ := strAttr(src, keyHTTPTarget)
	switch mode {
	case modeMetric:
		if route == "" {
			route = target // old-convention SDKs put the route template here
		}
		out.path = pathnorm.NormalizeSpan(pathnorm.SpanInputs{Route: route})
	default:
		urlPath, _ := strAttr(src, keyURLPath)
		full, _ := strAttr(src, keyURLFull)
		if full == "" {
			full, _ = strAttr(src, keyHTTPURL)
		}
		out.path = pathnorm.NormalizeSpan(pathnorm.SpanInputs{Route: route, URLPath: urlPath, Target: target, URL: full})
	}

	dst.EnsureCapacity(8)
	dst.PutStr(AttrRoute, out.path.Route)
	dst.PutStr(AttrRulesVersion, pathnorm.RuleSetVersion)
	if method, ok := canonicalMethod(src); ok {
		dst.PutStr(keyMethod, method)
	}
	if status, ok := canonicalStatus(src); ok {
		dst.PutInt(keyStatus, status)
	}
	for _, key := range [...]string{keyRPCMethod, keyRPCSystem, keyRPCSystemName} {
		s, ok := strAttr(src, key)
		if !ok || len(s) > maxRPCValueLen || !rpcCharsetOK(s) {
			continue
		}
		if sensitiveValue(s) {
			s = Redacted
			out.redactions++
		}
		dst.PutStr(key, s)
	}
	if mode == modeMetric {
		if v, ok := src.Get(keyMetricOverflow); ok && v.Type() == pcommon.ValueTypeBool && v.Bool() {
			dst.PutBool(keyMetricOverflow, true)
		}
	}
	return out
}

// canonicalMethod reads http.request.method or legacy http.method and maps it
// to the upper-case known method or _OTHER.
func canonicalMethod(m pcommon.Map) (string, bool) {
	v, ok := strAttr(m, keyMethod)
	if !ok {
		v, ok = strAttr(m, keyMethodLegacy)
	}
	if !ok || v == "" {
		return "", false
	}
	if v == MethodOther {
		return v, true
	}
	if len(v) > 16 {
		return MethodOther, true
	}
	up := strings.ToUpper(v)
	if _, known := knownMethods[up]; known {
		return up, true
	}
	return MethodOther, true
}

// canonicalStatus reads http.response.status_code or legacy http.status_code
// (int, integral double or decimal string) and keeps it when it is 100–599.
func canonicalStatus(m pcommon.Map) (int64, bool) {
	v, ok := m.Get(keyStatus)
	if !ok {
		v, ok = m.Get(keyStatusLegacy)
	}
	if !ok {
		return 0, false
	}
	var n int64
	switch v.Type() {
	case pcommon.ValueTypeInt:
		n = v.Int()
	case pcommon.ValueTypeDouble:
		d := v.Double()
		if d != math.Trunc(d) {
			return 0, false
		}
		n = int64(d)
	case pcommon.ValueTypeStr:
		p, err := strconv.ParseInt(strings.TrimSpace(v.Str()), 10, 64)
		if err != nil {
			return 0, false
		}
		n = p
	default:
		return 0, false
	}
	if n < 100 || n > 599 {
		return 0, false
	}
	return n, true
}

// Sampling-threshold bound (C-114): a span counts at most MaxAdjustedCount
// times (signal_to_metrics' AdjustedCount() = 2^56 / (2^56 − T)). A larger
// threshold is lowered to maxThreshold, i.e. "ot=th:ffc".
const (
	MaxAdjustedCount     = 1024
	maxThreshold         = uint64(1)<<56 - uint64(1)<<56/MaxAdjustedCount
	MaxSamplingThreshold = "ot=th:ffc"
)

// sampledTraceState reduces a W3C tracestate to the OpenTelemetry sampling
// threshold ("ot=th:<hex>", canonical: lower-case, trailing zeros removed),
// which AdjustedCount() reads; every other vendor entry and sub-key is
// removed and the threshold is capped at MaxSamplingThreshold.
func sampledTraceState(ts string) string {
	for member := range strings.SplitSeq(ts, ",") {
		member = strings.TrimSpace(member)
		val, ok := strings.CutPrefix(member, "ot=")
		if !ok {
			continue
		}
		for sub := range strings.SplitSeq(val, ";") {
			th, ok := strings.CutPrefix(sub, "th:")
			if !ok || th == "" || len(th) > 14 {
				continue
			}
			var t uint64
			valid := true
			for i := range 14 {
				var d byte = '0'
				if i < len(th) {
					d = th[i]
				}
				switch {
				case d >= '0' && d <= '9':
					t = t<<4 | uint64(d-'0')
				case d >= 'a' && d <= 'f':
					t = t<<4 | uint64(d-'a'+10)
				default:
					valid = false
				}
			}
			if !valid {
				continue
			}
			t = min(t, maxThreshold)
			hex := strings.TrimRight(strconv.FormatUint(t|1<<56, 16)[1:], "0")
			if hex == "" {
				hex = "0"
			}
			return "ot=th:" + hex
		}
	}
	return ""
}
