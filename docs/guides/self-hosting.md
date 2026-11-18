# Self-hosting guide

**Status: docs.deployment-guide deployment guide, checked against the code.** Checked against `infra/compose/README.md`,
`infra/compose/compose.yaml`, `infra/compose/scripts/`, the root `Makefile` and `mise.toml` on branch `main`; followed
in a clean-clone rebuild drill on 2026-11-18 (`docs/evidence/rebuild-drill-2026-11-18.md`), corrections D1–D8
applied. Every command below exists in the repository today. What is not built yet is marked **planned**.

Two ways to run it:

- **Local / evaluation:** Docker Compose on one machine with development secrets (§1–§9), single-node or with the HA
  overlay (§7) and its multi-node profile (§8).
- **Production on one host — the supported self-hosting path (§10):** the same Compose stack on one Debian 13 host,
  configured by Ansible (`infra/ansible/playbooks/lean.yml`) with a production override, secrets from SOPS, public
  certificates from ACME, backups to two blob repositories and a weekly restore drill. This is the lean profile (C-123; [`deploy-azure.md`](deploy-azure.md) adds Azure infrastructure); any Debian 13 host
  with Docker can run it. **Applied to a real host:** the public `usagemap.dev` service runs this playbook on one small
  VM — exact procedure in [`deploy-v1.md`](deploy-v1.md); a rebuild drill repeated it on a fresh VM.

## 1. What runs

Started by a plain `docker compose up` (`infra/compose/README.md` §Services):

| Service | Kind | Role |
|---|---|---|
| `postgres` | long-running | PostgreSQL 18.7 with databases `scf` (ours, row-level security everywhere) and `umami` (engine-owned) |
| `db-migrate` | one-shot | creates the `scf` roles and applies `db/migrations` (`db/migrate.sh migrate`) |
| `pgbouncer` | long-running | PgBouncer 1.26.1 in transaction mode; every runtime role connects through it |
| `umami-views-drop`, `umami-migrate`, `umami-views` | one-shot | engine migrations wrapped so our read-only views never block them |
| `umami` | long-running | Umami 3.5.0 built from the pinned commit (`vendor/umami`); **no published port, no egress** |
| `engine-proxy` | long-running | mutual-TLS front of Umami: allow-lists, bootstrap gate, visit memory |
| `umami-bootstrap` | one-shot | replaces the engine's default admin, creates the provisioning identity (restartable) |
| `control-plane` | long-running | public API (host port `127.0.0.1:8080`), internal edge API (mutual TLS) |

Also started by the same plain `up` (no profiles; `infra/compose/README.md` lists networks and ports): `gateway`
(the only public entry, host port `127.0.0.1:8443`), `collector` (in the gateway's network namespace),
`metrics-writer`, `jobs` and `portal` (`127.0.0.1:5173`). Backups and database failover come with the HA overlay
(§7). The monitoring stack (Prometheus, Alertmanager, Grafana, VictoriaLogs, probe, status page) is the separate
overlay `infra/compose/compose.monitoring.yaml` (`ops/README.md`; tested by `ops/e2e/run.sh`); the health controller
belongs to the multi-node profile only (§8).

## 2. Requirements

- Linux host with **Docker Engine from Docker's own repository** (tested: 29.9.3 with the Compose plugin v5.8.0, the
  version `infra/ansible/roles/docker_engine` pins; `init.sh` refuses Docker below 29.0 and a missing Compose or
  buildx plugin). Distribution packages can be too old: Debian 13's `docker.io` 26.1 fails the Umami build with
  "source.git.checksum is not supported by build server". Also `openssl`, `curl`, `jq`.
