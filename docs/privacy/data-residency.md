# Data-residency statement

> **Not legal advice.** Prepared by engineers; not reviewed by counsel (a review is for `<OPERATOR-ENTITY>` to
> commission). Binding decisions: ADR-0017
> (data residency), ADR-0021 (backup), and the design decisions in [`docs/adr/README.md`](../adr/README.md) — here in
> particular **C-123 (lean Azure profile, 2026-11-13)**, C-96, C-110, C-26, C-29, C-38, C-56, C-63, C-71, C-74,
> C-77, C-79 and C-112. Labels: **V** verified from a primary source (URL and date given) or from the deployed system
> (evidence file named), **L** likely, **U** unverified.
>
> **Version 2026-11-21.** This version describes what **runs today**, the single-VM profile
> ([`../guides/deploy-v1.md`](../guides/deploy-v1.md)), and, separately and labelled as such, the **full-size
> design** (§2.2). The earlier version of this file described only that design (West Europe compute,
> repositories in two EU regions, ZRS, Azure DNS) as if it were the deployment; it was not.

UsageMap declares its data-residency choices explicitly; this is that declaration for the hosted instance.

## 1. The statement

**What runs today (the single-VM profile).** All visitor-derived and telemetry data is processed and stored in one
**EU region** of the hosting provider: the whole service runs on **one virtual machine** with **one Standard SSD**
that holds the operating system and all data. Its database backups are kept in two places, both in that region: pgBackRest **repository 1 on the VM's
own disk**, and **repository 2 in one storage account in the same region**, without geo-redundancy, with blob
versioning and 14-day soft delete. There is **no copy in a second region**: a loss of
the region or of that datacenter would lose the service and both repositories (§2.1, last paragraph).

No CDN, proxy or other third party sits in front of ingest: browsers and tenants' OpenTelemetry exporters connect
directly to the gateway on our VM, which terminates TLS itself. Public DNS for `usagemap.dev` is at **Cloudflare in
DNS-only mode** (records not proxied): Cloudflare answers DNS queries for our hostnames and **never sees visitor
traffic** — no HTTP request, no connection, no event. It sees the recursive resolver that asks, and — where that
resolver sends EDNS Client Subnet — a truncated prefix of the asking network (§4).

**On the supported Azure profile the provider is US-owned** (Microsoft Corporation, USA). Hosting in an EU region fixes where data is stored
and processed; it does not take the data out of the reach of US law that applies to Microsoft (for example the CLOUD
Act, 18 U.S.C. § 2713, which lets US authorities require a US provider to disclose data in its control wherever it is
stored). What limits that exposure (§3): Microsoft's EU Data Boundary commitment for regional services, its
certification under the EU-U.S. Data Privacy Framework and the 2021 Standard Contractual Clauses in its DPA, and the
encryption of every backup on our VM before it is written (pgBackRest AES-256 for both repositories; age for the
weekly logical dump). **The limits of that last measure, stated plainly:** the pgBackRest cipher passes must be on
the VM to encrypt, so they sit on the same disk as the database; the running database and the VM's disk are
encrypted by the platform with platform-managed keys only (encryption at host is off on v1). A lawful order served on
Microsoft could therefore reach the live data and, through the VM's disk, the keys of both pgBackRest repositories.
Only the weekly dump's private age identity is never on Azure (it stays with the service operator, C-79). Whether
this is acceptable for tenants is a question for counsel; we state it rather than hide it.

The complete list of services outside this data path is in §4 — **none of them receives visitor-derived data**.
Remote administration by staff located outside the EU/EEA is a transfer question for counsel (§7).

## 2. Where every kind of data is processed or stored

### 2.1 Today: the single-VM profile (one VM, one EU region)

Source: the deployed system (V).

