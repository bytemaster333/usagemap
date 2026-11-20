# Service levels and support model

| | |
|---|---|
| Status | First written 2026-11-12; revised 2026-11-21. **One v1 host (the single-VM profile) runs the hosted instance** (§1.2); no monthly SLO report has been published yet, and everything this document says about edge nodes, core nodes, `probe-d`, Upptime, GitHub-hosted checks or the dead-man's-switch workflow is **design for the scale-out profile, not what runs today**. |
| Binding decisions | ADR-0017 (residency), ADR-0018 (topology), ADR-0019 (IaC), ADR-0020 (HA and spool), ADR-0021 (backup/DR), ADR-0022 (observability), ADR-0023 (release and patching), ADR-0031 (SLIs/SLOs), ADR-0032 (SCF programme data), and the binding design decisions C-01…C-112 at the end of the register (C-99…C-109 record the day-0 spike results); where a later clarification differs from an earlier one or from an ADR, the later one is the decision. See [`docs/adr/README.md`](adr/README.md). |
| Applies | To the hosted UsageMap instance (`usagemap.dev`) while its maintainers operate it, until a successor operator accepts a handover ([`handover-plan.md`](handover-plan.md)). Self-hosted deployments can adopt the same definitions and measurement. |
| Placeholders | `<domain-a>`, `<domain-b>`, `ORG/REPO`, `@SCOPE/tracker` stand for a deployment's own domains, repository and npm scope. |
| Capabilities | ops.service-window-start, ops.hosting, support.user-support, slo.ingest-availability, slo.dashboard-availability, security.patch-24h, support.first-response, support.resolution, support.public-issue-tracker, slo.concrete-commitments, ops.hosted-service-window in [`capabilities.md`](capabilities.md). |
| Deployment profile | **Running today: the v1 host** — one small VM in an EU region with one Standard SSD, pgBackRest repository 1 on that disk and repository 2 in one storage account in the same region, DNS at Cloudflare (DNS only), certificates from Let's Encrypt (§1.2, §11.0). **Designed, not deployed:** the full-size lean Azure profile (C-123: a larger VM with a Premium SSD data disk, optional standby VM, backups in two EU regions) and the multi-node scale-out profile. **Scale-out profile (C-180): we commit to 99.99 % ingest and 99.90 % dashboard availability, operated on the scale-out profile ([`scale-out-plan.md`](scale-out-plan.md)).** The v1 host is the launch host; its objective is 99.5 % (§1.1). |
| Companion | [`deployment-topology.md`](deployment-topology.md) (lean Azure profile; scale-out tiers); [`cost-model.md`](cost-model.md); [`monitoring-plan.md`](monitoring-plan.md) (the same SLI definitions, the alerts and the monthly report). |

Three kinds of statement appear in this document, and each is labelled:

- **Objective (O)**: a level of service we design for, measure and report against every month, with an error-budget
  policy (§5). Objectives are not guarantees (C-78): 99.99 % ingest and 99.90 % dashboard availability are
  operational targets, and the arithmetic in §2.1 shows why no team without on-call can promise them as a
  contractual guarantee. **On the scale-out profile we commit to these targets (C-180):** 99.99 % ingest and 99.90 % dashboard availability per calendar month, run on the scale-out profile of
  [`scale-out-plan.md`](scale-out-plan.md) (two edges, two cores, Patroni, health-controlled DNS), measured and
  published every month. The v1 host that runs today is one VM in one zone and cannot be engineered to
  99.99 %; it keeps a 99.5 % objective until the scale-out profile runs (§1.1). Design trade-off DV-41 is withdrawn for the
  scale-out profile.
- **Commitment (K)**: something we do commit to and that depends only on us doing it: the measurement method, the
  monthly publication with raw data, post-mortems, support times, the patch process, residency, the load test.
- **Target (to be measured) (M)**: a design figure that has not been measured yet. Each one is measured, and the
  measured value replaces the target here, before the scale-out profile goes live (§16).

## 1. Summary of objectives and commitments

| # | Area | Objective, commitment or target | How it is measured | Where it is reported |
|---|---|---|---|---|
| O1 | Ingest availability (web events) | **Scale-out profile: 99.99 %** per calendar month (≈ 4.4 min per average month) (C-180). **No maintenance exclusion.** v1 host: 99.5 % (§1.1). | **Headline: 30-second probe rounds with a 2-of-3 quorum**, defined once in §2.2 and identically in the monitoring plan (C-78). Published next to it: availability per ingest hostname and per edge node, the OTLP probe figure and the server-side ratio, with any difference explained (C-43). | Monthly SLO report, status page |
| O2 | Dashboard availability (portal + metrics API) | **Scale-out profile: 99.90 %** per calendar month (≈ 43.8 min per average month) (C-180). No maintenance exclusion (C-43). v1 host: 99.5 % (§1.1). | Synthetic journeys every 5 minutes (§3.3); on the v1 host every 60 s from the host probe, plus the operator workstation's probe (§1.2) | Monthly SLO report, status page |
| O3 | Durability | **Objective: no accepted event is lost unless it could not be delivered for 72 hours, or the edge node that accepted it is permanently lost before forwarding it** (C-18, C-77). The second case loses that node's undrained backlog, normally seconds of its traffic. Every discard and every loss is counted, published and followed by a post-mortem. | Spool accounting on every edge node, reconciled daily, plus end-to-end canary counts (§3.4, C-76) | Monthly SLO report |
| O4 | Freshness | **Objective: 99 %** of accepted events visible in dashboards within **5 minutes** of acceptance and **99.9 %** within **60 minutes**, per calendar month (C-28, C-43) | Canary events, timed from acceptance to visibility through the read path | Monthly SLO report |
| K1 | Measurement and publication | We measure O1–O4 exactly as defined in §2–§3, publish a monthly SLO report with the **raw per-probe data of every probe source** so anyone can recompute the figures, and never change a definition retroactively (§5, §7) | The report and the raw files themselves. **None published yet:** the first report covers the first full month the service runs; `docs/evidence/slo/` does not exist yet | `docs/evidence/slo/`, status page |
| K2 | Security patches | Critical and high vulnerabilities **patched or mitigated in production within 24 hours** of the clock starting (§8). This depends on named people: a daily watch roster and two named patch responders (§6.3; C-49, C-67); until the maintainers name them, K2 is conditional. | Timestamps in the advisory or issue record | Monthly patch-latency table in the SLO report |
| K3 | Support response | First maintainer response **≤ 5 business days** | Issue automation (§9.3) | Monthly support table |
| K4 | Support resolution | Resolved **≤ 10 business days** (definition in §9.2) | Issue automation | Monthly support table |
| K5 | Capacity | Sized for **1,000,000 API requests/day** and **1,000,000 web page views/day** across all tenants and load-tested at **10×** before the scale-out profile goes live (C-48) | Load-test report in `docs/evidence/` | Monthly SLO report |
| K6 | Transparency | Public status page; public post-mortem **within 5 business days** of resolving any objective miss or lost event; every objective miss announced on the status page within 1 business day | The artefacts themselves | Repo and status page |
| K7 | Residency | All visitor-derived and telemetry data processed and stored in an **EU region**, today a single region (VM, disk and the backup account; no second region on v1). Where the provider is US-owned (as on the Azure profile, C-96, C-123), the residency statement explains the transfer position. Cloudflare (authoritative DNS, DNS-only: sees DNS queries, never visitor traffic) and the other services that see no visitor data are listed in §11.2 and [`privacy/sub-processors.md`](privacy/sub-processors.md). | IaC region constraints, sub-processor list | `docs/privacy/` |
| M0 | Database recovery point and time (lean profile) | **Targets, to be measured on Azure:** **RPO ≤ 60 s** for a loss of the data disk, zone or region (WAL archived to both repositories at least every 60 s, `archive_timeout`; a VM failure with the disk intact loses nothing committed); **RTO ≤ 4 h** to a working service from IaC + backups, on `standby-1` or a new VM | Timed restore and rebuild drill on Azure (§16) | Drill records |
| M1 | Database failover (scale-out profile only; the lean profile has no standby database) | Target 30–60 s automatic, ≈ 0 data loss with both database nodes healthy (ADR-0021). **Measured on Compose (2026-11-13, C-120):** primary killed under write load → standby promoted in **≈ 24 s** (21.6–26.8 s over the day's runs), longest client write gap **≈ 30 s**, **0 acknowledged commits lost** (2,443 commits); an isolated primary demoted itself in 11.8 s; the old primary rejoined via `pg_rewind` in ≈ 30 s ([`docs/evidence/chaos/postgres-ha-2026-11-13.md`](evidence/chaos/postgres-ha-2026-11-13.md)). Still to be measured on the production nodes. Promotion itself took ≈ 0.5–1 s in S-08, so detection dominates; the old primary is always fenced (stopped, restarted as a standby, `pg_rewind`) before it rejoins, because unfenced it accepted diverging writes (C-108) | Chaos test and drill logs | Drill records |
| M2 | Rebuild from zero | **Target, to be measured**: ≈ 4 h wall clock into empty accounts (ADR-0021) | Quarterly DR drill | `docs/evidence/dr/` |
| M3 | Full database restore | **Target, to be measured**: ≤ 2 h from the moment a human starts it | Weekly restore drill | `docs/evidence/restore-drills/` |

### 1.1 Why the v1 host has its own objective (C-123, C-180)

| | v1 host (**runs today**) | Lean Azure profile, full size (designed, not deployed) | Scale-out profile (designed, not deployed) |
|---|---|---|---|
| Shape | one small VM, one **Standard SSD**, one EU region | one larger VM, Premium SSD data disk, optional standby VM | edges across zones or providers, two cores, Patroni |
| Ingest availability | **objective 99.5 %** per month — not a guarantee | objective 99.5 % | **commitment 99.99 %** (C-180) |
| Dashboard availability | **objective 99.5 %** per month — not a guarantee | objective 99.5 % | **commitment 99.90 %** (C-180) |
| Platform bound (single-instance VM SLA, below) | 99.5 % (Standard SSD) | 99.9 % (Premium SSD on every disk) | — (multi-instance) |
| Durability (O3) | every accepted event is stored, except after 72 h undeliverable or loss of the VM's one disk | same, the spool on the data disk | unchanged |
| Database | RPO target ≤ 60 s to repository 2 (`archive_timeout` 60 s, WAL archived asynchronously); restore of the latest off-host backup measured at 13.9 s for the 47.5 MB database of the first drill; RTO for a lost VM = rebuild from IaC + repository 2 | RPO ≤ 60 s, RTO ≤ 4 h (M0, targets) | synchronous standby, failover ≈ 24 s, 0 acknowledged commits lost (M1, measured on Compose) |

Reasons, all checkable:

- **The platform bound.** Microsoft's SLA for a single-instance VM is set by the lowest disk type on the VM: **99.9 %**
  with Premium SSD, Premium SSD v2 or Ultra Disk on every OS and data disk, **99.5 % with Standard SSD**, 95 % with
  Standard HDD (monthly uptime; Service Level Agreement for Microsoft Online Services, English, **November 17, 2026**
  edition, "Uptime Calculation and Service Levels for Single-Instance Virtual Machines", downloaded from
  microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services, read 2026-11-19). An objective
  above the platform's own commitment for the one machine everything runs on would be salesmanship. **On v1 the
  objective equals the platform bound: there is no margin.** One platform incident at the edge of the provider's own
  commitment, plus our maintenance restarts, can miss 99.5 % in a month. Note also that the provider's figure excludes
  its announced scheduled maintenance; ours has no maintenance exclusion. We keep 99.5 % as the v1 objective because it
  is what one VM can honestly be held to; the honest expectation for a month with a host event is "may be
  missed", and every miss is reported (K6).
- **Our own downtime comes on top**: kernel and Docker security updates that need a restart, PostgreSQL minor
  upgrades and Umami upgrades (`umami-views-drop → umami-migrate → umami-views`) all stop ingest or dashboards for
  minutes on one VM. 99.5 % leaves ≈ 3.65 h per month for these and for platform incidents; 99.9 % (43.8 min) would
  be used up by one unlucky host event plus two maintenance restarts.
- **Durability does not depend on availability.** The tracker retries for 72 h and the gateway acknowledges only
  after an fsync to the spool on the VM's disk (v1: the one Standard SSD; full-size lean profile: the Premium SSD data
  disk), so downtime delays events; it does not lose accepted ones — unless that disk itself is lost.
