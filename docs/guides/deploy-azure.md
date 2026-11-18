# Deploying the lean Azure profile (C-123)

Step-by-step for an operator. Profile: the Docker Compose stack on one VM (`app-1`), an optional standby VM
(`standby-1`) for the restore drill, backups in two storage accounts in two EU regions, Azure DNS
([`../deployment-topology.md`](../deployment-topology.md) §1). Cost: [`../cost-model.md`](../cost-model.md).

**This is the full lean profile.** A smaller single-VM deployment is described in [`deploy-v1.md`](deploy-v1.md);
it uses the same Ansible playbook with v1 settings, not this guide's OpenTofu root.

**Status: deployment guide for Azure, checked against the repository (OpenTofu root, Ansible playbook and role defaults) — this full-size profile (`envs/azure-lean`) has not been run against Azure yet.** The OpenTofu root is validated with `tofu test`
against a mock provider (`infra/opentofu/scripts/check.sh`); the Ansible playbook is tested in containers
(`infra/ansible/tests/lean/run.sh`: the lean playbook applied over SSH to a Debian 13 VM container). The first deployment is therefore also the first test of everything in §8.2 — record
what you see (clean commit, with the commit hash). Variable and unit names below follow
the repository; where this guide and `envs/azure-lean/prod.tfvars.example` or the role defaults differ, the files win.

## 1. Prerequisites

| What | Version / detail |
|---|---|
| Workstation | Linux, the service operator's machine (C-79): only it holds Azure and production credentials |
| OpenTofu | **1.13.9** (MPL-2.0; never Terraform ≥ 1.6) — `infra/opentofu/scripts/check.sh` downloads the pinned binary into `~/.cache/scf-tools` |
| Ansible | the tool image `usagemap/ansible-tools:2.22.0` built from `infra/ansible/tools/Dockerfile` (ansible-core 2.22.0, `community.sops` 2.5.1) |
| SOPS + age | for every secret (ADR-0019); each operator has an age key; `.sops.yaml` lists the recipients |
| Azure CLI | `az login` as a person with **Owner** (or Contributor + **User Access Administrator**) on the subscription — the first apply creates a custom role and role assignments. After the first apply drop to Reader and elevate only for applies (threat model TM-AZ-01) |
| Decisions | subscription (C-98), the two tracker domains and their registrar, the portal hostname and optional status hostname, the admin source address range for SSH (or Bastion), whether to run `standby-1` |

## 2. One-time subscription bootstrap

```sh
az account set --subscription <subscription-id>

# Resource providers (the root module does not register them: resource_provider_registrations = "none")
for ns in Microsoft.Compute Microsoft.Network Microsoft.Storage; do az provider register --namespace $ns --wait; done

# Encryption at host (the module enables it on every VM); registration can take ~10 minutes
az feature register --namespace Microsoft.Compute --name EncryptionAtHost
az feature show --namespace Microsoft.Compute --name EncryptionAtHost --query properties.state   # → "Registered"
az provider register --namespace Microsoft.Compute

# OpenTofu state account (created once, by hand, outside the module): Entra ID auth only, versioned
az group create -n scf-tfstate -l westeurope
az storage account create -n <stateaccount> -g scf-tfstate -l westeurope --sku Standard_ZRS \
  --min-tls-version TLS1_2 --allow-blob-public-access false --allow-shared-key-access false
az storage account blob-service-properties update -n <stateaccount> -g scf-tfstate --enable-versioning true
az role assignment create --assignee <your-object-id> --role "Storage Blob Data Contributor" \
  --scope $(az storage account show -n <stateaccount> -g scf-tfstate --query id -o tsv)
az storage container create -n tfstate --account-name <stateaccount> --auth-mode login
```

Then `infra/opentofu/envs/azure-lean/backend.hcl` (from `backend.hcl.example`, not committed):
`resource_group_name = "scf-tfstate"`, `storage_account_name = "<stateaccount>"`, `container_name = "tfstate"`.

The state is encrypted client-side (PBKDF2 + AES-GCM, enforced for state and plans). Its passphrase lives in SOPS:

```sh
export TF_VAR_state_passphrase=$(sops -d --extract '["tofu_state_passphrase"]' secrets/prod.yaml)
```

Losing that passphrase makes the state unreadable; keep it with the break-glass envelope (handover plan I-13).

## 3. Fill in `prod.tfvars`

Copy `infra/opentofu/envs/azure-lean/prod.tfvars.example` to `prod.tfvars` (git-ignored) and set at least:

| Variable | Value |
|---|---|
| `subscription_id` | the subscription |
| `location`, `secondary_location` | `westeurope`, `swedencentral` (validation accepts EU/EEA regions only) |
| app VM size | `Standard_D8as_v5` (design load) or `Standard_D4as_v5` (small deployment) |
| standby | on (`Standard_D2as_v5`) or off |
| Bastion | off (SSH from `admin_source_cidrs`) or on (Basic SKU, ≈ $139/month) |
| `admin_ssh_keys` | one key per person (no shared keys, no passwords) |
| `admin_source_cidrs` | the operators' fixed egress addresses, as narrow as possible |
| backup storage account names | two globally unique names (3–24 lowercase letters/digits) |
| DNS | the two tracker zones, the ingest hostnames, the portal hostname, optional status hostname |
| image | the **pinned** Debian 13 image version (validation rejects `latest`) |

