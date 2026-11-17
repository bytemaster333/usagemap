# Deployment hardening baseline

Status: **baseline of the built deployment, revised 2026-11-13** (first written 2026-11-12). This is the configuration
every deployment (ours, and the successor service operator's after handover) must match. Ansible roles
(`infra/ansible/roles/{common,docker_engine,compose_stack,egress_proxy,pgbouncer,pki,postgres,restore_drill}`) and the
Compose files in `infra/compose/` implement it; §15 says how each item is checked and §15.1 which checks exist today.
**Production profile (C-123):** the lean profile runs the whole Compose stack on one Azure VM (`app-1`), so the
multi-node items below (edge nodes, core nodes, `mon-c`, `probe-d`, the WireGuard mesh, the health controller) apply
to the scale-out profile only; in the lean profile the internet-facing listeners are the gateway and the portal's
Caddy on `app-1` (NSG and host nftables admit 443 to the two front IPs and SSH from the admin range), every other
service is on container networks or loopback, and **there is no 2-of-3 probe quorum and no external port scan from
`probe-d`** — see [`../monitoring-plan.md`](../monitoring-plan.md) and open point P7 (§16). **Applied to the reference
deployment:** the lean role on one small VM (`infra/opentofu/envs/v1-small`,
[`../guides/deploy-v1.md`](../guides/deploy-v1.md)); the outside check of its listeners is the smoke test from the
operator workstation (portal IP: only 22 from the operator address, 80, 443; ingest IP: only 22 from the operator and
443). The v1 small profile deviates from this baseline
where its role options say so (no registry, image signatures not verified, SAS instead of a managed identity, no
private endpoint — `deploy-v1.md` §5). The lean profile is also tested with `infra/ansible/tests/lean/run.sh` (the
playbook applied to a Debian 13 VM container) and `infra/opentofu/scripts/check.sh` (mock provider).
Binding decisions: ADR-0003 (Umami lock-down), ADR-0005 (gateway), ADR-0013 (database roles),
ADR-0014 (sessions), ADR-0016 (keys), ADR-0017/0018 (residency, topology), ADR-0019 (IaC, secrets, image
verification), ADR-0022 (logging), ADR-0024 (portal), and the register's Clarifications C-01 … C-112 — in particular
C-04, C-05, C-09, C-10, C-12, C-17, C-20, C-21, C-38, C-40, C-50, C-60, C-61, C-66, C-74 (engine proxy), C-77
(first-release simplifications), C-79 (build and deploy secrets, `mon-c`), C-81 (peppers), C-85, C-87, C-90 and the
day-0 spike decisions C-99 (engine proxy, Umami provisioning), C-103 (database), C-104 (our Umami image), C-106 (geo,
scanners), C-107 (Collector) and C-108 (backups). Values marked **(proposed)** are not in the
register or a clarification; they are collected in §16. Threat IDs refer to [`../threat-model.md`](../threat-model.md).
"SCF operator" means a portal user with the `operator` or `operator_admin` role; "service operator" means the entity
that runs the service (C-59).

## 1. Principles

1. **Only two things listen on the internet:** the gateway on edge nodes and Caddy on core nodes. Everything else is
   on the WireGuard mesh, loopback or a container network; every node-to-node hop also uses per-node mutual TLS
   (C-60).
2. **Deny by default** at every layer: host firewall, container networks, database roles, Umami routes (the engine
   proxy with per-caller allow-lists, C-74), egress (only the destinations listed in C-10, through the egress proxy).
3. **Nothing identifying on disk or in logs** (ADR-0006/0022), including crash dumps and swap (C-66).
4. **Everything verifiable from the repository:** configuration is code; deviations are drift and alert.

## 2. Network exposure

### 2.1 Listeners

| Host(s) | Process | Bind | Reachable from | Purpose |
|---|---|---|---|---|
| `edge-a1`, `edge-a2`, `edge-b1`, `edge-b2` (C-25) | gateway | public IPv4/IPv6, **443/tcp** | **Internet** | Tracker files and signed manifest, challenge, web events, OTLP/HTTP and OTLP/gRPC, `/healthz` (ADR-0005/0009). Exact ports and any HTTP/3 listener per `docs/contracts/wire-formats.md`. |
| edge | `scf-otelcol` | its address on the private `otlp` network (alias `otlp-collector`; C-130) | the gateway only (the `otlp` network has no other member; the gateway forwards only content and `x-scf-*` headers, because every forwarded header is written to the on-disk queue, C-107) | OTLP pipeline; exports directly to the writers with the node certificate through one name (`writers.<mesh>`) that resolves to both cores, failing over at connection level; the loopback hop back through the gateway only for an mTLS/SAN problem (ADR-0009, C-107) |
| edge | range-list updater | — (outbound only, through the egress proxy) | — | Weekly fetch of cloud, Private Relay, Tor-exit and VPN range lists into a local volume; checksums logged (C-38) |
| edge | gateway key-exchange port | WireGuard address, dedicated port | other gateways, mutually authenticated | Exchange of the edge key bundle — `K_day`, the multiplicity key, `K_chal` (ADR-0007, C-04, C-68) |
| edge | gateway and Collector metrics | WireGuard address | `mon-c` | Prometheus scrape |
| edge | WireGuard | public address, UDP | **mesh peers only** (nftables source allow-list) | Private links (ADR-0018) |
| edge | sshd | WireGuard address **(proposed, HD-01)** | maintainers via the mesh | Administration |
| `core-a`, `core-b` | Caddy | public IPv4/IPv6, **443/tcp** (80/tcp only for redirect and, if chosen, ACME HTTP-01) | **Internet** | Portal SPA, control-plane API, SEP-10 endpoints, `stellar.toml`, `metrics_endpoint`/`health_endpoint`, traction-snapshot key under `/.well-known/` (ADR-0018/0024/0032, C-14, C-47) |
| core | control plane | container network behind Caddy | Caddy; the engine proxy (internal edge API) | REST API; internal edge API `/internal/v1/edge/snapshot` (signed, sequence-numbered snapshot every 30 s) and `/internal/v1/edge/counters` (ADR-0005, C-39, C-60, C-62) |
| core | engine proxy (`/services/engine-proxy`) | WireGuard address, mTLS with per-node certificates from the private CA | edge forwarders (`POST /api/send` and the internal edge API only); control plane and jobs (adapter-contract endpoints and parameters only); provisioning identity (admin endpoints) | The only way to reach Umami and the internal edge API; holds Umami's cache token and the visitor's last event time per (site, surrogate) in memory only and enforces the 30-minute visit rule; strips `cache`, `sessionId` and `visitId` from Umami's answers; purges a deleted website's tokens (C-60, C-74, C-99) |
| core | Umami | engine container network only | the engine proxy | Engine (ADR-0003) |
| core | metrics-writer | WireGuard address, mTLS with a certificate that carries both the node name and `writers.<mesh>` in its SAN (C-107) | edge Collectors with a node certificate (or gateways, in the relay fallback) | OTLP/HTTP in (ADR-0009, C-107); closes its listener while PostgreSQL is unreachable |
| core | PostgreSQL / PgBouncer and the Patroni-following local proxy | WireGuard address and container network | core services on both core nodes; nothing else | Databases `scf`, `umami` (ADR-0013, C-07) |
| core | Patroni REST, etcd | WireGuard address | core nodes, `mon-c`, health controller | HA (ADR-0020) |
| `core-b` | health controller (second instance) | — (outbound DNS-provider API only, through the egress proxy) | — | Ingest and portal A/AAAA records (C-27) |
| core | exporters | WireGuard address | `mon-c` | Metrics |
| `mon-c` | Prometheus, Alertmanager, Grafana, VictoriaLogs, Pushgateway, Gatus, etcd member, health controller | WireGuard address; status endpoints only on the public address | maintainers via the mesh; core nodes (etcd); **no inbound except the mesh and the status endpoints** (C-79) | Monitoring (ADR-0022, C-27). Holds the DNS write credential, an etcd member and mesh access, so its compromise is High impact (C-79, §4.1) |
| `probe-d` | probes | no inbound service except WireGuard (if joined) and SSH per HD-01 | — | Availability probes from a fourth provider (C-25, C-30) |

A daily scan from outside (`probe-d`) and from `mon-c` compares actual listeners with this table; any difference
alerts (monitoring plan `UnexpectedListener`).

### 2.2 Egress

C-10 decides which components may open outbound internet connections, and to which named destinations; each node's
firewall and an egress proxy enforce the list. Allowed: the control plane to GitHub's OAuth endpoints and the
configured Stellar RPC/Horizon hosts (sign-in and L2 verification); the domain verifier; registry sync; the API
liveness probe (A2); the contract-verification job (Stellar RPC); the audit-anchoring job (Stellar network and the
public evidence repository); the optional on-chain job; ACME from the gateway and Caddy; DNS-provider APIs from the
health controller; backup uploads; the range-list updater on edge nodes (C-38); probes from edge nodes, `mon-c` and
`probe-d` to our own public endpoints; alert notifications from `mon-c`; operating-system and image updates from their
mirrors and registry. **The engine, the writer, the Collector and all other jobs have no internet egress.**

| From | Allowed destinations | Basis | Everything else |
|---|---|---|---|
| Umami (engine network) | PostgreSQL only | ADR-0003, C-10 | Dropped and counted (`EgressDenied`) |
| metrics-writer, `scf-otelcol`, engine proxy, jobs not listed below | Nothing on the internet; mesh peers only | C-10 | Dropped and counted |
| Control plane | GitHub OAuth endpoints; configured Stellar RPC/Horizon hosts | C-10 | Dropped |
| API liveness probe (A2) | Tenants' declared API base URLs, with the same private-range and redirect rules as the domain verifier **(proposed)** | ADR-0028, C-10 | Dropped |
| Contract-verification job | Configured Stellar RPC hosts | C-10, C-19 | Dropped |
| Audit-anchoring job | Stellar network (when enabled) and the public evidence repository | C-10, C-63 | Dropped |
| Gateway | ACME CA and the DNS-provider API for its delegated `_acme-challenge` zone only (C-61); WireGuard peers | C-10, C-61 | Dropped |
| Caddy | ACME CA | C-10 | Dropped |
| Domain verifier (egress network) | Public internet over HTTPS, **no private, loopback, link-local, CGNAT or our own ranges, no redirects** | ADR-0015, C-10 | Dropped |
| Registry sync (egress network) | Registry APIs (Stellarlight, PG Atlas) | C-10 | Dropped |
| On-chain job and `onchain-reader` (egress network, optional) | Hubble/BigQuery or public ledger files when enabled | ADR-0028, C-10, C-42 | Dropped |
| Health controller (`mon-c`, `core-b`) | APIs of the two DNS providers | C-10, C-27 | Dropped |
| Range-list updater (edge nodes) | The publishers' list URLs | C-10, C-38 | Dropped |
| Probes (edge nodes, `mon-c`, `probe-d`) | Our own public endpoints only | C-10, C-30 | Dropped |
| Alertmanager (`mon-c`) | The alert channels the operating team chooses | C-10, C-26 | Dropped |
| PostgreSQL hosts | Backup object storage (two storage accounts through the Azure Blob interface, C-96), with credentials that may delete current blobs but not blob versions (C-108) | ADR-0021, C-10, C-29, C-108 | Dropped |
| All hosts | NTP, WireGuard peers, `mon-c`; operating-system and image updates from their mirrors and registry | C-10 | — |

The geo database (DB-IP IP to Country Lite, CC BY 4.0, read with `maxminddb-golang/v2`, ISC; C-106) is fetched at
image build by pinned SHA-256, its `database_type` checked (`DBIP-Country-Lite`), and is part of the gateway image,
refreshed monthly. One database serves every lookup; switching to another source is a whole-database switch, never a
per-lookup fallback (S-12). The cloud-provider, Private Relay, Tor-exit and VPN range lists are **not** in any published
image and not committed: the range-list updater fetches them weekly at runtime, logs their checksums and keeps them in
a local volume; the gateway starts with empty lists if none are present (C-38).

## 3. Firewall and network policy

- **nftables default-deny** inbound on every host, plus the provider's cloud firewall with the same rules (two
  independent layers). Inbound: 443/tcp on edge and core; 80/tcp on core if used; WireGuard UDP from the static peer
  list only.
