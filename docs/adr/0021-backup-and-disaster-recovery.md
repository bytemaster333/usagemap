# ADR-0021: Backup and disaster recovery

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** slo.dashboard-availability, handover.data-migration, ops.rebuild-from-repo, docs.operator-runbooks, test.automated-suite, privacy.tenant-erasure

## Context
Handover needs a full data migration (handover.data-migration) and infrastructure that can be rebuilt from the open-source
monorepo (ops.rebuild-from-repo); handover readiness must be demonstrable at any time. The dashboard target
(99.9 %) and the durability objective need backups that are restorable, not merely taken. One PostgreSQL 18
cluster holds two databases, `scf` and `umami` (register, "System at a glance").

**pgBackRest maintenance history** (VERIFIED from the repository,
release notes, LWN, Percona and The Register):
- Crunchy Data, the long-time sponsor and employer of sole maintainer David Steele, was acquired by Snowflake in
  June 2025.
- **2026-04-27:** the repository was archived for lack of sustainable funding.
- **2026-05-18:** continuation announced with a sponsor coalition (initially AWS, Supabase, pgEdge, Tiger Data,
  Percona, Eon); the README now also lists Xata, Dalibo and Data Egret.
- Releases resumed: 2.59.0–2.59.3 (Aug–Oct 2026) and **2.60.0 on 2026-10-18**; commits as recent as 2026-11-06.
- **2.59.3** fixed "weak encryption subkeys and salts" generated when system random data could not be read.
  **2.60.0** makes `restore` fail on invalid page checksums by default.
- Percona plans a second maintainer; no confirmation found, so the bus factor is still about one.

Alternatives: **WAL-G 3.0.9** (Apache-2.0, but official release
binaries include GPL-3.0+ LZO; multi-storage, very active), **Barman 3.20.1** (GPL-3.0, EDB), native
`pg_basebackup` with PG 17+ incremental backups (no tool, but retention, encryption and upload are ours to script).
Hetzner Object Storage offers only SSE-C and only `NoncurrentDays` lifecycle rules (one reason neither repository
is placed there); client-side encryption is needed in any case.

## Options considered
1. **pgBackRest, two encrypted repositories at two providers, plus a weekly logical dump (chosen).** Pros: mature
   PITR, parallel restore, per-repository encryption and retention, `create_replica_methods` for Patroni. Cons:
   bus factor ≈ 1; a second maintenance lapse is possible.
2. **WAL-G as primary.** Pros: very active, failover storages. Cons: release binaries are a GPL-3.0+ combined work
   (still OSI); fewer restore-verification features out of the box. Kept as the documented fallback.
3. **Barman.** Pros: EDB-backed. Cons: GPL-3.0, centred on a backup server we would also operate.
4. **`pg_basebackup` + `pg_combinebackup` + our scripts.** Pros: no external tool. Cons: we would own encryption,
   retention and upload code — the riskiest part to get wrong.
5. **Managed PostgreSQL backups.** Cons: no physical WAL access, so backups cannot be restored elsewhere;
   undermines handover (ADR-0018).

## Decision
- **pgBackRest pinned at the current 2.60 series** (never below 2.59.3; 2.60.0 makes `restore` fail on invalid page
  checksums by default) (C-29), with two repositories, each with its own client-side cipher pass (AES-256-CBC)
  held in SOPS; provider-side encryption is not relied on:
  - `repo1`: **UpCloud** object storage;
  - `repo2`: **OVHcloud** object storage (on the witness provider) (C-29).
  > **Superseded by C-110 (2026-11-12):** the two repositories are two Azure storage accounts in two regions (C-96
  > makes Azure the deployment target); the second may move to another provider later without a design change.
  > pgBackRest is 2.60.0 from the PGDG packages (C-108).
- **Schedule and retention (C-29):** weekly full and daily differential backups; a **35-day point-in-time
  window** in both repositories.
- **Write without delete (C-66).** Database nodes write backups with credentials that cannot delete or
  overwrite; expiry is by bucket lifecycle rule, not by a delete issued from a database node. A compromised
  database node therefore cannot destroy existing backups.
  > **Superseded by C-108 / C-110 / C-112 (2026-11-12, spike S-08):** pgBackRest cannot complete a backup without
  > delete rights, so there is no no-delete credential. Instead: **blob versioning** on the containers; database
  > nodes may delete current blobs but **not previous versions** (Azure: no `deleteBlobVersion` / `permanentDelete`);
  > pgBackRest's own `expire` enforces retention; a lifecycle rule deletes previous versions after **14 days** and
  > never touches current blobs; the restore-drill host uses a read-and-list-only credential. Erased data leaves
  > backups within **56 days** (35-day window + up to 7 days a weekly full stays current + 14 days as a previous
  > version, C-112). PostgreSQL runs with `init: true`, a `CHECKPOINT` after every start and promotion, and an old
  > primary is fenced and `pg_rewind`-ed before it rejoins (C-108).
