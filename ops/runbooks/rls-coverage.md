# Runbook: row-level security coverage drift

Status: first check exercised 2026-11-14 (gates on the running local stack) — see the drill log
Owner: security responders
Last reviewed: 2026-11-14
Alerts: RLSCoverageDrift

Source: `docs/monitoring-plan.md` §4.4, `db/README.md`. Alert state (`ops/alerts/coverage.json`): **no rule yet** —
`scf_rls_coverage_violations` (rows of a scheduled RLS-coverage query) is not exported (owner: jobs). Until it
is, run the gates below after every deploy and weekly.

## Built today

- The database gates G1–G11 (`db/gates/g*.sql`, each must return zero rows; data-model §15 as amended by C-103 and
  C-114): RLS + `FORCE` on every table and partition, backstop policies, no grants on partitions,
  `security_invoker` views, the `SECURITY DEFINER` allow-list, no `BYPASSRLS` role (except `replicator` with
  `REPLICATION` only, C-120), partition policies, definer membership, tenant primary keys, composite foreign keys,
  the global-table list.
- They run in the database tests (`make test-db`, `db/tests/gates_test.go` breaks each gate on purpose) and on every migration when
  `SCF_DB_RUN_GATES=1`, and inside every restore drill (`restore-drill.md`).
- `db/migrate.sh gates` runs them on demand; in Compose through the migration image (it holds the migrator password).

## RLSCoverageDrift (TM-ISO-02.M.1)

**Meaning.** A table or partition in `scf` without RLS + FORCE, a grant on a partition, a view without
`security_invoker`, a non-allow-listed `SECURITY DEFINER` function, or a role with `BYPASSRLS` exists in production.

**First checks**

```sh
$DC run --rm --no-deps db-migrate gates        # one line per gate: "gNN_….sql: ok" or the offending rows; exit ≠ 0 on a finding
```

- Which object (the gate prints it); was it created by a migration (then the database gate tests should have failed — find out
  why) or by hand (`ddl` in the PostgreSQL log is off by design; check the change records and who had superuser)?
- Partitions are created by the `partitions` job (`scf.ensure_partitions()`) and must carry RLS: check
  `scf_job_runs_total{job="partitions"}` for failures and `\d+` of the new partition.

**Mitigation**

- Fix in a migration (never by hand without a migration); re-run the gates (`db/README.md`).
- Until fixed, treat the object as possibly cross-tenant readable: check the isolation matrix
  (`make isolation-report`) and `isolation-breach.md`.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- ADR-0013, C-103, C-114, C-120, `db/README.md`, `isolation-breach.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg`, after the day's drills (tenants created, erased and purged; key rotation) | `$DC run --rm --no-deps db-migrate gates` | **pass** — G1–G11 `ok`, under 1 s. A deliberate breakage was not provoked here (that is `db/tests/gates_test.go`, `make test-db`). |
