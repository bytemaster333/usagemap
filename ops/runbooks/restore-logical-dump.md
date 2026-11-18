# Runbook: restore a logical dump (data migration, handover — handover.data-migration)

Status: to be exercised (no drill has run in this profile)
Owner: maintainers
Last reviewed: 2026-11-14

**Design:** ADR-0021 (weekly `pg_dump`, kept 5 weeks, the data-migration format for handover). Tool:
`scf-backup dump` / `scf-backup dump-restore` / `scf-dump-verify` (`infra/compose/ha/bin/`).

## What a dump contains

`dumps/<UTC time>/dump.tar.age` in repository 2's container, plus `SHA256SUMS` (written last — a dump without it is
incomplete). Inside the age envelope: `globals.sql` (roles **without** passwords — they come from SOPS), one
`pg_dump -Fc` archive per database, `databases.txt`, and `manifest.tsv` (per table: row count, and an MD5 over the
sorted row hashes for tables up to 256 MiB). The age identity (private key) is held only by the service operator
(SOPS) and the host that restores; database nodes hold only the recipient.

## Verify the newest dump (monthly, and before a handover)

```sh
# Compose HA profile
docker compose -p <project> -f infra/compose/compose.yaml -f infra/compose/compose.ha.yaml --profile migration \
  run --rm dump-verify <name> --expect-sha256 <hex>   # → DUMP-RESTORE PASS dump=… databases=… tables=… checksum=out-of-band
```
`<hex>` is the out-of-band record of the dump: the `dump <name> sha256 <hex>` line `scf-backup dump` logs on the
database node (journal / container log, copied to the change record) — never the `SHA256SUMS` stored next to the dump,
which anyone who can write the dump store can rewrite together with the dump. Without `--expect-sha256` the restore is
refused (`stage=args`); `--trust-stored-checksum` exists for a drill on our own store only and is logged as a WARNING.
It restores into an empty scratch instance with `pg_restore --create` (each database's owner, ACL and settings kept —
e.g. umami's `REVOKE CONNECT … FROM PUBLIC`) and compares the row-count/checksum manifest and the databases'
owners/ACLs; any difference is `FAIL stage=compare`.

## Migrate to a new operator's infrastructure

1. New infrastructure: `tofu apply` + `ansible-playbook playbooks/site.yml` (infra.iac-complete), PostgreSQL empty except roles.
2. Take a fresh dump on the old primary: `docker exec scf-postgres scf-backup dump`; hand its logged
   `dump <name> sha256 <hex>` line to the new operator over a different channel than the dump store (signed e-mail,
   the handover record).
3. On a host of the new operator with the age identity and read access to the container:
   `PGHOST=<new primary> PGUSER=postgres scf-backup dump-restore <name> --expect-sha256 <hex>` — downloads, checks
   the SHA-256 against that out-of-band value, decrypts, restores globals and every database with `pg_restore
   --create`, then compares the manifest and the databases' owners/ACLs. Only a `DUMP-RESTORE PASS … checksum=out-of-band`
   line counts.
4. Set the role passwords from the new operator's SOPS file (`db/migrate.sh bootstrap` sets them as SCRAM verifiers).
5. Run `db/migrate.sh gates`, start the services, take full backups to both of the new repositories.

Alternative with less downtime: make the new primary a standby of the old one (replica promotion), then switch over.

## Lean profile (C-123)

The weekly dump is taken by the scheduler in the `postgres` container (`SCF_DUMP_EVERY`, uploaded to repository 2's
container with the VM's managed identity, `SCF_DUMP_AUTH=msi`). By hand on `app-1`: `$DC exec -T postgres scf-backup dump`
and `$DC exec -T postgres scf-backup dump-list`. The VM holds only the age **recipient**; `dump-restore` runs on a
host that holds the identity (the new operator's, or a scratch instance on the service operator's infrastructure).
Not drilled: the lean test VM uses posix repositories, so the blob upload cannot run there; the dump path is covered
by the HA profile's tests (`infra/compose/ha/tests/run.sh`, `dump-verify`).
