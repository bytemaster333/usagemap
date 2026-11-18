# Runbook: PostgreSQL without leader / etcd degraded

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: PatroniNoLeader, EtcdMembersLow

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `PatroniNoLeader` — rule in `ops/alerts/platform.rules.yaml`; `EtcdMembersLow` — rule in `ops/alerts/platform.rules.yaml`.

**Built today:** a single PostgreSQL 18.6 container in the local stack and the lean production profile (`init: true`, `CHECKPOINT` after every start, C-108); the HA overlay `infra/compose/compose.ha.yaml` (Patroni + etcd with TLS, a synchronous standby behind HAProxy and PgBouncer, C-120), tested by `make ha-test` (failover under write load, fencing, rejoin). The cross-provider replica of the scale-out profile is not built. The failover procedure itself is in [`failover-postgres.md`](failover-postgres.md).

## PatroniNoLeader (TM-DOS-04.M.4)

**Meaning.** No PostgreSQL leader for 30 s: writes fail; dashboards should fall back to read-only from the replica (ADR-0020); writers close their listeners (data waits in Collector queues); web events wait in the spools.

**First checks**

- Patroni and etcd state on both cores; network between providers (`mesh-health.md`).

**Mitigation**

- See the failover procedure in [`failover-postgres.md`](failover-postgres.md): promotion, `CHECKPOINT` after promotion so archiving starts, fencing the old primary before it rejoins (`pg_rewind`) — never let it accept writes (C-108).

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.
- Tenant-visible impact (ingest, dashboards or data): open an incident (`incident.md`) and post on the status page.

## EtcdMembersLow (TM-DOS-04.M.6)

**Meaning.** Fewer than 3 healthy etcd members for 5 m: one more loss and Patroni cannot elect a leader (and the health controller loses its lease).

**First checks**

- Which member (`core-a`, `core-b`, `mon-c`) and why.

**Mitigation**

- Restore the member; postpone maintenance on the others.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0020, C-108.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