Find the current Debian 13 image versions and pick the newest one (record it; upgrades change it deliberately):

```sh
az vm image list --publisher Debian --offer debian-13 --sku 13-gen2 --all -o table
```

## 4. Plan and apply

```sh
cd infra/opentofu
scripts/check.sh                                   # fmt, validate, tofu test (mock provider), tflint — must pass
cd envs/azure-lean
tofu init -backend-config=backend.hcl
tofu plan -var-file=prod.tfvars -out=plan.bin       # the plan file is encrypted too
tofu apply plan.bin
tofu output                                         # public IPs, name servers, backup repositories, identities
```

Review the plan before applying: two resource groups, one VNet with subnets `app`, `endpoints` (and Bastion if on),
one NSG, `app-1` (+ `standby-1`), their disks and public IPs, two storage accounts with private endpoints, the
private DNS zone for blob, the custom role `<prefix>-backup-writer` and its assignments, the DNS zones with A, CAA and
`_acme-challenge` TXT records and the two ACME role assignments per hostname. The backup accounts and containers
have `prevent_destroy`.

## 5. Delegate DNS

At the registrar of each tracker domain, set the NS records to the four Azure DNS name servers from
`tofu output dns_name_servers`. Check with `dig NS <domain> +short` and `dig A <ingest-hostname> +short` (should be
the `ingest` IP) before continuing — lego's DNS-01 challenge needs working delegation.

## 6. Secrets

Generate every production secret **once** on the workstation and keep it only SOPS-encrypted
(`dev-secrets.sh` is for local stacks and must never be used here):

```sh
infra/ansible/scripts/gen-stack-secrets.sh --age-recipient "$SCF_DUMP_AGE_RECIPIENT" \
  | sops --encrypt --age "$SCF_AGE_RECIPIENTS" --input-type yaml --output-type yaml /dev/stdin \
  > infra/ansible/group_vars/lean.sops.yaml
```

The file holds the database passwords, Umami `APP_SECRET` and bootstrap passwords, the key sets
(`umami_creds_keys`, the three peppers), the edge-snapshot and traction-snapshot signing keys, the SEP-10 seed,
the pgBackRest cipher passes of both repositories, the age recipient of the weekly dump, the Grafana admin password,
the heartbeat token, the CA key passphrase and the OpenTofu state passphrase. `--age-recipient` is the public key of
the weekly dump; create its identity with `age-keygen` on an offline machine. With `-o FILE` the script writes a 0600
file and refuses to overwrite an existing one: re-generating would lock you out of the existing database and backups.
Never let `sops` overwrite an existing `lean.sops.yaml` either. Back up the age identity of the dump (it decrypts the weekly
dumps) and the PKI directory (`infra/ansible/.pki`, SOPS-encrypted) with the break-glass envelope.

## 7. Configure the hosts

```sh
cd infra/ansible
tofu -chdir=../opentofu/envs/azure-lean output -json \
  | scripts/inventory-from-tofu.py --lean > inventory.lean.yml   # next to group_vars/ (git-ignored)
cp group_vars/lean.yml.example group_vars/lean.yml                # subscription id, release tag, image digests
ansible-playbook -i inventory.lean.yml playbooks/lean.yml --check --diff     # first look
ansible-playbook -i inventory.lean.yml playbooks/lean.yml
```

Set the release in `group_vars/lean.yml`: the release reference whose `infra/compose` files are deployed and
the image digests built and published for that release (C-79). The playbook: mounts the data disk at
`/srv/scf`; applies SSH hardening, nftables and unattended security upgrades; installs Docker CE 29.9.3 (held);
issues the node certificates from the workstation CA; obtains the public certificates with lego (DNS-01, managed
identity); renders the secrets and `compose.prod.yaml`; brings the stack and the monitoring overlay up with `--wait`;
installs the certificate-renewal and restore-drill timers.

## 8. First start: checks

### 8.1 The service

