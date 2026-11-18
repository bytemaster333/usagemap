# Runbook: incident handling

Status: to be exercised (no drill has run)
Owner: maintainers (incident lead = the first responder who acknowledges); security incidents: security responders
Last reviewed: 2026-11-13
Alerts: none (procedure). Applies to: any alert with tenant-visible impact, any security alert, anything unexplained after 30 minutes

There is **no on-call rotation**. Critical alerts are pushed to the maintainers' channel and acted on
best-effort; one named person per calendar day holds the **daily watch** and checks the alert channel and the
advisory feed at least once (C-49). Security criticals are pushed to the two named **security responders** (C-67).
Names and the roster are open. Terminology (C-59): "SCF operator" = a portal user with `operator` /
`operator_admin`; "service operator" = whoever hosts the service. Never use the bare word "operator".

**Built today:** the services, their health endpoints, logs and metrics (see the alert runbooks). Planned: the
monitoring stack (ADR-0022), the public status page (Upptime, separate repository, DV-06), the private ops repository
for incident issues, the evidence repository for post-mortems.

## 1. Declare

An incident exists when any of these holds:

- ingest or dashboard availability is impaired for tenants (burn-rate, probe or freshness alerts);
- accepted data may have been lost (`SpoolDiscarded`, `DurabilityDiscrepancy`, `CanaryCountMismatch`);
- a security alert fired (isolation, revocation, signing keys, tracker hashes, log PII, unexplained access);
- an alert's runbook did not resolve it within 30 minutes and the cause is unknown.

The first maintainer who acknowledges becomes **incident lead** and opens an issue in the private ops repository
(planned; until it exists a private GitHub issue) with: start time (UTC), alert(s), severity, lead.

## 2. Severity

| Severity | Definition | Communication |
|---|---|---|
| SEV-1 | Ingest down for all tenants, data loss, cross-tenant exposure, active compromise | Status page within 30 minutes of declaring; SCF operators informed the same day; security: private advisory |
| SEV-2 | Partial ingest or dashboard outage (one hostname, one provider, some tenants), freshness objective missed | Status page within 1 hour |
| SEV-3 | Degradation without objective impact (one node out with capacity left, delayed rollups) | Ops issue only |

## 3. Stabilise first

1. Follow the alert's runbook (`README.md` lists them). Prefer actions that keep accepting events: drain or remove a
   node from DNS rather than restart everything; never delete spool segments or Collector queue files (they are
   accepted data, kept up to 72 hours, C-18).
2. For a security incident: contain before investigating (revoke the key, block the route, take the node out of DNS),
   preserve evidence (no fixes in place on the affected data; copy logs — which hold no personal data — before
   rotation).
3. Never collect IP addresses, User-Agents, request headers, tokens or query strings to diagnose — the services do
   not log them on purpose and must not start to (privacy invariants, `docs/monitoring-plan.md` §7).

## 4. Communicate

- **Status page** (planned, Upptime): what is affected, since when, next update time. No tenant names.
- **Affected tenants**: portal notice (planned) or e-mail to the tenant's contact if one is stored.
- **SCF operators**: anything affecting data integrity, isolation or availability (vulnerability-response §2).
- **Personal-data breach** (as processor): inform affected tenants (controllers) without undue delay under the DPA
  breach clause (`docs/privacy/dpa-template.md`); they decide on notifications to authorities.
- Update at the promised times even if nothing changed.

## 5. Resolve and record

- Close when the objective metrics are back to normal and any backlog (spool, Collector queue) has drained.
- Record in the issue: timeline, cause, impact (requests refused, events discarded, duration), what was changed.
- Data-quality impact on numbers (split visits, over-counted uniques after a key regeneration, discarded events) is
  annotated on the affected days and listed in the monthly SLO report (`docs/sla.md`).

## 6. Post-mortem

Required for SEV-1, for anything that missed the 24-hour patch commitment, and for any data loss. Blameless; public
(evidence repository, planned) unless it would disclose an unfixed vulnerability — then published after the fix.
Contents: summary, impact in numbers, timeline, root cause, what went well/badly, actions with owners. Review the
runbooks that were used and update their `Last reviewed` line.

## 7. Drill

Exercise this runbook once with a simulated SEV-2 (e.g. stop the engine proxy in the local stack:
`docker compose -f infra/compose/compose.yaml stop engine-proxy`, observe, restore with `start`) and record it in
`README.md` (drill log).

## Related

- `docs/monitoring-plan.md` §5, `docs/sla.md`, `docs/security/vulnerability-response.md` §10, ADR-0022, ADR-0031,
  C-49, C-59, C-67.
