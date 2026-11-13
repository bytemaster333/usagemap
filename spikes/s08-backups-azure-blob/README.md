# S-08 — Backups to Azure Blob (Azurite): pgBackRest PITR, two repos, write-only credentials, failover, drill, WAL-G
**Result:** PARTIAL — pgBackRest 2.60.0 → Azure Blob (Azurite, TLS, AES-256-CBC) does PITR, two repositories, a standby, a repeatable restore drill, and WAL-G works as a fallback; but **C-66 as worded is impossible with pgBackRest: a credential without delete cannot complete a single backup**, so the no-delete guarantee has to come from Azure blob versioning instead.

## Question
Can the backup design of ADR-0021 (C-29, C-56, C-66) be built on the Azure Blob interface that C-96 requires, and work
under Docker now against Azurite? Specifically:
1. pgBackRest → Azure Blob with client-side encryption, WAL archiving (`archive_timeout=60`), full + diff, exact PITR.
2. Two repositories, both written.
3. Credentials that cannot delete (C-66): what works, what fails, how retention must then work, does Azurite emulate lifecycle?
4. Streaming standby + promotion time; fencing of the old primary.
5. A restore-drill script with one PASS/FAIL line (the weekly drill).
6. WAL-G fallback: one backup + restore against Azurite.

## Method (versions, commands, how to re-run: one command if possible)
**Re-run:** `./run.sh` (≈ 16 min; `KEEP=1 ./run.sh` leaves the stack up). Docker project `scf-s08`, **no host ports
published**. Everything printed is in `evidence/run.log` (the log of the run quoted below). The drill alone:
`./restore-drill.sh [--target 'YYYY-MM-DD HH:MM:SS+00'] [--expect FILE]` (needs the stack from `KEEP=1 ./run.sh`).