- **Measurement in the lean profile.** The three independent probe sources of §2.2 (`mon-c`, `probe-d`, edge
  probers) do not exist. The scale-out design computes the SLI from GitHub-hosted checks (outside
  Azure) and the local probe; **on the v1 host the GitHub-hosted checks do not run** (not built).
  What runs is described in §1.2. The 2-of-3 quorum of C-78 is not available; the open point P7 (§17)
  proposes a second outside source.
- **How the hosted instance reaches 99.99 %** is the scale-out profile: two edges in two zones, two cores with a
  Patroni synchronous standby, a witness and monitoring node in a second EU region, health-controlled DNS at two
  providers. Layout, error budgets, cost and the steps before it goes live are in
  [`scale-out-plan.md`](scale-out-plan.md); the Patroni failover is already measured on Compose (M1). The deployment
  code for that profile is built before it goes live (scale-out plan §5).

### 1.2 What runs today on the v1 host

Facts from the deployment and [`guides/deploy-v1.md`](guides/deploy-v1.md):

| | v1 host |
|---|---|
| Compute | one small VM in one EU region, no availability set or zone redundancy, no failover |
| Disk | one **Standard SSD**, holding the OS and all data |
| Backups | pgBackRest repository 1 on the VM's disk; repository 2 and the weekly age-encrypted dump in one storage account, blob versioning, 14-day soft delete — same region, no geo copy |
| DNS and TLS | Cloudflare, DNS-only (never proxied); Let's Encrypt via ACME DNS-01 |
| Probes that exist | the **host probe** `probe-mon-c` on the VM (canary every 30 s, signed-in journey every 60 s), Gatus on the VM, and the **operator workstation's probe** `ws-1` (another network, not shown on the status page). No `probe-d`, no edge probers, no GitHub-hosted checks, no dead-man's-switch workflow |
| Status page | `status.usagemap.dev`, served **from the same VM** it reports on — it cannot show a total outage of the VM |
| Alerts | recorded on the VM only; no outside channel yet, nobody is paged |
| Monthly SLO report | none yet; months with < 95 % probe coverage are "not measured", never "met" (C-146) |

**Objective for v1: 99.5 % ingest and 99.5 % dashboard availability per calendar month — an objective, not a
guarantee, with no margin above the provider's 99.5 % single-instance bound for Standard SSD (§1.1).** 99.99 % and
99.90 % are our commitment on the scale-out profile (C-180); they are never claimed for the
v1 host.

We offer no financial credits; our remedies are transparency measures (§14).

## 2. Definitions

### 2.1 Downtime arithmetic

We use an average month of 30.44 days = 43,830 minutes (365.25 / 12). The figures below are computed, not
measured.

| Objective | Allowed per 30-day month | Allowed per average month | Allowed per year |
|---|---|---|---|
| 99.99 % (ingest) | 4.32 min | **4.38 min** | 52.6 min |
| 99.9 % (dashboard) | 43.2 min | **43.8 min** | 8.77 h |
| 99.5 % (lean profile, ingest and dashboard, C-123) | 3.6 h | **3.65 h** | 43.8 h |

What this means in practice:

- With 30-second probe rounds, the whole monthly ingest budget is about **8 bad rounds** (87,660 rounds in an
  average month).
- A single restart that drops ingest for 5 minutes misses the month's ingest objective.
- A human who is woken up typically needs 15–30 minutes to respond. That is 3–7 months of ingest budget.
  So ingest recovery has to be automatic. Humans restore redundancy afterwards (§6).
- The dashboard budget allows roughly one manual database promotion of about 10–40 minutes per month, but
  the design does not rely on that: failover is automatic, and dashboards can fall back to read-only.

### 2.2 SLI formulas (ADR-0031, C-78)

**Ingest availability — the headline figure (C-43, C-78).** This definition is used word for word in
[`monitoring-plan.md`](monitoring-plan.md) §4.1:

> Every 30 seconds each of the three probe sources (`mon-c`, `probe-d`, and the cross-provider probes on the edge
> nodes — C-30) sends a canary event for the canary site, as the pinned tracker does. The source records the round
> as good when at least one of the two ingest hostnames accepts the event (2xx after durable persistence) within
> 2 seconds, on the first attempt or on one retry to the other hostname. A round is good when at least two of the
> three sources record it good (2-of-3 quorum). Monthly ingest availability = good rounds ÷ rounds. Availability per
> ingest hostname and per edge node is published alongside and alerted on.

```
                      good rounds
ingest availability = ───────────        per calendar month, objective ≥ 99.99 % on the scale-out profile (C-180); ≥ 99.5 % on the v1 host
                        rounds
```

- **Accepted**: the gateway returned 2xx **after** the event was appended to the node's spool and fsync'd (group
  commit allowed, ADR-0020), and the response arrived within 2 seconds. The code path cannot send a 2xx before fsync
  returns.
- A 2xx sent later than 2 s, a 5xx, a 429 or 503 caused by global overload, a timeout, a DNS error or a TLS failure
  is **not accepted**.
- **One retry, as the tracker does**: the pinned tracker rotates between the two ingest hosts on two domains
  (ADR-0004), so the round reflects what a real browser experiences when one hostname or one node fails.
- **Missing probe sources**: a source whose own self-check fails in a round does not vote. With two voting sources a
  round is bad only if both record it bad; with one left, its result counts on its own (the conservative choice).
  Rounds decided by fewer than three sources are counted and published.