- **Egress allow-lists** per §2.2, enforced on the host for container networks (Docker `DOCKER-USER` chain or
  equivalent) and logged as counters per component.
- **One container network per trust zone** on core nodes: `edge-facing` (Caddy, control plane), `engine` (Umami and
  the engine proxy's inner side, no default route), `data` (PostgreSQL/PgBouncer), `jobs`, and `egress` (the
  components C-10 allows outbound, each only to its named destinations through the egress proxy). A service joins only
  the networks it needs.
- **WireGuard:** static mesh generated from inventory; one key pair per host; `AllowedIPs` per peer limited to the
  peer's mesh address; a compromised edge cannot claim another host's address.
- **Per-node mutual TLS** on every hop between nodes: certificates from a private CA managed in the IaC, one per node;
  the engine proxy and the writer authenticate the caller by certificate (C-60, C-74). Revoking a node's certificate
  cuts it off. **Certificate identity (C-113):** each node certificate carries exactly **one OU naming its role** —
  `edge`, `reader` (control plane, jobs) or `provisioner` (Umami provisioning worker) — and its **CN is the node name**
  (the `node_id` of the wire formats); the engine proxy picks the caller's allow-list by the OU, refuses a certificate
  with no, several or an unknown OU, and on internal edge calls replaces any incoming `X-Scf-Edge-Node` header with the
  CN (wire-formats §c.5). The CA in the IaC issues certificates only in this form.
