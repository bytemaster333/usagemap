# Evidence: PostgreSQL failover, fencing, backups and restore drill (Compose HA profile, 2026-11-13)

**Run:** `infra/compose/ha/tests/run.sh` with `EVIDENCE_DIR=docs/evidence/chaos/postgres-ha-2026-11-13`, 2026-11-13
09:56–10:02 UTC, one 8-core host, Docker project `scf-wsj2`. **Result: 16 passed, 0 failed.** Raw log, measurements
and the drill's JSON report are in [`postgres-ha-2026-11-13/`](postgres-ha-2026-11-13/) (pass/fail, timings,
checksums — no rows, no addresses, no secrets; T14 checked every container log for every secret value).

**Stack:** PostgreSQL 18.6 + Patroni 4.1.5 + pgBackRest 2.60.0 (PGDG packages) on two nodes, synchronous non-strict
replication, `use_pg_rewind`; etcd 3.6.16 × 3; HAProxy 3.2.26 following `GET /primary`; PgBouncer 1.26.1 (transaction
mode) from the base stack; two Azurite 3.37.0 accounts as the two backup repositories (HTTPS, AES-256-CBC per
repository); database nodes hold a `racwdl` SAS, the drill a read+list SAS. Patroni `ttl` 30 s, `loop_wait` 10 s,
`retry_timeout` 10 s. The platform's own `db-migrate` ran through the proxy; the RLS gates ran on every restored copy.

## Failover under write load (T08, T09)

Four writers committed one row per transaction through **PgBouncer → HAProxy → primary**; an id was recorded as
acknowledged only after `COMMIT` returned. The primary was killed with `SIGKILL` (power loss).

| Measure | Value |
|---|---|
| Acknowledged commits during the test | 2,443 |
| **Acknowledged commits missing on the new primary** | **0** (RPO 0 with a healthy synchronous standby) |
| Kill → standby promoted (Patroni leader-key expiry dominates; promotion itself < 1 s) | 23.8 s |
| Longest gap between acknowledged commits (write outage seen by clients, incl. HAProxy detection) | 30.4 s |
| Client-side failures with unknown outcome / of which actually committed | 3 / 1 — a failed `COMMIT` is ambiguous; writers must be idempotent (the metrics writer's batch ledger is) |
| New timeline | 2 |
| `CHECKPOINT` after promotion (C-108), logged by the callback | yes |
| `pgbackrest check` on the new primary (WAL of timeline 2 archived to **both** repositories) | ok, 0.26 s |
| Old primary restarted → rejoined as synchronous standby (Patroni ran `pg_rewind`) | 29.9 s; read-only; row count and sum identical to the new primary |

Earlier runs of the same suite on the same day: promotion 21.6–26.8 s, write gap 30.4–30.7 s, 0 acknowledged commits
lost in every run (1,526–2,949 commits).

## Fencing by isolation (T10)

The primary was disconnected from etcd, its standby and the proxy (all three networks) while the writers ran.

| Measure | Value |
|---|---|
| Isolated primary stops accepting writes (Patroni demotes it: "DCS is not accessible") | 11.8 s after isolation |
| Standby promoted | 24.5 s after isolation — **after** the old primary was fenced, so no split brain |
| Write attempted on the isolated node's local socket | refused (`the database system is shutting down`) |
| Acknowledged commits lost | 0 of 318 |
| Rejoined after the partition healed | 6.7 s |

Earlier runs: demotion 11.9–15.0 s, promotion 24.5–27.1 s; the order held every time.

## Backups and restore drills (T04–T07, T12, T13)

| Test | Result |
|---|---|
| Full backup to repo 1 and repo 2 by the scheduler; `pgbackrest check` (WAL to both) | ok |
| Differential backup to both repositories | ok |
| Restore drill, latest (repo 2, read-only SAS): restore 9.7 s, ready 11.3 s, `pg_amcheck --heapallindexed` all databases, **11 of 11 RLS gates**, 3 expectations (row count and id sum of the test table, number of applied migrations, Umami tables) | PASS |
| Point-in-time drill to a time between two batches of 1,000 rows | PASS — exactly the first batch (`1000:-500500`) |
| Four bundle blobs of the backup set overwritten in repo 2 | drill **FAIL** `stage=restore` (`block map version must be zero`); metric `scf_restore_drill_success{repo="2"} 0` |
| New full backup to repo 2, drill again | PASS |
| Weekly logical dump (age-encrypted) → restore into an empty instance → manifest of 56 tables in 3 databases compared | `DUMP-RESTORE PASS` |

## Limits of this evidence

- One machine, small database (≈ 40 MB); timings measure overhead, not throughput at production volume.
- Fencing was Patroni's self-demotion and a container kill; the provider-API power-off of the runbook was not run.
- Azure-only protections (blob versioning, previous-version lifecycle rule, managed identity, private endpoints)
  cannot run on Azurite; they are asserted in `infra/opentofu` against a mock provider only (risk R-23, MP-10).
- RLS gate G6 was run with the replication-role exemption for the HA setup (`replicator` with REPLICATION only); the
  unmodified gate flags that role on any streaming-replication cluster.
