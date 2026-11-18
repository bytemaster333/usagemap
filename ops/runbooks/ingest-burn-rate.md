# Runbook: ingest error budget burn

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: IngestBurnRateFast, IngestBurnRateSlow, IngestBudgetTicket

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `IngestBurnRateFast` — rule in `ops/alerts/slo.rules.yaml`; `IngestBurnRateSlow` — rule in `ops/alerts/slo.rules.yaml`; `IngestBudgetTicket` — rule in `ops/alerts/slo.rules.yaml`.

**Built today:** the gateway's own request counters `scf_gateway_requests_total{route,status}` and `scf_gateway_spool_append_errors_total`; the canary probe client `probe` (`services/gateway/cmd/probe`, exports `scf_probe_canary_accepted_total{source,path}`). The SLO definitions in `ops/slo/*.yaml` and their Sloth rules are planned.

## IngestBurnRateFast (TM-DOS-01.M.1)

**Meaning.** The ingest availability error budget (99.99 %/month, ADR-0031, C-78) burns at ≥ 14.4× over 1 h and 5 m: at this rate a month's budget is gone in about two days.

**First checks**

- Which hostname, node or provider: compare per-node and per-hostname availability (C-78); `ingest-hostname-degraded.md`, `edge-node-down.md` if one stands out.
- Status mix on the failing nodes: `scf_gateway_requests_total` by `status` — `503` (no snapshot, draining, spool full, Collector queue full), `429` (rate limit / quota), `5xx` from crashes.
- Spool health: `scf_gateway_spool_append_errors_total` rising, `scf_gateway_spool_durable == 0`, disk full (`disk-space.md`).
- Recent deploys or certificate changes (`certificate-renewal.md`).
- `docker compose -f infra/compose/compose.yaml ps` and `docker compose -f infra/compose/compose.yaml logs --since 30m <service>` (logs never contain IPs, User-Agents, headers or tokens — do not try to add them).

**Mitigation**

- Remove a broken node from DNS (health controller does this automatically — planned; until then by hand at the DNS provider).
- Roll back the last gateway release if errors started with it (deploy playbook, planned; locally `docker compose -f infra/compose/compose.yaml up -d gateway` with the previous image).
- A full spool volume: free or grow the volume; never delete spool segments by hand (they are accepted events).

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.
- Tenant-visible impact (ingest, dashboards or data): open an incident (`incident.md`) and post on the status page.

## IngestBurnRateSlow (TM-DOS-01.M.2)

**Meaning.** Budget burning ≥ 6× over 6 h and 30 m: a sustained partial degradation (one node, one hostname, or a fraction of requests).

**First checks**

- Same as the fast burn; look for one degraded node or provider rather than an outage.
- Compare the probe-based figure with the server-side ratio; a gap points at DNS, TLS or the network path (C-43).

**Mitigation**

- As for the fast burn; prefer draining the degraded node (it closes its listener, ADR-0020) over restarts.

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.

## IngestBudgetTicket (TM-DOS-01.M.3)

**Meaning.** Budget burning ≥ 1× over 3 d and 6 h: the month will end over budget if nothing changes.

**First checks**

- Monthly SLO report draft: which days and nodes consumed the budget.

**Mitigation**

- Apply the error-budget policy (ADR-0031): freeze risky changes to the ingest path until the burn stops.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- `docs/sla.md`, ADR-0031, C-43, C-78.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
