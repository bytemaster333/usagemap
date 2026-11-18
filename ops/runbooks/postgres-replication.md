# Runbook: replica lag

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: ReplicationLagHigh

**Rule:** `ops/alerts/platform.rules.yaml` — `max by (instance) (pg_replication_lag_seconds) > 30` for 5 m, warning, TM-DOS-04.M.5 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** streaming replication exists only in the HA overlay (Patroni 4.1.5 + etcd, synchronous standby; `infra/compose/compose.ha.yaml`, services `pg-a`, `pg-b`; C-120). The lean profile runs a single PostgreSQL and has no replica (C-123), so this alert does not apply there. **Gap:** as for `postgres-connections.md`, no PostgreSQL exporter is scraped yet.

## Commands used below

```sh
DCHA="docker compose -f infra/compose/compose.yaml -f infra/compose/compose.ha.yaml"
$DCHA exec -T pg-a patronictl -c /etc/scf/patroni.yml list      # Leader, Sync Standby, lag in MB, timeline
```

## ReplicationLagHigh (TM-DOS-04.M.5)

**Meaning.** The standby is more than 30 s behind. With a **synchronous** standby, commits on the primary wait for
it, so lag normally shows as slow writes, not as data at risk; a standby that falls out of sync is demoted to
asynchronous by Patroni and a failover could then lose the lag.

**First checks**

```sh
$DCHA exec -T pg-a patronictl -c /etc/scf/patroni.yml list
$DCHA exec -T pg-a sh -c 'PGPASSWORD="$(cat /run/secrets/pg_superuser_password)" psql -X -U postgres -c \
  "SELECT application_name, state, sync_state, write_lag, flush_lag, replay_lag FROM pg_stat_replication"'
```
Check disk I/O and disk space on the standby (`disk-space.md`) and WAL archiving (`backup-failure.md`).

**Mitigation**

- Transient (bulk erasure, retention, a large rollup): wait and watch; the alert clears.
- Standby stuck or broken: reinitialise it from the primary — `$DCHA exec -T pg-b patronictl -c /etc/scf/patroni.yml
  reinit <cluster> pg-b` (restores from repository 1 through `scf-backup replica-restore`, then streams).
- Never promote a lagging standby by hand; failover is Patroni's (`failover-postgres.md`).

**Escalation**

- Warning: maintainers within the working day; critical if `Sync Standby` disappears from `patronictl list`.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