| Location | Region · component | What data | Personal data? | Notes |
|---|---|---|---|---|
| Gateway memory | EU region, the single VM | IP address, raw User-Agent, `Referer`, challenge tokens, per-event retry IDs (10-minute window), multiplicity and rate-limit counters (keyed, per truncated subnet, no IP kept), the edge keys `K_day`, multiplicity key and `K_chal` | **Yes**, transiently | Memory only; IP and UA destroyed at the end of each request; edge keys in locked memory, destroyed at the daily/hourly switch; core dumps off (ADR-0005/0006/0007; C-04, C-37, C-66, C-68, C-80, C-90). OTLP requests: tenant tokens and foreign vendor headers in memory only |
| Gateway spool | same VM, its Standard SSD | Reduced web event records — **no IP, no raw User-Agent** — and verdict/reason counter records | Yes (pseudonymous; residual PII possible in paths/props the scrubber cannot recognise) | fsync'd, deleted on acknowledgement, never older than 72 h (ADR-0011; C-18, C-52); no copies anywhere else (C-77) |
| Collector queue | same disk | Sanitised API metric points | No end-user data by design | 72-hour cap (ADR-0009; C-18) |
| Engine proxy memory | same VM | Umami visit cache tokens per (site, surrogate) | Yes (pseudonymous), transiently | Memory only, 30 minutes (C-74) |
| PostgreSQL `umami` database | same disk | Web event-level data (events, sessions, custom-event properties) | Yes (pseudonymous) | **90 days** by default, 30–395 days settable (ADR-0011; C-54) |
| PostgreSQL `scf` database | same disk | Tenants, accounts, sessions, hashed keys, encrypted Umami credentials, audit log, erasure requests (literal selector only until the job has finished plus 56 days), web and API aggregates, trust scores, on-chain daily counts | Account/audit data yes; aggregates intended anonymous | RLS on every tenant-owned table (ADR-0013; C-17, C-40, C-64, C-72, C-85, C-88, C-112) |
| Monitoring overlay, status page, Gatus | same VM | Prometheus metrics, VictoriaLogs (30 days), Grafana, Alertmanager (alerts recorded locally only — no outside alert channel yet), the host probe's results, the public status page `status.usagemap.dev` | No visitor data: logs never contain IPs, User-Agents, request headers or tokens (ADR-0022; the live log scan found 0 findings, evidence above) | Monitoring bound to 127.0.0.1 (C-71); the status page is served **from the same VM** |
| Weekly restore drill | same VM (timer `scf-restore-drill`) | Restored copy of the databases from repository 2, in a scratch volume | Yes | Scratch volume deleted after each drill; only pass/fail, timings and checksums are kept (C-56) |
| pgBackRest repository 1 | same VM disk (`/var/lib/pgbackrest-repo/1`) | Weekly full + daily differential backups and WAL of the databases | Yes | Encrypted (AES-256-CBC, cipher pass on the VM); 35-day time-based full retention. Protects against database errors and operator mistakes, **not** against loss of the VM or its disk |
| pgBackRest repository 2 | same EU region, one storage account, no geo-redundancy | same, plus the weekly logical dump under `dumps/` (`pg_dump` of every database + a checksum manifest) | Yes | Encrypted on the VM before upload (pgBackRest AES-256; age for the dump, private age identity off the hosting provider). Blob versioning, soft delete 14 days (blobs and containers), previous versions deleted after 14 days; the VM writes with a container SAS that cannot delete versions; network access only from the VM's subnet and the operator's address (C-108, C-110, C-112; `live-deploy` "Backups and protection") |
| OpenTofu state | operator workstation, outside the repository | Infrastructure state | No visitor data | Encrypted client-side (ADR-0019); not in the cloud on v1 |

**No second region today.** Both repositories are in the same region and repository 2 has no geo-redundant copy. A
regional or datacenter-wide loss would lose the service and its backups at once; v1 has no geo-redundant copy. The
full-size design (§2.2) adds one.

Erased or expired data leaves all backups within **56 days** (35-day retention + up to 7 days until the next full +
14 days as a previous version, data-model §14; C-29 as corrected by C-112). On v1 the same bound applies to both
repositories.

### 2.2 Full-size design — not what runs today

