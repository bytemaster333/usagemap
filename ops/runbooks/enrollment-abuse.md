# Runbook: enrollment abuse

Status: to be exercised (no drill has run)
Owner: maintainers and operator_admins
Last reviewed: 2026-11-13
Alerts: SignupBurst, DomainReclaimed

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `SignupBurst` — rule in `ops/alerts/control-plane.rules.yaml`; `DomainReclaimed` — not a Prometheus alert (see `ops/alerts/coverage.json`).

**Built today:** rate limits on sign-up and site/service creation per identity and subnet (C-64); domain claims and tombstones in the control plane (`operatorListTombstones`, `operatorLiftTombstone`). Notices are planned.

## SignupBurst (TM-ENR-06.M.1)

**Meaning.** Tenant sign-ups per hour above 10× baseline, or rate-limit hits per identity and subnet.

**First checks**

- New tenants' verification levels (L0 tenants are quota-limited).

**Mitigation**

- Switch enrollment to `approval_required` (`PUT /v1/operator/settings/enrollment-mode`, operator_admin, step-up) — affects new enrollments only; bulk re-approval exists (`POST /v1/operator/reapprovals`).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. Plus an `operator_admin` notice.

## DomainReclaimed (TM-ENR-03.M.1)

**Meaning.** A host's verification lapsed and another tenant claimed it, or a claim was refused by a tombstone.

**First checks**

- Domain history and both tenants.

**Mitigation**

- Resolve the dispute (the SCF-operator domain-dispute operation is not built yet — planned).

**Escalation**

- Portal notice to `operator_admin`s.

## Related

- ADR-0015, C-64, `tenant-lifecycle.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