| Component | Exact version / digest | Licence | How |
|---|---|---|---|
| PostgreSQL | `postgres:18@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42` = 18.6 (`18.6-1.pgdg13+2`, Debian trixie), data checksums on by default | PostgreSQL | base image |
| pgBackRest | **2.60.0**, package `pgbackrest=2.60.0-1.pgdg13+1` from **PGDG apt `trixie-pgdg`** (already configured in the official image) | MIT | `apt-get install pgbackrest=2.60.0-1.pgdg13+1` in `Dockerfile` |
| WAL-G | **v3.0.9** (commit 3e49318, 2026-08-20), official release asset `wal-g-pg-24.04-amd64.tar.gz`, sha256 `444ce216…14ef4` (verified by `ADD --checksum`) | Apache-2.0 source; **official binary is built with `USE_LZO=1` (GPL-3.0+ LZO) plus libsodium, brotli** (WAL-G's release workflow) | `Dockerfile` |
| Azurite | 3.37.0, `mcr.microsoft.com/azure-storage/azurite@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5`, run with `--disableTelemetry` (telemetry is **on by default**) | MIT | `compose.yaml` |
| Helper | `python:3.13-slim@sha256:e48f59cd…`, `azure-storage-blob==12.31.1` | MIT | `tools/` (containers, SAS, list/delete) |

Files: `Dockerfile` (PG 18 + pgBackRest + WAL-G), `compose.yaml`, `conf/pgbackrest.conf` (primary, repo1+repo2),
`conf/pgbackrest-drill.conf` (drill host: repo2 only, read+list SAS), `conf/pgbackrest-nodelete.conf` (C-66 test),
`conf/initdb-replication.sh`, `scripts/entry-restore.sh` (restore-then-start entrypoint), `tools/az.py`, `run.sh`,
`restore-drill.sh`. Secrets (random account keys, cipher passes, passwords, SAS tokens) and a throw-away CA are
generated per run into `.work/` (git-ignored) and passed as environment variables, never in config files.

Topology: two Azurite containers with **different storage accounts and keys** (`scfbackupa` on `azurite-a`,
`scfbackupb` on `azurite-b`) stand in for two providers/accounts; both serve **HTTPS only**, with a certificate from a
private CA. The run: Azurite up → primary + `stanza-create` on both repos → TLS variants → archive_timeout samples →
full (repo1, repo2) → 100 k rows → diff (repo1, repo2) → 100 k rows → note T → 100 k rows → PITR to T from repo1 into a
fresh container → restore drill (repo2) ×3 → no-delete SAS tests → standby restored from repo1, sync replication →
promotion with old primary alive → fencing, demotion, `pg_rewind` → WAL-G backup + restore → lifecycle-deletion
simulation → `down -v`.

## Observations (raw facts, with excerpts of output)
All excerpts are from `evidence/run.log` (final run, 2026-11-12 16:31–16:42 UTC). Data per batch: 100 000 rows
(~11 MB); database 30–41 MB. Times are wall-clock on one 8-core host, so they measure overhead, not throughput.

**O1 — Installation.** `postgres:18` already carries the PGDG apt source (`trixie-pgdg`). `apt-cache policy` there
offers `2.60.0-1.pgdg13+1`, `2.59.3-1.pgdg13+1`, `2.59.2-1.pgdg13+1` (PGDG) and `2.55.1-1` (Debian main). An unpinned
install from Debian main would land **below the 2.59.3 floor**, so the version must be pinned.

**O2 — Azure repo + TLS against Azurite.** `stanza-create`, `check`, backups, archive-push and restore all work with
`repoN-type=azure`, `repoN-azure-uri-style=path`, `repoN-storage-host=azurite-a`, `repoN-storage-port=10000`,
`repoN-azure-key-type=shared`, over HTTPS with a private CA:
```
-- with repo1-storage-ca-file=/certs/ca.crt:              archive / backup        exit=0
-- without the CA file (system trust store):
ERROR: [095]: unable to verify certificate presented by 'azurite-a:10000 (172.20.2.2)': [20] unable to get local issuer certificate
-- without the CA file, repo1-storage-verify-tls=n:       archive / backup        exit=0
```
pgBackRest's Azure driver is HTTPS-only, so Azurite has to run with `--cert/--key`; `repoN-storage-ca-file` is the clean
answer (`verify-tls=n` works but must never reach production). Python 3.13's strict X.509 check rejected a CA without
`keyUsage` (`CA cert does not include key usage extension`); the CA in `run.sh` carries `basicConstraints=critical,CA:TRUE`
and `keyUsage=critical,keyCertSign,cRLSign`.

**O3 — `archive-async` needs an init process as PID 1.** In the first attempt (PID 1 = postmaster, the official image's
default) the async archiver's detached child exited non-zero and the postmaster treated it as a crashed backend:
```
LOG:  untracked child process (PID 146) exited with exit code 103
LOG:  terminating any other active server processes
FATAL:  archive command was terminated by signal 3: Quit
LOG:  all server processes terminated; reinitializing
```
With `init: true` (docker-init/tini as PID 1) this never recurred in three full runs.

**O4 — `archive_timeout=60`.** Three samples, each one small INSERT into an otherwise idle primary:
```
sample 1: write in ...03 -> segment switched after 292.25 s, archived to both repos after 292.46 s   (fresh start)
sample 2: write in ...04 -> segment switched after 44.76 s,  archived to both repos after 44.96 s
sample 3: write in ...05 -> segment switched after 38.46 s,  archived to both repos after 38.58 s
  16:31:38 checkpoint starting: shutdown immediate      16:36:43 checkpoint starting: time
```
The sample-1 effect reproduced in all three runs (run 1: segment switched only at the first timed checkpoint, 5 min after start; run 2: 331 s; run 3: 292 s): **after a server start, the first
archive_timeout switch does not happen until the first timed checkpoint (`checkpoint_timeout`, 5 min).** Cause (from
reading `src/backend/postmaster/checkpointer.c`, REL_18_STABLE l. 572): the checkpointer computes its sleep while
`RecoveryInProgress()` is still true during startup, so it ignores archive_timeout and sleeps a full checkpoint_timeout;
nothing wakes it. A promoted standby did not show it (promotion requests a checkpoint). Mitigation tested on the fresh
WAL-G instance: `CHECKPOINT` right after start, then one write → `archived after 58.48 s`. Once the archiver has a
segment, the push to both repos takes ~0.1–0.6 s.

**O5 — Backups, both repositories.** Full and diff to each repo (backup runs per repo; `archive-push` writes every
segment to **all** repos):
```
FULL repo1: 1.81 s  (30.1MB, repo size 3.6MB)   FULL repo2: 1.89 s
DIFF repo1: 1.72 s  (11.1MB, repo size 3MB)     DIFF repo2: 1.14 s
check: WAL segment ...11 successfully archived to '/scf/archive/scf/18-1/...' on repo1 / on repo2
-- account A: # 38 blobs, 31668008 bytes      -- account B: # 38 blobs, 31667896 bytes
```
`pgbackrest info` reports `cipher: aes-256-cbc`; each repo has its own cipher pass.

**O6 — Point-in-time restore (repo1 → fresh container).** T = `2026-11-12 16:38:52.258381+00`, taken between batch 2
and batch 3:
```
restore_seconds=8.85
PITR container up -> promoted and writable: 10.73 s
LOG:  recovery stopping before commit of transaction 773, time 2026-11-12 16:38:53.535668+00
restored batch 1: 100000      restored batch 2: 100000
PITR VERIFY PASS (batch1/2/3 = 100000/100000/0)
```
Runs 1 and 2 gave the same exact counts (run 1: restore 10.93 s, writable after 15.30 s).

**O7 — Restore drill (`restore-drill.sh`).** The drill host has only `pgbackrest-drill.conf` (repo2 alone) and a
**read+list SAS (`sp=rl`)**: no account key and no write permission.
```
RESTORE-DRILL PASS repo=2 target=latest restore=8.93s ready=12.0s amcheck=0.5s counts=1ok(0.1s) end_lsn=0/13B4E000 total=13.3s
RESTORE-DRILL FAIL repo=2 stage=counts reason="scf.pitr_test expected '1 1' got '300000 45001050000'" total=12.1s   (negative control)
RESTORE-DRILL PASS repo=2 target=2026-11-12 16:38:52.258381+00 restore=8.49s ready=11.3s amcheck=0.5s counts=1ok(0.2s) end_lsn=0/12DFE000 total=12.7s
```
`pg_amcheck --all --install-missing --heapallindexed` ran on every database. The scratch container and volume are
removed in both the PASS and FAIL paths.

**O8 — C-66, SAS without delete (`sp=racwl`).** `stanza-create`, `check` and archive-push **work**. **Backup fails**,
even with `--no-expire-auto` on an empty repository. The debug log shows the only remove issued:
```
new backup label = 20261112-163957F
storageRemove: (... path: /nd ...), fileExp: {"/nd/backup/nd/latest"}
ERROR: [039]: HTTP request failed with 403 (This request is not authorized to perform this operation using this permission.)
-- second full: first cleans up the aborted one (storagePathRemove) -> 403 again
-- info: status: error (no valid backups)
-- expire with the no-delete SAS: ERROR: [039]: repo1: HTTP request failed with 403
```
pgBackRest removes the `latest` link path at the end of **every** backup (a DELETE even on object stores, where
the link does not exist). Without `d`, Azure refuses that request with 403 before checking whether the blob exists. A
backup that aborts this way also cannot be cleaned up on the next attempt (`storagePathRemove` → 403). So **no backup
ever completes**. With `sp=rcl` (create-only, no overwrite, no delete): archive-push still works (a new WAL file is a
create) and backup fails with the same 403.

**O9 — Azurite cannot emulate the protections.** `set_immutability_policy` and `set_legal_hold` →
`HTTP 501 Current API is not implemented yet`. Lifecycle management is a management-plane (ARM) feature
(`managementPolicies`), and the Azurite 3.37.0 code base has no implementation of it at all. Blob versioning and soft
delete are not emulated either, so nothing in this paragraph's remedy can be exercised locally.

**O10 — Lifecycle deletion behind pgBackRest's back.** Deleting only the repo1 full backup's prefix, as an age-based
rule would, while its diff still exists:
```
info after deletion:   status: ok   full backup: 20261112-163844F   diff backup: ..._20261112-163848D
verify after deletion: verify exit=0
  WARN: backup '20261112-163844F' found in backup.info but not in the repository
  INFO: verify command end: completed successfully        ... 'file missing' lines: 1047
restore --set=<diff>: ERROR: [055]: ... unable to open missing file '/scf/backup/scf/20261112-163844F/bundle/1' for read
```
Manifest drift is real and silent: `info` still says `ok`, and `verify` **exits 0** while logging 1 047 missing files.
Only a restore fails. Blob layout a rule would have to target:
`scf/archive/scf/archive.info{,.copy}` (written once at stanza-create, never rewritten), `scf/archive/scf/18-1/<tli>/<WAL>`,
`…/<seg>.partial-*`, `scf/archive/scf/18-1/<tli>.history`, `scf/backup/scf/backup.info{,.copy}`,
`scf/backup/scf/backup.history/<yyyy>/<label>.manifest.gz`, `scf/backup/scf/<label>/…`.

**O11 — Standby and promotion.** Standby restored from repo1 with `--type=standby` (the Patroni
`create_replica_methods: pgbackrest` path): `restore_seconds=8.57`, then `replication: standby1 state=streaming sync=sync`.
```
pg_ctl promote -w: 0.48 s; promote + first committed write: 0.61 s      (run 1: 1.09 s / 1.74 s)
```

**O12 — No fencing means split brain.** With the old primary still running after the promotion:
```
after 15 s: state=active wait_event=SyncRep (statement_timeout does not cover the SyncRep wait)
WARNING:  canceling wait for synchronous replication due to user request
DETAIL:  The transaction has already committed locally, but might not have been replicated to the standby.
synchronous_commit=local:  INSERT 0 1
old primary rows in batches 11/12 (diverged history): 2
```
In run 1, before pg_cancel_backend was added, that client stayed blocked for over 15 minutes until the script's
timeout killed it.

**O13 — Fencing, demotion, rewind.**
```
fenced (SIGKILL = power-off via provider API) in 0.27 s
connect to old primary: ... Connection refused
restarted DEMOTED (standby.signal): ERROR:  cannot execute INSERT in a read-only transaction
LOG:  new timeline 2 forked off current database system timeline 1 before current recovery point 0/130002D8
(second start without rewind, run 2: FATAL: requested timeline 2 does not contain minimum recovery point 0/15000310 on timeline 1)
pg_rewind: Done!   new primary replication: oldprimary state=streaming
old primary after rewind: batch 11/12 rows=0 batch 10 rows=1
```
The split-brain rows were discarded by the rewind, and the new primary archives timeline 2 to both repos.

**O14 — WAL-G 3.0.9 against Azurite.** WAL-G only builds `https://<account>.blob.<AZURE_ENDPOINT_SUFFIX>/<container>`
(source `pkg/storages/azure/storage.go`), so Azurite was reached with a network alias `scfbackupa.blob.azurite-a` and
`AZURE_ENDPOINT_SUFFIX=azurite-a:10000`. Azurite takes the account from the host name when it has a dot. TLS used
`SSL_CERT_FILE`, and encryption used `WALG_LIBSODIUM_KEY`.
```
Wrote backup with name base_000000010000000000000004 ...   WAL-G backup-push: 1.54 s
WAL-G restore up->writable 8.60 s; rows want '200000 20000100000' got '200000 20000100000' -> PASS
WAL-G binary LZO symbols: lzo1x_decompress_safe
```
The official binary is dynamically linked against glibc only (`ldd`: libm, libc). Its LZO code is the GPL-3.0+ part
noted in ADR-0021.

## Answer to the question
1. **pgBackRest → Azure Blob: yes.** pgBackRest 2.60.0 from PGDG (`2.60.0-1.pgdg13+1`) works against the Azure Blob
   API (Azurite) with shared-key auth, HTTPS with a custom CA, AES-256-CBC client-side encryption, async WAL archiving
   and full/diff backups. PITR to a timestamp restored **exactly** 100 000/100 000/0 rows in ≈ 9 s restore + ≈ 2 s
   replay/promotion. Two caveats: run PostgreSQL under an init process (O3), and issue a `CHECKPOINT` after every
   start, or `archive_timeout` does not bite for up to `checkpoint_timeout` (O4).
2. **Two repositories: yes.** Every WAL segment goes to both repos. Each backup targets one repo (`--repo=N`), so the
   schedule must back up each repo explicitly.
3. **Delete-protected credentials: no, not as C-66 is written.** With a SAS lacking `d`, archive-push works but **no
   backup can ever complete**: pgBackRest deletes `backup/<stanza>/latest` at the end of every backup (O8). `expire`
   obviously fails too. Retention therefore cannot be "pgBackRest without delete + lifecycle rule". Age-based deletion
   behind pgBackRest's back also creates silent manifest drift that only a restore detects (O10). Azurite emulates
   neither lifecycle nor immutability nor versioning (O9). The workable Azure equivalent of C-66: database nodes get
   `d` but **not `x`/`y`** (delete version / permanent delete) on a storage account with **blob versioning** (plus
   soft delete, or version-level immutability). pgBackRest then keeps its own `expire` and a consistent manifest. A
   delete or overwrite by a compromised node only turns blobs into previous versions, which the node cannot remove.
   A **lifecycle rule deletes previous versions** after N days. This is from Azure documentation and cannot be tested
   locally.
4. **Standby + promotion: yes.** `pg_ctl promote -w` 0.48–1.09 s, first committed write 0.61–1.74 s after the
   promote call (detection time not included). Without fencing the old primary accepts writes (`synchronous_commit=local`)
   or blocks clients indefinitely (`SyncRep`, immune to statement_timeout). Fencing = stop the old primary (provider-API
   power-off; here SIGKILL), then bring it back only with `standby.signal` (read-only proven) and `pg_rewind`, which
   discarded the diverged rows.
5. **Restore drill: yes.** `restore-drill.sh` restores repo2 into a scratch container with a read-only SAS, runs
   `pg_amcheck --heapallindexed` on all databases, compares counts and sums, prints one PASS/FAIL line with timings
   (≈ 13 s total at this size) and destroys the scratch instance.
6. **WAL-G fallback: yes.** v3.0.9 official binary: backup-push 1.5 s, backup-fetch + WAL replay → exact counts. It
   needs a host-style URL trick for Azurite. Licence: Apache-2.0 source; the official binary includes GPL-3.0+ LZO.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)
