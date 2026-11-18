# Runbook: PostgreSQL connections near the maximum

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: ConnectionsNearMax

**Rule:** `ops/alerts/platform.rules.yaml` — `sum by (instance) (pg_stat_activity_count) / max by (instance) (pg_settings_max_connections) > 0.8` for 5 m, warning (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** all runtime roles connect through PgBouncer 1.26.1 in transaction mode (`infra/compose/compose.yaml` service `pgbouncer`); only `db-migrate`, the backup scripts and Patroni connect directly. **Gap:** the rule reads `postgres_exporter` metrics, and no PostgreSQL exporter is scraped in `ops/prometheus/prometheus.yml` or the lean template — the alert has no input until one is added. The SQL below works regardless.

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

## ConnectionsNearMax

**Meaning.** More than 80 % of `max_connections` are in use. New connections (a deploy, a migration, an emergency
`psql`) will soon be refused.

**First checks**

```sh
scfsql "SHOW max_connections"
scfsql "SELECT usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC"
scfsql "SELECT pid, usename, state, now() - state_change AS in_state FROM pg_stat_activity
         WHERE state = 'idle in transaction' ORDER BY in_state DESC LIMIT 10"
$DC logs --since 30m pgbouncer | tail -30
```
Many direct connections from one role (not `pgbouncer`) point to a service configured to bypass PgBouncer.

**Mitigation**

- Terminate long `idle in transaction` sessions of runtime roles: `scfsql "SELECT pg_terminate_backend(<pid>)"`.
- A leaking service: restart it (`$DC restart <service>`) and open a defect.
- Raise PgBouncer's pool sizes only together with `max_connections` (a restart of PostgreSQL — a maintenance window
  in the lean profile).

**Escalation**

- Warning: maintainers within the working day; critical (incident) once connections are refused.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
