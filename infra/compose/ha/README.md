# HA profile: PostgreSQL primary + standby, backups, failover

Overlay `infra/compose/compose.ha.yaml` on top of `compose.yaml`: the single `postgres` container becomes a Patroni
cluster with backups to two blob stores, as decided in ADR-0020/0021 and measured in S-08 (C-108, C-110, C-112).

```sh
infra/compose/ha/scripts/ha-init.sh                       # HA dev secrets next to the base ones (idempotent)
docker compose -p scf-ha -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f infra/compose/compose.ha.yaml up -d --build --wait
infra/compose/ha/scripts/restore-drill.sh -p scf-ha       # weekly drill (one RESTORE-DRILL PASS|FAIL line)
infra/compose/ha/tests/run.sh                             # integration suite T01–T15 (project scf-wsj2, ≈ 6 min)
```

| Service | What |
|---|---|
| `pg-a`, `pg-b` | PostgreSQL 18.6 + Patroni 4.1.5 + pgBackRest 2.60.0 (`postgres/Dockerfile`, PGDG packages pinned); `init: true`; synchronous non-strict replication; `use_pg_rewind`; `CHECKPOINT` + WAL switch after every start and promotion (`postgres/callback.sh`); Umami's role and database at bootstrap as a SCRAM verifier (`postgres/post-bootstrap.sh`); the backup scheduler next to Patroni (acts only while primary) |
| `etcd-a/b/c` | etcd 3.6.16, three members (core-a, core-b, mon-c in production) |
| `postgres` | **HAProxy 3.2** under the old service name: follows Patroni's `GET /primary`, cuts sessions of a demoted node, so PgBouncer, db-migrate and Umami follow a failover with no change |
| `azurite-a`, `azurite-b` | two Azure Blob accounts (`scfbackupa` = repo 1, `scfbackupb` = repo 2), HTTPS with a private CA |
| `azurite-init` | one-shot: the `pgbackrest` container in each account |
| `pg-drill` (profile `drill`) | scratch instance of the restore drill: repo 2 only, **read+list SAS** only |
| `dump-verify` (profile `migration`) | restores a weekly logical dump into a scratch instance and compares its manifest (handover.data-migration) |

**DCS TLS (F15):** etcd client and peer traffic over TLS with client-certificate authentication against a CA of its
own (`.secrets/ha/dcs/`, made by `ha-init.sh`), Patroni's REST API over HTTPS only (`postgres/patroni.yml`), HAProxy
checking `/primary` over TLS with that CA and the node name; T15 shows plaintext and certificate-less clients refused.
The Ansible `postgres` role renders the same for production (DCS CA from the `pki` role, `playbooks/site.yml`).

Credentials (`.secrets/ha/`, git-ignored): database nodes hold a container SAS with `racwdl` — never `x`/`y` (C-108);
the drill holds `rl`; the age identity of the dumps is mounted only into `dump-verify`. Scheduler intervals
(`SCF_BACKUP_FULL_EVERY` 7 d, `SCF_BACKUP_DIFF_EVERY` 1 d, `SCF_BACKUP_CHECK_EVERY` 1 h, `SCF_DUMP_EVERY` 7 d,
`SCF_BACKUP_TICK` 60 s) can be overridden from the environment.

## What Azurite cannot show (verified only on Azure — risk R-23, MP-10)

Blob versioning, soft delete, the lifecycle rule that deletes previous versions after 14 days, version-level
immutability, managed-identity access (`repoN-azure-key-type=auto`) and private endpoints. They are configured in
`infra/opentofu` and asserted there against a mock provider (`tofu test`); the first real deployment must verify
them (`BackupCheckFailing` covers drift).

## Image scan (lead request)

`usagemap/postgres-ha` on the Debian trixie `postgres:18` base, scanned with Trivy
0.76.2 and Grype 0.121.3 on 2026-11-13, after `apt-get upgrade`, removing gosu and GnuPG, and building `age` from source
with Go 1.27.4 (Debian's package and the upstream binary carried Go standard-library findings):

| Scanner | HIGH + CRITICAL | of which with a fixed version |
|---|---|---|
| Trivy | 147 (1 CRITICAL: libxml2 CVE-2026-6653, "affected", no fix) | **0** |
| Grype | 200 | **0** (`--only-fixed`) |

All remaining findings are Debian packages without a fix (krb5 libraries via libpq, python3.13 for Patroni,
util-linux, libxml2, …). Zero is not reachable with Debian's PostgreSQL/Patroni packages today, and the Alpine base
of the single-node stack has its own findings and no PGDG pgBackRest 2.60. `apt-get upgrade` at build time picks up
fixes as Debian publishes them.
