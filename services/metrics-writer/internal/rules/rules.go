// SPDX-License-Identifier: Apache-2.0

// Package rules holds the writer's closed sets and small deterministic rules: metric names and stream-group kinds
// (wire-formats §g.2), scope priority and rank keys (§g.5, C-22), HTTP method codes (data-model §7), the Stellar RPC
// method set (ADR-0012), data-quality reasons (§h.3) and route prefixes for the cardinality guard (C-24).
package rules

import (
	"fmt"
	"strings"
)

// Metric names accepted by the writer (wire-formats §g.2).
const (
	MetricStable      = "http.server.request.duration"
	MetricLegacy      = "http.server.duration"
	MetricSpanDerived = "scf.span.server.duration"
	MetricDropped     = "scf.ingest.dropped"
)

// Stream-group kinds (scf.stream_kind) and metric sources (scf.metric_source).
const (
	KindSDKStable   = "sdk_stable"
	KindSDKLegacy   = "sdk_legacy"
	KindSpanDerived = "span_derived"

	SourceSDK         = "sdk_metric"
	SourceSpanDerived = "span_derived"
)

// GroupKind returns the stream-group kind, metric source and kind rank of a histogram metric name.
func GroupKind(metric string) (kind, source string, rank int, ok bool) {
	switch metric {
	case MetricStable:
		return KindSDKStable, SourceSDK, 1, true
	case MetricLegacy:
		return KindSDKLegacy, SourceSDK, 2, true
	case MetricSpanDerived:
		return KindSpanDerived, SourceSpanDerived, 3, true
	}
	return "", "", 0, false
}

// ConnectorScope is the fixed scope name of span-derived points; the writer stores it as StoredConnectorScope (C-107).
const (
	ConnectorScope       = "github.com/open-telemetry/opentelemetry-collector-contrib/connector/signaltometricsconnector"
	StoredConnectorScope = "scf/signal_to_metrics"
	SanitizeScope        = "scf/scfsanitize"
)

// StoredScopeName maps a received scope name to the name stored in api_stream_groups.
func StoredScopeName(name string) string {
	if name == ConnectorScope {
		return StoredConnectorScope
	}
	return name
}

// Scope priority prefixes (wire-formats §g.5); first match wins; everything else is 100. Versioned with the writer.
var scopePriority = []struct {
	prio     int
	prefixes []string
}{
	{10, []string{
		"@opentelemetry/instrumentation-express", "@fastify/otel", "@opentelemetry/instrumentation-fastify",
		"@opentelemetry/instrumentation-koa", "@opentelemetry/instrumentation-nestjs-core",
		"opentelemetry.instrumentation.django", "opentelemetry.instrumentation.fastapi",
		"opentelemetry.instrumentation.flask", "Microsoft.AspNetCore", "io.opentelemetry.spring-webmvc",
		"io.opentelemetry.spring-webflux", "go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic",
		"go.opentelemetry.io/contrib/instrumentation/github.com/gorilla/mux",
		"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo",
		"opentelemetry-instrumentation-actix-web", "opentelemetry-instrumentation-tower", "tower-http", "axum",
	}},
	{50, []string{
		"@opentelemetry/instrumentation-http", "opentelemetry.instrumentation.asgi",
		"opentelemetry.instrumentation.wsgi", "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp",
		"io.opentelemetry.tomcat", "io.opentelemetry.netty", "io.opentelemetry.jetty",
	}},
}

// ScopePriority returns the priority (10, 50 or 100) of a stored scope name.
func ScopePriority(scope string) int {
	for _, p := range scopePriority {
		for _, pre := range p.prefixes {
			if strings.HasPrefix(scope, pre) {
				return p.prio
			}
		}
	}
	return 100
}

// RankKey is api_stream_groups.rank_key: kind rank ‖ '|' ‖ lpad(priority, 3, '0') ‖ '|' ‖ scope name.
func RankKey(kindRank int, scope string) string {
	return fmt.Sprintf("%d|%03d|%s", kindRank, ScopePriority(scope), scope)
}

// MethodCode maps a canonical method (or "" when absent) to data-model §7's smallint code; absent → 0 (_OTHER).
func MethodCode(m string) int16 {
	switch m {
	case "GET":
		return 1
	case "HEAD":
		return 2
	case "POST":
		return 3
	case "PUT":
		return 4
	case "DELETE":
		return 5
	case "CONNECT":
		return 6
	case "OPTIONS":
		return 7
	case "TRACE":
		return 8
	case "PATCH":
		return 9
	case "QUERY":
		return 10
	}
	return 0
}

