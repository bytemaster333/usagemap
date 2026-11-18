# Runbook: OTLP rejections and sanitise drops

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: OTLPRejectedSpike, CollectorSanitiseDrops, CollectorReceivedAtFallback, CollectorSpanFilterHit

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `OTLPRejectedSpike` — rule in `ops/alerts/edge.rules.yaml`; `CollectorSanitiseDrops` — rule in `ops/alerts/data-quality.rules.yaml`; `CollectorReceivedAtFallback` — rule in `ops/alerts/data-quality.rules.yaml`; `CollectorSpanFilterHit` — rule in `ops/alerts/data-quality.rules.yaml`.

**Built today:** Collector self-metrics `otelcol_processor_scfsanitize_dropped{signal,reason}`, `…_redactions{kind,location}`, `…_merged_points`, `…_received_at_fallback`, `…_tenant_level_absent{reason}`, `otelcol_processor_filter_spans_filtered`. Gateway OTLP rejections (auth, size, rate limit) are planned with the OTLP front door (day 3).

## OTLPRejectedSpike (TM-OTL-05.M.1)

**Meaning.** OTLP rejections by reason (auth, schema, size, time bounds, rate limit) above 5× baseline for 15 m.

**First checks**

- Reason: `401` bursts usually mean a tenant's environment headers override its token (Rust, C-105) or a revoked token still configured; `413` large batches; `429` a tenant above its rate.

**Mitigation**

- Tenant-side problems: portal notice and the onboarding quickstarts; our regression: roll back.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## CollectorSanitiseDrops (TM-OTL-05.M.3)

**Meaning.** `otelcol_processor_scfsanitize_dropped` above 5× its 7-day baseline for 15 m.

**First checks**

- Reason label: `service_not_allowed` (token's service list), `metric_not_allowed` / `client_metric_ignored` (tenant sends everything), `malformed_point`, `too_old` / `future` (clock skew), `no_tenant` (gateway bug).

**Mitigation**

- Tenant-caused reasons appear in the tenant's data-quality view; `no_tenant` is ours — fix the gateway.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## CollectorReceivedAtFallback (TM-OTL-05.M.4)

**Meaning.** `otelcol_processor_scfsanitize_received_at_fallback` increasing: the gateway forwarded a request without a valid `x-scf-received-at`.

**First checks**

- Gateway release; the six `x-scf-*` headers it must always send (wire-formats §f.4).

**Mitigation**

- Fix the gateway; meanwhile the Collector uses its own clock (time bounds slightly shifted).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## CollectorSpanFilterHit (TM-OTL-05.M.5)

**Meaning.** `otelcol_processor_filter_spans_filtered > 0`: the defensive span filter after `scfsanitize` dropped a span, so `scfsanitize` let through a span it should have dropped and counted — a bug.

**First checks**

- Collector version and the input shape (local root / SERVER flags).

**Mitigation**

- Open a bug with a reproducing fixture; the drop is not attributed to the tenant.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- `collector/README.md`, `docs/contracts/wire-formats.md` §f, C-113, C-114, C-115.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