| Check | How | Expected |
|---|---|---|
| Containers | `ssh app-1 sudo docker compose -p scf ps` | every long-running service `healthy`; one-shots exited 0 |
| Certificates | `openssl s_client -connect <ingest-hostname>:443 -servername <ingest-hostname> </dev/null \| openssl x509 -noout -issuer -dates` | Let's Encrypt issuer; same for the portal hostname |
| Renewal | `systemctl list-timers 'scf-acme*'`; `journalctl -u scf-acme.service` | timer active; last run succeeded |
| Ingest | load a test page with the tracker snippet from the portal; or the ops probe journey | `202` on `/v1/e`; event visible in the dashboard |
| Portal / API | `curl -fsS https://<portal-hostname>/public/v1/health` | `200` once the gateway has reported (C-121) |
| Nothing else exposed | from outside: `nmap -Pn -p- <ingest IP> <portal IP>` | only 443 open (22 only from the admin range) |
| Backups | `ssh app-1 sudo docker exec -u postgres <postgres container> scf-backup check` | passes for both repositories |
| First full backup | `... scf-backup backup full 1` and `... backup full 2` (or wait for the scheduler) | `pgbackrest info` lists a full in each repository |
| Weekly dump | `... scf-backup dump`, then `... scf-backup dump-list` | one dump listed in repository 2 |
| Restore drill | `ssh standby-1 sudo systemctl start scf-restore-drill.service` (on `app-1` when there is no standby) | one `RESTORE-DRILL PASS` line in the journal; metrics updated |
| Monitoring | `ssh -L 3000:127.0.0.1:3000 app-1`, open Grafana | dashboards D1–D14 load; no `Watchdog` gap at the dead-man's-switch workflow |

### 8.2 What only Azure can show (risk R-23)

None of these can be emulated by Azurite or the mock provider; each must be checked once and recorded:

1. **Versioning and lifecycle:** both accounts show blob versioning on, soft delete 14 days, and the management
   policy `delete-previous-versions` acting on versions only (`az storage account management-policy show`).
2. **Version delete is denied for the VM identity:** on `app-1`, with a token from IMDS, overwrite a test blob, then
   try `DELETE …?versionid=<previous>` — expect `403 AuthorizationPermissionMismatch`; deleting the current blob
   works and leaves a previous version.
3. **No shared keys, no public access:** `az storage account show … --query "{key:allowSharedKeyAccess, net:publicNetworkAccess}"`
   → `false`, `Disabled`; a request from outside the VNet is refused.
4. **Private endpoints:** on `app-1`, `getent hosts <account>.blob.core.windows.net` resolves to a `10.50.250.x`
   address.
5. **IMDS only from the database container:** `curl -s -m 3 -H Metadata:true "http://169.254.169.254/metadata/instance?api-version=2021-02-01"`
   succeeds inside the `postgres` container and fails (timeout) inside every other container that has a shell, e.g.
   the `control-plane` and `jobs` containers (they use Node.js: `node -e "fetch('http://169.254.169.254/...',{headers:{Metadata:'true'}})…"`).
6. **ACME identity scope:** with the VM identity, writing an `A` record in the zone is refused; writing the
   `_acme-challenge.<host>` TXT record works.
7. **Standby identity:** on `standby-1`, listing repository 2 works and any write is refused; repository 1 is refused.
8. **Activity Log:** an alert or at least a saved query for Run Command, extension writes, snapshot/disk-export and
   role-assignment writes (TM-AZ-01/02).

## 9. Upgrades and rollback

- **Application release:** set the new release reference and image digests, `ansible-playbook playbooks/lean.yml`.
  Compose recreates only changed services; every start of Umami re-runs `umami-views-drop → umami-migrate →
  umami-views` (C-121). Database migrations run in `db-migrate` and are forward-only — take a manual full backup
  first (`scf-backup backup full 1`).
- **Rollback:** re-run the playbook with the previous release. If a migration of the new release must be undone,
  restore to the point in time before the upgrade (runbook `restore-pitr.md`) — that loses everything after it, so
  prefer a forward fix.
- **OS:** unattended upgrades install security updates daily; Docker packages are held and upgraded deliberately by
  changing the pinned version in the role. Reboots are manual, in an announced window (one VM: the reboot is downtime,
  [`../sla.md`](../sla.md) §1.1).
- **Debian image version:** changing it in `prod.tfvars` replaces the VM; do it only together with a rebuild drill.
- **Resize:** change the VM size and apply; a restart, no data change.

## 10. Disaster recovery

| Situation | Steps |
|---|---|
| `app-1` unrecoverable, disks intact | `tofu apply` re-creates the VM and attaches the existing disks; re-run the playbook |
| Data disk or zone lost | `tofu apply` (new VM and disk), playbook with the database restore option, restore from repository 1 (or 2) — runbook `restore-pitr.md`; RTO target 4 h |
| Region lost | `tofu apply` with another `location` (the old resource group is unreachable; repository 2 in `secondary_location` is the source), restore from repository 2, point the DNS records at the new IPs |
| Restore on `standby-1` | possible for a fast start while `app-1` is rebuilt; it is sized for the drill, not for production load |

Time every real or drilled recovery and record it; measured times replace the RTO/RPO targets.

## 11. Teardown

`tofu destroy` stops at the backup accounts and containers (`prevent_destroy`): removing backups is a deliberate,
manual decision. To decommission (handover plan §6.4): destroy everything else, keep the repositories until the
erasure bound has passed (56 days, C-112) or until the successor confirms its own backups, then remove
`prevent_destroy` in a reviewed change and destroy them. Delete the OpenTofu state account last.
