# Sub-processors

> **Not legal advice.** Engineer-prepared list; not reviewed by
> counsel. Layout: the lean single-cloud profile (C-123), which replaces the multi-provider list
> (Hetzner, UpCloud, OVHcloud, Bunny DNS) of version 0.3. Facts are labelled **V** (verified from a primary source,
> URL and date given, or from the deployed system), **L** (likely) or **U** (unverified). The list becomes binding
> when the DPA is offered.

Processor: `<OPERATOR-ENTITY>` (the service operator). Version: `0.6`. The list matches the single-VM profile that
the hosted instance runs: the whole stack in one EU region, one backup storage account in the same region instead of
two accounts in two regions, and **Cloudflare** as the DNS provider (DNS only). Version 0.4 (C-123) described the
full-size design as if it were deployed.

## 1. Sub-processors that handle tenant personal data

| Sub-processor | Company · ownership | Service | Locations | Data touched | Role |
|---|---|---|---|---|---|
| **Hosting provider** | The hosting provider of the hosted instance, with its ownership, EU representative and contracting entity, is listed to customers in the DPA annex (Annex 3) | **Today (single-VM profile):** one virtual machine with one managed disk, static public addresses, one blob storage account (pgBackRest repository 2 and the weekly dump). Full-size design (not deployed): a larger VM with a data disk, a standby VM, two backup accounts in two EU regions, private endpoints, provider DNS | **One EU region**: VM, disk and backup account (V, deployed system) | Transient IP/UA in gateway memory; the gateway spool (no IP, no raw User-Agent; ≤ 72 h); visit cache tokens in engine-proxy memory; the `umami` and `scf` databases; encrypted backups | Infrastructure sub-processor |

Backups today: weekly full + daily differential, 35-day point-in-time window, weekly logical dumps kept 5 weeks.
Repository 1 is on the VM's own disk; repository 2 and the dumps are in one storage account in the same region with
blob versioning and 14-day soft delete; previous versions are deleted after 14 days, so erased or expired data leaves
all backups within 56 days (data-model §14; C-29, C-108, C-110, C-112). **There is no copy outside that region.**
Every backup is encrypted on our VM before upload (pgBackRest AES-256; age for the dump). The pgBackRest cipher passes
are necessarily on the VM (it encrypts with them); only the dump's private age identity is held solely by the service
operator, outside the hosting provider (C-79). The weekly restore drill runs on the same VM, never on GitHub-hosted runners (C-56).

### 1.1 Transfer position for a US-owned provider (for counsel review)

Where the hosting provider is a US-owned company, data is stored and processed in EU regions but the provider is
subject to US law, so access from the US (by provider personnel or under a US legal order) is possible in principle.
For the supported Azure deployment profile (Microsoft Corporation), the safeguards are:

1. **EU-U.S. Data Privacy Framework.** Microsoft's DPA states that Microsoft is certified to the EU-U.S. Data Privacy
   Framework (and its Swiss and UK counterparts) — V from the DPA (November 2026 edition, read 2026-11-13); the entry
   on the public DPF list (dataprivacyframework.gov) was not read (U). Transfers to a certified US company rely on the
   Commission's adequacy decision of 10 July 2023 (Implementing Decision (EU) 2023/1795) — to be confirmed by counsel,
   including the decision's current legal status.
2. **Standard Contractual Clauses (fallback).** The DPA makes every transfer out of the EU/EEA subject to the 2021 SCCs
   (Commission decision 2021/914, processor-to-processor module) between Microsoft Ireland Operations Limited and
   Microsoft Corporation (V, same DPA), so the transfer has a basis if the DPF adequacy decision falls.
3. **EU Data Boundary.** For regional services deployed in EU regions (the VMs, disks and storage accounts), Microsoft
   commits to store and process customer data within the EU/EFTA (V, DPA and learn.microsoft.com/privacy/eudb, read
   2026-11-13).
4. **Supplementary measure under our control — and its limit.** Backups are encrypted on the VM before upload, but
   the pgBackRest cipher passes live on the VM's disk; the running VM is not encrypted under our keys (its disk uses
   platform-managed keys, encryption at host off). Data in use, data on the VM's disk and the pgBackRest keys are
   therefore reachable by a lawful order served on Microsoft; only the weekly dump's private age key is not. A
   transfer impact assessment should weigh this.

The multi-provider, EU-based layout (ADR-0017/0018) is the documented alternative for a service operator that wants
no US-owned infrastructure provider; it runs the same software ([`deployment-topology.md`](../deployment-topology.md) §S1).

## 2. Services that do not receive collected analytics data

Listed for transparency; whether each is a sub-processor in the legal sense is for counsel. "Today" = used by the
v1 host.

