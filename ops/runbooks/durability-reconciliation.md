# Runbook: durability reconciliation

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: DurabilityDiscrepancy, CanaryCountMismatch, ReconciliationStale

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `DurabilityDiscrepancy` — no rule yet: the signal is missing (`scf_durability_discrepancy{node}`, owner: jobs, durability_reconcile); `CanaryCountMismatch` — no rule yet: the signal is missing (`scf_durability_canary_shortfall{source}`, owner: jobs, durability_reconcile); `ReconciliationStale` — rule in `ops/alerts/data-quality.rules.yaml`.

**Built today:** per-node spool accounting `scf_gateway_spool_events` (fsynced, acked, `expired_72h`) and `scf_gateway_spool_queued`; spool accounting uploaded through the internal edge API (C-113). The daily reconciliation job and the canary hourly-count comparison are planned.

## DurabilityDiscrepancy (TM-EDG-09.M.2)

**Meaning.** On some node, records fsync'd ≠ acknowledged + expired at 72 h + still queued; or a node stopped reporting its accounting (possible permanent loss of its backlog, C-77).

**First checks**

- Node history: crash, disk replacement, volume loss; `scf_gateway_spool_corrupt_frames` (torn frames truncated at recovery).

**Mitigation**

- If the volume is lost, the backlog is lost (no object-storage copies, C-77): record node, period and estimated count for the SLA report.

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.

## CanaryCountMismatch (TM-EDG-09.M.3)

**Meaning.** Canary events counted in Umami for an hour differ from the known hourly count the probe sources sent (C-76), after the hour drained.

**First checks**

- Spool backlog not yet drained (wait); canary site verdicts (`rejected` canaries never reach Umami); duplicate forwards.

**Mitigation**

- Explain the difference and record it; a real loss is a durability exception.

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.

## ReconciliationStale (TM-EDG-09.M.4)

**Meaning.** The reconciliation job has not succeeded for 26 h.

**First checks**

- Job logs and lock (`scf_job_runs_total{outcome}` once the job exists).

**Mitigation**

- Re-run the job; investigate failures before the monthly report.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- C-76, C-77, `docs/contracts/wire-formats.md` §d.4.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
