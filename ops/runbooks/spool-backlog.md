# Runbook: spool backlog and discards

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: SpoolAge, SpoolDepthHigh, SpoolDiscarded, SpoolCorruptFrames

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `SpoolAge` — rule in `ops/alerts/data-quality.rules.yaml`; `SpoolDepthHigh` — rule in `ops/alerts/edge.rules.yaml`; `SpoolDiscarded` — rule in `ops/alerts/data-quality.rules.yaml`.

**Built today:** gateway spool gauges `scf_gateway_spool_oldest_age_seconds`, `scf_gateway_spool_queued`, `scf_gateway_spool_pending`, `scf_gateway_spool_bytes` (cap `GW_SPOOL_MAX_BYTES`, default 20 GiB, `503` when reached), `scf_gateway_spool_events` (fsynced / acked / `expired_72h`), `scf_gateway_forward_total{outcome="expired_72h"}`; writer `scf_ingest_dropped{reason="undeliverable_72h"}`.

## SpoolAge (TM-DOS-03.M.1)

**Meaning.** The oldest unacknowledged spool record is older than 1 h (warning), 6 h (critical) or 24 h (critical, re-sent to both responders and the daily watch). At 72 h records are discarded (C-18).

**First checks**

- Forwarder outcomes `scf_gateway_forward_total` by `outcome` (`core_failed`, `refused`, `rejected`, `deferred_twin`) and `core` (`forwarder-errors.md`).
- Engine proxy gate and Umami health (`engine-proxy.md`); PostgreSQL primary (`postgres-failover.md`).
- Only one node affected: its mesh link or node certificate (`mesh-health.md`, `certificate-renewal.md`).

**Mitigation**

- Restore the forward path; the spool drains by itself, oldest first.
- Never delete segments by hand and never restart with an empty spool volume.

**Escalation**

- 1 h warning; 6 h and 24 h critical. At 24 h two days remain before data is discarded — the daily watch must make sure someone is on it (C-49).

## SpoolDepthHigh (TM-DOS-03.M.2)

**Meaning.** Spool bytes ÷ cap > 50 % (warning) or > 80 % (critical). At the cap the node answers `503` and the tracker retries on the other host.

**First checks**

- As for SpoolAge; disk headroom on the spool volume (`disk-space.md`).

**Mitigation**

- Grow the volume or raise `GW_SPOOL_MAX_BYTES` within the free space; fix the drain.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. Critical above 80 %.

## SpoolDiscarded (TM-DOS-03.M.3)

**Meaning.** Records (web) or OTLP points (writer `undeliverable_72h`) were discarded at the 72-hour cap. Every discard is a durability exception reported monthly.

**First checks**

- `scf_gateway_spool_events` `expired_72h` per node; `scf_ingest_dropped{reason="undeliverable_72h"}` at the writers.

**Mitigation**

- Nothing recovers the data; record counts, node and period for the monthly SLO report and the affected tenants' data-quality view.

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.
- Tenant-visible impact (ingest, dashboards or data): open an incident (`incident.md`) and post on the status page.

## SpoolCorruptFrames (TM-INF-08.M.2)

**Meaning.** On recovery the gateway found frames it could not read in the middle of a spool segment and skipped them
(`scf_gateway_spool_corrupt_frames`, size in `scf_gateway_spool_corrupt_bytes`; only a torn tail of the newest
segment is truncated silently). The skipped events are lost. Never normal operation.

**First checks**

- The data disk: `dmesg`/kernel log for I/O errors, `df` and SMART/Azure disk health; was the node power-cut?
- The gateway log around its last start (recovery reports the segment and offset).

**Mitigation**

- Replace a failing disk or node (`edge-node-down.md`); the counter resets with the process, the loss stays.
- Count the lost bytes in the month's durability exceptions (monthly report).

**Escalation**

- Critical: maintainers' push channel; a repeat on healthy hardware is a defect (issue with the recovery log).

## Related

- ADR-0020, C-18, C-49, C-76, C-77, C-112(8).
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
