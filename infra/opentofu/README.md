# OpenTofu: Azure (C-96, C-123 — written and validated against a mock provider, not applied)

OpenTofu 1.13.9 (MPL-2.0) only — never Terraform ≥ 1.6 (BUSL). Provider `hashicorp/azurerm` 5.13.0 from the OpenTofu
registry, pinned exactly; `envs/azure-eu/.terraform.lock.hcl` pins its checksums.

```sh
infra/opentofu/scripts/check.sh   # fmt -check, init -backend=false, validate, tofu test (mock-provider plan), tflint
```

**Production is the lean profile (C-123):** `modules/azure-lean` + `envs/azure-lean`. `modules/azure-platform` +
`envs/azure-eu` (four edges, two cores, monitoring, probe, egress proxy) stay as the documented scale-out path.

| Path | What |
|---|---|
| `modules/azure-lean` | **lean profile (C-123):** one EU region; one VNet (`app` subnet, private-endpoint subnet, optional Bastion subnet); the app VM (default Standard_D8as_v5 = the measured host shape, D4as_v5 for a small start) with **two front addresses** (ingest and portal, static Standard public IPs, fixed private IPs Docker publishes on) and a ≥ 250 GB data disk (C-109); optional standby VM (restore drill, cold standby; outbound-only public IP); Debian 13 image **pinned to one version** (validation rejects `latest`); Trusted Launch, SSH keys only, encryption at host, **no VM extensions** (Run Command), disk export off; NSG: inbound only 443 to the two front addresses and SSH from `admin_source_cidrs` (never `0.0.0.0/0`) or the Bastion subnet, outbound 80/443 + the private endpoints; two backup accounts in two EU regions (hot ZRS, versioning, 14-day previous-version rule, shared keys and public access off, private endpoints) with the custom role `<prefix>-lean-backup-writer` for the app VM's managed identity (**no** version delete, permanent delete, list keys or user-delegation key — F10) and Storage Blob Data Reader on repo 2 for the standby; Azure DNS zones with A records, CAA (one CA, no wildcards) and `_acme-challenge` TXT records on which alone the app VM's identity is DNS Zone Contributor (Reader on the zone) for lego's DNS-01 |
| `modules/azure-lean/tests/plan.tftest.hcl` | mock-provider plan: regions, inbound rules (no database/etcd/monitoring port), pinned image, no extensions, disks, front addresses, backup protection and role actions, DNS/ACME least privilege, CAA; single VM + Bastion variant; rejections (`latest` image, non-EU region, small disk, `0.0.0.0/0` SSH, host name outside the zones, > 14-day version window) |
| `envs/azure-lean` | root module of the lean profile: same backend and **enforced state/plan encryption** as `envs/azure-eu`; `prod.tfvars.example`, `backend.hcl.example` |
| `modules/azure-platform` | resource groups in two EU regions; VNets (primary + secondary, peered) with one subnet and NSG per node class; Debian 13 VMs (Trusted Launch, SSH keys only, system identity, data disk ≥ 250 GB for PostgreSQL nodes, C-109); two backup storage accounts in two regions (C-110) with blob versioning, soft delete, a lifecycle rule that deletes **previous versions** after 14 days and never touches current blobs (C-108/C-112), shared keys and public access off, private endpoints + `privatelink.blob.core.windows.net`; a custom role for database nodes **without** `deleteBlobVersion`/`permanentDelete`; read-only role for the drill host on repo 2; Azure DNS zones for the two tracker domains; a private mesh zone with `writers` → both cores (C-107) |
| `modules/azure-platform/tests/plan.tftest.hcl` | plan against a mock provider; asserts regions, backup protection, egress allow-list, disks, identities, plus rejections (non-EU region, small DB disk, bad node name, > 14-day version window) |
| `envs/azure-eu` | root module: `azurerm` backend (blob-lease locking), **enforced state and plan encryption** (AES-GCM, pbkdf2 from a SOPS passphrase, ADR-0019); `prod.tfvars.example`, `backend.hcl.example` |

**Egress (C-10).** Every subnet has `default_outbound_access_enabled = false`, explicit deny rules for the
`VirtualNetwork` and `Internet` tags after the allow rules, and only the egress-proxy subnet may reach the internet
(80/443); the probe may reach only the public addresses of edge and core nodes. Per-destination allow-lists (FQDNs)
are in the egress proxy (Ansible role `egress_proxy`).

**Secrets.** None are created here (no `random_password`, no Key Vault): passwords, cipher passes and the CA key
passphrase live in SOPS + age (ADR-0019, C-79). No storage key exists to leak (shared keys disabled).

**Debian image version.** Both modules require one exact published version (`az vm image list --publisher Debian
--offer debian-13 --sku 13-gen2 --all`), recorded in `prod.tfvars`; an image upgrade is a deliberate change.

**Not done by design.** `tofu plan` against Azure needs credentials: with fake ones it stops at token acquisition
(`AADSTS700038`), so the plan is exercised through `tofu test` with `mock_provider` instead. The OpenTofu state
account itself is created once (bootstrap) — `backend.hcl.example`.
