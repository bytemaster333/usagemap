# Handover data-migration drill, local — 2026-11-18

Capabilities: handover.data-migration (mechanics), handover.independent-operator and handover.ready (partly), ops.end-of-window-read-only (export) · runbooks
[`handover-migration.md`](../../ops/runbooks/handover-migration.md),
[`end-of-window-no-successor.md`](../../ops/runbooks/end-of-window-no-successor.md) · script
[`tests/handover/run.sh`](../../tests/handover/run.sh).

**Result: `HANDOVER-DRILL PASS commit=pre-release passed=27 failed=0`** (run 6 of the day; runs 1–5 failed and
each failure is listed under "What the drill found", with what was changed).

## Setup

| | Old operator | New operator |
|---|---|---|
| Source | `git clone --branch main` of this repository at `pre-release` (committed tree only) | a second, separate clone of the same commit |
| Stack | Compose project `scf-hoa`: `compose.yaml` + `compose.dev.yaml` + `compose.ha.yaml` (Patroni primary + standby, three etcd, HAProxy, pgBackRest to two Azurite blob accounts, weekly age-encrypted logical dump) | Compose project `scf-hob`: `compose.yaml` + `compose.dev.yaml`, single PostgreSQL |
| Secrets | its own (`ha-init.sh`) | its own (`init.sh`: own database passwords, own PKI and CA, own SEP-10 key), plus the 11 values carried over under C-50: `pepper_ing`, `pepper_op`, `pepper_pub`, `edge_signing_key.pem`, `edge_snapshot_pub.pem`, `edge_snapshot_pub_next.pem`, `snapshot_signing_key.pem`, `snapshot_pub.pem`, `umami_creds_keys`, `umami_app_secret`, `umami_provisioner_password` |
| Data | the 20 synthetic DEMO projects of `tools/demo-seed` through the real API and the database: **105 tables (75 `scf`, 30 `umami`), 580,723 rows** (392,145 `scf`, 188,578 `umami`) | — |
| Host ports | 127.0.0.1:56720–56722 | 127.0.0.1:56723–56725 |

At most one stack ran at a time: the old stack was removed (`down -v`) before the new one started. Images: the
machine's `scf/*:dev` tags and `usagemap/postgres-ha:18.6-pgbr2.60.0-patroni4.1.5` (`--no-build`); both stacks used the
same images, so the drill tests the data path, not an upgrade.

## Steps and timings (run 6)

| Step | Result | s | What |
|---|---|---|---|
| a-secrets, a-up | ok | 2 + 38 | old stack healthy |
| a-seed | ok | 38 | demo seed (API + SQL), then 30 s for the jobs service |
| a-freeze | ok | 1 | writers stopped (gateway, Collector, writer, jobs), public answers recorded, read path stopped |
| a-fingerprint | ok | 4 | F0 on the primary: 150 lines — every table and partition (rows + MD5 over sorted row MD5s), sequences, 10 schema parts, database owner/ACL/settings, 17 roles |
| a-dump | ok | 5 | `scf-backup dump`: 12,414,104 bytes, uploaded to repository 2 |
| a-transfer | ok | 0 | downloaded; SHA-256 `79057c0b…87dbe9` recorded **out of band** |
| a-pgbackrest-full | ok | 3 | `scf-backup backup full 2` |
| b-pgbackrest-restore | ok | 22 | **path (b)**: repository 2 restored with the read+list SAS (restore 15 s, recovery 1 s, `pg_amcheck` 5 s); **F_b = F0** |
| t1-flipped-byte | ok | 0 | one bit flipped in `dump.tar.age`, `SHA256SUMS` untouched → refused, `stage=integrity` (out-of-band hash) |
| t2-consistent-forgery | ok | 0 | forged archive (one Umami website renamed, manifest recomputed, re-encrypted to the recipient, fresh `SHA256SUMS` — what anyone with write access to the store can make) → refused, `stage=integrity` |
| t3-stale-manifest | ok | 6 | forged archive with the original manifest, imported with its own hash (out-of-band channel lost) → refused, `stage=compare` (`public.website`) |
| t4-compromised-oob-hash | ok | 0 | the consistent forgery with a forged out-of-band hash: the import **passes**; only the fingerprint diff against F0 names `umami public.website` |
| t5-import-without-create | ok | 10 | the original imported the way `scf-backup dump-restore` does (plain `CREATE DATABASE`): data equal, but the **owner and ACL of both databases are lost** (`scf`: `scf_migrator` → `postgres`; `umami`: `umami_app` → `postgres`; ACL → default, i.e. `CONNECT` for `PUBLIC`) |
| n-secrets, n-carry-over, n-postgres | ok | 1 + 0 + 6 | new operator's secrets; three of its database passwords checked to differ from the old ones |
| a-import | ok | 12 | **path (a)**: `import.sh --into-fresh` (hash, age, archive members, fresh-target guard, globals, `pg_restore --create`, manifest) |
| a-import-twice | ok | 1 | a second import into the now non-fresh target → refused, `stage=target` |
| a-fingerprint | ok | 0 | **F_a = F0** (all 150 lines; SHA-256 of the three fingerprint files identical: `09f374ab…3d99`) |
| n-up | ok | 27 | the whole new stack healthy on the migrated data |
| n-umami-bootstrap, n-db-migrate, n-readyz | ok | 0 | the carried-over provisioning password logs in to the migrated Umami; migrations a no-op and every role password set from the new secrets; control plane reaches the database |
| n-old-credentials-refused | ok | 0 | the old operator's `scf_app` password does not log in |
| n-api-parity | ok | 0 | the public answers that were `200` before the freeze are identical after (status + body, origin and time fields normalised): 1 of 4 — see limits |
| n-aggregate-export | ok | 5 | **ops.end-of-window-read-only**: `export-aggregates.ts` (working tree, Node 24 container on the database network) → `usagemap-aggregate-export` 1.0.0, 15 files, 295,026 rows, every SHA-256 equal to the manifest, no unlisted file |

