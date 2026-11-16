# Local stack (Docker Compose)

The whole platform on one machine (ADR-0019, C-96). Production adds the
multi-node profile, SOPS secrets and the IaC-managed CA; everything else is identical.

## Quick start

```sh
infra/compose/scripts/init.sh                                     # once: dev secrets + dev PKI in .secrets/, tracker/dist
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d --build --wait  # or: make up
infra/compose/scripts/smoke.sh                                    # whole-stack checks (brings its own stack up and down)
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml down -v                # stop and delete the data
```

`compose.yaml` is also the base of the production lean profile (`infra/ansible` role `compose_stack` adds
`compose.monitoring.yaml` and its rendered production override), so it holds no synthetic data or test fixture.
**`compose.dev.yaml`** holds the development and test fixtures — today `onchain-fixture` and the read-only ledger
mount + start dependency it gives `jobs`. Every local stack adds it (`make up`, `scripts/smoke.sh`, `ops/e2e/run.sh`,
`tests/stack/up.sh`, `tests/quickstarts/stack/up.sh`, `services/gateway/integration/run.sh`,
`apps/portal/e2e/real/run.sh`, `ha/tests/run.sh`, `ha/scripts/restore-drill.sh`); no deployment loads it, and the
fixture image (`services/onchain-reader/Dockerfile` target `lakegen`) is built from this file only. Without it the stack still runs: `jobs` then gets the empty,
writable `ledgers` mirror a deployment has.

Needs Docker with Compose v2.24+ and BuildKit, `openssl`, `curl`, `jq` (smoke test). The first build of the Umami images takes a few
minutes (the source is fetched from GitHub by commit); later builds are cached.

## Services

