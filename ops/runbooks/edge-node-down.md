# Runbook: edge node down or degraded

Status: exercised 2026-11-14 (gateway restart and recreate under load, Compose) — see the drill log
Owner: maintainers
Last reviewed: 2026-11-14
Alerts: EdgeNodeProbeFailing, EdgeNodeDown, IngestCapacityDegraded

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `EdgeNodeProbeFailing` — rule in `ops/alerts/slo.rules.yaml`; `EdgeNodeDown` — rule in `ops/alerts/slo.rules.yaml`; `IngestCapacityDegraded` — rule in `ops/alerts/slo.rules.yaml` (partial).

**Built today:** the gateway (`services/gateway`): `gateway healthcheck` (container health check against `/healthz` on `GW_METRICS_ADDR`, default `:9464`), `scf_gateway_live_edge_nodes`, the spool gauges. The health controller that removes nodes from DNS (`services/health-controller`) is built and tested against fake DNS providers in `ops/e2e/run.sh`; it belongs to the multi-node profile — the lean profile (one VM, C-123) runs without it.

## EdgeNodeProbeFailing (TM-DOS-01.M.9)

**Meaning.** Direct probes to one edge node address fail by 2-of-3 quorum for 3 rounds: the node is black-holed or degraded. Critical if it is still in DNS after 5 m.

**First checks**

- Is the node still in the ingest record sets at both DNS providers?
- Node health: `gateway healthcheck` exit code, `scf_gateway_requests_total` by status, `scf_gateway_snapshot_stale`, `scf_gateway_spool_durable`.
- `docker compose -f infra/compose/compose.yaml ps` and `docker compose -f infra/compose/compose.yaml logs --since 30m <service>` (logs never contain IPs, User-Agents, headers or tokens — do not try to add them).

**Mitigation**

- Remove the node's address from DNS (by hand while the health controller is planned; never the last address of a hostname, C-92).
- Do not wipe its spool volume: accepted events are still in it and drain when the node returns (72-hour cap, C-18).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. Critical while the node is still in DNS after 5 m.

## EdgeNodeDown (TM-DOS-01.M.6)

**Meaning.** `up{job="gateway"} == 0` for 2 m: the gateway process is not scraped.

**First checks**

- Container state: `$DC ps gateway` (no profiles any more: a plain `up` runs every service).
- Start-up refusals in the log: no snapshot keys (`GW_SNAPSHOT_KEYS`), key memory cannot be locked (`GW_REQUIRE_MLOCK=1`), tracker files not matching their manifest (`GW_TRACKER_DIR`), geo database checksum (`GW_GEO_SHA256`).

**Mitigation**

- Fix the start-up error and restart **only the gateway**: `$DC up -d --no-deps gateway` (`--no-deps`: a plain
  `up`/`start` of the gateway also starts its stopped dependencies — control plane, engine proxy, Umami — C-122).
- After a restart the node pulls `K_day` from its peers; if no peer answers it generates one (`visitor-key-regenerated.md`).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## IngestCapacityDegraded (TM-DOS-01.M.7)

**Meaning.** Fewer than 2 healthy nodes behind an ingest hostname, or every node of one provider unhealthy (C-25): one more failure is an outage.

**First checks**

- Which nodes are out and why (sections above); provider status pages.

**Mitigation**

- Restore a node before anything else; postpone deploys; consider adding a temporary node (IaC, planned).

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.

## Planned restart of the gateway (deploy, configuration change, certificate)

1. `$DC restart gateway` (same container) or `$DC up -d --no-deps --force-recreate gateway` (new image or
   configuration). On the lean profile there is one gateway: ingest is unavailable for a few seconds and SDKs/trackers
   retry; the spool volume `gwstate` keeps every accepted, not yet forwarded event across the restart.
2. Wait for `healthy` (`docker inspect -f '{{.State.Health.Status}}' $($DC ps -q gateway)`).
3. Expect `KDayRegenerated` on a single node: without a live peer the gateway re-keys the rest of the UTC day
   (`visitor-key-regenerated.md`, C-124) — uniques of that day are over-counted. Avoid restarts late in the UTC day
   when possible; annotate the day.
4. Check `scf_gateway_spool_queued` returns to 0 and `scf_gateway_forward_total{kind="event",outcome="acked_stored"}`
   keeps rising.

## Related

- ADR-0020, C-25, C-92.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg` (ports 56450–56452), images built from the working tree | Gateway probe events (challenge + proof + event, unique path each, ~2/s) during `$DC restart gateway` and, separately, `$DC up -d --no-deps --force-recreate gateway`; every accepted event looked up in Umami | **pass** — restart: 62 accepted, 1 attempt refused/unreachable, longest gap 3.9 s (includes the client's 3 s deadline), 62/62 stored; recreate: 56 accepted, 1 refused, gap 4.3 s, 56/56 stored; spool back to 0; healthy 6.2 s after the restart command; `KDayRegenerated` condition seen (`scf_gateway_kday_regenerated_total` 1 and the re-key warning in the log), as expected on one node. The DNS steps (health controller) were not exercised: lean profile has none. |
