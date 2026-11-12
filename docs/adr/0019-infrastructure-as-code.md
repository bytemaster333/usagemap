# ADR-0019: Infrastructure as code

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** repo.monorepo-complete, licence.osi-only, repo.single-monorepo, infra.iac-complete, docs.deployment-guide, handover.repo-transfer, ops.rebuild-from-repo

## Context
The monorepo contains all infrastructure-as-code needed for an independent operator to take over the service (we
call that entity the service operator, C-59) (repo.monorepo-complete, repo.single-monorepo), released under an OSI licence (licence.osi-only), and the
infrastructure can be rebuilt from the open-source monorepo alone (ops.rebuild-from-repo). The future service operator may be one or two volunteers. The
estate is small: 8 VMs in the recommended tier across four providers (ADR-0018, C-25).

What research established:
- **OpenTofu v1.13.9** (2026-11-05, MPL-2.0; Linux Foundation, CNCF Sandbox since 2025-04-23, LIKELY). The 1.13
  series is supported until 2027-08-01. It has client-side state and plan encryption (1.7), S3-native locking
  without DynamoDB via conditional `If-None-Match` writes (1.10, `use_lockfile`), and ephemeral values and
  write-only attributes so secrets need not land in state (1.11).
- **Terraform is BSL 1.1** for ≥ 1.6.0 (Licensor now IBM); Nomad (≥ 1.7.0), Vault (≥ 1.15.0) and Consul
  (≥ 1.17.0) are BSL too. All excluded by ADR-0001.
- **State-bucket trap:** Hetzner Object Storage does not support "Conditional PUT/DELETE operations on versioned
  Buckets" and offers only SSE-C, so OpenTofu's native lock is not expected to work there. OVHcloud and Scaleway
  document `If-None-Match` conditional writes (search summaries, not executed).
- Providers on registry.opentofu.org: `hetznercloud/hcloud` 1.70.2 (MPL-2.0), `ovh` 2.24.0 (MPL-2.0; GitHub
  already at 2.25.0), `scaleway` 2.91.0 (MPL-2.0), UpCloud's provider (MIT); DNS: `BunnyWay/bunnynet` 0.20.1
  (MPL-2.0, pre-1.0), Gcore (MPL-2.0).
- **ansible-core 2.22.0** (2026-11-02, GPL-3.0; playbooks are input data, LIKELY reading), **Docker Engine
  29.9.3** (2026-11-03) and **Compose v5.7.1** (2026-11-11), both Apache-2.0. **Debian 13** (13.7 on 2026-09-12)
  is current stable; Debian 12 moved to LTS on 2026-07-12.
- **SOPS 3.13.3** (MPL-2.0) and **age 1.3.2** (BSD-3; 1.3.0 added post-quantum hybrid recipients). OpenBao 2.7.2
  (MPL-2.0) is a stateful server to operate; Infisical is open-core (`ee/`); ansible-vault has one shared
  password, so per-person revocation is impossible.
- GitHub-hosted runners for public repos (4 vCPU / 16 GB / 14 GB SSD, 6 h per job) can run the whole stack in
  Compose; scheduled workflows in public repos auto-disable after 60 days without repository activity.

## Options considered
1. **OpenTofu + Ansible + Docker Compose on Debian 13, SOPS + age (chosen).** Pros: every host inspectable with
   `docker compose ps` and `journalctl`; ubiquitous skills; `tofu plan` diffs are reviewable by volunteers; HA
   lives in our application layer, which needs no orchestrator. Cons: two tools (provisioning and
   configuration); rolling deploys are our own playbook logic.
2. **Terraform instead of OpenTofu.** Cons: BSL 1.1, not OSI. Excluded.
3. **Pulumi (Apache-2.0) with a self-managed S3 backend.** Pros: real programming languages. Cons: infra code
   becomes application code; harder for volunteers to review. Runner-up only.
4. **k3s or Talos + Flux/Argo CD.** Pros: rescheduling, GitOps. Cons: CNI, ingress, storage, an etcd quorum
   across providers over WireGuard, and a Kubernetes upgrade cadence of ~3 minors/year; the database still needs
   Patroni and the edge still needs DNS failover. Low handover simplicity.
5. **Ansible + Podman/Quadlet.** Pros: systemd-native, rootless. Cons: smaller knowledge pool; Podman 5→6 major
   in 2026. Runner-up runtime.
6. **Self-hosted PaaS (Coolify, Dokploy, Komodo).** Cons: a stateful control plane outside git; Dokploy has
   `/proprietary` directories. Poor fit for "rebuild from the monorepo".

## Decision
- **Provisioning: OpenTofu `~> 1.13`**, providers pinned to `registry.opentofu.org/...` addresses, lock file
  committed. One module per provider exposing the same node interface (name, size class, site, public/private
  addresses, volumes), so nodes can move between Hetzner, UpCloud, OVHcloud and Scaleway (ADR-0018). Only EU
  locations are accepted as inputs (ADR-0017).
- **State** in a **versioned OVHcloud object-storage bucket** with `use_lockfile = true` and **enforced state and
  plan encryption** (AES-GCM, `pbkdf2` key provider; passphrase from SOPS). Secrets are generated in SOPS, not by
  `random_password`, and passed through ephemeral or write-only attributes where providers support them. The state
  bucket's credentials are **not stored on any server** (C-79); they live in SOPS and are decrypted on the
  service-operator workstation that runs `tofu`.