- **C-66 / ADR-0021 "Write without delete" must change.** Replace "credentials that cannot delete or overwrite;
  expiry is by bucket lifecycle rule" with: *Database nodes hold credentials that can write and delete current blobs
  but cannot delete blob versions (Azure: no `x`/`y`, i.e. no `deleteBlobVersion`/`permanentDelete` data actions; S3
  equivalent: no `s3:DeleteObjectVersion`) on a container with versioning enabled. pgBackRest's own `expire` enforces
  retention (manifest stays consistent). A lifecycle rule deletes **previous versions** older than the protection
  window (e.g. 14 days); optionally version-level immutability for the same window.* ADR-0021 "Unproven" can drop the
  "write-only credentials" item and replace it with "versioning protection on real Azure".
- **ADR-0021 open point 1 closes as "no"**: pgBackRest cannot run with no-delete credentials (O8). Age-based lifecycle
  on current blobs must **not** be used for pgBackRest repositories: deleting a full under a live diff is invisible to
  `info` and `verify` (O10). The ops-tooling reference §3.5's "separate copy job with a write-only key" stays the only
  way to get a write-only copy. If wanted, it is a third, separate copy (out of scope for v1).
- **C-29/C-96 confirmed for Azure Blob**: repo1/repo2 become two Azure storage accounts (ideally two regions, or one
  Azure account plus one non-Azure S3 store for provider independence). The schedule must run `backup --repo=1` and
  `backup --repo=2` separately.