- **Why per-hostname and per-node figures are published**: a round succeeds if *either* hostname works, so a
  black-holed node or a lost domain does not by itself make a round bad, even though real browsers on that path wait
  up to the tracker's 3 s timeout or lose a page-hide `fetch(keepalive)`. Two further figures are therefore
  published every month and alerted on (monitoring plan §4.4):
  - **per ingest hostname**: the same rounds, counting only the first attempt against that hostname (no retry);
  - **per edge node**: the same canary event sent to each node address directly, bypassing DNS.
- **OTLP**: in the same rounds each source sends a small OTLP/HTTP metrics export with a probe-only ingest token.
  Accepted means 2xx after the Collector's persistent queue has stored the batch with `fsync: true` (ADR-0009). Its
  figure is published next to the headline, computed with the same rules. Spike S-04 confirmed the persistent queue
  with `fsync: true`: requests acknowledged while the writer was down survived `kill -9` of the Collector and were
  delivered exactly once afterwards (C-107); power loss was not tested.

**Ingest availability — server-side ratio** (published next to the headline, C-43):

```
                                  accepted requests
ingest availability (server) = ───────────────────
                                   valid requests
```

- **Valid request**: any request that reaches an edge node on a published ingest route (web and OTLP), minus the
  exclusions in §4. The routes are listed in `docs/api/`; their final names depend on the ad-blocker filter-list
  check (ADR-0004/0005).
- **Accepted request**: as above.
- This view is blind to requests that never reach an edge (DNS failure, every node unreachable, a partition); the
  probe view covers that gap, which is why the probe view is the headline (C-43). Any difference between the two is
  explained in the monthly report.

**Dashboard availability:**

```
                         good journey windows
dashboard availability = ────────────────────     per calendar month, objective ≥ 99.90 % on the scale-out profile (C-180); ≥ 99.5 % on the v1 host; scale-out design
                            journey windows
```

- A journey window is 5 minutes. It is good when at least two of the three probe sources record a successful
  journey in it (§3.3), with the same rule for missing sources as above.
- Read-only mode (ADR-0020, used when the primary database is unavailable) counts as available, because the
  journey only reads. Windows spent in read-only mode are published separately so nobody mistakes them for
  full service.

**Durability (C-76):**

Every spooled web record carries its node ID, segment and offset. On every edge node, every day:

```
records fsync'd = records acknowledged + records expired under the 72-hour rule + records still queued
```

- *Acknowledged* means the engine answered the forwarder with success. That includes events Umami silently drops
  as bots while still answering 200, which the forwarder counts as `engine_bot_drop` (C-69); they are delivered,
  not lost, and their count is published.
- *Expired under the 72-hour rule* (C-18): the 72-hour cap is deliberate. A record or metric batch that could not
  be delivered for 72 hours is discarded and counted as "undeliverable (72 h)". It is outside the durability
  objective as worded, but it is published every month and triggers a post-mortem. The Collector queue has the same
  cap; the writer's de-duplication ledger keeps 7 days.
- An equation that does not balance on a node is a loss and triggers an alert and a post-mortem.
- **What spool accounting cannot see** (C-77): there are no copies of spool segments in object storage. If an edge
  node is permanently lost (disk destroyed) before it forwards, its undrained backlog is lost — normally seconds of
  that node's traffic, more if the core was unreachable at the time. The node's last reported accounting bounds the
  loss, and the bound is published.
- **End-to-end cross-check** (C-76): the probe sources send canary events of a known hourly count to the canary
  site; the reconciliation job counts them in Umami. A shortfall is reported even when every node's equation
  balances, because it would mean the forwarder's acknowledgement did not imply storage.
- Events delivered more than once (at-least-once delivery, ADR-0020) are not losses. They are counted and reported
  as "ambiguous retries".
- OTLP: the Collector's persistent queue and the writer's batch ledger are reconciled the same way (batches queued =
  batches acknowledged by a writer + batches expired at 72 h + batches still queued). The Collector has no age-based
  eviction (S-04), so the 72-hour cap is enforced end to end: `scfsanitize` stamps the receipt time as resource attribute `scf.received_at_unix_nano`, and the writer drops points received more than 72 h earlier, counted `undeliverable_72h` (C-112); the queue size limit stays as the second bound (C-107, risk R-28). Such points are
  counted, never silently dropped. The sanitise step's 48-hour late-data bound against `x-scf-received-at` remains a
  data-quality rule (`too_old`), not the cap.

**Freshness:**

```
                 accepted events visible ≤ 5 min after acceptance
freshness = ──────────────────────────────────────────────────────     objective ≥ 99 % per month
                             accepted events
```

The same ratio with a 60-minute limit has an objective of **≥ 99.9 %** per month (C-28, C-43).

- Freshness is measured on canary events (§3.5) and runs from acceptance at the edge to visibility through the
  dashboard read path.
- It does not include the tenant SDK's own export interval: OpenTelemetry metrics are exported every 60 s by
  default (OTel specification, `OTEL_METRIC_EXPORT_INTERVAL`).

**Coverage floor (C-146).** A month's objective is judged only when ≥ 95 % of its slots were measured (a good or bad
verdict; unknown rounds and missing slots are not measured); otherwise the month is reported as *not measured*, never
as met (`tools/support/slo-report.ts`).

## 3. How each SLI is measured

### 3.1 Server-side counters

- Each gateway exports Prometheus counters per route, per outcome (accepted, rejected-by-verdict, client 4xx,
  site rate-limited or over quota, overload 503, error) and per latency bucket around the 2 s threshold.
- The counters hold no IPs, User-Agents, headers or tokens (ADR-0022). Prometheus on `mon-c` scrapes them over
  the WireGuard mesh.
- The blind spot: requests that never reach an edge (DNS failure, every node unreachable, a network partition)
  are invisible here. The probe view covers that gap.

### 3.2 Independent probes (ADR-0022, C-30, C-78)

- **Probe sources** (C-30): three, voting with a 2-of-3 quorum:
  1. `mon-c` (OVHcloud), which hosts no ingest node;
  2. `probe-d`, a small VPS at a fourth EU provider that runs probes only (C-25);
  3. the cross-provider probes that edge nodes run against the other provider's nodes (Hetzner edges probe the
     UpCloud edges and vice versa).
- **Probe client**: Gatus cannot fetch a challenge and solve a proof-of-work, so the web probe is a small
  **probe client** of our own that does what the pinned tracker does: it fetches a challenge, solves it, posts a
  canary event for the dedicated canary site to one ingest hostname and, if that attempt is not accepted within
  2 s, retries once on the other hostname. It records the first attempt per hostname separately, and runs the same
  event against each node address directly for the per-node figure. Owner, directory and pass criteria are
  fixed in C-83.
- **OTLP probe**: a small OTLP/HTTP metrics export with a probe-only ingest token, in the same rounds (§2.2).
- **Canary data**: canary events go to canary tenants. They are excluded from tenant and SCF-operator metrics, and
  their volume is published.
- **Additional outside view**: GitHub-hosted scheduled checks of the public endpoints feed the public status page
  (5-minute resolution). They are published but do not vote and are not used for the SLI (C-30). *Not running today;
  see §1.2.*
- **Dead-man's switch**: a scheduled GitHub workflow (`.github/workflows/deadman.yml`) alarms when the monitoring heartbeat stops (C-30). Silence
  means monitoring is dead and triggers an alert (ADR-0022). *Not running today.*

### 3.3 Dashboard journeys

- Every 5 minutes from each probe source, a synthetic canary tenant does the following:
  1. Signs in with a dedicated Stellar keypair (SEP-53 signature, ADR-0014). No real person's credentials are
     used.
  2. Loads the portal's static assets.
  3. Requests the web overview and the API overview for its own sites and services through the control-plane
     API that the portal uses (`docs/api/`).
  4. Checks that the data is non-empty and belongs to the canary tenant only. The web overview covers both read
     paths: a range in the site's live window (answered by Umami) and an older range (answered by our rollups;
     C-109).
  5. Queries the SCF-operator metrics API with a probe-scoped `op` key (`web:read`, `api:read`, restricted to the
     canary tenants; ADR-0016).
- A journey **fails** if any step errors, returns foreign or empty data, or a single step takes longer than 3 s.
  *The 3 s step threshold is a target to calibrate on production data.* Measured context (S-11, C-109): Umami alone could
  not meet it for long ranges of large sites (24–43 s at 30–90 days for a 174k page-view/day site), which is why only
  each site's live window (sized from the larger of the 28-day average and today's count projected to a full day, so ≤ 250,000
  events per query, ≈ 1 s p95 warm) is answered live; ten concurrent loads or a cold cache still multiply live latency by
  3–10× (risk R-22), so each Umami call has a 5 s timeout and falls back to the rollups (`source: rollup`,
  `partial_today`), and `umami_app` has `statement_timeout = 30s` (C-112).
- SCF-operator sign-in itself needs a passkey (ADR-0014, C-09). The journey does not exercise it. SCF-operator
  sign-in is covered by end-to-end tests, not by the SLI.

### 3.4 Durability reconciliation (C-76)

- Every record on an edge spool carries `(node, segment, offset)`. Each node keeps, per day, the counters of the
  equation in §2.2: records fsync'd, acknowledged (including `engine_bot_drop`), expired at 72 h, still queued.