Wall clock of the whole drill: 4 min 10 s (17:06:28–17:10:38 UTC).

## What the drill found (runs 1–5) and what changed

| # | Finding | Where | Status |
|---|---|---|---|
| 1 | **`scf-backup dump-restore` / `dump-verify` lose database-level properties**: they restore each database into a plain `CREATE DATABASE`, so the owner (`scf_migrator`, `umami_app`), the ACL (`REVOKE ALL ON DATABASE umami FROM PUBLIC` and the per-role `CONNECT` grants) and any `ALTER DATABASE … SET` are not migrated, and their manifest check cannot see it. Measured by t5. | `infra/compose/ha/bin/scf-backup` (`dump_restore`) | `import.sh` uses `pg_restore --create`; infra change requested (below) |
| 2 | **The dump's integrity rests on a file stored next to it**: `dump_restore` checks `SHA256SUMS` from the same container. Anyone who can write the dump store also holds the age recipient (it is on every database host) and can produce a well-formed archive and a matching `SHA256SUMS` (t2). | same | `import.sh` requires `--expect-sha256` from a separate channel; infra change requested |
| 3 | PostgreSQL 18 re-parses CHECK expressions on restore and flattens nested `AND`s (`((a AND b) AND c)` → `(a AND b AND c)`; `hist_exp3_map`, `seal_leaves`, `web_dev_events`), and names a partitioned table's NOT NULL constraints differently (`api_metrics_1m_*_not_null` → `…_not_null1`). Semantically identical; **a future migration must not refer to a generated NOT NULL constraint by name**, or it fails on a migrated database. | PostgreSQL behaviour | fingerprint compares CHECKs without parentheses and NOT NULLs by column; risk noted for migrations |
| 4 | Explicit owner-only ACLs on partitions and on schema `scf_migrations` come back as `NULL` (the same effective privileges). | PostgreSQL behaviour | fingerprint compares effective ACLs (`acldefault`) |
| 5 | Drill harness defects: the HA image's entrypoint needs `--entrypoint`; the demo seed needs the portal origin `http://localhost:<port>` (CSRF origin check); fingerprint parts were aggregated in an undefined order; files the exporter writes must be readable by the operator. | `tests/handover/` | fixed |

## Limits (what this drill does not show)

- Both operators were on one machine with Azurite instead of Azure Blob; the transfer was a local copy. The real
  drill between two environments is recorded in `live-handover-drill-2026-11-18.md`.
- **Dashboard parity is thin:** only one of the four public answers sampled was `200` before the freeze (a signed
  snapshot list); the public stats pages answered `404` on the old stack even after 300 s in run 3 (not investigated
  here: the stats pages are computed by the jobs service). Tenant- and operator-API parity over closed ranges
  (handover plan §4.3) needs signed-in clients and was not run. The fingerprint equality (every row of every table)
  is the primary evidence.
- Not exercised: the carried-over peppers authenticating an existing ingest token / `op` key / share key, a
  provisioning-worker rotation of a tenant's Umami key on the new side, the delta migration after a DNS switch
  (§4.4), replica promotion over the mesh (§4.5), the read-only switch of ops.end-of-window-read-only (the images are from `main`, which
  predates it), and the hand-off of the export to a successor operator.
- Signed acceptance by a real successor (handover.independent-operator) is outside a local drill.

## Reproduce

```sh
eval "$(mise env -s bash)"
tests/handover/run.sh                 # OUT=<dir> keeps steps.tsv, F0/F_a/F_b, diffs, logs; KEEP=1 leaves scf-hob up
```
