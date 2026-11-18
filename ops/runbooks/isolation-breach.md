# Runbook: tenant isolation breach

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: CanaryIsolationBreach, CanaryProbeFailing

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `CanaryIsolationBreach` — no rule yet: the signal is missing (`scf_isolation_canary_breaches_total{surface}`, owner: isolation canary runner); `CanaryProbeFailing` — no rule yet: the signal is missing (`scf_isolation_canary_last_success_timestamp_seconds`, owner: isolation canary runner).

**Built today:** the isolation tests (database RLS gates in `db/tests`, control-plane isolation tests) and per-tenant view-only Umami keys. Canary tenants in production and the 5-minute canary journey are planned.

## CanaryIsolationBreach (TM-ISO-01.M.1)

**Meaning.** Canary tenant A saw a marker of canary B through the portal API, an adapter-backed endpoint or a tenant-restricted `op` key: a cross-tenant data exposure.

**First checks**

- Which endpoint and which release; reproduce with the canary credentials only — never with real tenants' data.

**Mitigation**

- Contain first: disable the endpoint (roll back the release, or block the route at the reverse proxy). Then fix with a test added to the isolation matrix.
- Assess exposure from the audit log (SCF-operator reads) and access logs (no personal data is in them).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.
- Counts as a 24-hour-class vulnerability (`security-patch-24h.md`, criterion 6); notify SCF operators and affected tenants (DPA breach clause).

## CanaryProbeFailing (TM-ISO-01.M.2)

**Meaning.** The canary journey cannot run for 30 m: a blind spot, not a breach.

**First checks**

- Canary credentials expired or revoked; portal/control plane down.

**Mitigation**

- Restore the canary; until then isolation is not being watched.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0013, C-17, C-87.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
