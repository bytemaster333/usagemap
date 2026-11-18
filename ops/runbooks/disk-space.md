# Runbook: disk space

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: DiskPredictedFull, DiskHigh

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `DiskPredictedFull` — rule in `ops/alerts/platform.rules.yaml`; `DiskHigh` — rule in `ops/alerts/platform.rules.yaml`.

**Built today:** the node exporter of the lean production profile (`infra/ansible/roles/compose_stack`, scraped as job `node`). Known consumers: PostgreSQL (≈ 1.05 GB/day of Umami data per 1 M page views/day, ≥ 250 GB host disk at 90-day retention, C-109), gateway spool (`GW_SPOOL_MAX_BYTES`, 20 GiB), Collector queue (`SCF_QUEUE_BYTES`, 2 GiB).

## DiskPredictedFull (TM-DOS-03.M.4)

**Meaning.** The filesystem will be full within 24 h at the current rate.

**First checks**

- Which volume: database data/WAL (archiving stuck? see [`backup-failure.md`](backup-failure.md)), spool (`spool-backlog.md`), Collector queue (`otlp-writer.md`), logs.

**Mitigation**

- Grow the volume; for WAL, fix archiving rather than deleting files; never delete spool or queue files.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## DiskHigh (—)

**Meaning.** A filesystem is more than 80 % used.

**First checks**

- As above.

**Mitigation**

- As above; plan capacity (`capacity-review.md`).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- C-109, `docs/monitoring-plan.md` §4.7.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
