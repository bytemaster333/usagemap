# Runbook: SCF operator activity

Status: to be exercised (no drill has run)
Owner: security responders and operator_admins
Last reviewed: 2026-11-13
Alerts: SCFOperatorBulkRead, SCFOperatorPrivilegedAction

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `SCFOperatorBulkRead` — rule in `ops/alerts/control-plane.rules.yaml`; `SCFOperatorPrivilegedAction` — not a Prometheus alert (see `ops/alerts/coverage.json`).

**Built today:** audited `op_*` functions (C-17) and the platform audit log; privileged actions built in the control plane: tenant transitions, removal, restoration, purge, re-approval, tombstone lift, enrollment mode, settings, operator grants. Notices to `operator_admin`s are planned.

## SCFOperatorBulkRead (TM-OPR-01.M.1)

**Meaning.** Audited cross-tenant reads by one SCF operator per hour exceed 3× that person's 30-day p99.

**First checks**

- The audit rows (actor, function, counts); is there a known reason (report, review)?

**Mitigation**

- Ask the person; if unexplained, revoke the sessions and require re-authentication; review with an `operator_admin`.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. To the security responders and an `operator_admin` notice.

## SCFOperatorPrivilegedAction (TM-OPR-04.M.1)

**Meaning.** Any tenant removal, restore, purge, enrollment-mode change, SCF-operator allow-list change, `op` key creation or revocation, or tombstone lift happened.

**First checks**

- Audit row and reason text; each needs a fresh passkey step-up (C-09).

**Mitigation**

- None if expected; otherwise follow `tenant-lifecycle.md` to reverse (restore within the 30-day grace) and `auth-anomaly.md`.

**Escalation**

- Info; portal notice to all `operator_admin`s.

## Related

- C-09, C-17, C-59, `tenant-lifecycle.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
