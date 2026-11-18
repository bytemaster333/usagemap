# Runbook: verdict shifts

Status: to be exercised (no drill has run)
Owner: maintainers (SuspectSurgeOnSite: tenant and operator_admins)
Last reviewed: 2026-11-13
Alerts: RejectedWebSpikePlatform, VerifiedShareDropPlatform, SuspectSurgeOnSite

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `RejectedWebSpikePlatform` — rule in `ops/alerts/data-quality.rules.yaml`; `VerifiedShareDropPlatform` — rule in `ops/alerts/data-quality.rules.yaml`; `SuspectSurgeOnSite` — not a Prometheus alert (see `ops/alerts/coverage.json`).

**Built today:** `scf_gateway_events_total{verdict}`, `scf_gateway_reasons_total{reason}` (closed list, wire-formats §h.2); per-site verdict and reason counters in `scf.web_edge_counters`, shown on the installation check. Portal notices are planned.

## RejectedWebSpikePlatform (TM-INF-01.M.1)

**Meaning.** Rejected web events by reason, across all tenants, above 5× the 7-day same-hour baseline for 15 m. Malformed or signature reasons right after a release suggest our regression.

**First checks**

- Which reasons: `challenge_invalid` / `challenge_missing` / `proof_invalid` together across tenants after a gateway or tracker release → protocol regression; `ua_bot` → a bot burst; `origin_mismatch` on one site → misconfigured domain.

**Mitigation**

- Roll back a regressing release; bot bursts need no action (rejected events are counted only).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## VerifiedShareDropPlatform (TM-INF-02.M.1)

**Meaning.** The verified share across all tenants dropped by more than 20 points in 1 h: a key rotation or gateway bug, not tenants.

**First checks**

- `challenge_unverifiable` up → nodes lack the challenge key epoch (restart, partition; `visitor-key-regenerated.md`); `proof_missing` up → tracker or PoW difficulty change; `scf_gateway_keys_current == 0` on a node.

**Mitigation**

- Restore key exchange between nodes; roll back the release.

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.

## SuspectSurgeOnSite (TM-DOS-02.M.4)

**Meaning.** One site's suspect share rose by more than 30 points within 1 h without more verified events: possible framing or flooding by a third party (C-80).

**First checks**

- The site's reason codes on its installation check (`net_datacenter`, `multiplicity_high`, `proof_missing` …).

**Mitigation**

- Nothing to block: quotas count verified events only; tenant and SCF operators can annotate the period (C-80).

**Escalation**

- Portal notice to the tenant and to `operator_admin`s; no maintainer action unless many sites at once.

## Related

- ADR-0008, `docs/contracts/wire-formats.md` §h, C-80.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
