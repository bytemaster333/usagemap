# Deploying a single-VM host (v1 profile)

**Status:** the procedure that built the public `usagemap.dev` service (`https://usagemap.dev`, `app.`, `e1.`/`e2.`,
`status.`), repeated in a rebuild drill on a fresh VM. Anyone with the repository, the cloud login for the resource
group, the DNS token and the SSH key can redo it; replace the `usagemap.dev` host names with your own.

What it is: the lean profile (all services, Docker Compose, Ansible role `compose_stack`) on **one** 2 vCPU / 8 GiB VM
with one disk for the system and all data, two front addresses, public DNS at Cloudflare (DNS only), ACME DNS-01 at Cloudflare, backups to
a local pgBackRest repository plus one storage account. It is the smallest complete deployment; the multi-node design (`deploy-azure.md`,
`../deployment-topology.md`) is the high-availability production design.
**One VM means no failover:** never quote 99.99 % for it ([`../sla.md`](../sla.md) §1.1).

Everything deployment-specific or secret lives **outside the repository** in `$DEPLOY_DIR` (a directory of
your choice, mode 0700; set it explicitly):

```
$DEPLOY_DIR/
    dns-token                     DNS token: "Edit zone DNS" on the one zone (0600)
  tofu/                         passphrase, v1.tfvars, encrypted state and plans
  secrets/                      dump-age-identity.txt, stack-secrets.yml, extra.yml, deploy-secrets.yml, owner-phrase (0600)
  ansible/                      inventory.yml, v1.yml, state/ (known_hosts, pki/ = the private CA)
  release/<rev>/                images.yml, tracker-<version>/ (scripts/build-release.sh)
  release/landing-<rev>/        the built landing site
  onboard/                      onboard.json (ids, public site keys), ingest-token (0600), journey-seed (0600)
```

Back up `secrets/`, `ansible/state/pki/` and `tofu/` (encrypted copies, offline): without the age identity no weekly
dump decrypts, without the CA no node certificate can be renewed, without the state passphrase the state is unreadable.

## 1. Workstation

| Tool | Version | Notes |
|---|---|---|
| Linux, Docker Engine with buildx | 29.x | builds every image locally; nothing is pushed anywhere |
| toolchain | `mise install && eval "$(mise env -s bash)" && pnpm install --frozen-lockfile` | Node, pnpm, Go from `mise.toml` |
| OpenTofu | 1.13.9 | `infra/opentofu/scripts/check.sh` downloads it to `~/.cache/scf-tools/tofu-1.13.9/tofu` |
| cloud CLI (`az`) | any current | logged in as an identity with Contributor on the resource group; `export AZURE_CONFIG_DIR=…` if you keep the login apart |
| Ansible | tool image `usagemap/ansible-tools:2.22.0` | `scripts/play-v1.sh` builds it from `infra/ansible/tools/Dockerfile` |
| age | v1.3.2 | `GOBIN=~/.cache/scf-tools/age-1.3.2 go install filippo.io/age/cmd/age-keygen@v1.3.2 filippo.io/age/cmd/age@v1.3.2`, then put that directory on `PATH` |

```sh
export DEPLOY_DIR=~/usagemap-deploy  TOFU=~/.cache/scf-tools/tofu-1.13.9/tofu
mkdir -p $DEPLOY_DIR/{tofu,secrets,ansible/state,release,onboard} && chmod -R go-rwx $DEPLOY_DIR
```

## 2. Infrastructure (OpenTofu, `infra/opentofu/envs/v1-small`)