- The **durability reconciliation job** runs daily on the core, collects every node's counters, checks the equation
  per node, and writes the result to `scf` and to the monthly report. Owner, directory and pass criteria are
  fixed in C-83.
- The same job counts the canary site's events in Umami for each hour and compares them with the known hourly count
  the probe sources sent.
- This measures what each node accepted against what the engine acknowledged. Storage itself is checked only by the
  canary count, which is why both are published.

### 3.5 Freshness canaries

- Every 5 minutes, the prober sends canary events (web and OTLP) and polls the read path until they appear.
- The measured delay is acceptance → visibility.
- Spool depth, the age of the oldest spool record, and writer lag are published as supporting server-side views.

### 3.6 Integrity of the measurement

1. The probe client, probe configuration, SLO specifications (Sloth) and the **SLO report generator** all live in
   the monorepo, so a new service operator inherits the same measurement. Owners and directories are in the
   development plan (C-83).
2. Raw probe results are appended to object storage at a provider other than the one that wrote them. The monthly
   report and its raw files are signed, so later edits are detectable (ADR-0031).
3. Server-side and probe figures are published side by side. If they disagree, the disagreement is itself
   reported and explained.
4. **No maintenance exclusion for ingest.**
   - Deploys, reboots and database switchovers are rolling: one node at a time, drained by closing the listener,
     with DNS records removed first (ADR-0020).
   - If a change cannot be made without ingest downtime, we do not make it while the objective applies. A
     PostgreSQL major upgrade is not planned before 2030 (PG 18 is supported to 2030-11-14).
5. **No planned-maintenance exclusion for dashboards either.** Database switchovers take seconds. Anything
   longer runs in read-only mode, which counts as available (§2.2) and is published separately.

## 4. Exclusions and why

The excluded requests are counted and published every month.

| Excluded from "valid requests" | Why | Guard against abuse of the exclusion |
|---|---|---|
| 4xx caused by the client: malformed or oversized payload, unknown version (`404`), withdrawn tracker version (`410`, C-37, C-39), unknown or revoked site key or ingest token, origin mismatch | The service worked; the request was wrong | We alert if the rate of client 4xx changes sharply, and publish the monthly totals |
| 429 for a single site that exceeded its per-minute rate limit or daily quota (ADR-0015 quotas for L0 tenants, C-19; rate limits and quotas carried in the snapshot, C-90) | Fair-use control, not failure. Quotas count **verified** events only (C-80), so a flood of `suspect` events sent with another tenant's public site key cannot use up that tenant's quota. Each edge node enforces its share (limit ÷ live edge nodes) and the control plane marks a site `over_quota` in the next snapshot, so enforcement is exact within about a minute (C-90). | A 429 or 503 caused by **global** overload is **not** excluded. Site 429s are **reported per site** every month (C-80), so a site pushed into its per-minute limit by someone else's traffic is visible rather than hidden in the exclusion. |
| Requests the gateway classifies as `rejected` (ADR-0008: no valid challenge, origin mismatch, known bot, header combinations a browser cannot produce) | They are deliberately not stored, so "accepted" cannot apply. The gateway still answers `202` to every well-formed event whatever its verdict, so the response is no oracle; rejected events are outside the denominator (C-39). | Canary probes must be accepted. A sudden rise in the rejected share is alerted and published. |
| Our own load-test and chaos-test traffic | Synthetic | It runs against a marked test site and is published |
| Pending tenants in `approval_required` mode (counted as `tenant_pending`), suspended or removed tenants (ADR-0015, C-08) | Ingest is refused by design | Removals by SCF operators are audited |
| `/v1/logs` (no logs pipeline, ADR-0009) | Not a published ingest route | n/a |

**Not excluded**:

- Our own deploys and maintenance
- Provider outages
- DNS provider outages
- Certificate problems
- Bad releases
- Overload from all tenants together

## 5. Error-budget policy

- **Budgets**:
  - Ingest: 0.01 % of valid requests and 4.38 min of probe time per average month.
  - Dashboard: 43.8 min per average month.
  - Durability: zero, apart from events undeliverable for 72 h (C-18) and the undrained backlog of an edge node lost
    before it forwards (C-77); both are counted and published.
  - Freshness: 1 % of accepted events later than 5 minutes; 0.1 % later than 60 minutes.
- **Alerting** (multi-window, multi-burn-rate rules generated with Sloth, ADR-0022). Without an on-call rotation
  these are notifications, not pages:

| Condition | Action |
|---|---|
| Burn 14.4× over 1 h (confirmed over 5 min), or 6× over 6 h (confirmed over 30 min) | `critical`: chat push + e-mail to the maintainers, repeated every 4 h until acknowledged |
| Burn 1× over 3 days (confirmed over 6 h) | `warning`: an issue opens automatically in the operations tracker |
| Any lost accepted event, any node whose spool accounting does not balance, or a canary-count shortfall (C-76) | `critical`, whatever the remaining budget |
| Availability of one ingest hostname or one edge node below its expected level (C-78; thresholds in the monitoring plan §4.4) | `critical` for a hostname, `warning` for a node, even while the headline rounds stay good |
| Oldest undelivered spool or queue record older than 1 h, 6 h, 24 h (C-49) | Notification at each threshold, so the daily watch (§6.3) sees it well before the 72-hour cap |

- **More than 50 % of a monthly budget used, or a budget exhausted**:
  1. Feature deploys to the affected path stop. Only security fixes and corrective changes ship, and they use
     the normal rolling path.
  2. A post-mortem is published within 5 business days.
  3. The freeze lifts only when the corrective action named in the post-mortem has been merged and deployed.
- **Any objective missed**: the miss is announced and marked on the status page within 1 business day of
  detection.
- **Two misses of the same objective in a row, or three in twelve months**: we publish a written remediation plan with
  dates within 10 business days, including whether the topology tier must change.
- **Objectives and definitions are never changed retroactively.** A change to a published objective or SLI
  definition is announced 30 days ahead and applies from the following calendar month.

## 6. Meeting the objectives without on-call

UsageMap is operated without a mandatory on-call rotation. The design therefore aims for one property: **for every
failure we expect, service recovery is automatic, and a human only restores redundancy.** Where that is not
true, we say so below.

**Lean profile (C-123).** §6.1–6.2 describe the scale-out profile, where no single node failure needs a human. In the
lean profile the automatic part is narrower: Docker restarts crashed containers, Azure redeploys a failed VM onto
healthy hardware with its disks, and the spool and the tracker's retry protect accepted events. Loss of the data
disk, zone or region needs a human: rebuild from IaC and restore (RTO target 4 h, M0) — [`deployment-topology.md`](deployment-topology.md) §1.3.

### 6.1 Failures handled automatically

All times are targets to be measured in the chaos tests (ADR-0026) before the scale-out profile goes live.

| Failure | Automatic response | Expected effect on the SLIs |
|---|---|---|
| One edge node crashes or is drained | Refused connections make browsers try the next A/AAAA record in about one round trip. The tracker times out after 3 s and rotates to the other ingest host. The health controller (two instances, etcd lease) removes the node's records at both DNS providers. TTL is 60 s. | A few failed requests and no bad round, as long as one healthy node per hostname remains. Visible in the per-node figure. |
| An edge node is black-holed (host gone, packets dropped) | Tracker timeout and rotation, then DNS removal | Requests delayed by up to the 3 s timeout; resolver caches stretch this tail. The headline rounds can stay good while real browsers wait, which is why the per-node and per-hostname figures are published and alerted on (§2.2). |
| An edge node is permanently lost before its spool drains | DNS removes it; the other nodes take its traffic | Its undrained backlog is lost (normally seconds; C-77). Counted from its last reported accounting and published under O3. |
| A whole provider fails (Hetzner or UpCloud) | Edges at the other provider keep accepting. Patroni promotes the standby at the other provider. Dashboards follow the new primary. Edge forwarders that routed to the lost core by consistent hash fall back to the other core's engine proxy (C-74). | Ingest: requests, not minutes. Dashboard: one failover (target 30–60 s). Visits in progress may split once at the failover (C-74). |
| PostgreSQL primary lost | Patroni with synchronous, non-strict replication promotes the standby. Ingest is unaffected because edges keep spooling. | Dashboard: failover time (M1). Freshness degrades until the writer and forwarder reconnect. |
| Umami, engine proxy, writer or control plane down on one core | Edge forwarders fall back to the other core's engine proxy (C-74). The Collector's single exporter targets one name that resolves to both writers; when a writer's connections fail — a writer that loses its database closes its listener — the dialer moves to the other writer (C-107; S-04 measured no loss and ≈ 15–17 s to switch when a host vanished). A live writer answering `503` is **not** failed over, which is why it closes its listener instead. Only that connection loss is retried: a tenant's write that fails with a non-transient SQL error is rolled back, counted (`tenant_write_error`) and answered `200`, and a histogram count beyond int4 is rejected (`count_overflow`), so one tenant's bad data never blocks a queue (C-112). | Ingest unaffected; freshness may dip briefly. Visits may split once at the switch. |
| Umami, writer or control plane down on both cores | Edges keep accepting and spooling. Gateways keep working from the last signed snapshot on disk (ADR-0005). | Ingest unaffected. Freshness and dashboards degrade. |
| One DNS provider down | The zone is served by the second provider | Some resolvers retry slowly; we expect no bad round (unmeasured) |
| Certificate renewal | Each node renews over ACME DNS-01 with its own certificate. We alert when one third of the certificate's lifetime is left. | None if renewal works. Weeks of margin if it does not. |
| Tenant OTLP export fails briefly | The gateway answers 503 + `Retry-After`. SDKs and Collectors retry. Cumulative temporality (the OTel default) re-sends running totals on the next export. | Little or no lost counts. Delta temporality loses the failed export; the onboarding guide warns about this. |
| All gateway nodes restart in the same UTC day | A new daily key is generated (ADR-0007) | That day's unique visitors are over-counted. This is documented and annotated in dashboards, and is not an SLI breach. |

