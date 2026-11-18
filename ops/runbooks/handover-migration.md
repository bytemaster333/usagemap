# Runbook: handover data migration into a new operator's infrastructure (handover.independent-operator, handover.data-migration, handover.ready)

Status: exercised locally 2026-11-18 (two Compose stacks, `tests/handover/run.sh`, drill log below); not yet run
between two real environments
Owner: outgoing and incoming service operators together
Last reviewed: 2026-11-18

**Design:** [`docs/handover-plan.md`](../../docs/handover-plan.md) §4.1 step 5 (trial migration), §4.2 steps 1–4
(freeze, dump, restore, verify), §4.3 (verification), §4.5 (replica promotion); ADR-0021 (weekly dump format);
C-50 (what is carried over). Related runbooks: [`restore-logical-dump.md`](restore-logical-dump.md) (monthly dump
check), [`restore-drill.md`](restore-drill.md) (weekly pgBackRest drill), [`app-secret-rotation.md`](app-secret-rotation.md)
and [`key-and-cert-rotation.md`](key-and-cert-rotation.md) (rotations after acceptance).

Tools (all in this repository):

| Tool | Runs where | Does |
|---|---|---|
| `scf-backup dump` (`infra/compose/ha/bin/`) | old operator's primary | the weekly logical dump, now: `dump.tar.age` (age) + `SHA256SUMS` in repository 2 |
| `tests/handover/fingerprint.sh` | any host with `psql` 18 that reaches the server as superuser | per-table row count + checksum, sequences, schema parts, database owner/ACL/settings, roles — counts and hashes only |
| `tests/handover/import.sh` | the new operator, in the `usagemap/postgres-ha` image | verifies the out-of-band SHA-256, decrypts, checks the archive's members, refuses a non-fresh target, restores with `--create`, recomputes the manifest |
| `tests/handover/pitr-restore.sh` | the new operator's scratch host, `rl` SAS on the old repository 2 | path (b): pgBackRest restore to the end of the archive, fingerprint, `pg_amcheck` |
| `tests/handover/run.sh` | a workstation with Docker | the whole procedure as a drill on two local stacks |

## 0. Before D0 (trial migration, D−30 … D−7)

1. The new operator has its own environment up to the database (`tofu apply`, `lean.yml` with `scf_stack_up=false`,
   or locally `infra/compose/scripts/init.sh`) and **its own secrets**, except the items carried over under C-50:
   `pepper_ing`, `pepper_op`, `pepper_pub` (I-15), `edge_signing_key` + `edge_snapshot_pub(_next)` (I-16),
   `snapshot_signing_key` + `snapshot_pub` (I-26), `umami_creds_keys` (I-17), Umami `APP_SECRET` and the Umami
   provisioning password (I-17; rotated after acceptance). Database role passwords, the PKI, the SEP-10 key and the
   backup keys are the new operator's own.
2. Hand over through a channel other than the dump store: the age **identity** of the dumps (I-12), and later the
   SHA-256 of the dump (step 2.3). The dump store is writable by the old database hosts, and the age **recipient** is
   on every one of them, so anyone who can write there can put a well-formed archive there **and** a matching
   `SHA256SUMS`. Only the out-of-band hash proves which archive the old operator made.
3. Run the whole procedure below once on a copy (trial), time each step; the times set the freeze window.

## 1. Freeze (D0, handover plan §4.2 step 1)

```sh
$DC stop gateway collector metrics-writer jobs control-plane portal engine-proxy umami   # local drill
```
In production the control plane and portal go read-only instead, the writer and jobs stop, and edges keep spooling.
Status page: "Maintenance — dashboards read-only; ingest unaffected".

## 2. Old operator: fingerprint, dump, hash

```sh
# 2.1 the fingerprint F0 of the frozen source (superuser on the primary's socket)
$DC exec -T -e PGPASSWORD="$PGPW" -e PGHOST=/var/run/postgresql -e PGUSER=postgres <primary> \
  bash -s -- scf umami <tests/handover/fingerprint.sh >F0.tsv
# 2.2 the dump, now, and a full pgBackRest backup to repository 2 (path b)
$DC exec -T -e SCF_PATRONI_URL=none <primary> scf-backup dump   # -e … only on hosts deployed before the role set it
$DC exec -T <primary> scf-backup backup full 2
# 2.3 download dumps/<NAME>/dump.tar.age and SHA256SUMS (scf-azblob get, or az storage blob download), then
sha256sum dump.tar.age        # → send this value and F0.tsv out of band, signed by both teams' handover record
```

## 3. New operator: import (path a, the default)

Start **only PostgreSQL** of the new environment (fresh: no `scf` database, `umami` without tables). Then:

```sh
docker run --rm --network <project>_db --user 999:999 --read-only --cap-drop ALL --tmpfs /tmp:size=1g,uid=999,gid=999 \
  -e PGHOST=postgres -e PGUSER=postgres -e PGPASSWORD="$NEW_PG_SUPERUSER_PASSWORD" \
  -v "$PWD/tests/handover:/handover:ro" -v /path/to/transfer:/w:ro --entrypoint bash usagemap/postgres-ha:<tag> \
  /handover/import.sh --dir /w --expect-sha256 <hash from step 2.3> --identity /w/identity --into-fresh
```

One line: `IMPORT PASS …`, or `IMPORT FAIL stage=<integrity|decrypt|target|restore|compare> reason=…`. **Any FAIL
stops the handover** (go/no-go 2 is "no"): unfreeze the old core (§4.4).

| Stage that refused | Meaning | Action |
|---|---|---|
| `integrity` | the archive is not the one whose hash the old operator sent, or `SHA256SUMS` disagrees | Do not retry with the file's own hash. Fetch again; if it persists, treat the store as compromised (`incident.md`) |
| `decrypt` | wrong identity, or the age MAC failed (corrupted or forged) | as above |
| `target` | the new server is not fresh (an earlier import, or the wrong host) | rebuild the new database volume, never import over data |
| `restore` | `pg_restore` failed | the message names the object; compare PostgreSQL major versions and extensions |
| `compare` | the restored rows differ from the dump's own manifest | storage or transfer fault, or a forged archive with a stale manifest |

## 4. Verify (handover plan §4.3)

```sh
docker run … --entrypoint bash <image> /handover/fingerprint.sh scf umami >F_new.tsv   # same docker run as step 3
diff F0.tsv F_new.tsv && echo "fingerprints equal"
```
**Equal is the pass condition**: every table and partition (rows and content), every sequence, the schema (columns,
constraints, indexes, policies, RLS flags, grants, functions incl. `SECURITY DEFINER` owners, triggers, views,
extensions), the databases' owner, ACL and settings, and every role's attributes, memberships and settings. A
difference names the object. Take the fingerprint **before** any service of the new stack starts (they write).

Then start the whole new stack with the new secrets (`$DC up -d --wait`): `db-migrate` is a no-op on the migrated
schema and sets every `scf` role password from the new secrets, `umami-views` sets the two Umami-side roles,
`umami-bootstrap` logs in with the carried-over provisioning password. Check `GET /readyz`, the public answers of a
sample of projects against the old environment (handover plan §4.3 dashboard parity), and that an old role password
no longer logs in.

## 5. Path (b): pgBackRest restore (replica promotion, path B, or when a dump is too slow)

```sh
docker compose -p <old project> … --profile drill run --rm --no-deps -T --entrypoint bash \
  -v "$PWD/tests/handover:/handover:ro" pg-drill /handover/pitr-restore.sh >F_b.tsv
diff F0.tsv F_b.tsv
```
It needs the old repository 2 with a **read+list** SAS and repository 2's cipher pass, restores to the end of the
archive with `archive_mode=off` (it must never write into the old repository), fingerprints, then runs `pg_amcheck`.

## Known limits (2026-11-18)

- `scf-backup dump-restore` (and `dump-verify`) restore each database into a plain `CREATE DATABASE`: the database
  owner, its ACL (e.g. `REVOKE ALL ON DATABASE umami FROM PUBLIC`) and `ALTER DATABASE … SET` settings are lost,
  and its integrity check is only the `SHA256SUMS` stored next to the dump. `import.sh` restores with `--create` and
  needs the out-of-band hash. The drill measures the difference (case t5). The fix belongs in `scf-backup` (an
  `--expect-sha256` argument and `pg_restore --create`).
- If both channels are compromised (forged archive and forged out-of-band hash), the import passes; only the
  fingerprint diff against F0 detects it (case t4). F0 must therefore travel with the signed handover record.
- Not yet exercised: two real environments, the delta migration after a DNS switch (§4.4), replica promotion over the
  mesh (§4.5), the carried-over peppers authenticating an existing key (handover plan §4.3 "keys and tokens").

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-18 | workstation, two Compose stacks (`scf-hoa` HA, `scf-hob` single) from two clones of `main` | `tests/handover/run.sh`: freeze, F0, dump + full backup, path (b), five tamper cases, path (a) import, F_a, new stack up, parity, ops.end-of-window-read-only export | **pass** (27/27, run 6; runs 1–5 found the issues in the evidence file) — F_a = F_b = F0 over 105 tables / 580,723 rows; [`docs/evidence/handover-drill-2026-11-18.md`](../../docs/evidence/handover-drill-2026-11-18.md) |