- **WAL archiving** with `archive-async` and a local spool, `archive_timeout = 60` s, so WAL-based loss is about
  one minute even if both database nodes are lost. Hourly `pgbackrest check` feeding a metric. Timers run only on
  the current primary.
- **Point-in-time recovery** to any moment inside the 35-day window.
- **Weekly logical `pg_dump`** (custom format, all databases, age-encrypted) to `repo2`'s provider, **kept 5
  weeks** (C-29): a tool-independent copy, portable across major versions, and **the data-migration format for
  handover**.
  > **Note (C-121, 2026-11-13):** until upload with a managed identity exists, the weekly dump is uploaded with a
  > **user-delegation SAS** (permissions `racwdl`, short-lived, kept SOPS-encrypted with the other secrets) — the
  > same credential shape the database nodes use for pgBackRest in the Compose HA profile.
- **Erasure and backups.** Erased or expired data therefore leaves all backups within 35 days, which the erasure
  report states (C-29, ADR-0030).
  > **Superseded by C-112:** within **56 days** (see the note above); erasure selectors are kept for the job plus
  > 56 days so any restore can re-apply them (C-111, C-112).
- **Weekly automated restore drill** into a scratch instance **on our own EU infrastructure, never on
  GitHub-hosted runners; backup keys never leave it** (C-56). The drill restores from `repo2` to "now − 15 min",
  runs `pg_amcheck --heapallindexed`, compares per-day row counts and value sums against a checksum manifest
  written by the nightly rollup job, pushes success time and duration as metrics, and destroys the scratch
  instance. Only the result — pass/fail, timings, checksums — is published to `docs/evidence/restore-drills/`;
  never rows (ADR-0017).
- **Rebuild-from-zero drill** in a throwaway project using the runbook `ops/runbooks/dr-rebuild-from-zero.md`
  (quarterly). The handover rehearsal is this drill
  run by the incoming service operator.
- **Fallback:** if pgBackRest loses maintenance again, switch to **WAL-G** (or `pg_basebackup`) within a day via a
  documented runbook behind the same `make backup` / `make restore-drill` interface; the weekly dump bridges
  the gap.
- **Targets, to be measured before they are quoted:** failover 30–60 s; rebuild from zero ≈ 4 h; data loss ≈ 0
  with both database nodes healthy (synchronous replication, ADR-0020).

**These recovery targets are unmeasured.** Until a drill has produced timed evidence, `docs/sla.md` and
any public statement may only call them design targets.

| Scenario (research estimate) | Data loss | Time to recover |
|---|---|---|
| Primary host lost, standby healthy | 0 (synchronous) | ≈ 30–60 s, automatic |
| Both database nodes lost / corruption | ≤ ≈ 1 min of WAL, or to the chosen PITR target | ≤ ≈ 2 h plus human response time |
| Whole primary provider lost | ≤ ≈ 1 min (from `repo2`) | ≤ ≈ 4 h rebuild in the other provider |
| Ingest during any database outage | 0 acknowledged events (spools) | n/a — ingest stays up |

## Consequences
Positive: two independent repositories at two providers; a tool-independent dump that doubles as the handover
artefact; restores are exercised weekly and evidenced in the repository; the fallback is pre-written.

Negative: backups keep data after an erasure until they expire (within 35 days; stated in ADR-0030 — superseded by C-112: within 56 days);
cipher passes cannot be rotated for existing backups, so handover needs a new repository path and the old
repository kept readable until its retention lapses; lifecycle-based expiry must stay consistent with pgBackRest's
own backup manifest; drill VMs cost ≈ €10–30 each; restore time is dominated by
VM provisioning, so it depends on provider capacity at the time.

Must do / watch: alert on last full > 8 days, last differential > 26 h, archive failures, and drill success older
than 8 days; watch pgBackRest's maintainer situation each quarter; keep scheduled workflows alive (60-day
auto-disable) for the evidence and dead-man's-switch jobs (ADR-0022).

Revisit if: pgBackRest is archived again or misses a security release; a drill misses a target; WAL-G gains an
LZO-free official build; counsel requires faster erasure propagation into backups.

Unproven: pgBackRest against UpCloud and OVHcloud object storage (signature version, path style), with
write-only credentials and lifecycle expiry (S-08);
every number in the table above; the checksum-manifest comparison.

## Open points
1. Open: whether pgBackRest works with credentials that cannot delete and with expiry by bucket lifecycle rule
   (C-66) without its manifest drifting from what the bucket holds — closes with S-08.