// StatusCode maps an HTTP status to the stored smallint: 100–599, else 0 (absent or invalid).
func StatusCode(v int64, present bool) int16 {
	if !present || v < 100 || v > 599 {
		return 0
	}
	return int16(v)
}

// stellarRPCMethods are the 13 documented Stellar RPC methods (ADR-0012 "JSON-RPC"; research file
// references/stellar-path-normalization-2026-11-12.md source 13).
var stellarRPCMethods = map[string]bool{
	"getEvents": true, "getFeeStats": true, "getHealth": true, "getLatestLedger": true, "getLedgerEntries": true,
	"getLedgers": true, "getNetwork": true, "getTransaction": true, "getTransactions": true, "getVersionInfo": true,
	"queryEvents": true, "sendTransaction": true, "simulateTransaction": true,
}

// RPCMethod returns the stored rpc_method of a point: "" (NULL) when the service has no rpc_method dimension or the
// point carries none; the method when it is in the closed set; otherwise "_OTHER".
func RPCMethod(dimension bool, v string, present bool) string {
	if !dimension || !present || v == "" {
		return ""
	}
	if stellarRPCMethods[v] {
		return v
	}
	return "_OTHER"
}

// Placeholder routes.
const (
	RouteUnknown  = "{unknown}"
	RouteOverflow = "{overflow}"
)

// ValidRoute reports whether r can be stored in api_routes.route.
func ValidRoute(r string) bool {
	return len(r) <= 1024 && r != "" && (r[0] == '/' || r == RouteUnknown || r == RouteOverflow)
}

// ParentPrefix is api_routes.parent_prefix: the route without its last segment ("/a/b" → "/a", "/a" → "/",
// "/" and the placeholders → "").
func ParentPrefix(route string) string {
	if route == "/" || route == "" || route[0] != '/' {
		return ""
	}
	i := strings.LastIndexByte(route, '/')
	if i == 0 {
		return "/"
	}
	return route[:i]
}

// SiblingOverflow is the route a sibling beyond the per-prefix cap becomes: "<prefix>/{overflow}".
func SiblingOverflow(prefix string) string {
	if prefix == "/" || prefix == "" {
		return "/" + RouteOverflow
	}
	return prefix + "/" + RouteOverflow
}

// GuardExempt reports whether a route is outside the cardinality caps: the placeholders and the per-prefix
// overflow routes (they are bounded by the routes that were admitted).
func GuardExempt(route string) bool {
	return route == RouteUnknown || route == RouteOverflow || strings.HasSuffix(route, "/"+RouteOverflow)
}

// LiteralChild reports whether the route's last segment is literal (it counts against the sibling cap; typed
// placeholders such as {id} do not — "distinct literal children per prefix", settings route_sibling_cap).
func LiteralChild(route string) bool {
	return !strings.HasSuffix(route, "}") && route != "/"
}

// Data-quality reasons (wire-formats §h.3) written by the writer or accepted from the Collector.
const (
	ReasonServiceNotAllowed    = "service_not_allowed"
	ReasonServiceQuotaExceeded = "service_quota_exceeded"
	ReasonBeforeRegistration   = "before_registration"
	ReasonTooOld               = "too_old"
	ReasonFuture               = "future"
	ReasonMetricNotAllowed     = "metric_not_allowed"
	ReasonRouteOverflow        = "route_overflow"
	ReasonCumulativeFirstPoint = "cumulative_first_point"
	ReasonCumulativeReset      = "cumulative_reset"
	ReasonDuplicateBatch       = "duplicate_batch"
	ReasonHistLayoutApprox     = "hist_layout_approx"
	// ReasonHistUnitSuspect: explicit bounds are the OpenTelemetry millisecond default layout while the unit says
	// seconds; the point was corrected (values in ms) or estimated from its sum, stored as "coarse".
	ReasonHistUnitSuspect  = "hist_unit_suspect"
	ReasonExpScaleCoarse   = "exp_scale_coarse"
	ReasonMalformedPoint   = "malformed_point"
	ReasonNegativeValue    = "negative_value"
	ReasonUndeliverable72h = "undeliverable_72h"
	ReasonCountOverflow    = "count_overflow"
	ReasonTenantWriteError = "tenant_write_error"
)