```sh
cd infra/opentofu/envs/v1-small
head -c 32 /dev/urandom | base64 > $DEPLOY_DIR/tofu/passphrase          # once
cp v1.tfvars.example $DEPLOY_DIR/tofu/v1.tfvars                          # fill in: subscription, resource group,
#   SSH public key(s), your current address as /32 (curl -s https://api.ipify.org), a free storage account name
#   (az storage account check-name -n <name>), the Debian 13 image version that exists IN THE REGION:
#   az vm image show -l <region> --urn Debian:debian-13:13-gen2:<version>   (the newest listed may not be there yet)
export TF_VAR_state_passphrase=$(cat $DEPLOY_DIR/tofu/passphrase) CLOUDFLARE_API_TOKEN=$(cat $DEPLOY_DIR/dns-token)
$TOFU init -backend-config=path=$DEPLOY_DIR/tofu/v1-small.tfstate
$TOFU plan -var-file=$DEPLOY_DIR/tofu/v1.tfvars -out=$DEPLOY_DIR/tofu/v1.tfplan    # 24 resources on a first run
$TOFU apply $DEPLOY_DIR/tofu/v1.tfplan
$TOFU output -json app            # ingest/portal public + private IPs → inventory and v1.yml
```

Price the plan before applying (public retail price list). The records are DNS-only (never
proxied: TLS ends on the VM and the gateway must see client addresses). The backup account has `prevent_destroy`.

Add an SSH alias (`Host <vm-host>`, `HostName <ingest public IP>`, `User <admin user>`, `IdentityFile <key>`).

## 3. Secrets

```sh
ACCOUNT=<backup storage account> RG=<resource group> CF_TOKEN_FILE=$DEPLOY_DIR/dns-token \
SAS_EXPIRY=<one year ahead, e.g. 2027-11-18T00:00Z> infra/ansible/scripts/v1-secrets.sh
```

It creates the dump age identity, every stack secret (`gen-stack-secrets.sh`, refuses to overwrite), a container SAS
for the database (`racwdl`: no version delete, no permanent delete — a compromised VM can only turn blobs into
previous versions, which stay 14 days) and a read/list SAS for the restore drill, and merges them with the DNS token
into `secrets/deploy-secrets.yml`. **Renew the SAS before `SAS_EXPIRY`** (`… v1-secrets.sh --renew-sas`, then §6):
an expired SAS stops WAL archiving and backups (alerts `WALArchiveFailing`, `BackupCheckFailing`, `BackupFullStale`). Never re-run
`gen-stack-secrets.sh` against a live database.

## 4. Release: images and tracker (no registry)

```sh
REV=$(git rev-parse --short=7 HEAD)        # a commit on main; only committed files are built
infra/ansible/scripts/build-release.sh $REV $DEPLOY_DIR/release/$REV https://e1.usagemap.dev,https://e2.usagemap.dev
```

`git archive` of that commit (a commit whose gateway Dockerfile has `ARG TRACKER_HOSTS`; `GATEWAY_DOCKERFILE=<file>`
builds an older commit with a newer gateway Dockerfile and records it), the same Dockerfiles Compose uses, the gateway's tracker built for **these** ingest names
(a tracker built for other names cannot be served here), tags `usagemap/<name>:$REV`; writes `images.yml` (tags +
configuration digests the role checks on the VM) and `tracker-<version>/` (the release directory the role verifies
against the gateway image). A tracker built for this deployment's names serves only the **current** version: list
exactly the versions present in `release/$REV/tracker-*` under `scf_tracker_versions` (§5).

## 5. Ansible settings

```sh
cp infra/ansible/inventory/v1.example.yml $DEPLOY_DIR/ansible/inventory.yml   # ansible_host = ingest public IP
cp infra/ansible/group_vars/v1.yml.example $DEPLOY_DIR/ansible/v1.yml         # set scf_release_ref: $REV, the names,
#   the two PRIVATE bind addresses (tofu output app), scf_vnet_cidrs, scf_ssh_admin_cidrs, the backup account,
#   scf_tracker_versions; leave scf_probe_* empty for now
```

Decisions encoded in `v1.yml.example`, each an explicit, documented role option:

| Setting | Why |
|---|---|
| `scf_images_require_digest/pull/verify_signatures: false` + `scf_image_ids` | no registry and no signed release yet; the role refuses any image whose configuration digest differs from the build |
| `scf_acme_dns_provider: cloudflare`, `scf_acme_env: {LEGO_DNS_PROPAGATION_WAIT: 60s}` | DNS-01 at Cloudflare; the host firewall admits DNS only to the platform resolver, which caches the negative answer for the challenge name, so lego waits a fixed 60 s instead of polling |
| `scf_backup_repos`: repo 1 `posix` (VM disk), repo 2 `azure` + `key_type: sas`; `scf_backup_public_endpoint: true` | no role assignments possible (Contributor only) and no private endpoint: SAS as above; the account admits only the VM subnet (service endpoint) and the operator |
| `scf_alert_email_worker_url` + `alert_email_worker_token` (SOPS); `scf_alert_local_only: false` | alerts go by **e-mail to the operator** through the alert mailer Worker on Cloudflare (`send_email` binding to a verified Email Routing address; no SMTP relay): one e-mail per notification, set up by `ops/scripts/cloudflare-email-setup.sh` ([runbook](../../ops/runbooks/alert-email.md)). Fallback while the Worker is not deployed: `scf_alert_local_only: true` + reason (notifications recorded in VictoriaLogs on the VM only, nobody notified) |
| `scf_http_redirect: true` | port 80 on the portal address answers only with `308` to https |
| `scf_landing_hostname/src` | the apex serves the static landing site |
| `scf_jobs_extra_env.SCF_ONCHAIN_LOOKBACK_DAYS: "2"`, `SCF_USAGE_MAP_LOOKBACK_DAYS: "2"` | on-chain correlation and the Ecosystem Usage Map (job `usage_map`) download the public pubnet ledger files they need (≈ 3 GB per day; the mirror keeps 7 days ≈ 20 GB of the disk) — the smallest windows; check `df -h /` after the first runs (06:00 / 07:30 UTC) and set `SCF_ONCHAIN_LEDGER_SOURCE_URL: none` to stop the download (the usage map then gets no new days) |
| `scf_postgres_shared_buffers: 1GB` etc. | sized for 8 GiB |
| `scf_gatus_enabled` | Gatus on the host |
| `scf_jobs_extra_env.SCF_REGISTRY_SOURCES: stellarlight,pg_atlas` | `registry_sync` fills the SCF project picker of `/onboard` from the public registries |
| `scf_seal_enabled: true`, `scf_seal_network: testnet` + `seal_secret_seed` (SOPS) | daily seal on **testnet only** (C-135; the role refuses mainnet without `scf_seal_mainnet_approved`); the job funds its account from the testnet Friendbot |
| `scf_probe_otlp`, `scf_probe_tracker_check`, `scf_probe_fresh_within: 15m`, `scf_probe_nodes: {}` + `probe_otlp_token` (SOPS, token limited to service `scf-probe`, from `live-onboard.ts`) | the status page proves a real web event, an OTLP export, the served tracker files = published SRI, and fresh dashboard data; no per-node probe on a single ACME-certified node |
| `scf_status_min_voters: 1`, `scf_status_objectives`, `scf_status_placement` | the status page names the one probe source, the v1 objective (99.5 %) and that it runs on the same VM; "not measured" below 95 % coverage; next to the objective, the role default `scf_status_service_window` adds that the 99.99 % ingestion and 99.90 % dashboard availability targets apply to the scale-out profile (C-180) |

## 6. Deploy

```sh
export SSH_KEY=<private key> RELEASE_DIR=$DEPLOY_DIR/release/$REV LANDING_DIR=<landing dir; a one-page placeholder the first time>
infra/ansible/scripts/play-v1.sh -e '{"scf_stack_up": false}'     # baseline, firewall, Docker, PKI, secrets, ACME, config
infra/ansible/scripts/ship-images.sh <vm-host> $RELEASE_DIR/images.yml   # docker save | ssh docker load, IDs compared
infra/ansible/scripts/play-v1.sh                                  # the stack: up --wait, timers, Gatus
```

The first full run takes 25–35 minutes from a workstation far from the region (every task is an SSH round trip). If
the first `up --wait` fails on an empty host with `container scf-postgres-1 is unhealthy`, run the playbook again:
the database's first start can outlast the health window on 2 vCPUs.

## 7. Onboard the operator's own project, then finish the configuration