- **Edge-to-core reach** is limited by port, source and certificate to: the engine proxy (Umami `POST /api/send` and
  the internal edge API for snapshot and counters) and the metrics-writer, and nothing else (TM-EDG-08, C-60). Edge
  forwarders choose the core by a consistent hash of the surrogate and fail over to the other core (C-74).
- **Draining** closes the gateway listener (RST), never firewall-drops (ADR-0020).

## 4. SSH and host baseline

- **OS:** Debian 13 (ADR-0019). Unattended security upgrades with `needrestart` (egress for package updates: HD-11);
  staggered reboots (edges one at a time via drain; database via Patroni switchover).
- **SSH:** key-only; no root login; no password or keyboard-interactive auth; per-person keys declared in the
  inventory (no shared keys); `AllowUsers` limited to the maintainer group; listening on the WireGuard address only
  **(proposed, HD-01)**, with provider console as break-glass. Every interactive session and `sudo` is logged and
  shown in the maintainers' channel (monitoring plan `SSHSession`).
- **Secrets in memory stay in memory (ADR-0007, C-04, C-66):** on edge nodes core dumps are disabled
  (`fs.suid_dumpable=0`, systemd-coredump storage `none`, `ulimit -c 0`) and there is **no unencrypted swap** (swap off
  or encrypted with an ephemeral key); the edge key bundle (`K_day`, the multiplicity key, `K_chal`; C-68) lives in
  locked memory (`mlock`). Otherwise those keys and in-flight IPs could reach disk. Applying the same settings on core
  nodes (where the engine proxy holds cache tokens in memory, C-74) is part of the baseline **(proposed)**.
- **Kernel and sysctl:** `kernel.kptr_restrict=2`, `kernel.dmesg_restrict=1`, `kernel.unprivileged_bpf_disabled=1`,
  `net.ipv4.conf.all.rp_filter=1`, `net.ipv4.conf.all.accept_redirects=0` (and IPv6 equivalents), SYN cookies on.
- **Time:** `systemd-timesyncd` (or chrony) with ≥ 2 sources; offset alert at 100 ms (time bounds and the 00:00 UTC
  key switch depend on it).
- **Docker daemon:** journald log driver; `live-restore`; `no-new-privileges` default; inter-container
  communication only within declared networks; **no Docker socket mounted into any container**.
- **Minimal packages;** auditd with a minimal rule set (exec of setuid binaries, changes to `/etc`, SSH keys,
  Docker and WireGuard configuration); journald capped at 1 GB / 7 days.
- **Accounts:** hoster consoles, registrar, DNS providers, GitHub and npm with hardware-key 2FA; hoster API tokens
  scoped per project and held only in SOPS by the service operator. **Build automation never holds production credentials**:
  deployments run from a service-operator workstation (or a pull-based agent on the nodes) with SOPS-decrypted
  secrets, and the OpenTofu state credentials are not stored on any server (C-79).

### 4.1 `mon-c` (C-79)

`mon-c` holds the health controller's DNS write credential for the ingest and portal record sets, one of the three
etcd members and mesh access to every node; its compromise is rated **High impact** in the threat model. Baseline on
top of §4: no inbound traffic except the WireGuard mesh and the status endpoints; no OpenTofu state credentials on it;
the DNS credential limited to the ingest and portal A/AAAA record sets (C-27); SSH sessions and `sudo` alerted like
every other host; Ansible drift checks; configuration changes to the health controller and DNS records alerted
(record drift vs git and vs the controller's set).

## 5. Umami lock-down (ADR-0003)

### 5.1 Build

Built by us from the pinned commit (`d3c62a8`, fetched by SHA, checksum-verified) with `SKIP_BUILD_GEO=1`, frozen
lockfile, signed and SBOM'd (ADR-0003/0023; `supply-chain.md` §6.1). Two images from one Dockerfile (C-104): `umami`
(runs `node server.js`, never upstream's `start-docker.sh`) and `umami-migrate` (one-shot `prisma migrate deploy` as
`umami_app`). Neither ships a geo database, so the gateway **always** sends a non-empty `cf-ipcountry` (`XX` when
unknown, C-99). Patch queue `vendor/umami/patches/` empty unless an emergency requires otherwise. Exact values:
`spikes/s02-umami-hardened-image/README.md`.

### 5.2 Environment

| Setting | Value | Source |
|---|---|---|
| `DISABLE_TELEMETRY` | `1` | ADR-0003 |
| `DISABLE_UPDATES` | `1` | ADR-0003 |
| `PRIVATE_MODE` | `1` | ADR-0003 |
| `SALT_ROTATION` | `day` | ADR-0003 |
| `TZ` | `UTC` | ADR-0003 |
| `CLIENT_IP_HEADER` | `x-scf-surrogate-ip` — always sent; a missing header collapses visitors, and `payload.ip` is never sent (it would override the surrogate, S-01) | ADR-0003, C-99 |
| `SKIP_DB_MIGRATION` | `1` — migrations run as an explicit one-shot deploy step | C-40 |
| `APP_SECRET` | ≥ 32 random bytes from SOPS (mandatory in v3.5.0), **identical on every Umami instance**; rotating it is a planned event — every session id and cache token changes, so visits and sessions in progress split at the rotation | research, C-112 |
| `DATABASE_URL` | role `umami_app` on database `umami` only | C-12 |
| `MCP_ENABLED` | **unset** (MCP off) | ADR-0003 |
| `DISABLE_BOT_CHECK` | **unset** — Umami's own `isbot` check stays on as a backstop to the gateway's check (C-36) | ADR-0008, C-36 |
| `CLOUD_MODE`, `ENABLE_TEST_CONSOLE`, `ENABLE_CLIENT_SALT`, `IGNORE_IP`, `REDIS_URL`, `SKIP_LOCATION_HEADERS`, `GEOLITE_DB_PATH`, `COLLECT_API_ENDPOINT`, `TRACKER_SCRIPT_NAME`, `TRACKER_SCRIPT_URL` | unset | C-99, C-104 (S-01, S-02) |
| `TRUSTED_PROXIES` | unset (S-01: must not be set) | C-99 |
| `LOG_QUERY` | off **(proposed)** — queries contain filter values | research |
| `DISABLE_UI`, `DISABLE_LOGIN` | `1` **(proposed)** — cosmetic only; neither disables the API; not tested in S-02 | research |

S-02 confirmed that `PRIVATE_MODE` alone suppresses all three browser-side calls and that the engine made no outbound
connection; all three flags stay as defence in depth (C-104).

### 5.3 Routes (C-60)

Umami is never reachable from the internet (ADR-0003). It listens only behind the **engine proxy** on each core node
(`/services/engine-proxy`, Go; C-74), which authenticates every caller by per-node mutual TLS and applies a path
allow-list per caller (C-60):

- **Edge forwarders:** only `POST /api/send`, with the rebuilt body and the headers listed in ADR-0005
  (`x-scf-surrogate-ip`, `cf-ipcountry`, a synthetic reduced User-Agent); the engine proxy adds `x-umami-cache` when
  it holds that visitor's cache token (C-74). They may also call the control plane's internal edge API (snapshot and
  counters) through the same proxy (C-60).
- **Control plane and jobs:** only the endpoints and parameters listed in the adapter contract.
- **Provisioning identity:** the admin endpoints needed to create one team, one view-only user and one API key per
  tenant, `/api/auth/login`, `/api/me/password` during bootstrap only, and the engine proxy's own
  `DELETE /internal/v1/visit-tokens/websites/{id}` (C-99).
- **Never on any allow-list:** the single deny-list of Umami routes in `docs/contracts/wire-formats.md` §c.5, checked
  before every allow-list (C-104, C-112) — ingest side doors, recorder, shares, export and reset, scripts, MCP, login
  and 2FA, OpenAPI and image routes. This document keeps no copy of it. User and admin routes (`/api/users*`,
  `/api/admin*`) are reachable only by the provisioning identity, and only the ones it uses.
- Shares are never created (ADR-0003). Umami's responses never reach browsers (the gateway answers `202` itself,
  ADR-0005). Umami's cache token is kept only in the engine proxy's memory per (site, surrogate) with the visitor's
  last event time, replayed to Umami only while events are ≤ 30 minutes apart (Umami itself would keep a replayed
  visit open for ever, S-01); the proxy always stores the `cache` Umami returns and sets `last_event_ts := max(previous,
  event)` (C-112). When a website is deleted the provisioning worker purges its tokens on **every** core **before** P9
  deletes it in Umami, and each proxy keeps a 72-hour in-memory list of deleted websites (a valid token otherwise lets
  events into a deleted website, C-99, C-110, C-112); it never leaves the core node, is never sent to a browser and never written to disk
  (C-74, C-99). The engine proxy also removes `sessionId` and `visitId` from Umami's answers (C-99).
