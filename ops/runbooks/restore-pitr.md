# Runbook: point-in-time restore (both database nodes lost, or logical corruption)

**Design:** ADR-0021 (35-day window, T3 target ≤ 2 h after start), C-108. **Measured** (Compose HA, small database):
restore ≈ 9–10 s, writable ≈ 11–12 s, exact to the transaction (`docs/evidence/chaos/postgres-ha-2026-11-13.md`).
A point-in-time restore discards everything after the target: a human decides the target and records why.

## 1. Choose the target and the repository

- Repository 2 (second region) is the default; repository 1 if repository 2 is unavailable.
- Target: last good moment in UTC, e.g. `2026-11-13 09:35:12+00`. Without a target, the restore replays to the end of
  the archive (everything archived, ≤ 60 s of WAL lost — C-108).
- `docker exec scf-postgres scf-backup pgbackrest --repo=2 info` shows the oldest restorable point.

## 2. Stop writers and Patroni's automation

```sh
patronictl -c /etc/scf/patroni.yml pause scf     # no automatic failover while restoring
# stop control plane, writer, jobs and Umami on both cores (ingest keeps spooling, ADR-0020)
```

## 3. Restore on the first node

```sh
docker compose -p scf-postgres -f /etc/scf/postgres/compose.yaml stop postgres
sudo mv /srv/scf/postgres/18/main /srv/scf/postgres/18/main.broken-$(date -u +%Y%m%dT%H%M%SZ)
docker run --rm --user postgres -v /srv/scf/postgres:/var/lib/postgresql \
  -v /etc/scf/postgres/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro -v /etc/scf/postgres/secrets:/run/secrets:ro \
  --entrypoint scf-backup <postgres image> pgbackrest --repo=2 --type=time --target='2026-11-13 09:35:12+00' \
  --target-action=promote restore
```
Then remove the cluster from etcd so Patroni bootstraps from this data (`patronictl remove scf`), start the node
(`docker compose … up -d postgres`), `patronictl resume scf`. Patroni's callback issues the `CHECKPOINT`.

## 4. Rebuild the second node and verify

- On the other node: `patronictl reinit scf <node>` (restores from the backup, then streams).
- Run `db/migrate.sh gates` and the restore drill's expectations against the new primary; take a **new full backup to
  both repositories** (`scf-backup backup full 1` / `2`) because the timeline changed.
- Re-apply erasure selectors kept for 56 days (C-112) — erased data restored from a backup must be erased again.
- Start the application services; spools and Collector queues drain (≤ 72 h, C-18).

In the Compose HA profile the same restore is exercised by `restore-drill.sh --target …` (into a scratch instance).
