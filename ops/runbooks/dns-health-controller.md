# Runbook: health controller holds no lease

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: HealthControllerNoLease

**Rule:** `ops/alerts/slo.rules.yaml` — `max(scf_health_controller_leader) < 1 or absent(scf_health_controller_leader)` for 2 m, critical, TM-DOS-05.M.1 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** `services/health-controller` (two instances elected through etcd, C-92) probes edge nodes and maintains the ingest DNS record sets at both providers. **Scale-out profile only:** the lean profile does not deploy the health controller, its etcd or DNS provider tokens — DNS records are static in Azure DNS (C-123), and the lean Prometheus template has no `health-controller` job. On the local monitoring overlay: services `hc-mon-c`, `hc-core-b`, `etcd`.

## Commands used below

Run from the repository root (local Compose) or on `app-1` (lean production profile, C-123). Prometheus and
Alertmanager listen on `127.0.0.1` only; from a workstation use an SSH tunnel (`ssh -L 9090:127.0.0.1:9090 -L
9093:127.0.0.1:9093 app-1`).

```sh
# Local Compose (base stack + monitoring overlay)
DC="docker compose -f infra/compose/compose.yaml -f infra/compose/compose.monitoring.yaml"
# Production, lean profile (the Ansible role compose_stack deploys exactly this project)
DC="docker compose -p scf --project-directory /opt/scf/current/infra/compose \
  -f /opt/scf/current/infra/compose/compose.yaml -f /opt/scf/current/infra/compose/compose.monitoring.yaml \
  -f /etc/scf/stack/compose.prod.yaml"

# Instant PromQL query → one JSON line per series
promq() { curl -s http://127.0.0.1:9090/api/v1/query --data-urlencode "query=$1" | jq -c '.data.result[] | {m: .metric, v: .value[1]}'; }
# Read-only SQL as the PostgreSQL superuser (break-glass: metadata and counts only, never tenant content;
# note every session in the incident record)
scfsql() { $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/pg_superuser_password)" psql -X -U postgres -d scf -c "$1"' sh "$1"; }
```

## HealthControllerNoLease (TM-DOS-05.M.1)

**Meaning.** No instance holds the leader lease, so nothing removes a dead edge node from DNS. Traffic keeps going
to whatever the records say; failover of a dead node is manual while this lasts.

**First checks** (local overlay / scale-out)

```sh
promq 'scf_health_controller_leader'
$DC ps etcd hc-mon-c hc-core-b
$DC logs --since 15m hc-mon-c | tail -30
$DC exec -T etcd etcdctl endpoint health
```

**Mitigation**

- etcd unhealthy: restart it (`$DC restart etcd`); in production restore quorum of the etcd members first.
- Both instances down: `$DC up -d hc-mon-c hc-core-b`.
- While no leader exists and an edge node is down: remove its address from the record set by hand at both DNS
  providers (`edge-node-down.md`) and record the change for `dns-drift.md`.

**Escalation**

- Critical: daily watch; incident if an edge node is down at the same time.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