| Service | Kind | What it does | Network(s) | Host port |
|---|---|---|---|---|
| `postgres` | long-running | PostgreSQL 18.6 from **our clean image** `usagemap/postgres:dev` (`db/Dockerfile` target `server`: pinned 18.6-alpine digest, patched `krb5-libs`/`libxslt`/`zlib`, no `gosu` — it must run as uid 70, C-119); databases `scf` and `umami`; `init: true` and a `CHECKPOINT` after every start (C-108, see `postgres/healthcheck.sh`); runs as uid 70 from the start, read-only root, **no capabilities**, SCRAM for TCP and the local socket (no `trust`) | engine, db | — |
| `db-migrate` | one-shot | `db/Dockerfile` (target `migrate`, built FROM `server`): idempotent bootstrap of the `scf` roles and database, then the migrations (`db/migrate.sh migrate`); connects directly | db | — |
| `pgbouncer` | long-running | PgBouncer 1.26.1 in **transaction mode** (`pgbouncer/pgbouncer.ini`) between the runtime roles and PostgreSQL; only the roles in `.secrets/pgbouncer_userlist` can log in (`scf_app`, `scf_jobs`, `scf_writer`, `scf_metrics_ro`, `scf_umami_ro`, `scf_umami_maint`) | db, data | — |
| `umami-views-drop` | one-shot | drops schema `scf_ro` before Umami's migrations (`db/migrate.sh umami-views-drop`, data-model §16.3) | db | — |
| `umami-migrate` | one-shot | `prisma migrate deploy` as `umami_app` from `usagemap/umami-migrate` (C-40, C-104) | engine | — |
| `umami-views` | one-shot | recreates the `scf_ro` views and the roles `scf_umami_ro`, `scf_umami_maint`; `umami_app` statement timeout 30 s (`db/umami/scf_ro.sql`, C-112(12)) | db | — |
| `umami` | long-running | `usagemap/umami` (vendor/umami): read-only root, no capabilities, uid 1001, `SKIP_DB_MIGRATION=1`; starts only after `umami-views`, so any start of Umami re-runs drop → migrate → views (C-121) | engine (internal) | **none** |
| `engine-proxy` | long-running | mTLS front of Umami and of the control plane's internal edge API; allow-lists, deny-list, bootstrap gate, visit memory (`services/engine-proxy`); calls the internal edge API over mutual TLS; its own bootstrap probe uses the provisioning credentials (C-114) | engine, core, cpi | — |
| `umami-bootstrap` | one-shot | B1–B5 through the engine proxy with its own provisioning certificate (`core-a-umami-bootstrap`); restartable; its B5 opens the proxy's gate (C-112(7)) | core | — |
| `control-plane` | long-running | `services/control-plane/Dockerfile`: public API on 8080 (`GET /healthz`), internal edge API on 8081 with **mutual TLS** (only the engine proxy's client certificate `core-a-engine-proxy` is accepted, C-114); database through PgBouncer, its three LISTEN sessions (`scf_edge`, `scf_verify`, `scf_umami`) directly on `db` as `scf_jobs` (C-117); in-process jobs (edge snapshot, Umami reconcile, domain verification, erasure); serves the tracker release from `tracker/dist` (mounted) + `tracker-releases.json`; `SCF_TRUST_PROXY=false` | data, db, cpi, public | `127.0.0.1:${SCF_CONTROL_PLANE_PORT:-8080}` |
| `portal` | long-running | the portal's Caddy image: the SPA and a same-origin reverse proxy of `/v1/*`, `/public/*` to the control plane; `SCF_PORTAL_SCHEME=http` locally | public | `127.0.0.1:${SCF_PORTAL_PORT:-5173}` |
| `jobs` | long-running | partitions, retention (Umami pruning as `scf_umami_maint`), web rollups (through `scf_ro` as `scf_umami_ro`), stream GC, tenant purge (engine through the engine proxy with its own provisioner certificate `core-a-jobs-provisioner`), durability reconciliation, trust scoring, audit anchor (files in volume `jobshome`, mounted on the image's `/home/node`) and audit verification — database through PgBouncer. `registry_sync`, `contract_verification`, the Stellar anchor and the canary half of `durability_reconcile` need egress settings that stay unset locally: logged once as `job_disabled` | data, core | — |
| `dev-settings` | one-shot, **`compose.dev.yaml` only** | applies `postgres/dev-settings.sql` as the superuser after the migrations on every start: the local stacks' platform settings (`edge_counter_features = ["props","dev"]`, C-137); `jobs` waits for it. Never deployed (C-139): a deployment sets the value once with `PATCH /v1/operator/settings/edge_counter_features` (operator_admin, step-up, audited) | db | — |
| `rangelist-updater` | long-running (weekly) | the gateway image's `rangelist-updater -interval 168h`: cloud-provider, Private Relay and Tor-exit range lists (C-38, bot.ip-multiplicity) into the volume `rangelists`, which the gateway mounts read-only and re-reads every minute. **Off in the local stacks** (`compose.dev.yaml`: profile `rangelist-fetch`; the gateway reads the documentation-range test lists of `rangelists/`); the lean profile runs it from the systemd timer `scf-rangelists` (result → `scf_rangelists.prom`, alert RangeListsStale) | public | — |
| `onchain-fixture` (`compose.dev.yaml`) | one-shot | **dev/test only, never deployed.** `services/onchain-reader` image target `lakegen`: writes a synthetic **testnet** ledger-file mirror (volume `ledgers`) with the 8 UTC days before today complete (contracts `smoke-contract`, `smoke-conflict`; strkeys in its log), regenerated on every start; `compose.dev.yaml` mounts it read-only in `jobs` at `SCF_ONCHAIN_LEDGER_DIR` (instead of `compose.yaml`'s writable mount) and makes `jobs` wait for it, so `onchain_correlation` runs without a live download (no egress; `SCF_ONCHAIN_LEDGER_SOURCE_URL` unset, so no `fetch` step). In a deployment the volume `ledgers` is the real mirror, filled by the job's fetch step | none | — |
| `metrics-writer` | long-running | OTLP from the Collectors over mutual TLS (OU `edge`) on `:4319`, alias `writers.mesh.local`; writes as `scf_writer` through PgBouncer | core, data | — |
| `gateway` | long-running | the only public entry — tracker files, challenge, events, verdicts, fsync'd spool (volume `gwstate`), forwarder to the engine proxy with `edge-a1`; OTLP front door with ingest tokens (`pepper_ing`, shared with the control plane) | core, public | `127.0.0.1:${SCF_INGEST_PORT:-8443}` (TLS, dev-CA certificate for the ingest host names) |
| `collector` | long-running | `scf-otelcol`, its own container on the private **`otlp`** network that only the gateway joins (C-130): receivers bound to its `otlp` address only (alias `otlp-collector`), no published port; exports to `writers.mesh.local:4319` with `edge-a1`; persistent queue in volume `colqueue` | (gateway's) | — |

Start order: `postgres` (healthy) → `db-migrate` and `umami-views-drop` → `pgbouncer` (healthy), `umami-migrate` →
`umami-views` → `umami` (healthy) → `engine-proxy` (healthy) → `umami-bootstrap` → `control-plane` and `jobs` →
`portal`, `gateway` → `collector`; `metrics-writer` after PgBouncer and the migrations. Every start re-runs the one-shots; all of
them are idempotent, so this is also the upgrade path for Umami (drop views → migrate → recreate views).

No profiles: a plain `up` runs every service. All application services use the `*hardened` anchor (read-only root,
no capabilities, `no-new-privileges`); runtime database users connect to `pgbouncer:6432` — the one exception is the
control plane's LISTEN-only sessions (C-117).

**`SCF_TRUST_PROXY`** (control plane): `false`. The portal fronts the API, but without a fixed address for the portal
locally every browser request shares the portal's rate-limit bucket (acceptable on one machine). To change that, set it to the portal's address
on the network it shares with the control plane — give that network a fixed subnet and the portal a fixed
`ipv4_address`, and list that address (or the CIDR); never `true`. Unlisted, every anonymous caller would share the
portal's rate-limit bucket.

## Networks (hardening.md §3)

| Network | Internal | Members | Purpose |
|---|---|---|---|
| `engine` | yes | PostgreSQL, Umami, `umami-migrate`, the engine proxy | Umami has no route anywhere else, and no egress (C-10) |
| `db` | yes | PostgreSQL, PgBouncer, `db-migrate`, `umami-views*`, control plane | direct database access: migrators and superuser steps; the control plane only for its LISTEN sessions |
| `data` | yes | PgBouncer, control plane, metrics writer, jobs | runtime database access, through PgBouncer |
| `core` | yes | the engine proxy's mTLS listener, its node callers (`umami-bootstrap`, gateway + Collector, the jobs service's tenant purge), the metrics writer (`writers.mesh.local`); the gateway answers to `edge-a1` here (node key exchange) | local stand-in for the WireGuard mesh with per-node mTLS (C-60) |
| `cpi` | yes | **only** the engine proxy and the control plane | the proxy → internal edge API hop (mutual TLS, C-114) and the control plane's adapter calls to the proxy |
| `public` | no | control plane, portal, gateway | published ports; egress the control plane is allowed (C-10) |

The control plane's internal port 8081 cannot be reached from `core` (the name does not even resolve there); on
`public` and `data` it can be reached but refuses every TLS client except the engine proxy's certificate (no
certificate: handshake refused; another node certificate of the same CA: `401`), so `X-Scf-Edge-Node` is trusted only
from the proxy.

The engine proxy publishes no port. To call it from the host, run a client container on `<project>_core` with a node
certificate — `scripts/smoke.sh` shows how (`scripts/smoke-client.mjs`).

## Secrets and PKI (`.secrets/`, git-ignored)

`scripts/dev-secrets.sh` creates random passwords (hex), `APP_SECRET`, the two Umami bootstrap passwords, connection
URLs, the key sets `umami_creds_keys`, `pepper_ing` (gateway + control plane), `pepper_op`, `pepper_pub` (format
`1:<base64 of 32 bytes>`), the edge-snapshot signing key with its public half (`edge_snapshot_pub.pem`, for the gateway), the traction-snapshot
signing key (`snapshot_signing_key.pem`, Ed25519 PKCS#8, kid `snap-1`) and a random SEP-10 server seed
(`sep10_signing_seed`, generated by a small Node.js snippet straight into the file, never printed); `scripts/dev-pki.sh` creates a dev CA and node certificates. Both only create what
is missing — existing values are never replaced, which is what makes the Umami bootstrap restartable. They reach
containers as Compose file secrets under `/run/secrets/` (never as environment values in this file; Umami's two
values are read by its entrypoint from the secret files). Compose file secrets are bind mounts and Compose ignores
`uid`/`gid`/`mode` for them, so ownership is set on the host: **private keys are `0600` and owned by the uid of the one
container user that reads them** (65532: engine proxy, `umami-bootstrap`, Go services, smoke client; 1000: control
plane and jobs). `dev-pki.sh` sets that ownership with a throwaway container (root with only `CAP_CHOWN`, no network), so after
it has run the host user can no longer read those keys — re-issue instead (delete the pair, re-run `dev-pki.sh`). The
CA key stays `0600` with the host user and is never mounted. Passwords and URLs from `dev-secrets.sh` are still
world-readable inside the `0700` directory (several containers with different uids read some of them).

| Certificate (`.secrets/pki/`) | Subject | Key owner | Used by |
|---|---|---|---|
| `engine-proxy.pem` | `CN=engine-proxy`, SAN `engine-proxy`, `localhost`, `127.0.0.1` | 65532 | engine proxy listener |
| `control-plane.pem` | `CN=control-plane`, SAN `control-plane` | 1000 | control plane internal edge API listener |
| `core-a-engine-proxy.pem` | `OU=engine-proxy, CN=core-a-engine-proxy` | 65532 | engine proxy → internal edge API (`SCF_INTERNAL_ALLOWED_CLIENTS`) |
| `edge-a1.pem`, `edge-a2.pem` | `OU=edge, CN=edge-a1` …, `serverAuth` + `clientAuth` (node key exchange) | 65532 | gateway (forwarder, snapshot), Collector → writer, smoke test |
| `ingest.pem` | `CN=ingest`, SAN the two ingest host names, `gateway`, `localhost`, `127.0.0.1` | 65532 | gateway's public listener |
| `core-a-writer.pem` | `CN=core-a-writer`, SAN `core-a-writer`, `writers.mesh.local`, `localhost` | 65532 | metrics writer's OTLP listener |
| `core-a-control-plane.pem` | `OU=reader, CN=core-a-control-plane` | 1000 | control plane adapter reads (§j.3) |
| `core-a-jobs.pem` | `OU=reader, CN=core-a-jobs` | 65532 | smoke test (reader identity; the jobs service reads Umami through SQL, not the proxy) |
| `core-a-jobs-reader.pem` | `OU=reader, CN=core-a-jobs-reader` | 1000 | jobs service (`umami_reconcile`: reads after a credential rotation; F16) |
| `core-a-umami-bootstrap.pem` | `OU=provisioner, CN=core-a-umami-bootstrap` | 65532 | `umami-bootstrap`, smoke test |
| `core-a-jobs-provisioner.pem` | `OU=provisioner, CN=core-a-jobs-provisioner` | 1000 | jobs service (`tenant_purge`: P13, P9, P11, visit-token purge) |

The role is the certificate's single OU, the node name its CN (`^[a-z0-9][a-z0-9-]{1,31}$`, checked by `dev-pki.sh`;
`services/engine-proxy/README.md`).

**To rotate.**
- *Node certificates and the CA:* delete the files and re-run `dev-pki.sh` (`FORCE=1` re-creates the CA). Docker
  secrets are bind-mounted when a container is **created**, so re-issued files reach a container only after a restart
  or recreate: `docker compose up -d --force-recreate engine-proxy` (a `SIGHUP` alone re-reads the files the container
  already sees and is not enough after re-issuing them; it also closes the connections opened before it), and the same
  for every other holder of a re-issued certificate — the gateway and the Collector (`edge_a1_*`), the metrics writer,
  and the **jobs service**, which runs the reader, provisioner and snapshot workers since C-125 (not the control
  plane, which keeps only its own adapter and internal-listener certificates).
- *Edge-snapshot signing key (no outage):* the gateways trust two slots, `edge-1` (`edge_snapshot_pub.pem`) and
  `edge-2` (`edge_snapshot_pub_next.pem`, a copy of the current key otherwise). (1) Generate the new key and put its
  public half into the free slot's file; recreate the gateway, which now trusts both keys. (2) Replace
  `edge_signing_key.pem` with the new private key, set `SCF_EDGE_SIGNING_KID` to that slot's kid and recreate `jobs`:
  the next snapshot is signed with the new key and accepted at once. (3) After a snapshot interval, copy the new public
  key into the other slot (or leave it) and recreate the gateway. On the lean profile the slot is the role variable
  `scf_edge_pub_next`; runbook `ops/runbooks/key-and-cert-rotation.md`.

## Environment

| Variable | Default | |
|---|---|---|
| `SCF_CONTROL_PLANE_PORT` | `8080` | host port of the control plane's public API |
| `SCF_PORTAL_PORT` | `5173` | host port of the portal, also the portal origin given to the control plane |
| `SCF_INGEST_PORT` | `8443` | host port of the gateway (TLS; resolve the ingest host names to 127.0.0.1 and trust `.secrets/pki/ca.pem`) |
| `SCF_GW_CORES_EXTRA`, `SCF_GW_KEYX_ADDR`, `SCF_GW_KEYX_PEERS` | empty | multi-node only (below) |

**Multi-node (HA overlay, `--profile multinode` of `compose.ha.yaml`).** The base file stays single-node; the second
core and edge are switched on by the overlay's profile plus three variables for the first gateway:
`SCF_GW_CORES_EXTRA=,core-b=https://engine-proxy-b:8443`, `SCF_GW_KEYX_ADDR=:9443`,
`SCF_GW_KEYX_PEERS=edge-a2=https://edge-a2:9443`. The control plane already admits `core-b-engine-proxy` on its
internal API (a name without a certificate admits nobody). `gateway-b` (overlay) sets its own
`GW_KEYX_ADDR=:9443`, `GW_KEYX_PEERS=edge-a1=https://edge-a1:9443` and the `core` alias `edge-a2`; measured run:
`docs/evidence/chaos/multinode-2026-11-13.md`.

The control plane also gets `SCF_SNAPSHOT_SIGNING_KEY_FILE`/`SCF_SNAPSHOT_KID=snap-1`, `SCF_SEP10_SIGNING_SEED_FILE`,
`SCF_HEALTH_INGEST_HOSTS` (both ingest host names → `edge-a1`) and a placeholder `SCF_STATUS_PAGE_URL`.

The control plane signs in against `SCF_STELLAR_NETWORK` (default `public`, C-114); set it in an override file for a
testnet deployment.

Use `-p <name>` to run a second copy side by side (all names are project-scoped; nothing uses fixed container names).

## Smoke test

`scripts/smoke.sh` (variables: `PROJECT`, `SCF_CONTROL_PLANE_PORT`, `SCF_PORTAL_PORT`, `SCF_INGEST_PORT`, `KEEP=1`,
`EXTRA_COMPOSE=<override file>`) brings the stack up with `--wait` and checks, besides the gate-G1 checks (one-shots,
Umami isolation, PostgreSQL/PgBouncer hardening, the internal edge API only through the engine proxy, engine-proxy
allow-lists and visit rule, restart and bootstrap re-run, privacy scans):

- every long-running service healthy; the Collector only on `otlp` + `core`, its receivers unreachable from `core`, `data` and `public` (C-130); each service
  only on its networks; only the control plane, portal and gateway publish ports; read-only root, no capabilities,
  `no-new-privileges`, non-root for Umami, the Collector and every application service;
- PgBouncer: every runtime-role backend comes from PgBouncer except the control plane's three LISTEN sessions, which
  are checked to run nothing but `LISTEN`;
- portal: health, CSP, same-origin proxy of `/v1/*`; the tracker release published with the SRI of `tracker/dist`;
- PostgreSQL runs `usagemap/postgres:dev` and the image has no `gosu`;
- control plane: `/.well-known/scf-snapshot-keys.json` publishes kid `snap-1`; `GET /public/v1/health` answers `200`
  once edge-a1 has sent its first counter report (`503` = `down` before that, by design, C-121);
- jobs: `readyz`; only on `core` and `data`; today's `api_metrics_1m` partition created by its start-up run;
  `tenant_purge`, `durability_reconcile`, `trust_scoring`, `audit_anchor` succeeded at start (`scf_job_runs_total`),
  no `job_failed`, `registry_sync` and `contract_verification` logged as `job_disabled`, an anchor file written;
- metrics writer: `readyz`; `writers.mesh.local:4319` accepts an edge certificate and refuses none or a reader one;
- web path: fixture tenant/site/domain in SQL, Umami websites through the engine proxy, the gateway's `probe`
  (challenge, proof, event) → `202`, the event stored in Umami with tag `v`; the published ingest port serves the
  tracker over TLS;
- API path: an ingest token seeded with the shared pepper → OTLP/HTTP through the gateway's front door → Collector →
  writer (mTLS) → 3 requests in `api_metrics_1m` for an auto-registered service; a wrong token `401`; a request with
  the gateway's metadata straight to the Collector on the `otlp` network (level `L1` lifts the L0 one-service limit, C-116);
  canaries (`host.name`, `client.address`) absent from the database; no User-Agent, surrogate, token or canary in
  the logs of the gateway, writer, Collector, jobs, control plane and portal.

Result on 2026-11-13, integration pass 2 (project `scf-int2`, ports 56290–56292, all images built from this tree):
**116 passed, 0 failed**. On the kept stack, `docker compose stop umami && docker compose start umami` re-ran
`umami-views-drop` → `umami-migrate` → `umami-views` before Umami started, and the `scf_ro` views were present.

## Recovery

- **`umami-bootstrap` fails with "neither the provisioning admin nor the seed admin can log in"**: the Umami database
  holds credentials that do not match `.secrets/` (e.g. secrets were deleted but the volume kept). Either restore the
  old secret files or start from an empty volume (`down -v`).
- **The engine proxy answers `503 bootstrap_pending`**: the B5 check has not succeeded since it started — look at
  `umami-bootstrap`'s log, at `scf_engine_proxy_bootstrap_probe_errors_total` (Umami unreachable) and at
  `scf_engine_proxy_bootstrap_probe_provisioner_last_status` (`401`: the provisioning password in `.secrets/` does not
  match Umami; `-1`: the proxy has no provisioning credentials).
- **`dev-pki.sh` fails with "docker is required"** or a `chown` error: it needs Docker to hand each private key to its
  container user. Keys created before this change are re-owned on the next run.
- **Umami upgrade blocked by a view**: never run `umami-migrate` alone; `docker compose up` always runs
  `umami-views-drop` first.
- **`scf_ro` views missing after an Umami restart**: fixed by the dependency order (C-121) — Umami depends on
  `umami-views`, so `up`/`start` of Umami re-runs drop → migrate → views; `restart umami` runs no migration
  (`ops/runbooks/umami-upgrade.md`).