### 6.2 Failures that need a human

| Failure | Why automation does not fix it | Human action | SLO consequence |
|---|---|---|---|
| A defective release reaches every edge node | Rolling deploys stop when a node fails its smoke test, but a defect that passes the smoke test and appears later affects every node | Roll back to the previous digest. Releases never go to both providers in the same hour. | Can breach the ingest month on its own. Most likely cause of a miss. |
| A dead node is not replaced | Removal from DNS is automatic; replacement is not. Hetzner has had a capacity notice open since 2026-06-26 (status.hetzner.com, read 2026-11-12), so a replacement may not be orderable. | `tofu apply` for a new node, or a node at the alternative provider (the IaC module is swappable) | None immediately, but redundancy is reduced until the node is replaced. In the recommended tier each provider has two edge nodes (C-25), so losing one edge still leaves both providers serving; losing a whole provider leaves two edges. |
| Both database nodes lost, or logical corruption | Needs a decision on the recovery point | pgBackRest (2.60.0, C-108) point-in-time restore from the second repository (M3 target ≤ 2 h after start; S-08 restored a small database exactly to the second in ≈ 9 s). WAL reaches both repositories within about a minute (`archive_timeout` 60 s) — but only once a `CHECKPOINT` has run after the server's start or promotion, which our start-up and promotion hooks issue; without it the WAL recovery point can lag up to `checkpoint_timeout` (5 min) after every restart (C-108) | Dashboards down: one such event can exhaust a month's dashboard budget. Ingest keeps spooling, but see the 72 h limit below. |
| Core outage longer than the spool retention | Spool records and the Collector queue are never kept longer than 72 h (ADR-0011, C-18) | Restore the core before the 72 h limit; spool-age alerts at 1 h, 6 h and 24 h reach the daily watch (C-49) | Records older than 72 h are discarded and counted as "undeliverable (72 h)". That is outside the durability objective as worded (C-18), but it is published and post-mortemed. Ingest keeps accepting. A long core outage also lengthens every node's undrained backlog, so losing an edge node during it loses more (C-77). |
| etcd quorum lost | `failsafe_mode` keeps a healthy primary running, but failover is impossible until quorum is back | Restore the etcd member, normally on `mon-c` | None unless the primary also fails |
| Monitoring node (`mon-c`) down | The dead-man's switch (a scheduled GitHub workflow) alerts, but nothing rebuilds the node | Rebuild from IaC. History stored on the node is lost; raw probe files are in object storage. | Measurement runs on the two remaining probe sources (missing-source rule, §2.2). Gaps are published. |
| ACME issuance fails for weeks | The alert at one third of lifetime leaves weeks to act | Fix the DNS API token or CA; switch to the second ACME CA | None if acted on in time |
| Domain, registrar or DNS-account problem (expiry, lock, compromise) | Outside our infrastructure | Registrar and DNS-provider support | Can cause a complete outage. Prevented by prepaid renewal, registry lock and two domains (ADR-0004). |
| Base engine or OS vulnerability | A patch needs judgement | 24 h process (§8) | None for ingest if done with rolling deploys |
| Ingest-token revocation or tenant suspension/removal while the core is down | Snapshots are not refreshed; each edge keeps serving from its last good snapshot (availability first) and alerts after 15 minutes without a fresh one (C-62) | Restore the core | The 60 s times for ingest tokens, site state and tenant suspension (C-06) do not hold during the outage — a stated residual risk. SCF operator keys are checked against the database on every request (C-06), so their revocation is immediate whenever the API is up. |
| GitHub outage | The source repository, the status page and the dead-man's-switch workflow depend on it. Deployments do not: no hosted runner holds production credentials, and deploys run from a service-operator workstation (or a pull-based agent on the nodes) with SOPS-decrypted secrets (C-79). | Wait for new releases; already published images can still be deployed | Service unaffected; releases, status page updates and the dead-man's switch are delayed |

### 6.3 Expected time to human response

- **Notification**: critical alerts go to the alert channels the operator chooses (ADR-0022, C-26).
  Nobody is required to be available at night.
- **Daily watch duty (C-49)**: "no on-call" stands, but the 24-hour patch commitment (K2) and the 72-hour delivery
  cap (O3) both need a human to look once per calendar day, weekends and public holidays included. **One named
  person per day** checks the advisory feed, the alert channel and the private security inbox. This is a roster, not
  paging.
