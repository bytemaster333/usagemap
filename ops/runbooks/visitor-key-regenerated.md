# Runbook: visitor key regenerated or diverged

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: KDayRegenerated, KDayDivergence

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `KDayRegenerated` — rule in `ops/alerts/edge.rules.yaml`; `KDayDivergence` — rule in `ops/alerts/edge.rules.yaml`.

**Built today:** the gateway key exchange (`internal/keys`; `GW_KEYX_ADDR`, `GW_KEYX_PEERS`): `scf_gateway_keys_current`, `scf_gateway_keys_held`, `scf_gateway_keyx_conflicts{kind}`, `scf_gateway_live_edge_nodes`. A metric for an off-schedule generation and a per-node key fingerprint export are not built yet (see `README.md`, known gaps).

## KDayRegenerated (TM-DOS-08.M.1)

**Meaning.** A node generated `K_day` outside the 23:50 UTC hand-over because no peer answered (C-04): that day's unique visitors are over-counted (visitors seen by nodes with different keys count twice).

**First checks**

- Why peers did not answer: all gateways restarted at once, mesh partition (`mesh-health.md`), certificate problems on the key-exchange port.

**Mitigation**

- Nothing to repair for the day; annotate it as over-counted on dashboards. Avoid restarting all gateways at once (rolling restarts).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## KDayDivergence (TM-EDG-03.M.2)

**Meaning.** More than one `K_day` is in use among edge nodes for the current day after a partition (C-04).

**First checks**

- `scf_gateway_keyx_conflicts{kind}` on each node; mesh connectivity.

**Mitigation**

- Nodes converge on the key with the smaller fingerprint once they see each other; annotate the day.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0007, C-04, C-68, `docs/contracts/wire-formats.md` §n.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