The canary site of the probes, the landing page's own site and the OTLP smoke token are created through the public
API like any tenant's (no database shortcuts; `tools/demo-seed` refuses deployed stacks on purpose):

```sh
head -c 48 /dev/urandom | base64 > $DEPLOY_DIR/secrets/owner-phrase          # once: the owner's sign-in key derives from it
grep -E '^  journey_seed:' $DEPLOY_DIR/secrets/stack-secrets.yml | sed -E 's/^  journey_seed: *"?([A-Z0-9]+)"?.*/\1/' > $DEPLOY_DIR/onboard/journey-seed
node infra/compose/scripts/live-onboard.ts --portal https://app.usagemap.dev --phrase-file $DEPLOY_DIR/secrets/owner-phrase \
  --cf-token-file $DEPLOY_DIR/dns-token --cf-zone <zone id> --canary-host app.usagemap.dev \
  --journey-seed-file $DEPLOY_DIR/onboard/journey-seed --out $DEPLOY_DIR/onboard
```

Put `sites.canary.site_key`, `tenant_id` and `sites.canary.site_id` of `onboard/onboard.json` into `v1.yml`
(`scf_probe_site_key`, `scf_probe_tenant_id`, `scf_probe_site_id`), build the landing site with the site key of
`sites["usagemap.dev"]`, and deploy again:

```sh
LANDING_SITE_KEY=<site key> LANDING_TRACKER_DIST=$RELEASE_DIR/tracker-1.1.0/lib LANDING_OUT=$DEPLOY_DIR/release/landing-$REV \
  pnpm --filter @usagemap/landing run build:release
LANDING_DIR=$DEPLOY_DIR/release/landing-$REV infra/ansible/scripts/play-v1.sh
```

## 8. Verify

```sh
LANDING=usagemap.dev PORTAL=app.usagemap.dev STATUS=status.usagemap.dev INGEST="e1.usagemap.dev e2.usagemap.dev" \
SITE_KEY=<canary site key> SITE_ORIGIN=https://app.usagemap.dev INGEST_TOKEN_FILE=$DEPLOY_DIR/onboard/ingest-token \
SSH_HOST=<vm-host> GATEWAY_IMAGE=usagemap/gateway:$REV infra/compose/scripts/smoke-remote.sh       # all PASS
node infra/compose/scripts/live-browser.ts --headed-ua --page https://usagemap.dev/docs/ --portal https://app.usagemap.dev \
  --phrase-file $DEPLOY_DIR/secrets/owner-phrase --onboard $DEPLOY_DIR/onboard                     # PASS
(cd apps/landing && node check-live.ts $DEPLOY_DIR/release/landing-$REV)                           # all ok
ssh <vm-host> sudo docker exec scf-postgres-1 scf-backup pgbackrest info                          # full backups, repo 1 and 2
```

Load (bounded, ≤ 10 min, DEMO site and service, platform limits raised and restored, DEMO data erased afterwards):
`node infra/compose/scripts/live-load.ts --phrase-file … --onboard $DEPLOY_DIR/onboard --cf-token-file … --cf-zone … --out <file>`.

Then start the outside vantage point (another network; it records the probe store that `scf-ops slo-report` reads):

```sh
STORE=~/.local/share/usagemap/probe-ws CONFIG_DIR=$DEPLOY_DIR/probe-ws OPS_IMAGE=usagemap/ops:$REV SOURCE=ws-1 \
INGEST="e1.usagemap.dev e2.usagemap.dev" PORTAL=app.usagemap.dev SITE_KEY=<canary site key> TENANT_ID=<id> \
SITE_ID=<canary site id> SEED_FILE=$DEPLOY_DIR/onboard/journey-seed ops/status/vantage/run.sh
```

## 9. Redeploy (new commit, new tracker version, new landing build) — one sequence