- **The pinned toolchain, also for a first start:** [mise](https://mise.jdx.dev) installs Node, Go and pnpm from
  `mise.toml` (Node 24.22.3, Go 1.27.4, pnpm 12.19.0); `init.sh` needs Node and builds the tracker with pnpm.
- Disk for the first build: about 15 GB free (images 1.3 GB, BuildKit cache 12 GB on the drill host).
- Disk: the engine stores about **1.05 GB per day per 1 million page views** (77 % indexes); at the default 90-day
  event retention plan **≥ 250 GB** for the database at the design volume (S-11, C-109). A small installation needs far
  less.
- Outbound internet during the image build only: the Umami image fetches its source from GitHub by commit and verifies
  it (`vendor/umami/README.md`). At runtime the engine has no egress.

## 3. First start

```sh
git clone <repository URL> && cd <repository directory>
mise install && eval "$(mise env -s bash)" && pnpm install --frozen-lockfile   # once: toolchain + workspace dependencies (or: make install)
infra/compose/scripts/init.sh                                     # once: dev secrets + dev PKI in infra/compose/.secrets/
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d --build --wait  # or: make up (runs init.sh first)
```

`infra/compose/compose.dev.yaml` adds development and test fixtures only (the synthetic testnet ledger mirror of
`onchain-fixture`); it is never deployed. A deployment uses `compose.yaml` with its own override (Ansible role
`compose_stack`), and the jobs service fills its ledger mirror from `SCF_ONCHAIN_LEDGER_SOURCE_URL`.

`init.sh` runs `scripts/dev-secrets.sh` (random database passwords, the Umami `APP_SECRET`, the two Umami bootstrap
passwords, connection URLs, the snapshot-signing key) and `scripts/dev-pki.sh` (a development CA and node
certificates). Both only create what is missing and never replace existing values — that is what makes the Umami
bootstrap restartable. `dev-pki.sh` needs Docker: it hands each private key to the uid of the container that reads it,
after which the host user can no longer read those keys.

On an empty host the first `up --build --wait` took 221 s (rebuild drill 2026-11-18); with built images `up --wait`
takes about 30–40 s.

Start order (enforced by `depends_on`): `postgres` → `db-migrate`, `umami-views-drop` → `pgbouncer`,
`umami-migrate` → `umami-views`, `umami` → `engine-proxy` → `umami-bootstrap` → `control-plane`.

## 4. Check it

```sh
SCF_CONTROL_PLANE_PORT=18080 SCF_PORTAL_PORT=15173 SCF_INGEST_PORT=18443 infra/compose/scripts/smoke.sh   # its own stack, on other ports than §3's
```

With the §3 stack stopped, `infra/compose/scripts/smoke.sh` (or `make smoke`) runs on the default ports; while it is
up, the two stacks would both publish 127.0.0.1:8080, 5173 and 8443, hence the ports above.

The smoke test (also `make smoke`) brings up **its own** stack (project name from `PROJECT`), runs about 160 checks — hardening, network
isolation, PgBouncer transaction mode, the engine proxy's allow- and deny-lists with real node certificates, the visit
rule, log and database scans for IPs, surrogates, User-Agents, query strings and tokens — and removes it with
`down -v`. Variables: `PROJECT`, `SCF_CONTROL_PLANE_PORT`, `KEEP=1` (keep the stack), `EXTRA_COMPOSE=<override file>`.
Result on 2026-11-18 (clean-clone rebuild drill, `docs/evidence/rebuild-drill-2026-11-18.md`): 157 passed, 0 failed.

The control plane answers `GET http://127.0.0.1:8080/healthz`.

## 5. Configure

| Variable | Default | Meaning |
|---|---|---|
| `SCF_CONTROL_PLANE_PORT` | `8080` | host port of the control plane's public API (bound to 127.0.0.1) |
| `SCF_PORTAL_PORT` | `5173` | host port of the portal (profile `web`), also the portal origin given to the control plane |
| `SCF_STELLAR_NETWORK` (control plane) | `public` | the network for Stellar sign-in; set it in an override file for testnet (C-114) |
| `SCF_TRUST_PROXY` (control plane) | `false` | keep `false` while the API is reached directly; when the portal fronts it, list the portal's fixed address — never `true` |

Run a second copy side by side with `docker compose -p <name> …`; nothing uses fixed container names.

## 6. Stop, reset, upgrade

```sh
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml down        # stop, keep data (make down)
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml down -v     # stop and delete all data
```

- **Engine upgrade:** never run `umami-migrate` alone. `docker compose up` always runs `umami-views-drop` →
  `umami-migrate` → `umami-views`, which is the upgrade path. The runbook is `ops/runbooks/umami-upgrade.md`.
- **Certificates:** delete the pair under `.secrets/pki/`, re-run `scripts/dev-pki.sh` (`FORCE=1` re-creates the CA),
  then `docker compose restart engine-proxy` or send it `SIGHUP`.

## 7. HA overlay: PostgreSQL primary + standby, backups

`infra/compose/compose.ha.yaml` goes on top of `compose.yaml` and replaces the single `postgres` with a Patroni 4.1.5
cluster (`pg-a`, `pg-b`, synchronous standby, three etcd members), HAProxy under the old service name `postgres` (so
every client follows a failover unchanged), pgBackRest 2.60.0 to two blob stores (two Azurite accounts locally) and
the weekly restore drill (C-108, C-120). Details and the measured failover: [`infra/compose/ha/README.md`](../../infra/compose/ha/README.md).

```sh
infra/compose/ha/scripts/ha-init.sh                       # once: HA dev secrets next to the base ones (idempotent)
docker compose -p scf-ha -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f infra/compose/compose.ha.yaml up -d --build --wait
infra/compose/ha/scripts/restore-drill.sh -p scf-ha       # restore drill: one RESTORE-DRILL PASS|FAIL line
```

What Azurite cannot emulate (blob versioning, soft delete, lifecycle rules) is configured by the OpenTofu module and
can only be verified on Azure.

## 8. Multi-node: two gateways, two cores

The overlay's profile `multinode` adds a second core (`umami-b` + `engine-proxy-b`, identity `core-b`) and a second
edge gateway (`gateway-b`, node `edge-a2`, host port `127.0.0.1:${SCF_INGEST_PORT_B:-56341}`). The first gateway
learns about core-b and its key-exchange peer from three variables; `gateway-b` sets its own (`GW_KEYX_ADDR=:9443`,
`GW_KEYX_PEERS=edge-a1=https://edge-a1:9443`, alias `edge-a2` on `core`):

```sh
infra/compose/ha/scripts/ha-init.sh
SCF_GW_CORES_EXTRA=,core-b=https://engine-proxy-b:8443 SCF_GW_KEYX_ADDR=:9443 \
SCF_GW_KEYX_PEERS=edge-a2=https://edge-a2:9443 \
docker compose -p scf-mn -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f infra/compose/compose.ha.yaml --profile multinode up -d --wait
```

What it gives you: both gateways hold the same daily and hourly keys (scf-keyx/1, C-110), so a challenge from one
gateway is valid on the other. Each event goes to the core that the rendezvous hash of the visitor surrogate ranks
first (C-74). If that core is down, the event goes to the next one. Both cores share one database. Gateway metrics
(`:9464`, internal only) to watch: `scf_gateway_live_edge_nodes` (2), `scf_gateway_keyx_conflicts{kind}` (0),
`scf_gateway_forward_total{kind,outcome,core}`. Measured run:
[`docs/evidence/chaos/multinode-2026-11-13.md`](../evidence/chaos/multinode-2026-11-13.md).

## 9. Recovery notes (from `infra/compose/README.md`)

- `umami-bootstrap` fails with "neither the provisioning admin nor the seed admin can log in": the engine database
  holds credentials that do not match `.secrets/`. Restore the old secret files or start from an empty volume
  (`down -v`).
- The engine proxy answers `503 bootstrap_pending`: the bootstrap check has not succeeded since it started — look at
  `umami-bootstrap`'s log and at the proxy metrics `scf_engine_proxy_bootstrap_probe_errors_total` and
  `scf_engine_proxy_bootstrap_probe_provisioner_last_status` (`401`: the provisioning password does not match;
  `-1`: the proxy has no provisioning credentials).

## 10. Production on one host (lean profile)

The local stack's `infra/compose/.secrets/` (from `dev-secrets.sh`, `dev-pki.sh`) is **never** used in production.
The production path is `infra/ansible/playbooks/lean.yml`, run from the service operator's workstation (C-79; tool
image `infra/ansible/tools/Dockerfile`):

