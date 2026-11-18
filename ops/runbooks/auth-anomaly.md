# Runbook: authentication anomalies

Status: to be exercised (no drill has run)
Owner: security responders (AuthFailureSpike: maintainers)
Last reviewed: 2026-11-13
Alerts: SCFOperatorAuthAnomaly, AuthFailureSpike

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `SCFOperatorAuthAnomaly` — rule in `ops/alerts/control-plane.rules.yaml`; `AuthFailureSpike` — rule in `ops/alerts/control-plane.rules.yaml`.

**Built today:** sign-in by GitHub OAuth, SEP-53 wallet signature (SEP-10 answers `not_implemented`) and passkeys in the control plane; sessions in PostgreSQL; rate limiting per identity and subnet. Failure-rate metrics and their alert rules are planned.

## SCFOperatorAuthAnomaly (TM-OPR-06.M.1)

**Meaning.** SCF-operator passkey failures ≥ 5 in 10 m, a new passkey registered, recovery by another `operator_admin` or break-glass, or step-up failures (C-20).

**First checks**

- Audit log for the account; confirm with the person through a second channel.

**Mitigation**

- Unconfirmed: revoke the operator's sessions and passkeys, require recovery by another `operator_admin` (audited).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## AuthFailureSpike (TM-AUT-03.M.1)

**Meaning.** Failed sign-ins (OAuth errors, SEP-53 verification failures, reused nonces) above 5× the same-hour baseline for 15 m.

**First checks**

- GitHub status (OAuth outages look like failures); Horizon/RPC reachability for SEP-53 (`SCF_HORIZON_URL*`); a credential-stuffing pattern.

**Mitigation**

- Outage: wait/communicate; abuse: rate limits already apply per identity and subnet (C-64).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0014, C-09, C-20, C-114.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