```sh
REV=<new commit>; RELEASE_DIR=$DEPLOY_DIR/release/$REV; RUNNING=$DEPLOY_DIR/release/<running rev>
infra/ansible/scripts/build-release.sh $REV $RELEASE_DIR https://e1.usagemap.dev,https://e2.usagemap.dev
# v1.yml: scf_release_ref: $REV; scf_tracker_releases / scf_tracker_versions = the tracker-* directories built
LANDING_SITE_KEY=<site key> LANDING_TRACKER_DIST=$RELEASE_DIR/tracker-<v>/lib LANDING_OUT=$DEPLOY_DIR/release/landing-$REV \
  pnpm --filter @usagemap/landing run build:release
infra/ansible/scripts/ship-images.sh <vm-host> $RELEASE_DIR/images.yml
export RELEASE_DIR LANDING_DIR=$DEPLOY_DIR/release/landing-$REV
```

**Order: the Collector last** when the new release adds a telemetry stream (for example `stellar_client_metrics: true`
in `collector/config/collector.yaml` emits a stream that only the new metrics writer stores, migration 0080). Stage 1
deploys the migrations (the `db-migrate` one-shot), metrics writer, control plane, jobs, portal, MCP and the rest with
the Collector held at the running release; stage 2 rolls the Collector:

```sh
infra/ansible/scripts/hold-images.sh $RELEASE_DIR/images.yml $RUNNING/images.yml otelcol > $RELEASE_DIR/hold-otelcol.yml
infra/ansible/scripts/play-v1.sh -e @/release/hold-otelcol.yml     # stage 1 (the override replaces both image maps)
ssh <vm-host> 'sudo docker ps --format "{{.Names}} {{.Image}} {{.Status}}"'   # all healthy, otelcol still <running rev>
infra/ansible/scripts/play-v1.sh                                  # stage 2: the Collector
```

A release that adds no stream runs the playbook once. Compose recreates only changed services; the playbook restarts
the ones whose mounted configuration changed (portal
for the landing or Caddyfile, Alertmanager, Prometheus, PostgreSQL for its start script, control plane and jobs for
the tracker list). A tracker version that pages already pin keeps being served only while it is in the build: a
tracker built for this deployment carries only the current version, so **bump the tracker version, never rebuild a
pinned one**, and keep earlier versions' directories in `release/` if pages still pin them.

After the deploy, besides §8 (remote smoke, browser journey, `check-live.ts`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.usagemap.dev/mcp -H 'content-type: application/json' -d '{}'  # 401 (hosted MCP, no key)
curl -s -o /dev/null -w '%{http_code}\n' https://app.usagemap.dev/mcp                                                      # 405
curl -sI https://usagemap.dev/.well-known/stellar.toml | grep -iE '^(content-type: text/plain|access-control-allow-origin: \*)'  # both
curl -sI https://usagemap.dev/skill.md | grep -i '^content-type: text/markdown'
ssh <vm-host> df -h /       # after the first on-chain / usage-map runs (ledger mirror)
```

The hosted MCP server (`services/mcp`, `scf_mcp_enabled`, fixed address `scf_mcp_fixed_ip` 172.30.0.11 which the
control plane also trusts for `X-Forwarded-For`) holds no key; with a share key the `curl` of `docs/ai/mcp.md` answers
`200` with `result.isError: false`. The portal's global write timeout (30 s) bounds one tool answer.

## 10. Operations on this host

| What | Command / where |
|---|---|
| Containers | `ssh <vm-host> sudo docker ps -a` |
| Grafana / Prometheus / Alertmanager | `ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 <vm-host>` |
| Recorded alerts (no outside channel) | `ssh <vm-host> 'sudo docker exec scf-prometheus-1 wget -qO- "http://victorialogs:9428/select/logsql/query?query=receiver:*"'` |
| Backups | `ssh <vm-host> sudo docker exec scf-postgres-1 scf-backup pgbackrest info` (full weekly, differential daily, WAL every ≤ 60 s) |
| Restore drill (weekly timer, repo 2, read-only SAS) | `ssh <vm-host> 'sudo systemctl start scf-restore-drill.service; journalctl -u scf-restore-drill -n 5 | grep RESTORE-DRILL'` |
| Certificates | timer `scf-acme.timer` (twice a day); `journalctl -u scf-acme` |
| SLO report from the outside vantage | `OUT=<dir> STORE=… CONFIG_DIR=… OPS_IMAGE=… ops/status/vantage/run.sh report YYYY-MM` |
| Temporary drill VMs | `drill_vms` in `v1.tfvars` (each powers itself off after 4 h); remove the entry and apply to delete VM, disk, NIC and IP |

## 11. Teardown

`tofu destroy` stops at the backup account (`prevent_destroy`). Keep backups until the erasure bound has passed
(C-112) or the successor has its own; then remove `prevent_destroy` in a reviewed change.

## 12. First operator and read-only guest logins

There is no SCF operator on a new host: the first one is a **bootstrap seed** written with the database superuser
(`platform_operators.granted_by` NULL is allowed only for that). Everything after it goes through the API, audited.
Operators must hold **two passkeys** (ADR-0014, C-09); an operator session without a passkey stops at
`/signin/passkey`. Do it on a machine with your own wallet and two authenticators (e.g. the device's platform
authenticator and a hardware key).

1. **Sign in once as yourself** at `https://app.usagemap.dev/signin` with your own Stellar wallet (SEP-53 message
   signing; an unfunded account works). This creates your user. Note your `G…` account.