- **ADR-0021 drill (C-56) confirmed** with one refinement: the drill host gets only repo2's config, a read+list SAS
  (`sp=rl`, short expiry) and repo2's cipher pass. Monitoring must not trust `pgbackrest verify`'s exit code (O10). The
  weekly drill (an actual restore) is the real integrity check; parse `verify` output for `missing`/`WARN` if it is
  used as well.
- **ADR-0020 / ADR-0021 RPO claim ("≈ 1 min of WAL")** holds only after the first checkpoint following a start. Add a
  post-start/post-promotion `CHECKPOINT` (Patroni: `post_bootstrap` / `on_start`/`on_role_change` callback, or a
  systemd/compose healthcheck hook). Otherwise the WAL RPO is up to `checkpoint_timeout` (5 min) after every restart.
- **ADR-0020 fencing confirmed as mandatory.** Measured promotion (≈ 0.5–1 s) is negligible next to Patroni's
  detection (ttl 30 s), so the 30–60 s failover target stands. Use `use_pg_rewind: true` (needs `wal_log_hints=on` or
  checksums; PG 18 has checksums on by default). Note for C-07 clients: on an unfenced old primary with sync
  replication, commits hang forever. statement_timeout does not help; clients need their own deadline.
- **Container images (ADR-0018/0023)**: PostgreSQL containers need `init: true` (or tini) whenever pgBackRest
  `archive-async` is on (O3).