// knownReasons is the closed list of §h.3; counters with any other reason are ignored (and counted in the writer's
// own metrics).
var knownReasons = map[string]bool{
	"service_not_allowed": true, "service_quota_exceeded": true, "before_registration": true, "too_old": true,
	"future": true, "metric_not_allowed": true, "client_metric_ignored": true, "span_not_server": true,
	"span_not_local_root": true, "logs_rejected": true, "route_overflow": true, "route_redacted": true,
	"route_seed_redacted":    true, // subset of route_redacted: a Stellar secret seed was redacted (tenant warning)
	"cumulative_first_point": true, "cumulative_reset": true, "duplicate_batch": true, "hist_layout_approx": true,
	"hist_unit_suspect": true,
	"exp_scale_coarse":  true, "quota_exceeded": true, "malformed_point": true, "negative_value": true,
	"rate_limited": true, "payload_too_large": true, "tenant_pending": true, "tenant_suspended": true,
	"token_expired": true, "undeliverable_72h": true, "count_overflow": true, "tenant_write_error": true,
	"stellar_series_overflow": true,
}

// KnownReason reports whether r is in §h.3.
func KnownReason(r string) bool { return knownReasons[r] }

// Service names the writer never registers: the Collector's fixed name for drops of a non-allowed service (C-114).
const ServiceNotAllowed = "{not_allowed}"

// ValidServiceName is api_services.service_name's check: printable ASCII, 1–128 characters.
func ValidServiceName(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '!' || s[i] > '~' {
			return false
		}
	}
	return true
}

// Stellar client metrics of @usagemap/stellar-otel (wire-formats §f.5 step 4a, §g.7; C-153). They are kept apart
// from the API metrics (tables scf.stellar_client_*) and never count as API usage.
const (
	MetricStellarRPC         = "rpc.client.call.duration"
	MetricStellarHTTP        = "http.client.request.duration"
	MetricStellarSubmissions = "stellar.tx.submissions"
	MetricStellarPolls       = "stellar.tx.polls"
	MetricStellarSimulations = "stellar.tx.simulations"

	// ReasonStellarSeriesOverflow: a Stellar client-metric point of a new series beyond the tenant's daily series cap,
	// or of a new cumulative stream beyond the stream-state cap (settings stellar_client_*; §h.3).
	ReasonStellarSeriesOverflow = "stellar_series_overflow"
)

// StellarMetric reports whether name is one of the five Stellar client metrics.
func StellarMetric(name string) bool {
	switch name {
	case MetricStellarRPC, MetricStellarHTTP, MetricStellarSubmissions, MetricStellarPolls, MetricStellarSimulations:
		return true
	}
	return false
}

// StellarHistogram reports whether a Stellar client metric is a duration histogram (else a counter).
func StellarHistogram(name string) bool { return name == MetricStellarRPC || name == MetricStellarHTTP }

// Integration client metrics (wire-formats §f.5 steps 4b partner, 4c payments, 4d anchors; §g.8; migration 0085):
// a tenant backend's partner-API calls, agent-payment events and anchor funnel, and an anchor's own Anchor Platform
// events. Stored apart from the API metrics and from the Stellar client metrics (tables scf.integration_*), never
// API usage. Overflow of their series caps is counted stellar_series_overflow.
const (
	MetricPartnerDuration        = "stellar.partner.call.duration"
	MetricPaymentEvents          = "payment.server.events"
	MetricAnchorRequestDuration  = "stellar.anchor.request.duration"
	MetricAnchorEvents           = "stellar.anchor.events"
	MetricAnchorTransferCreated  = "stellar.anchor.transfer.created"
	MetricAnchorTransitions      = "stellar.anchor.transfer.transitions"
	MetricAnchorStatusDuration   = "stellar.anchor.transfer.status.duration"
	MetricAnchorTransferDuration = "stellar.anchor.transfer.duration"
	MetricAnchorCustomerUpdates  = "stellar.anchor.customer.updates"
	MetricAnchorQuotesCreated    = "stellar.anchor.quotes.created"
)

// IntegrationMetric reports whether name is one of the ten integration client metrics.
func IntegrationMetric(name string) bool {
	switch name {
	case MetricPartnerDuration, MetricPaymentEvents, MetricAnchorRequestDuration, MetricAnchorEvents,
		MetricAnchorTransferCreated, MetricAnchorTransitions, MetricAnchorStatusDuration, MetricAnchorTransferDuration,
		MetricAnchorCustomerUpdates, MetricAnchorQuotesCreated:
		return true
	}
	return false
}

// IntegrationDuration reports whether an integration metric is a duration histogram (else a monotonic counter).
func IntegrationDuration(name string) bool {
	switch name {
	case MetricPartnerDuration, MetricAnchorRequestDuration, MetricAnchorStatusDuration, MetricAnchorTransferDuration:
		return true
	}
	return false
}

// IntegrationLongDuration reports whether a duration is stored as count and sum only: anchor transfer durations run
// for minutes to days, beyond explicit15's 10 s top bound, so a histogram would put everything in its last bucket.
func IntegrationLongDuration(name string) bool {
	return name == MetricAnchorStatusDuration || name == MetricAnchorTransferDuration
}