- Job `web_rollup` reads Umami data only through two read-only views in schema `scf_ro` (needed columns only, no
  query strings, titles or `distinct_id`) as role `scf_umami_ro` (C-109; `docs/data-model.md` §16.3). The view SQL
  runs in a one-shot Compose step after `umami-migrate` (C-112).

### 5.4 Identities and credentials

- Bootstrap (C-99, C-104, C-112; S-02 verified every step; steps B1–B5 in `docs/contracts/wire-formats.md` §j.2):
  log in as the seed `admin`/`umami` (the "change required" flag is a UI modal only), change its password with
  `POST /api/me/password`, create the provisioning admin, log in as it, **delete** the seed admin, and assert that
  `admin`/`umami` now answers `401`. It is **restartable**: both the new seed-admin password (B2) and the
  provisioning admin's password (B3) come from SOPS, so on start the worker tries P1 (provisioning login) first and
  resumes from the first incomplete step. The engine proxy refuses every non-provisioning caller until the worker has
  confirmed B5 (seed admin refused), and re-checks this at every proxy start (C-112).
- One Umami team, one user with **global role `view-only`** (team role `team-view-only`) and one API key per tenant,
  created by the control plane (ADR-0003, C-99). S-01 showed that global role `user` can create personal websites and
  teams, and that the `view-only` + team-member combination is isolated (`401` for other teams' websites, website
  creation, key minting and admin routes). The provisioning admin is `team-owner` of every tenant team; team access
  codes returned by Umami are never logged. Sites with `visitor_id = off` get a twin Umami website for their
  unidentified events, created on demand (C-73).
- Per-tenant Umami API keys **and the view-only user's password** are stored in `scf` encrypted with a key held
  outside the database; the password is used only by the provisioning worker to rotate the key (C-40, C-85).
- Direct SQL on `umami` only by the retention and erasure jobs, as `scf_umami_maint` (DELETE, C-12), and by job
  `web_rollup`, as `scf_umami_ro` (SELECT on the `scf_ro` views only, read-only transactions, C-109).

### 5.5 Runtime