- **ADR-0021 fallback (WAL-G)** confirmed to work against the Azure Blob interface; licence statement unchanged.

## Values the implementation must use (env vars, headers, config keys, flags, limits)
**Image:** `FROM postgres:18@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42`;
`apt-get install pgbackrest=2.60.0-1.pgdg13+1` (PGDG `trixie-pgdg`; never Debian main's 2.55.1); compose `init: true`.

**pgBackRest 2.60.0, Azure repository (per repo N):**
```
repoN-type=azure
repoN-azure-account=<storage account>
repoN-azure-container=<container>
repoN-azure-key-type=shared | sas | auto        # auto = managed identity on real Azure
repoN-azure-key=<key or SAS token, no leading '?'>   -> env PGBACKREST_REPON_AZURE_KEY
repoN-path=/<deployment>                         # e.g. /scf
repoN-cipher-type=aes-256-cbc
repoN-cipher-pass=<per repo, SOPS>               -> env PGBACKREST_REPON_CIPHER_PASS
repoN-bundle=y
repoN-block=y
repoN-retention-full=<n>   (or repoN-retention-full-type=time + days for the 35-day window)
# Azurite / test only:
repoN-storage-host=azurite-a      repoN-storage-port=10000
repoN-azure-uri-style=path        repoN-storage-ca-file=/certs/ca.crt
# real Azure: defaults (repoN-azure-endpoint=blob.core.windows.net, uri-style=host), system CA store
[global] archive-async=y  spool-path=/var/spool/pgbackrest  compress-type=zst  process-max=2  start-fast=y
[<stanza>] pg1-path=/var/lib/postgresql/18/docker      # PGDATA of the postgres:18 image
```
**PostgreSQL:** `archive_mode=on`, `archive_command='pgbackrest --stanza=scf archive-push %p'`, `archive_timeout=60`,
`wal_level=replica`, `wal_log_hints=on`; run `CHECKPOINT` after every start/promotion.
**Restore:** `pgbackrest --stanza=scf --repo=2 --type=time --target='YYYY-MM-DD HH:MM:SS.ffffff+00' --target-action=promote restore`;
standby: `--type=standby` plus `primary_conninfo`.
**SAS permissions:** DB node (with versioning, see Consequences) `racwdl` (no `x`, `y`); drill host `rl`.
**Drill line format:** `RESTORE-DRILL PASS|FAIL repo=2 target=… restore=…s ready=…s amcheck=…s counts=Nok(…s) end_lsn=… total=…s`.
**WAL-G 3.0.9 on Azure:** `WALG_AZ_PREFIX=azure://<container>/<path>`, `AZURE_STORAGE_ACCOUNT`,
`AZURE_STORAGE_ACCESS_KEY` or `AZURE_STORAGE_SAS_TOKEN`, `AZURE_ENDPOINT_SUFFIX` (default `core.windows.net`),
`WALG_LIBSODIUM_KEY` + `WALG_LIBSODIUM_KEY_TRANSFORM=hex`, `WALG_COMPRESSION_METHOD=zstd`; release asset
`wal-g-pg-24.04-amd64.tar.gz` sha256 `444ce216230c254edef803e098a59a1746806da3e0d55671d7b0f0082db14ef4`.
**Azurite (local stack):** pinned digest above, `--disableTelemetry`, HTTPS cert, custom accounts via
`AZURITE_ACCOUNTS=<name>:<base64 key>`.

## Open issues
1. **Versioning-based protection (the replacement for C-66) is untested.** Azurite cannot emulate versioning,
   soft delete, immutability or lifecycle. On a real Azure account: verify that a `racwdl` SAS (or an RBAC role
   without `deleteBlobVersion`/`permanentDelete`) lets pgBackRest back up and expire, but cannot remove previous
   versions. Also verify that restoring from previous versions works after a simulated wipe, and measure the extra
   storage from overwritten `*.info` files.
2. The `archive_timeout` startup gap (O4) comes from code reading plus reproduction. Worth confirming whether
   upstream considers it a bug; the post-start `CHECKPOINT` mitigation reached 58.5 s in one sample.
3. pgBackRest's `latest` remove on object stores is not documented. If upstream ever skipped it for object stores, a
   no-delete SAS would still fail at `expire` and at cleanup of aborted backups, so the conclusion stands.
4. Real Azure endpoints (host-style URI, `auto` managed-identity key type, Entra user-delegation SAS) were not
   exercised; only the Azurite path-style endpoint.
5. Patroni was not run. Promotion time excludes failure detection, and fencing was a container kill, not a provider
   API call.
6. The ADR-0021 checksum manifest (per-day counts and sums from the nightly rollup) is represented by a one-line
   `--expect` file. The real format belongs to the rollup job.
7. Sizes were tiny (30–41 MB). Restore throughput from Azure and for production volumes is still unmeasured.
