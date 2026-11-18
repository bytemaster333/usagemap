# Runbook: backup failure

**Alerts:** `WALArchiveFailing`, `BackupFullStale` (> 8 d), `BackupDiffStale` (> 26 h), `BackupCheckFailing`,
`LogicalDumpStale` (> 8 d). **Design:** ADR-0021 as superseded by C-108/C-110/C-112; tool `scf-backup`
(`infra/compose/ha/bin/scf-backup`), metrics in `scf_backup.prom` (node exporter textfile).
**Rules:** `ops/alerts/platform.rules.yaml` (BackupCheckFailing covers `pgbackrest check` only so far; verify output,
versioning, lifecycle and credential checks have no metric yet — `coverage.json` partial). Every weekly dump logs
`dump <name> sha256 <hex>` on the database node: keep that line (journal / change record) away from the dump store —
an import checks the dump against it (`dump-restore --expect-sha256`).

## Schedule (runs on the current primary only)

| What | When | Where |
|---|---|---|
| Full backup | newest full older than 7 days | repository 1 and repository 2, each separately (`--repo=N`) |
| Differential | newest backup older than 1 day | each repository |
| `pgbackrest check` | hourly | archiving to both repositories |
| Logical dump (`pg_dump` of every database + globals without passwords, row-count/checksum manifest, age-encrypted) | weekly, kept 35 days (5 dumps) | repository 2's container, `dumps/<UTC time>/` |
| WAL | every segment, at most 60 s apart (`archive_timeout`), asynchronously to both repositories | — |
| Retention | pgBackRest `expire` (35-day window, time-based) after every backup; previous blob versions deleted by the lifecycle rule after 14 days | — |

## Diagnose

```sh
docker exec scf-postgres scf-backup pgbackrest info                 # both repositories
docker exec scf-postgres scf-backup check
docker exec scf-postgres psql -U postgres -c 'select * from pg_stat_archiver'
docker logs scf-postgres 2>&1 | grep -E 'scf-backup|ERROR' | tail -20
cat /var/lib/node_exporter/textfile/scf_backup.prom
```

| Symptom | Likely cause | Action |
|---|---|---|
| `HostConnectError` / `403` on every repository | private endpoint, DNS (`privatelink.blob.core.windows.net`), NSG, or the node's identity lost its role assignment | `getent hosts <account>.blob.core.windows.net` must give the private address; check the role assignment (`tofu plan` must show no drift). |
| `403` on delete during backup/expire | someone removed `blobs/delete` from the custom role — pgBackRest cannot work without it (S-08 O8) | Restore the role from `infra/opentofu`. Never give `deleteBlobVersion`/`permanentDelete`. |
| archive lag of minutes right after a restart or failover | the post-start/promotion `CHECKPOINT` did not run (S-08 O4) | `docker logs scf-postgres | grep scf-pg-callback`; run `CHECKPOINT` by hand. |
| `unable to acquire lock` | a backup or check is already running | wait; the scheduler retries every tick. |
| `BackupCheckFailing` because versioning or the lifecycle rule is off | configuration drift on Azure | `tofu plan` in `infra/opentofu/envs/azure-eu`; re-apply. This protection cannot be emulated locally (S-08 O9). |
| dump missing | `SCF_DUMP_BASEURL` unset or the dump credential expired | see `restore-logical-dump.md`; on Azure the dump upload needs a container SAS from SOPS (`racwdl`, user-delegation) until managed-identity upload is added. |

## Manual backup

```sh
docker exec scf-postgres scf-backup backup full 1
docker exec scf-postgres scf-backup backup full 2
docker exec scf-postgres scf-backup dump
```
