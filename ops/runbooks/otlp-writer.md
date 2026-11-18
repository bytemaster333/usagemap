# Runbook: OTLP pipeline: Collector queue and metrics writer

Status: exercised 2026-11-14 (writer and Collector restarts under OTLP load, Compose) — see the drill log
Owner: maintainers
Last reviewed: 2026-11-14
Alerts: WriterDedupeAnomaly, WriterRejectedData, StreamResetsHigh, CollectorQueueHigh, CollectorExportFailing, WriterListenerClosed

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `WriterDedupeAnomaly` — rule in `ops/alerts/data-quality.rules.yaml`; `WriterRejectedData` — rule in `ops/alerts/data-quality.rules.yaml`; `StreamResetsHigh` — not a Prometheus alert (see `ops/alerts/coverage.json`); `CollectorQueueHigh` — rule in `ops/alerts/data-quality.rules.yaml`; `CollectorExportFailing` — rule in `ops/alerts/data-quality.rules.yaml`; `WriterListenerClosed` — rule in `ops/alerts/data-quality.rules.yaml`.

**Built today:** metrics writer (`services/metrics-writer`): `scf_writer_requests_total{code}`, `scf_writer_tenant_transactions_total{outcome}` (committed, duplicate, write_error, unavailable, retried), `scf_writer_points_total{outcome}`, `scf_ingest_dropped{reason}`, `scf_writer_listener_open`, `scf_writer_database_up`, `scf_writer_listener_transitions_total`; Collector (`collector/`): `otelcol_exporter_queue_size`, `otelcol_exporter_queue_capacity`, `otelcol_exporter_send_failed_metric_points`, `otelcol_exporter_enqueue_failed_metric_points`. The gateway's OTLP front door forwards tenant OTLP to the Collector (`services/gateway/internal/otlp`), exercised by the whole-stack API suite and `tests/load/run-api.ts`.

**Collector placement (C-130):** the Collector is its own container on the private `otlp` network with the gateway (alias `otlp-collector`; receivers bound to that address only) and on `core` for the writer. It used to share the gateway's network namespace, which left it unreachable after every gateway restart (found by the chaos run, 2026-11-13); now a gateway restart needs no action on the Collector (`tests/chaos/run-api.ts` asserts it). If the front door answers `503` while the Collector is up, check that both containers are on `<project>_otlp` (`docker network inspect`) and that `scf_gateway_otlp_collector_errors_total` stops rising.

## WriterDedupeAnomaly (TM-OTL-02.M.1)

**Meaning.** De-duplicated batches ÷ batches is more than 3× its 7-day median: Collector redeliveries (writer timeouts, failovers) or a tenant replaying data.

**First checks**

- `scf_writer_tenant_transactions_total{outcome="duplicate"}` vs `committed`; writer failovers (`scf_writer_listener_transitions_total`).

**Mitigation**

- Nothing is double counted (ledger, C-23); fix the cause of redeliveries (slow database, flapping listener).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## WriterRejectedData (TM-DOS-06.M.4)

**Meaning.** `scf_ingest_dropped` for `tenant_write_error` (a tenant transaction rolled back on a non-transient SQL error, answered `200`) or `count_overflow` (histogram bucket beyond int4) increased (C-112(1)).

**First checks**

- Writer log: SQLSTATE and constraint name only (never values); which reason; recent migrations.

**Mitigation**

- `tenant_write_error` after a migration: fix the migration or roll back; data of those batches is lost (counted). `count_overflow` is expected only for absurd inputs.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## StreamResetsHigh (TM-OTL-02.M.2)

**Meaning.** More than 20 cumulative-stream resets per hour for one tenant: restarts, or replicas sharing a stream identity without `service.instance.id` (C-105).

**First checks**

- `scf_ingest_dropped{reason="cumulative_reset"}` / `cumulative_first_point`; the tenant's data-quality view.

**Mitigation**

- Portal notice to the tenant pointing at the onboarding recipes (set `service.instance.id`, `docs/guides/` quickstarts).

**Escalation**

- Info plus portal notice to the tenant; no maintainer action unless platform-wide.

## CollectorQueueHigh (TM-DOS-06.M.1)

**Meaning.** The Collector's persistent queue is above 50 % (warning) or 80 % (critical) of `SCF_QUEUE_BYTES` (default 2 GiB); oldest-batch age uses the 1 h / 6 h / 24 h marks. At full the receiver answers `503` and tenants' SDKs retry.

**First checks**

- Writers reachable: `scf_writer_listener_open` on both cores; a writer that lost PostgreSQL closes its listener (C-107).
- Collector log for TLS errors to `SCF_WRITER_ENDPOINT` (`certificate-renewal.md`).

**Mitigation**

- Restore a writer or the database; the queue drains by itself. The 72-hour cap is enforced by the writer (`undeliverable_72h`).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. Critical above 80 %.

## CollectorExportFailing (TM-DOS-06.M.2)

**Meaning.** `otelcol_exporter_send_failed_metric_points` or `otelcol_exporter_enqueue_failed_metric_points` increasing: data dropped or refused by the queue.

**First checks**

- Queue full (above), or writer answering `400`/`415` (a Collector/writer contract mismatch after a release).

**Mitigation**

- Roll back the mismatching release; free queue space.

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.

## WriterListenerClosed (TM-DOS-06.M.3)

**Meaning.** A writer closed its OTLP listener because it cannot reach PostgreSQL (warning after 2 m), or both writers are unreachable from an edge Collector (critical).

**First checks**

- `scf_writer_database_up`, PgBouncer (`$DC ps pgbouncer`), PostgreSQL primary (`postgres-failover.md`).

**Mitigation**

- Restore database access; the listener reopens by itself (probe every `SCF_WRITER_PROBE_INTERVAL`, 2 s).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. Critical when both writers are closed.

## Planned restart of the writer or the Collector

- Writer: `$DC restart metrics-writer`. While it is down the Collector's persistent queue (volume `colqueue`) holds the
  batches and retries; the front door keeps answering `200`.
- Collector: `$DC restart collector`. While it is down the gateway's front door answers `503` with `Retry-After: 5`
  (or `UNAVAILABLE` for gRPC, C-118) and tenants' SDKs retry; nothing acknowledged is lost (the queue is on disk).
  Never restart the gateway for a Collector problem, and vice versa (C-130).
- After either: `scf_writer_listener_open` 1, `otelcol_exporter_queue_size` falling to 0, and the tenant's
  `api_metrics_1m` rows still arriving.

## Related

- `services/metrics-writer/README.md`, `collector/README.md`, C-23, C-105, C-107, C-112.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg` (ports 56450–56452), images built from the working tree | An OTLP/HTTP client through the gateway's front door with an ingest token: one delta histogram point (count 1) every 0.5 s for 45 s; `$DC restart metrics-writer` at 12 s; then the same with `$DC restart collector`; acknowledged points compared with `sum(request_count)` in `api_metrics_1m` | **pass** — writer restart: 89 acknowledged (`200`), 0 errors, 89 stored; Collector restart: 82 acknowledged, 1 request failed at the connection (0.5 s, not resent by the drill client — an SDK retries), 82 stored. 0 acknowledged points lost in both. |