2. **Grant yourself `operator_admin`** (bootstrap, superuser, one statement; replace the account):
   ```sh
   ssh <vm-host> 'P=$(sudo cat /etc/scf/stack/secrets/pg_superuser_password); sudo docker exec -i -e PGPASSWORD="$P" scf-postgres-1 \
     psql -X -v ON_ERROR_STOP=1 -h /var/run/postgresql -U postgres -d scf' <<'SQL'
   INSERT INTO scf.platform_operators (user_id, role, note)
     SELECT user_id, 'operator_admin', 'bootstrap: first operator (deploy-v1.md §12)' FROM scf.external_identities
      WHERE provider = 'stellar' AND subject = 'G…YOUR ACCOUNT…'
     ON CONFLICT (user_id) DO NOTHING;
   SELECT u.user_id, p.role FROM scf.platform_operators p JOIN scf.users u USING (user_id);
   SQL
   ```
   Expect one row. Record it in the access log (`ops/runbooks/access-review.md`).
3. **Sign out and in again**: the portal sends you to `/signin/passkey`; register **passkey 1**. Then
   `https://app.usagemap.dev/account` → *Passkeys* → register **passkey 2** on the second authenticator. Check that
   both are listed, sign out, sign in with each once. The operator area is `https://app.usagemap.dev/operator`.
4. **Operator API key for the forge script and the journey** (optional): `/operator` → API keys (or
   `POST /v1/operator/api-keys` `{"label":"forge","scopes":["web:read","api:read"],"expires_in_days":30}`); the key is
   shown once — keep it in `$DEPLOY_DIR/secrets/` (0600). Then the forge script (`tools/forge`) can run with
   `--operator-key-file … --project <tenant uuid>` and `--strict`.
5. **Read-only guest login for a walkthrough.** A guest signs in with their own wallet (step 1 for them; a
   throwaway unfunded key is fine). Then, as you (operator_admin):
   - tenant data, read only: on the `usagemap` tenant, *Team* → invite with role **viewer** (or
     `POST /v1/tenants/{tenant}/invitations {"role":"viewer","expires_in_hours":24}`), give the guest the one-time
     code, they open `https://app.usagemap.dev/invitations/accept`;
   - operator views, read only: `POST /v1/operator/operators {"user_id":"<their user id>","role":"operator","note":"guest, read-only, until <date>"}`
     (never `operator_admin`); the guest then registers two passkeys like step 3. Revoke afterwards
     (`DELETE /v1/operator/operators/{userId}`).
6. **DEMO projects:** `tools/demo-seed` refuses a deployed stack on purpose (its guard). Seeding the live host with
   labelled DEMO data needs a reviewed change to that guard and is a separate decision; until then a guest sees
   the operator's own project (`usagemap`: the landing site, the canary site and the OTLP smoke service).
