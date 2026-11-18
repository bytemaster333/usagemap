# Runbook: weekly restore drill

Status: exercised 2026-11-14 on the lean single-VM profile (test VM) — see the drill log
Owner: maintainers
Last reviewed: 2026-11-14

**Alerts:** `RestoreDrillStale` (no pass in 8 days; also, with `reason: never_passed`, when backups exist but no
drill has ever passed, for 8 d), `RestoreDrillIntegrityMismatch` (security event, TM-OPR-02.M.1). A failed drill keeps
the time of the last pass in `scf_restore_drill_last_success_timestamp_seconds`, so the 8 days count from that pass.
**Design:** ADR-0021, C-56 (on our EU infrastructure only, never on GitHub-hosted runners; backup keys never leave
it), C-108 (repository 2 only, read-and-list credential). Script: `infra/compose/ha/bin/scf-restore-drill`.

## What the drill does

On the drill host (`mon-c`, systemd timer `scf-restore-drill.timer`, Sundays 04:00 UTC; Ansible role
`restore_drill`), a scratch container restores the latest backup of **repository 2** with read-only access, then:

1. waits for WAL replay and promotion (socket only, no network listener, no archiving);
2. `pg_amcheck --all --install-missing --heapallindexed`;
3. the RLS gates G1–G11 of `db/migrate.sh gates` on the restored `scf` database;
4. optional expectations (`--expect`: `<db>\t<sql>\t<expected>` — e.g. per-day counts and sums);
5. prints one line `RESTORE-DRILL PASS|FAIL …`, writes `scf_restore_drill_*` metrics (textfile collector) and a JSON
   report (pass/fail, timings, restored point — never rows), destroys the scratch volume.

## Run it by hand

```sh
# lean production profile (C-123): the drill runs on the standby VM if there is one, else on app-1 (role restore_drill)
sudo systemctl start scf-restore-drill.service && journalctl -u scf-restore-drill -n 5 --no-pager | grep RESTORE-DRILL
cat /srv/scf/metrics/scf_restore_drill.prom        # scf_restore_drill_success, …_last_success_timestamp_seconds (node exporter textfile)
# scale-out (drill host mon-c)
sudo systemctl start scf-restore-drill.service && journalctl -u scf-restore-drill -n 5
# Compose HA profile
infra/compose/ha/scripts/restore-drill.sh -p <project> [--target 'YYYY-MM-DD HH:MM:SS+00'] [--expect FILE] [--report-dir DIR]
```

## When it fails

| `stage=` | Meaning | Action |
|---|---|---|
| `restore` | pgBackRest could not restore (missing/corrupted file, cipher pass, access) — e.g. `block map version must be zero` for an overwritten bundle (measured) | Run `scf-backup pgbackrest --repo=2 verify` on the primary and read its **output** (its exit code is 0 even with missing files, S-08 O10). Take a new full backup to repo 2 (`scf-backup backup full 2`), re-run the drill. If blobs were deleted or overwritten, restore them from **previous versions** (Azure portal or `az storage blob list --include v`) — versions are kept 14 days. Treat unexplained changes as a security incident. |
| `recovery` | WAL replay did not finish (missing WAL segment, timeline history) | `scf-backup check` on the primary; inspect `pg_stat_archiver`; take a new full backup. |
| `amcheck` | Physical corruption in the restored copy | Security/integrity incident: compare with the primary (`pg_amcheck` there), keep the failing backup set (do not expire it), escalate. |
| `gates` | The restored schema violates an RLS gate | Same gate on the primary (`db/migrate.sh gates`); a finding there is a P1 isolation incident. |
| `counts` | Expected counts/sums differ | `RestoreDrillIntegrityMismatch`: compare with the operator metrics API; escalate to security responders. |

Publish monthly: pass/fail, timings and the restored point only (`docs/evidence/restore-drills/`), never rows.

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Lean single-VM profile: `infra/ansible/tests/lean/run.sh` (playbook `lean.yml` applied to a Debian 13 VM container, PostgreSQL in single mode with pgBackRest to two local posix repositories instead of Azure Blob), repository working tree | The lean test (28 passed, 0 failed, incl. full backups in both repositories and the unit's first drill), then "Run it by hand" as written: `systemctl start scf-restore-drill.service` + journal + metrics file | **pass** — by hand: `RESTORE-DRILL PASS repo=2 target=latest restore=8.7s ready=10.2s amcheck=0.3s gates=11ok total=11.0s`; metrics `scf_restore_drill_success{repo="2"} 1` and `…_last_success_timestamp_seconds` written. Not exercised: `--expect` counts, `--target` (PITR), a corrupted-backup failure, Azure Blob repositories (Azurite/Azure only). |