- **Patch responders (C-67)**: the pipeline opens the patch change automatically and sends a push notification to
  **two named responders**. "Patched or mitigated within 24 hours" depends on one of them acting on it.
  - **First responder: the operations lead** (a role; the person is named only in the operator's private records).
    Alerts and reports to `security@usagemap.dev` reach the operations lead by e-mail (`ops/runbooks/alert-email.md`);
    the second responder is not yet named.
- **Honest status**: both depend on named people. The maintainers must accept the roster and the two responders and name
  them; until then the names are placeholders, and K2 and the 72-hour part of O3 are conditional on it.
- **Expected response, unmeasured**:
  - **Upper bound**: about 24 h, set by the daily check.
  - **Business hours**: typically a few hours.
  - **Weekend or holiday**: up to the next daily check.
  - We will publish the measured acknowledgement times in the monthly report.
- **Arithmetic** (§2.1): any ingest incident that needs a human misses the 99.99 % objective for that month. The
  objective is realistic only because the failures we expect most are in §6.1, not §6.2. We will report every month in which
  a §6.2 failure happened.

## 7. Reporting

| Artefact | Content | Cadence and location |
|---|---|---|
| Public status page | Current state of ingest, dashboard and API endpoints. Incident updates (Investigating / Identified / Monitoring / Resolved). Planned work. | Scale-out design: Upptime on GitHub Pages in `ORG/status` (generated data, deviation DV-06), outside our infrastructure, so it survives our total outage; Upptime checks every 5 min, so it is a public cross-check, not the SLI. **Today:** `status.usagemap.dev` is served by `scf-ops status-page` from the v1 VM itself, fed by the host probe — it does **not** survive a total outage of that VM (§1.2). |
| Platform `health_endpoint` | Machine-readable health, compatible with what the SCF Public Goods programme polls (ADR-0032) | Live |
| Monthly SLO report | For each SLI: value, budget used, incidents with links, exclusions with counts, rate-limit and quota `429`s **per site** (C-80), read-only windows, ambiguous retries, `engine_bot_drop` counts, per-node durability accounting and canary counts (C-76), availability **per ingest hostname and per edge node** (C-78), rounds decided by fewer than three sources, patch latency, support statistics, and a link to the **raw per-probe CSV for every probe source** so anyone can recompute the figures. Produced by the SLO report generator (C-83): `tools/support/run slo-report`, which applies the 95 % coverage floor of §2.2 (C-146); support statistics from `tools/support/run support-report` (§9.3). | Generated on the 1st of the month as a PR to `docs/evidence/slo/YYYY-MM.md` (+ CSV); merged within 5 business days |
| Post-mortems | Timeline, impact in SLI terms, cause, what worked, corrective actions with owners and dates | Within **5 business days** of resolution, for: any objective missed; any incident that used ≥ 25 % of a monthly budget; any lost accepted event; any cross-tenant exposure; any security incident affecting tenants (published after the fix, following coordinated disclosure). Stored in `docs/evidence/postmortems/`. |
| Restore and DR drill results | Weekly restore drill; quarterly rebuild-from-zero drill. Restore drills run on our own EU infrastructure, never on GitHub-hosted runners, and backup keys never leave it; only the result (pass/fail, timings, checksums) is published (C-56). | `docs/evidence/restore-drills/`, `docs/evidence/dr/` |

Public repositories disable scheduled GitHub workflows after 60 days without repository activity (GitHub docs, read
2026-11-12). The monthly report PR keeps the repository active, and the dead-man's switch catches a silently
stopped schedule.

## 8. Security-patch commitment (K2)

- **Scope**: everything we deploy.
  - Our services and the tracker.
  - The pinned Umami build.
  - PostgreSQL, Patroni, etcd, pgBackRest.
  - Base images and Debian 13 hosts.
  - The tools we run, including the action the dead-man's-switch workflow uses.
- **What triggers the 24-hour clock** (ADR-0023). Any of these, for a component that is deployed and reachable in
  our exposure model:
  - a CVSS base score ≥ 7.0;
  - a listing in CISA KEV;
  - an EPSS score ≥ 0.1;
  - a malicious dependency release;
  - any vulnerability in the tracker.
- **When the clock starts** (C-67): when an advisory affecting a component we run appears in a watched source, or
  when it is reported to us (GitHub private vulnerability reporting or `SECURITY.md`), whichever is first. The
  pipeline then opens the patch change automatically and sends a push notification to the two named responders
  (§6.3).
- **What "patched within 24 h" means**: a fix, or a compensating control if upstream has no fix, is **deployed to
  production**, with evidence (deploy log, image digest, verification output).
  - If the vulnerable code is not reachable, a reviewed VEX `not_affected` statement within 24 h closes the item.
  - Medium: 14 days. Low: next scheduled release.
- **When upstream has no fix**, we do the following, in this order of preference:
  1. Apply our own patch through `vendor/umami/patches/` and rebuild from the pinned commit. The patch queue is
     empty today and exists for this case (ADR-0003). Upstream Umami fixed its own bugs in 22–84 days in
     2024–2026 (our analysis of Umami's advisories), so we cannot wait for upstream.
  2. Block the affected route. Umami is never reachable from the internet, so most engine advisories are already
     unreachable. We confirm this per advisory.
  3. Switch dashboards to read-only. Ingest keeps running because it is a separate service.
  4. Disable the feature behind its flag, rotate exposed credentials, or rate-limit or IP-restrict SCF operator
     endpoints.
  5. Keep the compensating control until a real fix ships. Record the item as "mitigated, not fixed" in the
     monthly report.
- **Limits we state plainly**:
  - **We cannot patch a tracker that tenants have pinned.** Within 24 h we publish a fixed version and notify the
    affected tenants. They must change the version and SRI hash, or bump the npm dependency.
  - A released version is withdrawn **only for a security defect** (C-37). Its URL then returns `410 Gone`; pages
    that pin it stop sending analytics and are otherwise unaffected, and an advisory is published. This is the one
    exception to ADR-0004's rule that every version stays served.
  - Vulnerabilities in services we do not run (GitHub, hosting providers, DNS providers) are outside the 24 h
    commitment. We publish what we did to reduce exposure.
  - Kernel fixes need reboots. Debian has no free live-patching, so hosts reboot one at a time with a drain or a
    Patroni switchover. This is why the 24 h commitment holds without ingest downtime.
- **Evidence**: each item is a GitHub Security Advisory or an issue with timestamps (detected / triaged / merged /
  deployed / verified). The monthly report includes a patch-latency table.
- **EU Cyber Resilience Act**: we meet the reporting duties voluntarily (24 h early warning, 72 h notification,
  final report within 14 days, Art. 14) as far as they apply. Whether they apply to us is a question for counsel.

## 9. Support model

### 9.1 Channels

| Channel | For | Not for |
|---|---|---|
| **Public issue tracker** (GitHub Issues on `ORG/REPO`) with issue forms: tenant support, bug, enrolment, removal request, privacy-process question | Integration help, bugs, dashboards, enrolment, OTLP setup within our documented recipes, feature requests | Personal data, API keys, ingest tokens (the forms say so) |
| GitHub Discussions | Q&A, announcements, tracker release notes, planned work | Tickets with a clock |
| **GitHub private vulnerability reporting** | Security reports | — |
| **Privacy mailbox** `privacy@<domain-a>` (hosted mailbox; provider to be chosen and listed as a sub-processor) | Data-subject and controller requests that must not be public. Each request is logged in a private operations tracker by ticket number only. | Erasure of a tenant's own data: tenants do that themselves in the product (ADR-0030) |

There is no real-time support channel such as chat. We do not run one.

### 9.2 Clock, labels and definitions

- **Labels**:
  - `type:*`, `priority:p1…p4`, `tenant`, `security`, `privacy`;
  - `sla:awaiting-first-response`, `sla:response-breach`, `sla:resolution-breach`;
  - `status:needs-info`.
- **Business day**: Monday to Friday in time zone `<TZ placeholder>`, minus the dates in `ops/support/holidays.yaml`
  (`<calendar placeholder>`).
- **First response** (≤ 5 business days): a maintainer's comment that triages the ticket, i.e. labels it and
  either answers or asks a specific question. An automated reply does not count.
- **Resolved** (≤ 10 business days), one of:
  - **Bug**: the fix is deployed, or a documented workaround is provided.
  - **How-to question**: answered.
  - **Feature request**: a decision is communicated (planned with a target release, or declined with reasons).
    Building the feature is not covered by the 10-day clock.
  - The ticket also counts as resolved if the reporter confirms, or does not reply within 5 business days after a
    proposed resolution.
- **Clock pauses**: while the ticket carries `status:needs-info` and the reporter has not replied. Pauses are
  visible in the ticket history.
- **Clock exceptions**: none for our own absence. Holidays count only if they are in the published calendar.

### 9.3 Automatic breach flagging

- As built (C-118): `tools/support/sla.ts`, run by a maintainer with `tools/support/run sla --apply`, computes the
  business-day age of every open ticket (Monday–Friday in `SCF_SUPPORT_TZ`, UTC by default, minus
  `ops/support/holidays.yaml`). Labels are as fresh as the last run; the response clock uses the comment's own
  timestamp.
- A ticket labelled `sla:exempt` is skipped (e.g. not a support request).
- It labels the ticket and posts a warning at day 4 (response) and day 8 (resolution).
- It labels breaches at day 5 and day 10.
- A monthly job adds to the SLO report: median and maximum first response, median resolution, the number of
  breaches, and links to each breached ticket. The monthly support report is `tools/support/support-report.ts`
  (`tools/support/run support-report --month=YYYY-MM --github`): it reuses the label automation's clock
  (`tools/support/sla.ts`, imported, not copied), counts the month's cohort and carried-over tickets with one
  rule each, and names issue numbers, labels and business-day ages only — never authors, titles or bodies. Issue forms
  and the label set are in `.github/ISSUE_TEMPLATE/` and `tools/support/labels.json` (runbook
  `ops/runbooks/support-sla.md`).
- Breaches are not hidden or relabelled. A breach stays a breach, even if the ticket is resolved later.

### 9.4 What support covers, and what it does not

- **Covered**:
  - Onboarding and integration with our tracker and documented OTLP recipes.
  - Incorrect metrics or verdicts.
  - Access, roles and enrolment problems.
  - Questions from SCF operators.
  - API key issues.
  - Erasure workflow problems.
  - Bugs anywhere in the monorepo.
  - Security and privacy reports.
- **Not covered**:
  - Debugging the tenant's own application or framework beyond the documented recipes.
  - The tenant's own APM backend.
  - Custom path-normalisation rules (not offered; tenants set `http.route`).
  - Recovering data that a tenant erased or that expired under the retention policy (ADR-0011). (Erased data can
    still sit in backups and, under C-108's blob versioning, in previous versions of backup blobs for a while; see
    P6.)
  - Legal advice to tenants.
  - Guaranteeing that a tenant's numbers qualify for any SCF programme.
  - Real-time chat or phone support.
  - Support for tracker versions with known security issues beyond telling the tenant how to upgrade.

## 10. Capacity

| Dimension | Commitment or assumption | Basis |
|---|---|---|
| API traffic | Design target **1,000,000 requests/day** across all tenants. That is 11.6 req/s on average; we assume 50–120 req/s at peak. | Design target; research estimate |
| What actually reaches us for API traffic | OTLP exports, not requests. By default each SDK instance exports metrics once per 60 s, so 40 tenants × 3 instances ≈ 2 exports/s. Load is driven by series cardinality. | OTel spec defaults; research estimate (2026-11-12) |
| Spans from tenants without `http.route` | Tenants that cannot emit server metrics dual-export **traces**, and an unfiltered exporter sends child spans too (ADR-0009). **Planning assumption, to be confirmed in the load test** (S-04 did not measure volume): up to 10 spans per request for the whole 1,000,000 requests/day, i.e. about 116 spans/s on average and about 1,200 spans/s at peak, before the tenant-side filter below. The 10× load test includes this span volume. | Assumption; load test. Each incoming trace request also costs one fsync'd queue write (≈ 7.7 ms on the S-04 disk), so edge disks are sized for IOPS (C-107) |
| Tenant-side span filter | The onboarding recipes configure the tenant's SDK or Collector to export only SERVER-kind root spans to us, so child spans never leave the tenant. Our own sanitise step applies the same rule as a backstop: it keeps only local-root SERVER spans, using the span flags the SDK sets (ADR-0009, C-22, C-107). | Onboarding quickstarts tested in S-06a/b (C-102, C-105) |
| Cardinality guard | 1,000 routes per service per day and 5,000 per tenant per day, 200 siblings per prefix; the excess goes to `{overflow}` and is counted (ADR-0012, C-24) | Register |
| Web traffic | **Load assumption**: 1,000,000 page views/day across tenants (C-48). Event-level data is kept 90 days by default (C-54); dashboards read Umami only for each site's live window and our hourly/daily rollups for everything older (C-109). Measured at this load (S-11): Umami grows ≈ 1.05 GB/day (94 GB for 90 days), so the database host needs ≥ 250 GB of disk (risk R-27); one Umami container ingests ≈ 400 events/s (33× the design average; we plan ≤ 300/s per container); the daily rollup job takes ≈ 35 s for 300 sites. | Register; S-11; to be revised with production data |
| Load test | **10×** the design targets, sustained, plus chaos tests (kill the database, the engine, an edge node, the Collector, the writer, the control plane; partition the private mesh: ingest still answers 2xx and spools drain; C-48). Run before the scale-out profile goes live, with results in `docs/evidence/`. | ADR-0026 |
| Spool capacity | Sized for the backlog of a core outage up to the 72 h retention limit (ADR-0011). Disk alerts at 80 %. | Target, to be measured |
| Web rate limits and quotas | Each site's per-minute rate limit and daily quota travel in the snapshot; each edge node enforces limit ÷ live edge nodes, and a site over its daily quota is marked `over_quota` in the next snapshot (C-90). Quotas count verified events only (C-80). | Register |

If real traffic exceeds 50 % of the tested capacity on any sustained day, we open a capacity issue and publish it in
the monthly report.

## 11. Hosting plan

### 11.0 What runs today: the v1 host

One small VM in one **EU region** with one Standard SSD, all services in Docker Compose (lean
profile, `infra/ansible/playbooks/lean.yml` with the v1 settings of [`guides/deploy-v1.md`](guides/deploy-v1.md)),
static public addresses, pgBackRest repository 1 on the VM's disk and repository 2 in one storage
account in the same region, DNS at Cloudflare (DNS only), certificates from Let's Encrypt; provisioned with
`infra/opentofu/envs/v1-small`. §11.1 and the topology document describe the
**design for the full-size and scale-out profiles, not what runs today**.

### 11.1 Profile and provider (C-123) — full-size design

- The full-size hosted design is the **lean Azure profile** (C-123), replacing the
  multi-provider recommended tier of ADR-0018/C-25 for production:
  - **`app-1`**: one VM (Standard_D8as_v5; small Standard_D4as_v5) in **Azure West Europe** (Netherlands), zone 1,
    running the whole Docker Compose stack and the monitoring overlay; 256 GB Premium SSD data disk (C-109);
  - **`standby-1`** (optional): a small VM in zone 2 for the weekly restore drill (repository 2, read-only, C-56) and as
    cold-standby target;
  - **backups**: two pgBackRest repositories in two Azure storage accounts in two EU regions
    (C-110) — versioned, previous versions deleted after 14 days, shared keys off, private endpoints, written with the
    VM's managed identity whose role cannot delete versions (C-108, C-112);
  - **DNS**: Azure DNS for the two tracker domains; one DNS provider, static records, no health controller (C-123);
  - **OpenTofu state**: an Azure storage account (lease locking), encrypted client-side; credentials only on the
    service operator's workstation (C-79).
- Microsoft is a **US-owned** provider (C-96). The residency statement says so and explains the transfer position
  ([`privacy/data-residency.md`](privacy/data-residency.md)); it has not been reviewed by counsel.
- Everything is provisioned from the monorepo: `infra/opentofu/envs/azure-lean` and `infra/ansible/playbooks/lean.yml`
  ([`guides/deploy-azure.md`](guides/deploy-azure.md)). The scale-out profile (`modules/azure-platform`,
  `compose.ha.yaml`) is the documented path to the 99.99 % design objective.

### 11.2 Who hosts what

| Component or service | Runs on / provided by | Jurisdiction | Sees visitor-derived data? | Account holder while we operate it | At handover |
|---|---|---|---|---|---|
Rows describe what runs today (v1) and, where different, the full-size design.

| Component or service | Runs on / provided by | Jurisdiction | Sees visitor-derived data? | Account holder while we operate it | At handover |
|---|---|---|---|---|---|
| Gateway (tracker files, web and OTLP ingest, spool), Collector, engine proxy, Umami, control plane, writer, jobs, portal, PostgreSQL, PgBouncer, monitoring overlay, status page, weekly restore drill | **Today:** the v1 VM in an EU region. Design: `app-1` (+ `standby-1` for drills) in an EU region | EU | Yes: transiently in gateway memory (IPs truncated and discarded, ADR-0006); stored events and aggregates without IPs or UA strings | Us, in a cloud subscription | Subscription transfer (path B, [`handover-plan.md`](handover-plan.md) §5.6) or rebuild in the successor's subscription (path A) |
| Backup repositories 1 and 2 | **Today:** repository 1 on the VM's disk; repository 2 in one blob storage account, same region. Design: two storage accounts in two EU regions | EU | Encrypted backups (pgBackRest AES-256 — cipher passes on the VM; age for the weekly dump — private key off the hosting provider) | Us | Same |
| Authoritative DNS | **Today:** Cloudflare, DNS-only (records never proxied). Design: Azure DNS (one provider, C-123) | Cloudflare, Inc., USA (global anycast) | **No:** DNS queries only (hostnames, the asking resolver, possibly a truncated client subnet); no visitor traffic passes through it | Us | Zones re-created from the repository at the successor's provider |
| Domain `usagemap.dev` (design: `<domain-a>`, `<domain-b>`) | Registrar of the operator's choosing; registry lock not evidenced in the repository | `<TBD>` | No | Us | Registrant transfer (handover plan §5.3) |
| ACME certificate authority | Let's Encrypt (residency exception: certificate requests contain our hostnames, C-26) | US | No | One ACME account on the VM | New account; CAA updated first |
| Source code (today: private repository); designed: releases, container images (GHCR), status page history, scheduled checks of public endpoints, dead-man's-switch workflow — not running today | GitHub | US | **No visitor data** (residency exception, C-26) | Dedicated GitHub organisation `ORG` | Organisation ownership change or repository transfer |
| npm package `@SCOPE/tracker` | npm registry (residency exception, C-26) | US | No | npm organisation `SCOPE` | Owners added and removed |
| Signing transparency (Sigstore public instance) | Sigstore public-good service | US | No | Keyless | Identity changes with a repository transfer |
| Alert channels | Chosen by the operator | `<TBD>` | No | Us | New accounts |
| Optional on-chain correlation (off by default) | Google BigQuery Hubble dataset, or public ledger files on AWS Open Data (C-26, C-42) | US / `<TBD>` | **Public ledger data only** | `<owner TBD>` | Ownership transfer or new project |
| Privacy mailbox | `<to be chosen>` | `<TBD>` | Requests may contain personal data | Us | Mailbox transfer |
| SCF operators | Host nothing; SCF operators hold portal credentials for the global view (ADR-0014) | — | Anonymous per-tenant aggregates only (ADR-0027) | — | Keep their roles; credentials are reissued by the incoming service operator |

## 12. Running cost

The lean profile is priced in [`cost-model.md`](cost-model.md) from Azure's public Retail Prices API (list prices,
pay-as-you-go, US$, excluding VAT, read 2026-11-13):

| Layout | US$/month | US$/12 months |
|---|---|---|---|
| **Production** (D8as_v5 + D2as_v5 standby, 2 × 256 GB P15, backups in two regions) | **≈ 560** | ≈ 6,700 |
| Small (D4as_v5, no standby) | ≈ 235 | ≈ 2,800 |
| Production with a 1-year reservation for `app-1` | ≈ 445 | ≈ 5,300 |

Storage, transfer and query lines are estimates from the design load (C-48, C-109); compute, disk, IP and endpoint
lines are list prices. Not included: domains, VAT, staff time, support plans. The multi-provider figures of the research cost model (2026-11-12) are kept in
[`deployment-topology.md`](deployment-topology.md) §S3 for the scale-out profile.

## 13. Objectives and commitments at and after handover

"D0" is the cut-over day of the handover plan.

| Period | Who holds the objectives and commitments in §1 | Notes |
|---|---|---|
| Service start → cut-over day (D0) | Us | As written |
| D0 → acceptance signed (shadow period) | Us, jointly with the incoming service operator; the handover plan sets the rules | Probes run in both environments. The report for the cut-over month marks the cut-over interval and any downtime it caused. **Cut-over downtime counts against the objective** (no exclusion). |
| After acceptance | The incoming service operator, if it adopts them. We have no hosting role. | We answer the service operator's questions within 5 business days and fix defects in our code at the same speed as support tickets (§9). |

The objectives handed over are those of the scale-out profile: 99.99 % ingest and 99.90 % dashboard availability on the
scale-out profile (C-180, [`scale-out-plan.md`](scale-out-plan.md)); an incoming operator that chooses a single VM
instead inherits the 99.5 % objective of that profile (C-123).

## 14. Remedies

There are no financial credits. We commit to the following instead:

1. Monthly public SLO report with the raw data needed to recompute every figure (§7).
2. Public post-mortems within 5 business days, with dated corrective actions (§7).
3. A feature freeze on the affected path until the corrective action ships (§5).
4. An announcement on the status page within 1 business day of any objective missed.
5. A written remediation plan after repeated misses (§5).
6. A permanent record: reports and post-mortems are never deleted or rewritten. Corrections are added as new
   commits.
7. An offer of early handover. If we cannot meet the objectives or keep the commitments, a successor operator can take
   over on 30 days' notice (handover plan).

## 15. What we do not promise

- Availability for visitors or tenants whose own network, DNS resolver or browser blocks or fails to reach our
  hostnames, including ad-blocker lists that later add our names.
- Survival of a simultaneous outage of both compute providers, both DNS providers, or the registry of both domains.
- Delivery of events or metric batches that could not be delivered for more than 72 hours. They are discarded at the
  cap and counted (C-18).
- That no event is lost when an edge node is permanently lost before its spool has drained. Its undrained backlog
  is lost: normally seconds of that node's traffic, more if the core was unreachable at the time. There are no
  off-node copies of the spool (C-77). The loss is bounded from the node's last reported accounting (O3) and
  published.
- Financial credits or a contractual guarantee for 99.99 % ingest and 99.90 % dashboard availability. We commit to
  run the hosted instance at those targets on the scale-out profile, measure them and publish every month, and report
  every miss with a post-mortem (C-78, C-180). We do not claim 99.99 % for a single VM (C-123).
- Survival of the loss of the single VM's data disk, zone or region without downtime (lean profile): recovery is a
  restore (M0).
- Delivery of tenant OTLP data that the tenant's SDK gave up on before our endpoint recovered. Retry windows vary
  by SDK, from a few seconds to about 5 minutes for the Collector; the onboarding guide shows how to extend them.
- That telemetry sent by tenants is genuine. API data is labelled "self-attested" (ADR-0028).
- That a tenant's numbers will be accepted by any funding or grant programme.
- Measured failover or rebuild times before we have measured them (M1–M3).
- That patches for vulnerabilities in services we do not operate (GitHub, npm, providers) ship within 24 h.
- That the daily watch and the 24-hour patch commitment hold before the maintainers have accepted the roster and named the
  people.
- That pinned tracker versions on tenant sites get fixed without the tenant upgrading.
- Financial credits or any payment for a missed objective.
- Any hosting, support or availability objective or commitment after handover acceptance.
- Legal compliance for tenants. Our privacy documentation is marked "needs counsel review" (ADR-0027).

## 16. Targets to measure before the scale-out profile goes live

| Target | Method | Evidence location | Replaces |
|---|---|---|---|
| Database failover 30–60 s, ≈ 0 data loss (M1) | Chaos test: kill the primary under load | `docs/evidence/chaos/` | M1 in §1 |
| RPO ≤ 60 s and RTO ≤ 4 h on Azure (M0, lean profile) | Timed drill: rebuild `app-1` from `envs/azure-lean`, restore from repository 2, measure WAL lag at the time of loss | `docs/evidence/dr/` | M0 |
| Rebuild from zero ≈ 4 h (M2) | DR drill into empty accounts | `docs/evidence/dr/` | M2 |
| Full restore ≤ 2 h (M3) | Restore drill from repository 2 | `docs/evidence/restore-drills/` | M3 |
| Edge-loss effect on the SLI | Chaos test: kill and black-hole an edge during probing | `docs/evidence/chaos/` | §6.1 rows |
| 10× load, including the span volume of §10 | Load test | `docs/evidence/load/` | K5, §10 span assumption |
| OTLP 2xx only after queue fsync | Spike S-04 — done (C-107; power loss not tested) | `spikes/s04-collector-build/` | §2.2 note |
| Writer failover with mTLS and the real mesh DNS; writer closing its listener without its database | Chaos test in the build (S-04 used plain HTTP and `/etc/hosts`; risk R-25) | `docs/evidence/chaos/` | §6.1 core row |
| Journey step threshold of 3 s | Calibration on production data | `docs/evidence/slo/` | §3.3 |
| Uptime history | Probes running from the first production deploy | `docs/evidence/slo/` | Risk R-02 |
| Visit split rate when an edge forwarder switches core | e2e soak test. S-01 (C-99) established that spool delay alone does not change visits (timestamps are receipt times) and that the engine proxy's 30-minute rule on event timestamps keeps a delayed burst from merging visits; it did not measure a split rate | `docs/evidence/` | §6.1 provider-failure row |

## 17. Open points

Closed since the previous draft: the probe cadence and quorum unit (C-78 fixes one definition, §2.2); "EU-owned"
wording (C-26, §11.1); durability measurement (C-76, §3.4).

| # | Point | What closes it |
|---|---|---|
| P1 | Open: **daily watch roster and the two patch responders.** K2 and the 72-hour part of O3 depend on named people (C-49, C-67), and the maintainers have not yet accepted the roster or named them. | Roster and names; an alert channel |
| P2 | Open: **business-day calendar and time zone for support** (§9.2). Needed before K3 and K4 can be measured. | A published support calendar |
| P3 | Open: **second DNS provider** (§11.2), chosen from providers whose ownership is verified (C-26). | Choice of provider |
| P4 | Open: **ADR-0031's full text still describes the ingest probe view in bad minutes (≥ 2 of 3 sources failing on ≥ 50 % of probes in a minute), and its OTLP probe as part of the headline.** This document and the monitoring plan follow C-78 (30-second rounds, canary event, one retry, 2-of-3 quorum) and the 5-minute dashboard journeys that ADR-0031 already states. | Aligning ADR-0031 with C-78 |
| P5 | Open: **span-volume assumption** (§10) is ours, not a register figure. S-04 confirmed that spans become metrics and no span leaves the Collector, but did not measure volume. | The 10× load test |
| P7 | Open: **a second outside probe source for the lean profile** (§1.1). On the v1 host the only view from outside the VM is the operator workstation's probe `ws-1` (not on the status page); the GitHub-hosted 5-minute checks of the design do not run; the second outside source is **Gatus v5.38.0 at `probe-d`** (30-second checks from a small VPS at a provider that hosts nothing else of ours), configured in `ops/status/` from the same `sli.json` as Upptime (C-146) — it restores a 2-of-3 quorum once the VM runs; converting its results into the monthly SLO figure is not built yet. The monitoring plan's SLI text (§2.2 here, `monitoring-plan.md`) still describes the scale-out probe sources. | Maintainers' decision; monitoring-plan update |
| P6 | Closed (C-110, C-112): **how long erased data stays in backups.** With weekly full backups and time-based retention a full can stay current 35 + 7 days, then 14 days as a previous version, so erased or expired data leaves all backups within **56 days** (data-model §14); erasure selectors are kept for the job plus 56 days (C-111, C-112), so every restore can re-apply every erasure. | — |

## Sources

- Primary pages read on 2026-11-12; the findings are summarised here.
- **Downtime arithmetic, SLI structure and burn-rate windows**: Google SRE Workbook, "Implementing SLOs" and
  "Alerting on SLOs" (sre.google/workbook).
- **Lean profile (C-123), read 2026-11-13**:
  - Service Level Agreement for Microsoft Online Services, English (WW), **November 17, 2026** edition (download
    linked from microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services, read
    2026-11-19), "Uptime Calculation and Service Levels for Single-Instance Virtual Machines": the lowest disk type on
    the VM decides — Premium SSD / Premium SSD v2 / Ultra Disk on every disk 99.9 %, Standard SSD 99.5 %, Standard
    HDD 95 %. (This replaces the September 2026 edition read on 2026-11-13, which was cited for the Premium SSD figure
    only.)
  - Azure Retail Prices API (prices.azure.com/api/retail/prices): every price in [`cost-model.md`](cost-model.md).
- **Provider facts and prices (scale-out research, 2026-11-12)**:
  - Hetzner Cloud SLA (docs.hetzner.com/general/company-and-policy/slas-cloud/): 99.9 %, best effort, credits.
  - status.hetzner.com: capacity notice open since 2026-06-26.
  - hetzner.com/cloud price pages.
  - heise.de/-11333037: June 2026 price increase.
  - ovhcloud.com VPS and Public Cloud price pages.
  - UpCloud pricing via web.archive.org snapshot of 2026-11-02.
  - ECB eurofxref-daily of 2026-11-11.
- **Patroni defaults**: patroni.readthedocs.io (ttl 30 s, loop_wait 10 s).
- **PostgreSQL 18 end of life**: postgresql.org/support/versioning (2030-11-14).
- **Retry defaults and temporality**:
  - OpenTelemetry Collector v0.165.0 `configretry` and `exporterhelper`.
  - SDK sources at the tags cited in the research.
  - OTel specification `metrics/sdk_exporters/otlp.md`.
- **Scheduled workflows**: GitHub Docs on disabling scheduled workflows after 60 days of inactivity.
- **Umami patch latency** (22–84 days): our analysis of Umami advisories 2024–2026.
- **Cyber Resilience Act Art. 14**: Regulation (EU) 2024/2847. Read from a mirror; needs counsel.
