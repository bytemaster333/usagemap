// SPDX-License-Identifier: Apache-2.0
// Package scfsanitizeprocessor is the SCF sanitise step ("scfsanitize") of the
// scf-otelcol Collector distribution: docs/contracts/wire-formats.md §f.5,
// ADR-0009, ADR-0012, register clarifications C-101, C-102, C-105, C-107,
// C-112(8), C-113, C-114 and C-116.
//
// It runs first in the traces and metrics pipelines (after memory_limiter),
// before anything reaches the persistent queue, and for every request:
//
//  1. reads the tenant id, the allowed service names, the receipt time and the
//     tenant level from the request metadata the gateway set (x-scf-tenant-id,
//     x-scf-allowed-services, x-scf-received-at, x-scf-tenant-level); a
//     request without a valid tenant id is dropped whole and counted in the
//     Collector's own metrics; a level other than exactly "L0"…"L3" is left
//     absent and counted (C-116);
//  2. drops resources whose service.name is not allowed (service_not_allowed,
//     reported under the fixed name "{not_allowed}");
//  3. builds the output from scratch — new resources, scopes, metrics, points
//     and spans into which only allow-listed fields are copied (C-114), so
//     entity references, schema URLs, descriptions, exemplars, span names,
//     events, links and status messages cannot pass; sets scf.tenant.id from
//     the metadata, stamps scf.received_at_unix_nano, scf.stream.instance and
//     (when valid) scf.tenant.level as an int 0…3;
//     every kept free-text value (service name, namespace, instance,
//     environment, scope name and version, rpc.*) goes through pathnorm's
//     sensitive-value classifier (classify.go) and becomes "{redacted}" when
//     it looks like a secret or identifier;
//  4. keeps only the server request-duration metrics (http.server.request.duration
//     and legacy http.server.duration; ms converted to s), counting client
//     metrics (client_metric_ignored) and everything else (metric_not_allowed);
//     histograms with an impossible layout (exponential: > 320 buckets per
//     side, indexes outside the scale's range) are malformed_point;
//     4a. with stellar_client_metrics on (default off), also the Stellar client
//     metrics of @usagemap/stellar-otel (stellar.go): rpc.client.call.duration
//     (JSON-RPC, with stellar.network), http.client.request.duration (with
//     url.template and stellar.network) and the stellar.tx.submissions|polls|
//     simulations counters, each with a closed attribute set (values outside
//     it become _OTHER) — outbound dependency health, never API usage;
//     4b–4d. with client_metric_sets (default empty; clientrules.go), the
//     strict allow-list steps "partner" (stellar.partner.call.duration,
//     partner.go), "payments" (payment.server.events, payments.go) and
//     "anchors" (stellar.anchor.*, anchors.go): one compiled-in rule per
//     metric name, a marker attribute, every output value a closed-set
//     constant (anchor/client domains: a validated public DNS name);
//  5. keeps only SERVER spans that are local roots (span_not_server,
//     span_not_local_root) and at most 24 h long — spans only feed
//     signal_to_metrics; the sampling threshold is capped (adjusted count
//     ≤ 1024) and flags are masked;
//  6. normalises the route with pathnorm.NormalizeSpan into scf.route and
//     scf.rules_version ("{unknown}" when no route or path exists; http.route
//     values "" and "/**" count as absent) and deletes every raw path input;
//  7. drops points and spans more than max_future after or max_age before the
//     receipt time (future, too_old);
//  8. merges data points whose attribute sets became identical once the
//     non-allow-listed attributes were removed — only when their original
//     attribute sets differed and their timestamps are equal, in linear time
//     (merge.go);
//  9. reports what it dropped per (service.name, reason) to the tenant as the
//     delta sum scf.ingest.dropped: directly in the metrics pipeline, and in the
//     traces pipeline as marker spans that signal_to_metrics turns into the same
//     metric (see collector/config/collector.yaml).
//
// A request whose processing panics is dropped and counted malformed_point;
// the Collector keeps running. Attribute values are never logged; only counts
// and reason codes are.
package scfsanitizeprocessor
