# Runbook: PostgreSQL failover, fencing and rejoin

**Alerts:** `PatroniNoLeader`, `EtcdMembersLow` (monitoring plan §4; this file is the `postgres-failover` runbook).
**Design:** ADR-0020 (Patroni, synchronous non-strict, three etcd members), C-108 (fencing, `pg_rewind`, CHECKPOINT
after promotion). **Measured:** `docs/evidence/chaos/postgres-ha-2026-11-13.md` (Compose HA profile).

## What happens without a human

1. The primary dies or is cut off. Patroni on the standby waits for the leader key to expire (`ttl` 30 s), takes it,
   promotes (≈ 0.5–1 s), and its `on_role_change` callback runs a `CHECKPOINT` plus a WAL switch so archiving to both
   repositories starts at once (S-08 O4). Measured: promotion 21–27 s after the kill.
2. A primary that loses etcd **and** its standby demotes itself (`ttl > loop_wait + 2 × retry_timeout`): measured
   12–15 s after isolation, i.e. **before** the standby is promoted (24–27 s). It never accepts writes again until it
   has rejoined as a standby.
3. HAProxy on each core (`127.0.0.1:5000`, checks `GET /primary` on port 8008) marks the old node down within ≈ 4 s
   of the promotion and cuts its sessions; PgBouncer's next transaction opens a server connection to the new primary.
   Measured: no acknowledged commit lost (synchronous replication), writes resume as soon as the promotion is done.
4. When the old node comes back, Patroni starts it as a standby, runs `pg_rewind` if its timeline diverged, and it
   streams again (measured 9–30 s); it becomes the synchronous standby.

## Checks (any core node)

```sh
docker exec scf-postgres patronictl -c /etc/scf/patroni.yml list        # Leader + Sync Standby, same TL
curl -fsS http://127.0.0.1:8008/primary && echo "this node is primary"
docker exec scf-postgres scf-backup check                               # WAL of the new timeline in both repos
```
Compose HA profile: replace `docker exec scf-postgres` by `docker compose -p <project> -f infra/compose/compose.yaml
-f infra/compose/compose.ha.yaml exec pg-a`.

## When a human is needed

| Situation | Action |
|---|---|
| No leader for > 60 s (`PatroniNoLeader`) | Check etcd quorum: `etcdctl --endpoints=… endpoint health` on the three members (core-a, core-b, mon-c). With quorum lost, `failsafe_mode` keeps a healthy primary running, but no failover can happen — restore the etcd member first. |
| Old primary does not rejoin (`pg_rewind` failed, e.g. WAL already recycled) | `patronictl reinit scf <member>` — rebuilds it from the backup (`create_replica_methods: pgbackrest`, then `basebackup`). Never start it by hand without `standby.signal`. |
| Old primary is unreachable but may still be running (network partition with clients on its side) | **Fence it**: power it off through the provider API (Azure: `az vm deallocate -g <rg> -n <vm>`), then restart it; Patroni brings it back as a standby. S-08 O12: an unfenced old primary accepts diverging writes (`synchronous_commit=local`) or blocks clients forever. |
| Planned maintenance | `patronictl switchover scf --leader <current> --candidate <other> --force` (needs the REST API password from SOPS), one node at a time (`serial: 1` in `infra/ansible/playbooks/site.yml`). |
| Synchronous standby down for long | The primary continues asynchronously (non-strict mode); the RPO is then up to `maximum_lag_on_failover` (1 MiB) + the archive (≤ 60 s). Restore the standby (`patronictl reinit`). |

## After every failover

- Confirm `scf_backup_check_success == 1` on the new primary (the scheduler there takes over; backups run only on the
  primary).
- Confirm the old node is `Sync Standby` and `pg_is_in_recovery() = t`.
- Note the event (time, cause, promotion time from the Patroni log) in the incident log.
