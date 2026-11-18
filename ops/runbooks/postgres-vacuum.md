# Runbook: transaction ID wraparound risk

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-14
Alerts: XIDWraparoundRisk

Source: `docs/monitoring-plan.md` §4.4. Alert state (`ops/alerts/coverage.json`): **no rule yet** —
`pg_xid_wraparound_ratio` needs a custom postgres_exporter query (not built yet). Until it exists, run the first
query below monthly (it takes milliseconds) and record the ratio.

## Built today

- PostgreSQL 18.6 with autovacuum on defaults (local: `usagemap/postgres:dev`; lean: the HA image in single mode).
- Partitioned metrics tables (`api_metrics_*`, `web_*`): whole old partitions are dropped by the `partitions` job
  (`scf.drop_expired_partitions()`), which also removes their XID age; the big Umami tables are pruned by the
  `retention` job (`services/jobs/README.md`).
- The postgres_exporter of the monitoring overlay exports `pg_up`, connection counts and settings, not XID age.

## XIDWraparoundRisk (—)

**Meaning.** The oldest transaction ID age exceeds 50 % of 2³¹. PostgreSQL stops accepting writes at ~2³¹ − 3 M;
autovacuum normally freezes long before 10 % (`autovacuum_freeze_max_age` 200 M).

**First checks** (superuser `psql`, see `README.md` "`$DC`"; all four queries were run on the local stack on
2026-11-14 and return in milliseconds):

```sql
-- 1. per database: age and share of 2^31 (the alert's ratio)
SELECT datname, age(datfrozenxid) AS xid_age, round(100.0 * age(datfrozenxid) / 2147483648, 3) AS pct
FROM pg_database ORDER BY 2 DESC;
-- 2. the oldest relations of the database from (1) (connect with -d scf or -d umami)
SELECT c.oid::regclass AS relation, age(c.relfrozenxid) AS xid_age, pg_size_pretty(pg_total_relation_size(c.oid))
FROM pg_class c WHERE c.relkind IN ('r', 'm', 't') ORDER BY 2 DESC LIMIT 10;
-- 3. what blocks freezing: long transactions, abandoned prepared transactions, stale replication slots
SELECT pid, usename, state, now() - xact_start AS xact_age, backend_xmin FROM pg_stat_activity
WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 10;
SELECT gid, prepared, owner, database FROM pg_prepared_xacts;
SELECT slot_name, active, xmin, catalog_xmin FROM pg_replication_slots;
-- 4. is autovacuum keeping up on the relation?
SELECT relname, last_autovacuum, n_dead_tup FROM pg_stat_all_tables ORDER BY n_dead_tup DESC LIMIT 10;
```

**Mitigation**

- End the blocker: `SELECT pg_terminate_backend(<pid>)` for a stuck session (find its owner first: application
  roles are `scf_app`, `scf_writer`, `scf_jobs`, …); `ROLLBACK PREPARED '<gid>'` for an abandoned prepared
  transaction (none of our services uses two-phase commit, so any is abandoned); drop a replication slot that no
  standby uses (HA overlay: Patroni manages its slots — do not drop those by hand).
- Freeze the oldest relations in a quiet hour: `VACUUM (FREEZE, VERBOSE) <relation>;` — on a partitioned table run it
  per partition. For a partition that is past retention anyway, let the `partitions` job drop it instead.
- Above 80 %: freeze immediately regardless of load, and treat as an incident (`incident.md`).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- `docs/data-model.md` §10, §14; `postgres-connections.md`, `postgres-replication.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).