The production design (lean Azure profile C-123 at full size, [`../deployment-topology.md`](../deployment-topology.md)
§1, and the multi-node scale-out profile of the same document) differs from v1 in where things sit, not in what data
exists: a larger `app-1` VM with a separate Premium SSD data disk, an optional `standby-1` VM for restore drills,
**two storage accounts in two EU regions** (repository 1 and repository 2, each ZRS, private endpoints, written with
the VM's managed identity), Azure DNS for the tracker zones, and the OpenTofu state in a storage account. The IaC
for it (`infra/opentofu/modules/azure-lean`, `modules/azure-platform`) accepts only EU/EEA regions. None of it is
deployed today; this statement will be re-issued before any of it is (§8 and [`sub-processors.md`](sub-processors.md) §4).

## 3. Provider facts for the supported Azure profile

The hosting provider of the hosted instance is named to customers in the DPA annex. The facts below apply when the
service is deployed with the repository's Azure infrastructure code.

| Fact | Value | Label |
|---|---|---|
| Provider and ownership | Microsoft Corporation, USA — US-owned (C-96) | V |
| Region | **One EU region** for the VM, its disk and the backup storage account; the IaC accepts only EU/EEA regions | V (IaC) |
| Disk encryption | Managed disks encrypted at rest by the platform with platform-managed keys; encryption at host off on v1 (`encryption_at_host = false`, `infra/opentofu/envs/v1-small`) | L (platform default) / V (IaC) |
| EU Data Boundary | "For Azure, regional services that a customer deploys in an EU Data Boundary region will be in-scope for the EU Data Boundary"; non-regional services need configuration (learn.microsoft.com/privacy/eudb/eu-data-boundary-learn, read 2026-11-13). The DPA: "For EU Data Boundary Services, Microsoft will store and process Customer Data, Personal Data, and store Professional Services Data at rest within the European Union and the European Free Trade Association" | V |
| Data Privacy Framework | Microsoft's DPA states: "Microsoft is certified to the EU-U.S. and Swiss-U.S. Data Privacy Frameworks, the UK Extension to the EU-U.S. Data Privacy Framework" (Microsoft Products and Services DPA, English, November 2026, read 2026-11-13). The public DPF list itself (dataprivacyframework.gov) could not be read by script | V (DPA) / U (DPF list) |
| Standard Contractual Clauses | The DPA makes all transfers of Customer Data and Personal Data out of the EU/EEA subject to the 2021 SCCs (processor-to-processor module) "between Microsoft Ireland Operations Limited and Microsoft Corporation" (same DPA) | V |
| EU entity | Microsoft Ireland Operations Limited, Dublin, is Microsoft's data protection representative for the EEA and Switzerland (same DPA). Which Microsoft entity is the **contracting party** depends on how the subscription is bought (direct, CSP partner, enterprise agreement) and is to be confirmed | V (representative) / U (contracting entity) |
| Microsoft personnel access, government requests | Governed by the DPA and Product Terms (Appendix C "Additional Safeguards Addendum", Appendix D on challenging orders); not analysed further here — for counsel | U |

What is **not** claimed: that Azure is "EU-owned", "sovereign" or outside US jurisdiction. The earlier multi-provider
design (EU-based providers only, ADR-0017/0018) remains the documented alternative; a service operator who needs EU
ownership can run the same software elsewhere (the Ansible roles and the Compose stack are provider-neutral; only
`infra/opentofu` is Azure-specific).

## 4. Outside the EU-hosted data path — complete list

None of these receives visitor-derived data (C-26). "Today" marks what the v1 host actually uses.

| Service | Company · location | Today? | What it does for us | Data it sees |
|---|---|---|---|---|
| **Cloudflare DNS** | Cloudflare, Inc., USA (global anycast) | **Yes** | Authoritative DNS for `usagemap.dev` (apex, `app`, `status`, `e1`, `e2`, CAA), **DNS-only — no record is proxied**; the ACME DNS-01 challenge TXT records are written through its API with a token limited to editing this one zone | **DNS queries only**: our hostnames, record types and the address of the recursive resolver that asks (normally the visitor's ISP or public resolver, not the visitor); where a resolver sends EDNS Client Subnet, also a truncated prefix of the asking network (L: depends on the resolver). It never sees HTTP traffic, events, cookies or telemetry, because no traffic passes through it |
| **Let's Encrypt** | ISRG, USA | **Yes** | TLS certificates (ACME DNS-01 by lego on the VM) | Certificate requests containing our hostnames; the ACME account key's public half; certificates are public (CT logs) |
| **GitHub** | GitHub, Inc. (Microsoft), USA | Source only (private repository) | Source code. Designed for the scale-out profile: releases and container registry, public issue tracker, status-page history, scheduled outside checks, the dead-man's-switch workflow, the public evidence repository; sign-in identity provider for tenant users who choose GitHub OAuth (`read:user` scope only) — **not configured on the live host** | Today: source code. When used as designed: build artefacts, the credentials the release build needs to sign and publish, never production credentials or backup keys (C-56, C-79), probe results of public endpoints, support issues under users' GitHub identities, GitHub identity of users who sign in with it (account data, C-20). **No visitor data by design** |
| **npm registry** | npm, Inc. (GitHub/Microsoft), USA | No (package not yet published) | Distribution of `@usagemap/tracker` | Package code only |
| **Public Horizon** (`horizon.stellar.org` by default) and other configured Stellar RPC/Horizon hosts | public network operators | **Yes**, when a check runs | Contract verification, on-chain correlation's day-anchor check (C-150) | Public account or contract IDs being checked; ledger numbers |
| **On-chain sources** (optional, off by default) | Google BigQuery public Hubble dataset (dataset location to be confirmed), or public ledger files on AWS Open Data | No (ledger download disabled on v1) | Daily counts per tenant-declared contract (§6) | Tenant-declared contract IDs (public) in queries; **public ledger data only** |
| **Alert channels** `<chosen by the operator>` | recorded in [`sub-processors.md`](sub-processors.md) when chosen | No (alerts are recorded on the VM only) | Deliver alerts to the operator | Alert text; no visitor data by rule |
| **Stellar public network** (optional) | public, global ledger | No | Daily anchoring of the audit-chain head hash from a platform account, when anchoring is enabled (C-26, C-63) | **One hash value per day, no personal data** |

Other outbound connections that send no collected analytics data (in the lean profile only the `public` container
network and the host may leave the VM, on 80/443 and NTP; there is no separate egress proxy, C-123): the domain
verifier (tenant domains, private ranges blocked); registry sync (Stellarlight, PG Atlas); the API liveness probe (the
tenant's declared API base URL); the geo database fetched at image build by pinned checksum; the **range-list
updater** (timer `scf-rangelists`), which fetches the cloud-provider, Private Relay, Tor-exit and VPN lists from the
publishers' URLs into a local volume — never baked into images (C-38); operating-system and Docker package mirrors.
The Azure platform's guest-agent endpoint (168.63.129.16) is reachable from the host (platform-internal).

## 5. DNS, monitoring, builds and status page

- **DNS (today).** Cloudflare, DNS-only, five A records and one CAA record (`issue letsencrypt.org`), defined in
  OpenTofu (`infra/opentofu/envs/v1-small`). The token on the VM can edit DNS records of this one zone only (used for
  `_acme-challenge` TXT records). Cloudflare sees queries from recursive resolvers, not the analytics payload. (Full-size
  design: Azure DNS for the tracker zones, C-123.)
- **Monitoring (today).** Prometheus, Alertmanager, Grafana, VictoriaLogs, Gatus and the host probe run on the VM,
  bound to 127.0.0.1; logs never contain IPs, User-Agents, request headers or tokens. The one view from outside the VM
  is the operator workstation's probe (`ws-1`, another network), which records probe results only. **There are no
  GitHub-hosted checks running today.**
- **Builds and tests.** Builds and tests run on a maintainer workstation with no production data and no production
  credentials. Deployments run from the service
  operator's workstation with secrets kept outside the repository ([`../guides/deploy-v1.md`](../guides/deploy-v1.md)).
- **Status page.** `status.usagemap.dev`, served by `scf-ops status-page` **from the same VM** it reports on: probe
  results only. It cannot report a total outage of the VM. (Scale-out design: a status page hosted
  outside the infrastructure it monitors, design trade-off DV-06.)

## 6. Optional on-chain correlation

Off by default; enabled per tenant (ADR-0017, ADR-0028; C-26). The daily job sends one batched query per table with
the contract IDs that tenants have declared for this purpose, and stores the returned daily aggregates (transaction
counts, distinct source-account counts, fees) in the `scf` DB in the EU. Nothing from web or API analytics is sent;
no invoking address or per-address series is received or stored. Contract IDs are public ledger data; should the
register later allow tenants to declare `G…` project accounts, a declared account can belong to a natural person (a
sole developer) and must then be documented as "public ledger identifier, declared by the tenant for this purpose".
The fallback is our own Go reader of public ledger files on AWS Open Data (`/services/onchain-reader`, C-42), which
needs no Google account and downloads public data only. Who owns the GCP project is decided by the operator; the BigQuery dataset
location is to be confirmed (C-26).

## 7. Who can access what, from where

| Who | Access | From where |
|---|---|---|
| Tenant users (`owner`, `admin`, `member`, `viewer`) | Their own tenant's dashboards, keys, audit, erasure (RLS + API authorisation); dashboards apply `anonymous_reports` unless the tenant switched it off (C-51) | Anywhere (web portal) — the tenant, as controller, decides who in its team sees its data |
| SCF operators (`operator`, `operator_admin`) | Global view only through the thresholded, rounded `op_*` functions; every read audited; no event-level access (C-17) | Anywhere (web portal) — anonymous aggregates only |
| Machine consumers with SCF operator API keys | Scoped keys (`web:read`, `api:read`, `registry:read`), default expiry 90 days, checked on every request (C-06) | Anywhere — anonymous aggregates only |
| Holders of a tenant's `pub` share key, or the public if the tenant switched public stats on | That tenant's thresholded, rounded `metrics_endpoint` (C-14, C-47) | Anywhere — anonymous aggregates only |
| Service-operator administrators | Infrastructure: the VMs, databases (`umami` and `scf`), backups, the gateway spool, secrets | **To be decided with counsel.** Rule until then: event-level access only from EU/EEA-located administrators, or under SCCs + TIA |
| Microsoft (as infrastructure provider) | Platform access under its DPA; Azure principals with rights on the subscription can run commands on the VM and snapshot its disks ([`threat-model.md`](../threat-model.md) TM-AZ-01/02) | Microsoft's operations; our own Azure principals are named people only |
| GitHub-hosted release build (design; not set up) | Build, test, sign and publish only; **no** production credentials, **no** backup keys (C-79) | GitHub-hosted runners (location not controlled by us); restore drills never run there (C-56) |
| Cloudflare (DNS provider) | Our zone's DNS records through its dashboard/API; no access to the VM, its data or its traffic | Cloudflare's operations; our token edits DNS records of one zone only |

## 8. What changes at handover

At handover the community-appointed service operator `<SUCCESSOR-OPERATOR>`
takes over:

1. **Processor identity changes.** Tenants are notified in advance through the sub-processor/processor-change process
   ([`sub-processors.md`](sub-processors.md) §4); the DPA is novated or re-accepted with the successor.
2. **Providers may change.** The Azure subscription can be transferred (its role assignments and managed identities
   are deleted by Microsoft on a cross-tenant transfer and are re-created from IaC — [`handover-plan.md`](../handover-plan.md) §5.6),
   or the successor rebuilds from the IaC in its own subscription or elsewhere; this statement is re-issued before any data moves. The commitment to EU/EEA processing must be confirmed by the successor
   or tenants must be told it no longer holds.
3. **Data migration** uses the encrypted weekly logical dump (ADR-0021), transferred between EU locations.
4. **Keys.** `K_day`, the multiplicity key and `K_chal` are never transferred (they exist only in memory, C-68). The
   three key peppers (`ing`, `op`, `pub`) and the snapshot-signing key
   are handed over securely and **not** rotated at cut-over, because rotation would invalidate every token; they are
   rotated afterwards by issuing new tokens with overlap (C-50, C-81). The SEP-10 signing key and its `stellar.toml`, and the
   audit-anchor account key, are on the handover rotation list (C-15, C-63).
5. **Old copies.** After the successor confirms a working system, the outgoing service operator deletes its
   VMs, disks and storage accounts, lets backups expire on schedule — all within 56 days (C-29, C-112) — or deletes
   them, and confirms deletion in writing.
6. **Domains** are **transferred** to the successor; a redirect is insufficient for ingest from pinned trackers and
   is offered only as a temporary measure for the portal (C-50). DNS providers may change.
7. **GitHub / GCP accounts** transfer with the repository and, if used, the BigQuery project. What
   happens to provider accounts, the container registry and the signing identity on a repository transfer is
   unverified until the handover rehearsal (C-50).