- **Configuration: Ansible** (ansible-core 2.22, collections pinned in `requirements.yml`): OS hardening (SSH keys
  only, per-person keys declared in inventory, nftables default-deny, unattended security upgrades with staggered
  reboots; on edge nodes core dumps disabled and no unencrypted swap, C-66), the WireGuard mesh generated from
  inventory, Docker from Docker's apt repository, Patroni/etcd/pgBackRest, and every service. No custom Ansible
  modules; if one becomes unavoidable it carries a GPL-3.0 header.
- **Egress (C-10).** No component has unrestricted internet egress; each node's firewall and an egress proxy allow
  only named destinations: the control plane to GitHub's OAuth endpoints and to the configured Stellar RPC/Horizon
  hosts (sign-in and L2 verification); the domain verifier (tenant domains, private ranges blocked); registry sync;
  the API liveness probe; the contract-verification job (Stellar RPC); the audit-anchoring job (Stellar network and
  the public evidence repository); the optional on-chain job; ACME from the gateway and Caddy; DNS-provider APIs
  from the health controller; backup uploads; the range-list updater on edge nodes (C-38); probes from edge nodes,
  `mon-c` and `probe-d` to our own public endpoints; alert notifications from `mon-c`; operating-system and image
  updates from their mirrors and registry. The engine (Umami), the writer, the Collector and all other jobs have no
  internet egress at all. The nftables, egress-proxy and Compose network rules that enforce this are generated from
  inventory.
- **Node identity (C-60).** A private CA managed in the IaC issues one certificate per node. The engine proxy in
  front of Umami (`/services/engine-proxy`, C-74) — which also fronts the control plane's internal edge endpoints
  for the snapshot pull and counter upload — and the Collector → writer hop authenticate callers with these
  certificates.
- **DNS as code (C-27).** Static records are kept in git and applied to both DNS providers by one multi-provider
  tool — DNSControl or octoDNS, whichever supports both chosen providers (decided at implementation). The
  health controller owns only the ingest and portal A/AAAA record sets. Edge nodes hold a DNS credential that can
  only write a delegated `_acme-challenge` zone (C-61).
- **Runtime: Docker Compose on Debian 13.** The same Compose files run the full stack on a laptop, in tests and in
  production; production overlays only add host-specific values.
- **Images by digest only.** The deploy playbook runs `cosign verify` (and attestation verification) for every
  image digest before `docker compose up`, fails the play on any error and records the output (ADR-0023).
  Services run with the hardening profile from ADR-0023 (non-root, read-only root filesystem, `cap_drop: ALL`).
- **Secrets: SOPS + age**, encrypted files under `infra/secrets/`, recipients = the age key of each person on the
  service operator's team and a sealed break-glass key held by a second party. **No build automation is a recipient: production credentials stay with the service operator's team** (C-79).
- **Deploy** runs from a service-operator workstation with SOPS-decrypted secrets, through the `make` targets in the
  repository, or from a pull-based agent on the nodes (C-79); never from a hosted build job. Edges roll one node at a time (`serial: 1`): drain by closing the listener, wait for DNS TTL
  plus probe interval and an empty spool, deploy, smoke test, wait for external probes, continue. A nightly
  `ansible-playbook --check --diff` reports drift as an issue. Umami containers run with `SKIP_DB_MIGRATION=1`;
  its migrations run as an explicit one-shot deploy step (C-40).
- **Not used:** Kubernetes, Terraform, Consul, Vault, Nomad, any PaaS control plane. (A pull-based deploy agent is
  allowed by C-79 as an alternative to workstation deploys; earlier drafts excluded it.)

## Consequences
Positive: a rebuild is `tofu apply` → `make bootstrap` → `make deploy`, all from the repository; the toolchain is
fully OSI-licensed; volunteers need Linux, Docker and Ansible skills only; secrets are revocable per person; a
compromised build or repository cannot reach production, because no build automation holds a production credential (C-79).

Negative: rolling-deploy, drain and drift logic is ours to maintain; deploys depend on a person at a workstation (or
on the pull agent), not on hosted automation;
 hoster API tokens are long-lived secrets held in SOPS, because none of Hetzner,
UpCloud or OVHcloud is known to federate with OIDC (COULD NOT VERIFY);
git history keeps old SOPS ciphertexts, so handover means rotating every secret **value**, not only recipients —
except the key peppers and the snapshot-signing key, which are handed over securely and **not** rotated at
cut-over (rotation would invalidate every token) and are rotated afterwards by issuing new tokens with overlap
(C-50); pgBackRest cipher passes cannot be changed for existing backups (new repository path at handover).

Must do / watch: plan one OpenTofu minor bump (1.14) within the first year of operation; keep a monthly evidence commit
so scheduled workflows are not auto-disabled; record which workstations and people may deploy; publish `ops/runbooks/handover-secrets.md`.

Revisit if: the estate grows well beyond ~10 hosts; a provider offers OIDC federation; OpenTofu's locking fails
on OVHcloud (fallback: a Scaleway bucket, which also documents conditional writes).

Unproven: `tofu init/plan` lock acquire and release against the OVHcloud bucket with versioning (S-08); the exact
syntax for feeding the encryption passphrase from a variable (fallback: `TF_ENCRYPTION` environment variable);
Umami running with a read-only root filesystem (S-02); the full clean-environment rebuild (ADR-0021, ADR-0026).

## Open points
None outstanding.