| Service | Company · ownership | Purpose | Data touched | Notes |
|---|---|---|---|---|
| **Cloudflare DNS** (today) | Cloudflare, Inc., USA | Authoritative DNS for `usagemap.dev` and its hostnames (apex, `app`, `status`, `e1`, `e2`), **DNS-only: no record is proxied**, so no visitor or tenant traffic passes through Cloudflare; ACME DNS-01 challenge records written through its API (token limited to editing this one zone's DNS) | **DNS queries only**: hostnames, record types, the asking recursive resolver's address and, where a resolver sends EDNS Client Subnet, a truncated network prefix; our zone's records | No visitor data: no HTTP request, event, cookie or telemetry reaches Cloudflare. Free plan. Scope limited to DNS on purpose — enabling the proxy would make Cloudflare a processor of visitor traffic and needs this list changed first (§4) |
| **Let's Encrypt** (today) | Internet Security Research Group (ISRG), USA | TLS certificates for the ingest, portal, landing and status hostnames via ACME DNS-01 (lego on the VM) | Certificate requests containing our hostnames; the ACME account key's public half | Certificates are public (CT logs); no visitor data |
| **GitHub** (today: source only) | GitHub, Inc. (Microsoft), USA | Today: the source repository. Designed for the scale-out profile: releases and container registry (GHCR), public issue tracker, status-page history, scheduled checks of the public endpoints, the dead-man's-switch workflow (C-30), the public evidence repository with the daily audit-chain head hash (C-63); OAuth identity provider for users who sign in with GitHub (not configured on the live host) | Source code; when used as designed, the credentials the release build needs to sign and publish, never production or cloud credentials or backup keys (C-56, C-79); support issues written under users' GitHub identities; probe results; GitHub identity of users who sign in with it | **No visitor data by design** (ADR-0017; C-26) |
| **npm registry** (not yet) | npm, Inc. (GitHub/Microsoft), USA | Distribution of `@usagemap/tracker` once published | Package code | No visitor data |
| Alert channels `<chosen by the operator>` (none today: alerts are recorded on the VM only) | recorded here when chosen | Alert delivery (chat and e-mail, ADR-0022) | Alert text (no personal data by rule) | No visitor data (C-26) |
| **Stellar public network** (optional) | public, global ledger | Daily anchoring of the audit-chain head hash (C-63) | One hash value per day — **no personal data** | Only when anchoring is enabled |

## 3. Optional, off by default

| Service | Company seat | Purpose | Data touched | Condition |
|---|---|---|---|---|
| **Google BigQuery** (SDF public Hubble dataset) | Google LLC, USA; dataset location to be confirmed (C-26) | On-chain correlation for tenant-declared contracts (ADR-0028) | Tenant-declared contract IDs (public ledger identifiers) in queries; public daily aggregates returned. **No web or API analytics data** | Only when a tenant enables on-chain correlation; GCP project owner chosen by the operator |
| **AWS Open Data** (public ledger files) | Amazon Web Services, public dataset | Rebuildable fallback source, read by our Go command `/services/onchain-reader` (C-42) | Public ledger data downloaded; nothing sent but requests | As above; needs no account with Google |

Data suppliers that receive nothing from us: DB-IP (IP-to-Country Lite, CC BY 4.0) and sapics/ip-location-db
(`user-country`, PDDL-1.0), downloaded at image build by pinned checksum and refreshed monthly (ADR-0006, C-38);
cloud-provider, Private Relay, Tor-exit and VPN range lists, fetched weekly from the publishers' URLs by an updater on
each edge node and never baked into images (C-38). The configured Stellar RPC/Horizon hosts (on v1 the public
`horizon.stellar.org` by default) receive the public account or contract IDs being verified at sign-in, L2 and
contract verification (C-10); the final choice of hosts is not yet fixed (strategy OP-26).

## 4. Change-notification process

1. **Pull request.** Any change (addition, replacement, new location, change of ownership becoming known) is opened as a
   pull request to this file and to Annex 3 of the DPA, with the reason and a data-protection assessment (location,
   ownership, data touched, transfer mechanism).
2. **Notice.** When merged as "announced", tenants are notified at least `<30>` days before the change takes effect:
   portal banner, an e-mail to tenants that stored a contact address, a GitHub release note, and a machine-readable
   changelog entry at `docs/privacy/sub-processors.md` (history in git). Subscribers can watch the file.
3. **Objection.** A tenant may object on reasonable data-protection grounds within the notice period (DPA clause 6.2).
   The service operator answers within `<10>` business days; if unresolved, the tenant may leave and have its data
   deleted.
4. **Effect.** The change is applied through IaC only after the notice period; the residency statement
   ([`data-residency.md`](data-residency.md)) is updated in the same pull request.
5. **Emergency replacement.** If the provider fails or becomes unlawful to use (for example if the transfer basis of
   §1.1 falls), a replacement (another EU region of the same provider, or an EU-based provider running the same Compose stack) may be made immediately to keep the service running;
   tenants are notified within `<72>` hours with the same objection right.
6. **Handover.** The change of processor at handover follows the same process with the successor service operator
   named ([`data-residency.md`](data-residency.md) §8).