Verified in S-02 (C-104, 36/36 checks): read-only root filesystem with tmpfs `/tmp` (`size=16m`) and
`/app/.next/cache` (`size=64m`, uid 1001), `cap_drop: [ALL]`, `no-new-privileges`, uid 1001 with root-owned,
read-only app files, no package manager or `curl` in the image, one `internal: true` network (Umami, PostgreSQL and
the engine proxy's inner side) and no egress — zero outbound packets observed; an attempt shows up as a DNS question to
Docker's embedded resolver, not as a dropped packet (§2.2). Migrations run from the `umami-migrate` image as a one-shot
deploy step that `umami` waits for (`service_completed_successfully`), never at container start
(`SKIP_DB_MIGRATION=1` kept as a guard, C-40). Its schema engine is downloaded during the image build (see
`supply-chain.md`).

## 6. Container settings (all services)

| Setting | Value | Exceptions |
|---|---|---|
| User | non-root numeric UID/GID | PostgreSQL image starts as root and drops privileges (or runs as `postgres` with pre-owned volumes) |
| Root filesystem | `read_only: true`, tmpfs for `/tmp` | Umami also tmpfs `/app/.next/cache` (C-104); databases write only to their volumes |
| Init process | `init: true` for PostgreSQL containers — pgBackRest's asynchronous archiver crashed the postmaster without an init process as PID 1 (S-08, C-108) | — |
| Capabilities | `cap_drop: [ALL]` | PostgreSQL: minimal set (`CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`, `FOWNER`) only if needed; the gateway binds 443 via `CAP_NET_BIND_SERVICE` only, or a port redirect; the gateway needs `IPC_LOCK` (or a raised memlock limit) to lock `K_day` in memory (C-04) |
| Privilege escalation | `security_opt: ["no-new-privileges:true"]` | none |
| Seccomp / AppArmor | Docker defaults; never `unconfined` | none |
| Resources | `pids_limit`, memory and CPU limits per service | — |
| Images | referenced by digest; cosign- and provenance-verified before start (ADR-0019) | none |
| Mounts | no Docker socket; secrets as read-only files from tmpfs; no host paths beyond declared volumes | — |
| Networks | only the zone networks the service needs (§3) | — |
| Health checks | each service; failing health removes it from routing | — |

## 7. Database roles and network policy

**Roles in `scf` (ADR-0013, C-17):** `scf_migrator` (owner, DDL only, used by the migration job), `scf_app` (control
plane), `scf_writer` (metrics-writer; inserts under a tenant context, no bypass), `scf_jobs` (explicit cross-tenant
policies for named jobs), `scf_metrics_ro` (SCF-operator metrics API). Cross-tenant reads are **not** views: they are
allow-listed `SECURITY DEFINER` functions `op_*` with a fixed `search_path`, owned by a dedicated non-login role, that
apply the minimum-count threshold and rounding and insert the audit row in the same transaction. `scf_app` and
`scf_metrics_ro` have EXECUTE on those functions and **no** cross-tenant SELECT on base tables. Tenant-facing views
stay `security_invoker`. **No runtime role has `BYPASSRLS`.**

**Roles in `umami` (C-12):** `umami_app` (the engine's own role, owner of its schema; Umami does not run migrations at
start, C-40) and `scf_umami_maint` (DELETE on the event, session and their data tables only; used by the retention and
erasure jobs) and `scf_umami_ro` (SELECT on the two `scf_ro` views only, `default_transaction_read_only`, 300 s
statement timeout; job `web_rollup`, C-109 — replacing C-93's "only if S-01 fails"). No other role of ours connects to
`umami`. A break-glass maintenance role for backups and replication
is non-login by default **(proposed)**. **Who creates `umami_app` and the `umami` database (C-113):** in the Compose
stack the PostgreSQL container's initdb script creates the role (password from the stack's secrets) and the database
owned by it, before `umami-migrate` runs; in production the Ansible PostgreSQL role does the same, idempotently, with
the password from SOPS — neither Umami nor `umami-migrate` ever creates roles or databases.

**Settings and grants:**

- `password_encryption = scram-sha-256`; every role has its own password from SOPS.
- `REVOKE ALL ON DATABASE scf, umami FROM PUBLIC`; `scf` roles cannot connect to `umami` and vice versa (except
  `scf_umami_maint` and `scf_umami_ro`); `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; default privileges revoke `EXECUTE` on functions
  from `PUBLIC`, and `EXECUTE` on `op_*` is granted explicitly (C-17).
- No grants on partitions; no `TRUNCATE`, `REFERENCES` or `TRIGGER` to runtime roles (ADR-0013, research T9/T19).
- Per-role `statement_timeout` and `idle_in_transaction_session_timeout` **(proposed)**; decided so far: 30 s for
  `scf_metrics_ro` and 300 s for `scf_umami_ro` (C-103, C-109).
- Tenant context only through `scf.set_tenant_ctx()`, which always uses `set_config(…, true)` per transaction; a lint
  test rejects `set_config(`, `SET app.` and `RESET app.` in application code, and the nightly `pg_stat_statements`
  check flags them (C-103: S-03 saw a session-level `SET` leak to a **different client** through PgBouncer). Every
  tenant table also has a restrictive `FOR DELETE` policy requiring the row's tenant context (fix F1, C-103), and only
  the `SECURITY DEFINER` trigger owned by `scf_audit_definer` can write audit-chain heads (C-103). PgBouncer in
  transaction mode (ADR-0013); PgBouncer ≥ 1.26.1 (research lists CVEs fixed up to that version; S-03 ran 1.26.1). Each core reaches the current primary
  through a local proxy that follows Patroni (C-07); scheduled jobs take an advisory lock (C-07).
- Logging: `log_statement = none`; `log_parameter_max_length = 0` and `log_parameter_max_length_on_error = 0` so no
  parameter value is logged; `pg_stat_statements` keeps normalised statements only (ADR-0010).

**`pg_hba.conf` (shape):** `hostssl`/`host` lines only for the mesh addresses of the two core nodes, per database and
role; replication only between core nodes; `reject` for everything else; no `trust` lines; local socket access only
for the `postgres` superuser via peer authentication.

**Database gate tests and production re-check:** RLS + FORCE on every table and partition, both restrictive backstop policies on
every tenant table, no partition grants and no grants in schema `public`, every view in every schema a runtime role
can use `security_invoker`, `SECURITY DEFINER` functions compared against the explicit allow-list
`db/definer-allowlist.txt` (`op_*`, the §12 functions of the data model, the partition functions and
`audit_chain_append`; ADR-0013, C-17, C-103), no
cross-tenant SELECT for `scf_app`/`scf_metrics_ro`, plus the production query in the monitoring plan
(`RLSCoverageDrift`).

## 8. Secrets handling (ADR-0019)

- **SOPS + age**, encrypted files in the repository; one age recipient per maintainer and per host; a host can decrypt
  only its own secrets.
- Decrypted at deploy into tmpfs (`/run/secrets/<service>/…`, mode 0400, owned by the service UID); mounted read-only.
  Environment variables only where the software requires them (e.g. Umami `APP_SECRET`, `DATABASE_URL`), injected
  from those files at start; never baked into images, Compose files or logs.
- **Memory-only keys:** the edge key bundle — `K_day`, the multiplicity key and `K_chal` (ADR-0007, ADR-0008, C-04,
  C-68), in locked memory — and the engine proxy's cache tokens (C-74) are never written to disk; see §4 for core
  dumps and swap.
- **Where keys live (C-05, C-81):** three peppers — `ing` (edge and core), `op` and `pub` (core only); every stored key
  hash records its pepper version. The snapshot-signing key is separate from all three.
- **No production secret in build automation (C-79):** GitHub holds no production secret; every secret in this
  section lives in SOPS and is decrypted on the service operator's deploy path.
- **Secret classes and rotation:**

| Secret | Rotation |
|---|---|
| `K_day` and the multiplicity key | daily; next day's keys generated at 23:50 UTC, switch at 00:00 UTC (ADR-0007, C-04, C-68) |
| Challenge-token key `K_chal` | hourly, previous epoch still accepted (C-68) |
| Peppers `ing` (edge and core), `op` and `pub` (core only) | separate per kind (C-05, C-81); stored hashes record the pepper version, so a new version runs alongside the old one while keys are re-issued; on suspicion; **not rotated at handover cut-over** — handed over securely and rotated afterwards with overlap (C-50, C-81) |
| Snapshot-signing key | yearly and on suspicion; edges pin the public key; **not rotated at handover cut-over** (C-50) |
| Node mTLS certificates and the private CA | per IaC (lifetimes set at implementation); a node's certificate is revoked on suspicion of that node (C-60) |
| Key encrypting per-tenant Umami passwords and API keys | on suspicion; held outside the database; handover item (C-40, C-85) |
| Umami `APP_SECRET`, provisioning identity, per-tenant Umami keys | on suspicion; `APP_SECRET` is identical on every Umami instance and its rotation is a planned event: every session id and cache token changes, so visits and sessions split at the rotation (C-112); per-tenant keys rotated by the provisioning worker (C-85) |
| Traction-snapshot signing key (Ed25519, public key under `/.well-known/`) | on suspicion (C-47) |
| Audit-anchor Stellar account key | handover item (C-63) |
| Database role passwords | yearly and on maintainer change |
| pgBackRest repository cipher passes | never casually (old backups need them); on compromise, new repositories |
| pgBackRest storage credentials of the database nodes | yearly and on maintainer change; may delete current blobs but **not** blob versions (no `x`/`y` SAS permissions or `deleteBlobVersion`/`permanentDelete` data actions); the drill host gets a short-lived read-and-list SAS only (C-108) |
| SEP-10 `SIGNING_KEY` | on the handover rotation list with its `stellar.toml` (C-15); on suspicion |
| GitHub OAuth client secret | yearly and at handover |
| Edge DNS credential (`_acme-challenge` zone only) | yearly, on maintainer change, at handover (C-61) |
| DNS, registrar, hoster API tokens (held by the service operator, never in build automation, C-79) | yearly, on maintainer change, at handover |
| OpenTofu state passphrase and state-bucket credentials (not stored on any server — C-79) | at handover |

- **At handover** secrets are rotated or replaced as listed above, not just re-encrypted, **except** the three peppers
  and the snapshot-signing key, which are handed over securely and rotated afterwards (rotating them at cut-over would
  invalidate every token; C-50, C-81). `supply-chain.md` §10 describes the order.

## 9. TLS and certificates

- **Edge:** the gateway terminates TLS itself, ACME DNS-01 through an embedded library, using a DNS credential that
  can only write a delegated `_acme-challenge` zone (C-61); **one certificate per node that includes the node's own
  hostname** (avoids the ACME duplicate-certificate limit; ADR-0005). Renewal via ARI where supported; drills against
  the ACME staging CA.
- **Core:** Caddy with automatic ACME (ADR-0018).
- **Protocols:** TLS 1.3 preferred, TLS 1.2 allowed with ECDHE + AEAD suites only (OTLP SDKs and older browsers);
  no TLS 1.0/1.1; no compression; session tickets with rotated keys **(proposed values)**.
- **CAA** limiting issuance to our CA with `accounturi`; **certificate-transparency monitoring**; registry lock
  (ADR-0023). **DNSSEC is not enabled on the ingest zones at launch**: multi-signer DNSSEC across two DNS providers is
  an availability risk not taken for a 99.99 % target; revisited after six months of operation (C-31).
- **Internal:** WireGuard encrypts all node-to-node traffic, and every hop between nodes additionally uses per-node
  mutual TLS from the private CA (C-60). etcd peer and client TLS for Patroni (built in the HA overlay; HD-05).
- **HSTS:** `max-age=63072000; includeSubDomains` on the portal and ingest hosts. **No `preload` (proposed):** the
  domains are transferred to the successor service operator at handover (C-50), and preload would bind them and is
  hard to undo.

## 10. Security headers and CSP for the portal (ADR-0024)

The portal is a static Vite + React SPA with no third-party scripts that talks only to the control-plane API
(ADR-0024). It dog-foods the tracker as the **npm-bundled** build, so `script-src` stays `'self'`.

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self' https://<ingest host on domain-a> https://<ingest host on domain-b>;
  manifest-src 'self';
  worker-src 'none';
  frame-src 'none';
  frame-ancestors 'none';
  form-action 'self';
  base-uri 'none';
  object-src 'none';
  require-trusted-types-for 'script';
  trusted-types 'none';
  upgrade-insecure-requests
```

As built (C-117): **no `report-to`** — the portal runs no report collector, and a reporting endpoint would be a
place that receives page URLs; `trusted-types 'none'` because the SPA creates no Trusted Types policy (React renders
no raw HTML); `upgrade-insecure-requests` and HSTS only with `SCF_PORTAL_SCHEME=https` (the local stack on
`http://localhost` omits both). The header files `apps/portal/server/headers-*.caddy` are generated from
`apps/portal/server/headers.ts` and the image build fails when they are stale.

- Wallet sign-in (SEP-53/SEP-10, ADR-0014) may need additions (e.g. a WalletConnect relay or wallet-module assets);
  each addition is reviewed and documented, and Horizon/RPC lookups are done server-side so they need none.
- If any library needs a Trusted Types policy, it is named, reviewed and tested; the portal's e2e tests load every route under the
  production CSP and fail on violations.

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` (portal) |
| `Permissions-Policy` | all powerful features disabled (camera, microphone, geolocation, payment, USB, serial, HID, MIDI, …); **allowed for the portal's own origin only:** `publickey-credentials-get=(self)`, `publickey-credentials-create=(self)` (passkeys) and `clipboard-write=(self)` (copy snippet/key) (C-117). `bluetooth` is not listed (not a recognised feature in current browsers). |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` (portal assets) |
| `Cache-Control` | `no-store` on API responses; immutable hashed assets for the SPA |
| `Integrity-Policy` | `blocked-destinations=(script)` once browser support is confirmed **(proposed)** |
| CORS | **none** on the portal API. Exceptions required by Stellar specs: `stellar.toml` and SEP-10 endpoints send `Access-Control-Allow-Origin: *` (SEP-1/SEP-10). `health_endpoint` is public; a tenant's `metrics_endpoint` is readable with an `op` key, a `pub` share key, or publicly if the tenant switches public stats on (C-14); CORS for these per `docs/api/`. |

## 11. HTTP server limits and timeouts (gateway and Caddy) — timeouts proposed (HD-06)

| Limit | Proposed value | Threat |
|---|---|---|
| Header read timeout | 5 s | slow-loris (TM-OTL-08) |
| Body read timeout | 10 s | slow-read |
| Write timeout | 10 s | — |
| Idle keep-alive timeout | 60 s | connection exhaustion |
| Max header bytes | 8 KiB | — |
| HTTP/2 max concurrent streams per connection | 100 | stream exhaustion |
| Web event body | 8 KiB, ≤ 10 events (`docs/contracts/wire-formats.md`) | TM-OTL-07 |
| OTLP body / gRPC message | 4 MiB compressed / 16 MiB decompressed (`docs/contracts/wire-formats.md`) | TM-OTL-07 |
| Connections per source address | cap with RST on excess | TM-DOS-02 |
| Overload response | `503` + `Retry-After` (never 400/500), so SDKs retry (ADR-0009, C-39) | TM-DOS-* |

## 12. Rate limits

| Surface | Limit | Source |
|---|---|---|
| Web events per site | The signed snapshot carries each site's per-minute rate limit and daily quota; each edge node enforces its share (limit ÷ number of live edge nodes) locally; the control plane adds up the counter records and marks a site `over_quota` in the next snapshot, so enforcement is exact within about a minute. Quotas count **verified** events only, and `429`s caused by a site's quota are reported per site (C-80, C-90). L0 tenants: 50,000 web events/day (C-19) | C-19, C-80, C-90 |
| Events per challenge token | proof reused only up to a per-token event cap (C-35) **(proposed value: 300 events / 30 min)**; retries dropped by per-event ID within 10 minutes (C-37) | C-35, C-37 + research |
| Challenge issuance | per truncated subnet per site **(proposed)**; adaptive PoW difficulty (ADR-0008) | — |
| OTLP | per-tenant rate limit, `429`/`503` + `Retry-After` (ADR-0009) | register |
| `op` keys | default **600 requests/minute** per key (C-21) | C-21 |
| Sign-in (OAuth callback, SEP-53/SEP-10 verification, passkey) | per /24 (IPv4), /48 (IPv6) and per account **(proposed)** | — |
| Sign-up and site/service creation | per identity and per source subnet (C-64) **(proposed values: per /24, /48, per GitHub account; global alert)** | C-64 |
| SEP-10 challenge issuance | per /24, /48 **(proposed)** | — |
| Domain verification | per tenant per hour **(proposed)** | — |

All published thresholds are documented with the anti-inflation thresholds (ADR-0008). Rate-limiting keys use
truncated addresses in memory only; nothing is logged with an address.

## 13. Session and cookie settings (ADR-0014, C-09, C-20)

- Server-side sessions in PostgreSQL; the session token is 256-bit random and stored only as a hash **(proposed)**.
- Session cookie: `__Host-` prefix, `Secure`, `HttpOnly`, **`SameSite=Lax`**, `Path=/`, no `Domain` (C-20). Lax is
  required so the session survives the GitHub OAuth return (a cross-site top-level navigation).
- **OAuth state** lives in a separate cookie with a 10-minute lifetime (C-20).
- **CSRF:** every state-changing request also needs a matching `Origin` and a custom header (C-20); no GET changes
  state.
- **Timeouts (C-20):** tenants idle 12 h / absolute 14 days; SCF operators idle 30 min / absolute 12 h.
- **SCF operators** must hold a passkey and assert it at every sign-in; they register at least two passkeys; recovery
  is by another `operator_admin` (audited) or the documented break-glass procedure on a core node (C-09, C-20).
- **Step-up (C-09):** a fresh passkey assertion (≤ 10 minutes old) is required for removing or restoring a tenant,
  changing enrollment mode, creating or revoking `op` keys, and managing SCF operators.
- **Sensitive tenant actions (C-87):** confirming an erasure, transferring ownership, removing the tenant and deleting
  an account need a fresh sign-in, at most 10 minutes old, by the member's own method — a passkey assertion if one is
  registered.
- **Tenant scoping of identifiers (C-87):** every identifier a request carries, in the path or the body, is resolved
  under the caller's tenant context; tenant-owned tables reference each other with composite keys that include
  `tenant_id`; jobs that act for a tenant (erasure, purge) run under that tenant's context.
- Session rotated at sign-in and step-up **(proposed)**.
- **GitHub sign-in** uses an OAuth App with the `read:user` scope only; GitHub organisation membership is not used for
  authorisation (C-20).
- Sign-out invalidates the server-side session; removing an SCF operator invalidates all their sessions immediately.

## 14. Logging rules (ADR-0022)

- **Never logged:** IP addresses (full or truncated), User-Agents, request headers (including `Authorization`,
  cookies, APM-vendor headers), bodies, query strings (which are discarded at the gateway anyway, C-65), tokens and
  keys, session identifiers, `K_day` (only its SHA-256 fingerprint is exported, for divergence detection, C-04),
  challenge keys, surrogates, Umami cache tokens, Stellar addresses, XDR, signatures, page paths, referrers,
  custom-event names and properties, OTLP attribute values, SQL parameter values, literal erasure selectors (C-88).
  Page titles are not collected at all (C-89).
- **Gateway:** no access log. Structured operational events only (route class, status, latency, reason code, site or
  tenant ID, node).
- **Engine proxy:** caller node, path class, decision; no bodies, parameters, surrogates or cache tokens.
- **Caddy:** access log disabled, or the log filter deletes remote and client IP, headers and query string.
- **Umami:** `LOG_QUERY` off **(proposed)**; container output to journald.
- **PostgreSQL:** see §7.
- **Transport:** journald → VictoriaLogs on `mon-c` over the mesh; VictoriaLogs bound to the WireGuard address.
- **Enforcement:** the e2e suite greps its log output for IP, UA, bearer and `scfa_` patterns and fails on a match; the same
  scan runs daily on production logs (monitoring plan `LogPIIDetected`).

## 15. How the baseline is verified

| Item | Check |
|---|---|
| Listeners and egress (§2–3) | Daily external (`probe-d`) and internal (`mon-c`) port scans vs §2.1; egress drop counters per component (`EgressDenied`); network-policy test matrix against the Compose stack |
| Node identity (§3) | Test matrix: each hop refuses a missing, foreign or revoked node certificate; the engine proxy refuses every path not on the caller's allow-list (C-60, C-74) |
| Build and deploy secrets (§4, §8) | Listing of repository and environment secrets shows no production credential (C-79); deploy logs record where each deploy ran |
| Host baseline (§4) | Ansible in check mode weekly (drift = alert); CIS-subset assertions in the role, including core-dump, swap and memlock settings on edge nodes (C-66) |
| Umami (§5) | Contract tests against our built image; engine-proxy route test per caller; environment assertion at start (incl. `SKIP_DB_MIGRATION=1`) |
| Containers (§6) | Lint of Compose files (user, read-only, `cap_drop`, `no-new-privileges`, digest pins); deploy-time `cosign verify` |
| Database (§7) | Database gate tests (ADR-0013, C-17); production `RLSCoverageDrift` query; `pg_hba` rendered from inventory and diffed |
| Secrets (§8) | Secret scanning with push protection on the repository; no plaintext secrets in images (SBOM and filesystem scan); rotation drill records |
| Backups (§8) | Blob versioning and the previous-version lifecycle rule are on, and a database node's credential cannot delete a blob version (C-108; real Azure only — Azurite emulates neither, risk R-23); weekly restore drill on our EU infrastructure (C-56) is the integrity check, because `pgbackrest verify` exits 0 even with missing files (S-08) |
| DNS (§9) | The edge credential is refused on service records (C-61); record drift vs git and the health controller's set (C-27) |
| TLS (§9) | Weekly TLS scan of every public name and node address; CAA and HSTS checks; certificate-expiry alerts (incl. node mTLS certificates) |
| Headers and CSP (§10) | e2e under production CSP; header assertions per route |
| Limits and rate limits (§11–12) | Load and chaos suites (ADR-0026) |
| Sessions (§13) | Auth e2e (cookie attributes, timeouts, step-up, CSRF with and without the custom header) |
| Logging (§14) | e2e log grep; daily production scan |

### 15.1 Checks that exist today (2026-11-13)

| Item | Built check | How to run |
|---|---|---|
| Node identity, engine-proxy allow-lists (§3, §5.3) | `services/engine-proxy/internal/policy/policy_test.go`, `internal/proxy/tls_test.go`; `services/engine-proxy/integration/run.sh` against real Umami | `make test-go`; integration `make test-engine` |
| Umami image (§5) | `vendor/umami/test/hardening-check.sh` (read-only root, seed admin removed, flags) | `make test-engine` |
| Database roles and RLS gates (§7) | `db/tests/gates_test.go`, `hardening_test.go`, `matrix_test.go` | `make test-db` |
| Host baseline, egress default-deny (§4, §2.2) | Ansible roles `common` (SSH keys only, unattended upgrades, nftables egress), `egress_proxy`; applied in `infra/ansible/tests/run.sh` and `infra/ansible/tests/lean/run.sh` | `make ansible-test` |
| etcd and Patroni TLS (§9, scale-out/HA) | `infra/compose/compose.ha.yaml`, Ansible role `postgres`; `infra/compose/ha/tests/run.sh` | `make ha-test` |
| Images (§6, §8) | Deploy-time `cosign verify` in the playbook (`infra/ansible/roles/compose_stack/tasks/verify.yml`), effective once signed release images exist | deploy playbook |
| Portal headers and CSP (§10) | `apps/portal/test/unit/headers.test.ts`; mock e2e under the production CSP `apps/portal/e2e/mock/*.spec.ts` | `make test-portal` |
| Limits and rate limits (§11–12) | `services/gateway/internal/limits/limits_test.go`; shared control-plane rate limits `services/control-plane/test/integration/security-split.test.ts`; load and chaos `tests/load/*`, `tests/chaos/*` | `make test`; load and chaos `make load`, `make chaos` |
| Sessions (§13) | `services/control-plane/test/integration/auth.test.ts`, `passkeys.test.ts`; `apps/portal/e2e/mock/auth.spec.ts` | `make test-ts`; `make test-portal` |
| Logging (§14) | `ops/internal/logscan/logscan_test.go` (scanner), alert `LogPIIDetected` (`ops/alerts/tests/security-platform.test.yaml`) | `make test-go`; alert tests `ops/alerts/test.sh` |

| Listener scans, weekly TLS scan, Ansible drift check, Azure backup protection | not built (scale-out `probe-d`/`mon-c` scans; Azure-only checks wait for the first deployment, risk R-23) | — |

## 16. Open points

Resolved since the first draft: HD-02 by C-66 (core dumps off, no unencrypted swap on edge nodes — the half of C-66 that C-108 left standing); HD-03 by C-60 and
C-74 (engine proxy with per-caller path allow-lists, including the adapter contract); HD-04 by C-61; the inner-hop part
of HD-05 by C-60; HD-08 by C-09/C-20 (session timeouts, operator step-up) and C-87 (tenant step-up by the member's own
sign-in method, so passkeys for tenant owners/admins are not required); HD-10 by C-05/C-81 (per-kind, versioned
peppers) and C-40/C-85 (encrypted per-tenant Umami credentials); HD-11 by the revised C-10 (named egress destinations,
§2.2). The numeric body limits of HD-06 are fixed in `docs/contracts/wire-formats.md` (web 8 KiB; OTLP 4 MiB
compressed / 16 MiB decompressed).

| ID | Open point | What would close it |
|---|---|---|
| HD-01 | Open: SSH only on the WireGuard address, provider console as break-glass. | A register decision. |
| HD-05 | Built, awaiting a register entry: etcd peer and client TLS with client-certificate authentication and the Patroni REST API over TLS (`infra/compose/compose.ha.yaml`, Ansible role `postgres`, tested by `infra/compose/ha/tests/run.sh`); scale-out/HA path only, not deployed in the lean profile. | A register entry confirming it. |
| HD-06 | Open: the HTTP server timeouts and connection limits in §11 (body sizes are already fixed in `docs/contracts/wire-formats.md`). | A register decision on §11, informed by the 10× load test (ADR-0026). |
| HD-07 | Open: the proposed values in §12 (per-token event cap, challenge issuance, sign-in, sign-up/site-creation, SEP-10, domain verification). C-35 and C-64 decide that the limits exist; C-21 fixes the `op`-key default; C-106 keeps the PoW default 512 × 1024, measured in emulation only (risk R-24). | Real-device PoW timing and a register decision on the remaining values. |
| HD-09 | Open: the Umami settings in §5.2 still marked proposed (`LOG_QUERY` off, `DISABLE_UI`/`DISABLE_LOGIN`). Deleting the seed admin, the unset flags and `TRUSTED_PROXIES` are decided by C-99/C-104. | A register decision. |
| P7 | Open (same ID as `sla.md` §17 and `monitoring-plan.md` §9): the lean profile has no 2-of-3 probe quorum and no external listener scan. On the v1 small deployment the only outside views are the operator workstation's probe (`ws-1`) and the smoke test run from the workstation; the GitHub-hosted checks of the design do not run. | A second outside probe source (small VM in another region or a third-party monitor); a service-operator decision. |