| Step | What | Where it is |
|---|---|---|
| Host | Debian 13, ≥ 4 vCPU / 16 GiB (small deployment) or 8 vCPU / 32 GiB (design load), a separate data disk ≥ 250 GB mounted at `/srv/scf` (C-109), two public IPv4 addresses (one for the gateway, one for the portal — the gateway must see client addresses) | your provider, or `infra/opentofu/envs/azure-lean` on Azure |
| Secrets | `infra/ansible/scripts/gen-stack-secrets.sh` generates every password, key set, signing key and the SEP-10 seed once on the workstation; encrypt the result with SOPS + age into `infra/ansible/group_vars/lean.sops.yaml`. The role derives connection URLs, the PgBouncer user list and public keys itself. Keep the age key and a SOPS-encrypted copy of the PKI directory backed up — without them backups cannot be decrypted | `infra/ansible/README.md` |
| Node certificates | The `pki` role issues the stack's mutual-TLS identities from a private CA kept on the workstation | role `pki` |
| Docker | Docker CE 29.9.3 from Docker's repository (pinned, packages held), data root on the data disk, `userland-proxy: false`, container logs rotated | role `docker_engine` |
| Public TLS | lego 5.6.0, ACME DNS-01. On Azure DNS it uses the VM's managed identity (no secret). On another DNS provider, set the role's `scf_acme_dns_provider` to that provider's lego code and put its credentials (lego environment variables) into the SOPS file; or bring your own certificates | role `compose_stack` |
| Stack | The repository's `infra/compose` files plus the role's `compose.prod.yaml`: images by digest, real hostnames, gateway on the ingest address `:443`, portal (Caddy, HTTPS) on the portal address `:443`, no other published port except on `127.0.0.1` | role `compose_stack` |
| Firewall and updates | nftables default deny (443 to the two front addresses, SSH from the admin range), unattended security upgrades, journald cap | role `common` |
| Backups | PostgreSQL runs from the `postgres-ha` image in single mode: pgBackRest to **two** blob repositories (Azure: managed identity, no keys), weekly full, daily differential, hourly check, weekly encrypted logical dump; repository configuration from inventory variables | role `compose_stack`, `infra/compose/ha/bin/scf-backup` |
| Restore drill | Weekly systemd timer restoring repository 2 into a scratch container and running the integrity checks (C-56); on a second host if you have one | role `restore_drill` |
| Monitoring | The monitoring overlay on the same host, bound to `127.0.0.1` (`scf_monitoring_enabled`). The dead-man's-switch check (`ops/deadman/check.sh`) runs from `.github/workflows/deadman.yml` once the repository variable `SCF_STATUS_URL` is set, and one host has no 2-of-3 probe quorum (`docs/monitoring-plan.md`, open point P7) | `ops/README.md` |

What this profile gives up (one host, no failover) and the objectives it can meet are in
[`../deployment-topology.md`](../deployment-topology.md) §1.5 and [`../sla.md`](../sla.md) §1.1; costs on Azure in
[`../cost-model.md`](../cost-model.md).

## 11. Building and testing from source

```sh
make install     # mise install + pnpm install --frozen-lockfile
make lint        # go vet per Go module + biome check and each package's lint script
make test        # Go and TypeScript unit/integration tests (several need Docker)
```

Component READMEs list their own test commands and Docker port ranges.
