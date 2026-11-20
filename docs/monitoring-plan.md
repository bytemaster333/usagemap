# Monitoring plan

Status: **plan of the built monitoring, revised 2026-11-13** (first written 2026-11-12). It defines what is monitored,
how each signal is computed, who is told, and how we know the monitoring works. The monitoring is built
([`ops/README.md`](../ops/README.md)): alert rules in `ops/alerts/*.rules.yaml`, Grafana dashboards D1–D14 generated
into `ops/dashboards/`, the probe, SLO report, status page and log scanner in `ops/cmd/scf-ops`, the dead-man's-switch
check `ops/deadman/check.sh`, runbooks in `ops/runbooks/`, the Compose overlay `infra/compose/compose.monitoring.yaml`.
Of the **111** alerts in the catalogue (§4.4), `ops/alerts/coverage.json` records **69 with a rule**, 7 partial, 23
waiting for a metric (each with the exact metric and its owner) and 12 outside Prometheus (portal notices, jobs, external checks).
Every rule has a firing and a non-firing `promtool` case (`ops/alerts/tests/*.test.yaml`, run by `ops/alerts/test.sh`);
the overlay is tested end to end against the real stack by `ops/e2e/run.sh`. Where this plan names a metric that the code names differently, the rule files are authoritative.
Every monitor is keyed to a threat in [`threat-model.md`](threat-model.md) as `<ThreatID>.M.<n>`, following SDF's
template convention.

**Production profile (C-123): no 2-of-3 probe quorum.** Production on Azure is the **lean profile** — the whole stack
on one VM (`app-1`). The three probe sources of §4.2 (`mon-c`, `probe-d`, the edge probers), the health controller and
the per-edge-node figures exist only in the **scale-out profile** (built and tested on Compose — `ops/internal/quorum`,
`services/health-controller`, `ops/probes/compose-*.json` — not deployed). In the lean profile the SLI is computed from
**two** views: the local probe on `app-1` (30-second rounds, `scf-ops probe`) and the **GitHub-hosted 5-minute checks**
of the public endpoints as the only outside source; the rules are in [`sla.md`](sla.md) §1.1 (a 5-minute window the
outside checks record as failed counts as bad in full; a window without outside data is unknown). There is therefore
**no quorum** and no independent confirmation of a bad local round. **The outside source is not wired:** the only
workflow is `.github/workflows/deadman.yml`, which runs `ops/deadman/check.sh` every 5 minutes once the repository
variable `SCF_STATUS_URL` is set; nothing runs the 5-minute public checks yet, so the lean profile has the local probe
only. The 99.99 % ingest objective of §4.1 is **not
claimed** for this profile (`sla.md` states the achievable figure). Where Prometheus scrapes exactly one probe source
(the lean `probe-mon-c`), `scf:probe_quorum:required` is 1 and that source decides alone, against the lean 99.5 % budget
(DV-41; `ops/alerts/recording.rules.yaml`): the burn-rate, `ProbeQuorumFailing`, `IngestHostnameDegraded` and
`EdgeNodeProbeFailing` alerts fire on that self-view, which sees the stack fail but never the VM, its public IP or DNS
from outside (P7). Without a configured probe site (`scf_probe_site_key` empty) no availability alert can fire.
`HealthControllerNoLease` is silent where no health controller is scraped. A second outside probe source is **open point P7** (§9; same ID as
`sla.md` §17). Sections 4.1 and 4.2 below describe the scale-out profile unless they say otherwise.

Binding decisions used here: ADR-0022 (observability stack, probes, quorum, dead-man's switch, log rule), ADR-0031
(SLIs and SLOs), ADR-0020/0021 (spool, HA, backups), ADR-0013/0014/0016 (isolation, audit, keys), ADR-0023 (supply
chain), ADR-0008/0028 (anti-inflation signals), and the register's Clarifications, in particular C-04 (daily-key
exchange), C-18 (72-hour cap), C-28/C-43 (freshness and SLI details), C-30 (probe sources, dead-man's switch), C-39
(gateway responses and counters), C-49 (daily watch duty), C-56 (restore drills in the EU), C-60 and C-74 (engine
proxy), C-62 (snapshot freshness), C-63 (audit anchor), C-67 (patch clock), C-71 (retention of monitoring data),
C-73 (tags `v`/`s` and the twin website), C-76 (durability measurement), C-77 (first-release simplifications), C-78
(availability definition), C-79 (monitoring node and deploy secrets), C-80 and C-90 (competitor flooding, quotas),
and the day-0 spike decisions C-99 (engine-proxy visit rule), C-104 (our Umami image), C-107 (Collector), C-108
(backups) and C-109 (dashboard read path). All clarifications C-01 … C-112 are binding; a later one overrides an
earlier one. Controls not in the register are
listed in §9 and are not presented as decided. "SCF operator" means a portal user with the `operator` or `operator_admin` role;
"service operator" means the entity that runs the service (C-59). "Maintainers" are the service operator's staff.

## 0. Mapping to SDF's monitoring-plan template

SDF publishes an "On-Chain Monitoring Plan Template (Builders)" with six sections, and this plan follows it. The template is written for contracts and accounts. Our
system has almost no on-chain surface (threat model §1.3), so we keep the six questions and their order and change
what they are asked about, rather than padding the plan with on-chain rules that could never fire.

| SDF section | Our section | How it is adapted |
|---|---|---|
| 1. What are we monitoring? (inventory of `C…` and `G…` addresses) | §1 Inventory | Inventory of hosts, public endpoints, data paths, keys, domains and release artifacts. The few on-chain items (SEP-10 signing account, read-only correlation) are listed for completeness. |
| 2. What could go wrong? (threats with STRIDE IDs and severity) | §2 Threats in scope | References the threat model's IDs and residual ratings instead of repeating them. |
| 3. What does exploitation look like on-chain? | §3 What exploitation looks like in our telemetry | Observable signatures in metrics, logs, audit rows, probes and external sources (CT logs, advisories). On-chain signatures appear only for the A3 correlation. |
| 4. What will we monitor for? (monitor IDs `<ThreatID>.M.<n>`, trigger, baseline, rule) | §4 SLIs, probes, dashboards, alert catalogue and the security, data-quality, capacity and backup monitors | Monitor IDs keep the template format. Each alert row states trigger, threshold (baseline where relevant) and rule. |
| 5. What happens when an alert fires? (who, channel, automated response, owner, status, last reviewed) | §5 Response | Severity routing without on-call (best-effort support model), automated responses where they exist, runbook per alert, owner, review date. |
| 6. Did we do a good job? | §6 Did we do a good job? | Alert tests, drills, false-positive and missed-detection review, the monthly public SLO report and the patch-latency report. |

Topics beyond the template (log policy, retention of monitoring data, how the monthly report is produced) are in §7
and §8.

---

## 1. What are we monitoring? (inventory)

| Item | Instances | Monitored for |
|---|---|---|
| Public ingest endpoints | gateway on `edge-a1`, `edge-a2`, `edge-b1`, `edge-b2` (C-25), reached via two ingest hosts on `<domain-a>` and `<domain-b>` (ADR-0004/0018) | Availability, latency, durability, freshness, abuse, tracker bytes |
| Public portal and API | Caddy on `core-a`, `core-b`; portal and API hostnames resolve to both (ADR-0018, C-07) | Availability, synthetic journeys, auth anomalies |
| Data path, web | tracker → gateway → spool → forwarder → engine proxy on the core picked by a consistent hash of the surrogate, the other core on failure (C-74) → Umami (`tag` ∈ `v`/`s`, C-73; events without a visitor identifier go to the site's twin Umami website) → job `web_rollup` reading Umami's tables through the read-only `scf_ro` view into hourly and daily rollups (C-109); counter records → the control plane's internal edge endpoint → `scf` (ADR-0005/0008/0011, C-39, C-60) | Spool depth/age, 72-hour discards, per-node spool accounting (C-76), forward errors, core failovers, duplicate forwards, verdict mix, rejected reasons, proxy denials, site rate-limit and quota state (C-90), rollup job lag and duration (C-109) |
| Data path, API | SDK/Collector → gateway (forwards only content and `x-scf-*` headers, C-107) → `scf-otelcol` → persistent queue → metrics-writer on `core-a` or `core-b` directly, through one name that resolves to both writers; the dialer moves to the other writer on a connection-level failure, and a writer without its database closes its listener (C-107); the loopback hop through the gateway (C-07) only for an mTLS/SAN problem → PostgreSQL (ADR-0009/0010) | Rejections by reason, queue depth/age, 72-hour discards, de-duplication, resets, stream groups, cardinality, `{redacted}` |
| Database | PostgreSQL 18 with Patroni, etcd (third member on `mon-c`), PgBouncer (ADR-0013/0020) | Replication, leader, connections, RLS coverage, audit chain and anchor |
| Engine and engine proxy | Umami v3.5.0 on each core node, reachable only through the **engine proxy** (`/services/engine-proxy`, Go) on the same core node, which terminates per-node mutual TLS, applies the per-caller path allow-lists and keeps Umami's cache token per (site, surrogate) in memory for 30 minutes (ADR-0003, C-60, C-74) | Engine and engine-proxy health, cache-token hit rate, egress attempts, proxy denials, adapter error codes |
| Backups | pgBackRest 2.60.0 to two repositories in two Azure storage accounts in two EU regions (C-96, C-110; Azurite locally), blob versioning with previous versions removed after 14 days (C-108, C-110), weekly `pg_dump`, weekly restore drill on our EU infrastructure (ADR-0021, C-29, C-56) | Age, failures, drill integrity |
| Keys and credentials | SCF-operator sessions and passkeys, `op` keys, `ing` tokens, `pub` keys (ADR-0014/0016, C-14), snapshot signing and sequence (C-62), `K_day` exchange and rotation (ADR-0007, C-04), the multiplicity key and the hourly challenge-token key `K_chal` (C-68), node mTLS certificates (C-60) | Use, creation, revocation propagation, key divergence, certificate expiry, anomalies |
| Domains and PKI | `<domain-a>`, `<domain-b>`, two DNS providers with static records as code (C-27), ACME certificates per node via the `_acme-challenge`-only credential (ADR-0005/0017/0023, C-61) | Record drift, certificate expiry, unexpected certificates (CT) |
| Release artifacts | tracker versions and signed manifest (including withdrawn versions answering `410`, C-37), npm package `@SCOPE/tracker`, images (ADR-0004/0023) | Served-hash drift, npm version list, advisories against deployed SBOMs |
| Monitoring itself | `mon-c`, `probe-d`, the edges' cross-provider probes and the probe client they run, GitHub-hosted scheduled checks and the GitHub dead-man's-switch workflow (ADR-0022, C-30). `mon-c` also holds the health controller's DNS write credential, an etcd member and mesh access, so its compromise is rated High impact (C-79, threat model) | Dead-man's switch, notification delivery, probe-source health, logins and listeners on `mon-c` |
| Audit anchor | Daily head hash of the audit chain in the public evidence repository and, when enabled, on the Stellar ledger (C-63) | Publication happened; published head matches the recomputed chain |
| On-chain (read-only, plus the optional anchor account) | SEP-10 `SIGNING_KEY` account (ADR-0014, C-15); audit-anchor account (C-63); correlation source health (ADR-0028) | Unexpected account changes (signers, thresholds); correlation job freshness |

## 2. What could go wrong? (threats in scope)

All threats in [`threat-model.md`](threat-model.md) §4–§8 are in scope. The ten highest residual risks are in its §9;
the monitors that address them are tagged in the alert catalogue (§4.4). Threats with no monitor are those where no
signal exists (e.g. TM-INF-05 paid humans produce no technical anomaly beyond L7 statistics); they are listed in §6.3
so the gap is visible.

## 3. What exploitation looks like in our telemetry

| Threat family | Observable signature |
|---|---|
| Web inflation (TM-INF) | Verified/raw ratio falls for one site; `suspect` reasons concentrate (datacenter share, multiplicity, header mismatch, framed/hidden); PoW issue→redeem latency distribution too fast or too narrow; step change shortly before an SCF deadline; no wallet events or on-chain movement despite more visitors. These are **tenant-level analytics signals** shown to SCF operators via the trust score (ADR-0028), not pages for maintainers. |
| Framing or flooding a competitor (C-80) | A sudden rise in one site's `suspect` share with `proof_missing` or origin reasons, without a matching rise in verified events; the site's per-minute rate-limit `429`s rise. Shown to the tenant and to SCF operators with reason codes so it can be annotated; quotas count verified events only, so the flood cannot use up the victim's quota; site `429`s are reported per site. |
| OTLP fabrication (TM-OTL-01/02) | Plausibility reason codes; de-duplication spikes for one tenant; flat or single-bucket histograms; on-chain divergence. Also SCF-operator-facing, not maintainer alerts. |
| OTLP abuse (TM-OTL-05…08) | Per-tenant 429s, overflow counters, memory-limiter refusals, size rejections, many slow connections. |
| Isolation (TM-ISO) | Canary tenant sees the other canary's marker; production RLS-coverage query returns rows; adapter receives 403/404 from Umami; one session touches many tenants. |
| Tracker supply chain (TM-TRK) | Served bytes differ from the signed manifest; npm lists a version we did not release; a certificate for our names from an unexpected issuer or account; DNS records outside our inventory. |
| Edge compromise (TM-EDG) | One node's verdict mix or per-tenant share diverges from its peers (traffic attributable by node certificate, C-60); unsigned binary or unexpected process; snapshot stale or an older sequence offered (C-62); `K_day` fingerprints diverge (C-04); engine-proxy denials; DNS changes outside `_acme-challenge` (C-61). |
| Umami exposure (TM-UMA) | Packets from the engine network to the internet (dropped by firewall); calls refused by the engine proxy; new advisory against our pin. |
| SCF-operator and service-operator abuse (TM-OPR) | Bulk SCF-operator reads; key creations; audit-chain verification failure or anchor mismatch; restore-drill integrity mismatch. |
| DoS (TM-DOS) | Probe quorum failures; one hostname or one node failing its own probes; spool growth and age (1 h / 6 h / 24 h marks); 72-hour discards; burn-rate alerts. |
| Enrollment abuse (TM-ENR) | Signup bursts and rate-limit hits; claims refused by tombstones (C-64); verification lapses followed by new claimants. |
| Privacy (TM-PRV) | `{redacted}` counters rise (API routes and web page paths, C-52); IP/UA patterns found by the log scanner. |

---

## 4. What will we monitor for?

### 4.1 Service-level indicators (ADR-0031, C-78)

The ingest availability definition below is used word for word in [`sla.md`](sla.md) §2.2 (C-78):

> Every 30 seconds each of the three probe sources (`mon-c`, `probe-d`, and the cross-provider probes on the edge
> nodes — C-30) sends a canary event for the canary site, as the pinned tracker does. The source records the round
> as good when at least one of the two ingest hostnames accepts the event (2xx after durable persistence) within
> 2 seconds, on the first attempt or on one retry to the other hostname. A round is good when at least two of the
> three sources record it good (2-of-3 quorum). Monthly ingest availability = good rounds ÷ rounds. Availability per
> ingest hostname and per edge node is published alongside and alerted on.

| SLI | Definition | How it is computed | Objective |
|---|---|---|---|
| **Ingest availability, probe rounds (headline)** | As quoted above (C-43, C-78) | The probe client on each source (§4.2) fetches a challenge, solves it and posts the canary event; *accepted* = 2xx after the record is fsync'd to the node's spool. A source whose own self-check fails does not vote; with two voting sources a round is bad only if both record it bad; with one, its result counts alone. Good rounds ÷ rounds per calendar month. | **Objective** 99.99 % per calendar month, no maintenance exclusion; measured and reported with an error-budget policy, not guaranteed |
| **Per ingest hostname** (published, alerted) | The same rounds, counting only the first attempt against that hostname (no retry) | Shows a lost domain, a DNS problem or a hostname-level failure that the retry hides (review finding AR-07) | No separate objective; alerts in §4.4 |
| **Per edge node** (published, alerted) | The same canary event sent to each node address directly, bypassing DNS, 2-of-3 quorum per node | Shows a black-holed or degraded node while the headline stays good | No separate objective; alerts in §4.4 |
| **OTLP probe** (published) | The same rounds with a small OTLP/HTTP metrics export and a probe-only ingest token; accepted = 2xx after the Collector's persistent queue stored it with `fsync: true` (S-04) | Published next to the headline | No separate objective |
| **Ingest availability, server-side ratio** (published next to the headline, C-43) | accepted ÷ valid requests at the edge; *accepted* = 2xx **after durable persistence** (fsync to spool or Collector queue) within 2 s | Gateway counters per node, route and outcome: `valid` excludes client-caused 4xx (bad token, `400` malformed, `404` unknown site key, `410` withdrawn version), site rate-limit and quota `429`s (reported per site, C-80, C-90) and our own load tests; **`rejected` events are outside the denominator** (C-39); 5xx, global-overload 429/503, timeouts and TLS failures count as bad. | — (explained against the headline) |
| **Durability** (C-76) | No accepted event is lost unless it could not be delivered for 72 hours, or the edge node that accepted it is permanently lost before forwarding it (its undrained backlog, normally seconds — C-18, C-77) | Every spooled record has a node ID, segment and offset. Per node and day: records fsync'd = records acknowledged (including Umami bot drops counted as `engine_bot_drop`, C-69) + records expired under the 72-hour rule + records still queued. The durability reconciliation job checks this daily; the same job counts the canary site's events in Umami per hour against the known hourly count sent. OTLP: queue batches = batches acknowledged by a writer + expired + queued. | **Objective**: 0 lost outside those two cases; every discard, imbalance and canary shortfall reported |
| **Freshness** | 99 % of accepted events visible within 5 minutes and 99.9 % within 60 minutes (C-28, C-43) | Probe canary events timed from send to visibility through the public read path, every 5 minutes, per data path (web, API). | **Objective** 99 % ≤ 5 min and 99.9 % ≤ 60 min per calendar month |
| **Dashboard availability** | good 5-minute journey windows ÷ windows | Every 5 minutes from each probe source a synthetic tenant signs in with a dedicated Stellar keypair (never a real user), loads the web overview (the site's live window answered by Umami and an older range served from our rollups, C-109), the API overview and, with a probe-scoped `op` key, the SCF-operator metrics API, and checks non-empty, correct-tenant data (any step > 3 s fails). A window is good when ≥ 2 of 3 sources record a successful journey. Plus `GET /healthz`-style readiness at 60 s (not part of the SLI). | **Objective** 99.9 % per month, no maintenance exclusion (C-43) |
| Support | first response ≤ 5 business days, resolution ≤ 10 | Issue automation labels (ADR-0031) | Commitment (sla K3, K4) |
| Vulnerability response | critical/high patched or mitigated within 24 h of the advisory appearing in a watched source or being reported to us (C-67) | Timestamps from advisories/issues (see `security/vulnerability-response.md` §11) | Commitment (sla K2), conditional on the named daily watch and responders |

**Reporting rule (C-43):** the headline availability figure is the probe-based one; the server-side ratio, the
per-hostname, per-node and OTLP figures are published next to it and any difference is explained in the report.

### 4.2 Probe design and quorum (ADR-0022, C-30, C-78)

- **Probe sources (C-30).** Three sources with a **2-of-3 quorum** for any availability verdict: (1) `mon-c`
  (OVHcloud, which hosts no ingest node); (2) `probe-d`, a small probe-only VPS at a fourth EU provider; (3) the
  cross-provider probes that edge nodes run against the other provider's nodes (Hetzner edges probe UpCloud edges and
  vice versa). A single-source failure is recorded and published but does not count.
- **Probe client.** Gatus cannot solve the proof-of-work, so the ingest probe is a small **probe client** of our own
  that behaves like the pinned tracker (challenge, proof, canary event, one retry on the other hostname) and records
  first attempts per hostname and direct per-node attempts. Gatus schedules the simpler checks. Its design is
  recorded in C-83.
- **Outside view.** GitHub-hosted scheduled checks feed the public status page (Upptime) from infrastructure we do not
  operate, at 5-minute resolution. They are a witness, **not** part of the SLI (C-30).
- **Probe set (every 30 s unless stated):** the ingest rounds (canary event through both hostnames, first attempt per
  hostname, and per node address); OTLP/HTTP metrics export with a probe tenant's token; OTLP/gRPC export (60 s);
  tracker file `GET` with hash check per node; `GET /healthz`. Per portal: readiness (60 s) and the authenticated
  journey (5 min). Per authoritative name server of each DNS provider: resolution of every public name (60 s). TLS
  expiry and issuer per node (hourly). Freshness canaries (5 min). Hourly canary count for the durability
  cross-check (C-76).
- **Probe identities** are dedicated synthetic tenants with a canary site (C-43; also used as isolation canaries,
  §4.5) with their own keys, rotated like any key, never real users.
- **Probe hygiene.** Probers use NTP; raw results (timestamp, probe source, target, outcome, latency) are stored
  append-only on object storage at a provider other than the one hosting the prober and published monthly (§8).

### 4.3 Dashboards

Provisioned from `ops/dashboards/` (ADR-0022). No dashboard shows IPs, User-Agents, paths of visitors, tokens or
per-visitor data; tenant-identifying labels appear only on operational counters.

| Dashboard | Panels |
|---|---|
| **D1 SLO overview** | Ingest availability (probe-round headline, per ingest hostname, per edge node, OTLP probe and server-side ratio, all month-to-date; rounds decided by fewer than three sources); error budget remaining (ingest 4.38 min, dashboard 43.8 min); burn rate 1 h/6 h/3 d; freshness share ≤ 5 min and ≤ 60 min per path; durability accounting per node, canary counts and 72-hour discards; dashboard journey success; open incidents |
| **D2 Edge ingest** | Requests by route and outcome per node; p50/p95/p99 time-to-2xx; 5xx and 429/503 rate; TLS handshakes and failures; open connections and HTTP/2 streams; bytes in; node health per DNS controller |
| **D3 Spool and forwarder** | Spool depth (bytes, records) and oldest-record age per node against the 1 h / 6 h / 24 h / 72 h marks; records discarded at 72 h; fsync latency; group-commit size; forward rate and errors per target core (consistent-hash routing, C-74); failovers to the other core; ambiguous retries (duplicate-forward counter); `engine_bot_drop` (C-69); per-node spool accounting and reconciliation result (C-76) |
| **D4 Verdicts and rejections (platform level)** | `v` / `s` shares, share of events sent to twin websites (no visitor identifier, C-73) and `rejected` counts across all tenants; rejected by reason; suspect by reason (incl. `proof_missing`, C-35); response codes `400`/`404`/`410`; PoW difficulty steps; challenge issuance vs redemption; `K_day` age, regeneration and divergence events (C-04); multiplicity-key and hourly `K_chal` rotation, events with an unknown token epoch (C-68); sites at their per-minute rate limit and sites marked `over_quota` (C-90) |
| **D5 OTLP pipeline** | Gateway OTLP requests by outcome and reason (auth, schema, size, time bounds, rate limit); Collector accepted/refused; memory-limiter refusals; queue size, oldest batch age and 72-hour discards; exporter failures; writer batches, de-duplication rate, stream resets, stream groups per service (C-22), late/future points, `{overflow}` (per service and per tenant, C-24) and `{redacted}` counts |
| **D6 PostgreSQL and HA** | Leader, replication lag (bytes, seconds), synchronous state; connections vs max; PgBouncer pools; long transactions; WAL archive status; XID age; table and partition sizes; slow query top-N (normalised, no parameters) |
| **D7 Engine and engine proxy** | Umami up per core; engine proxy up per core; `/api/send` latency and errors; cache-token memory size and hit rate (share of forwarded events that carried a cache token, C-74); adapter calls by endpoint and status; engine-proxy denials by caller and path (C-60); engine-network egress drops |
| **D8 Control plane and portal** | Requests and errors by route class; auth events (sign-ins, failures, passkey assertions, step-ups); session counts; key and token events; snapshot publication age and sequence |
| **D9 Jobs** | Last success and duration per job (partitions, retention, rollups, trust scoring, registry sync, domain verification, on-chain correlation, snapshots, purge, audit anchor, durability reconciliation, SLO report generator); RLS-coverage, audit-chain verification and anchor-comparison results |
| **D10 Security** | Canary results; SCF-operator reads per hour; `op` key use by key (volume, rate-limited, bad checksum); revoked tokens still presented; audit-chain and anchor status; tracker hash-drift per node; CT findings; DNS drift; listening-port scan diff; egress drops by component (C-10); node-certificate expiry; open advisories against deployed SBOMs with clock running |
| **D11 Backups and DR** | Last full/diff backup per repository; WAL archive lag; `pgbackrest check`; last logical dump; last restore drill on our EU infrastructure (result, duration, restored point, `pg_amcheck` and count checks, C-108); WAL archive lag right after each start or promotion (a missing post-start `CHECKPOINT` shows as up to `checkpoint_timeout` of lag, C-108) |
| **D12 Capacity** | CPU, memory, disk and predicted-full per host; database growth per month; page views/day against the 1,000,000/day web assumption and OTLP points/day against the 1 M requests/day API target, and the 10× tested level (C-48); per-site quota utilisation counted on verified events (top-N, C-80) |
| **D13 Hosts and network** | Host up; reboots pending; unattended-upgrade status; NTP offset; WireGuard handshake age per peer; firewall drop counters |
| **D14 Delivery and support** | Patch latency month-to-date; dependency-update and advisory PR age; daily-watch check log (C-49); support first-response and resolution clocks |

### 4.4 Alert catalogue

Severity and routing (ADR-0022; no on-call, best-effort support model):

- **critical** — push to the maintainers' chat channel and e-mail; repeats every 4 h until acknowledged. Security
  criticals go to the **security responders** (two named maintainers who receive push notifications, C-67;
  `security/vulnerability-response.md` §2). Whoever holds the **daily watch** that day (§5, C-49) sees every critical
  in the alert channel at the latest at their daily check.
- **warning** — e-mail digest (hourly grouping) and an issue in the private ops repository.
- **info** — dashboard and weekly review only.
- **portal notice** — shown to the affected tenant or to `operator_admin`s in the portal (product notifications, not
  maintainer alerts).

Pseudo-expressions use PromQL-like syntax with illustrative metric names. Burn-rate rules are generated by Sloth from
`ops/slo/*.yaml` (ADR-0022), so their exact expressions are not hand-written.

#### SLO and availability

| Alert | Monitor ID | Expression (words; pseudo-expression) | Threshold | Severity | Notified | Runbook |
|---|---|---|---|---|---|---|
| IngestBurnRateFast | TM-DOS-01.M.1 | Ingest error budget burning ≥ 14.4× over 1 h **and** 5 m (Sloth) | 14.4× | critical | maintainers | `ingest-burn-rate` |
| IngestBurnRateSlow | TM-DOS-01.M.2 | ≥ 6× over 6 h and 30 m (Sloth) | 6× | critical | maintainers | `ingest-burn-rate` |
| IngestBudgetTicket | TM-DOS-01.M.3 | ≥ 1× over 3 d and 6 h (Sloth) | 1× | warning | maintainers (issue) | `ingest-burn-rate` |
| DashboardBurnRateFast / Slow | TM-DOS-04.M.1 | Dashboard budget 14.4× (1 h/5 m) / 6× (6 h/30 m) | as stated | critical | maintainers | `dashboard-burn-rate` |
| ProbeQuorumFailing | TM-DOS-01.M.4 | Two consecutive bad ingest rounds (C-78): ≥ 2 of the 3 probe sources (`mon-c`, `probe-d`, edge cross-provider probes; C-30) record the round bad; `count(probe_round_good{kind="ingest"} == 0) >= 2` for 2 rounds | 2 of 3, 2 rounds | critical | maintainers | `ingest-probe-failure` |
| SingleVantageFailing | TM-DOS-01.M.5 | One probe source fails for 5 m while the others succeed | 5 m | info | — | `prober-health` |
| IngestHostnameDegraded | TM-DOS-01.M.8 | First-attempt success for one ingest hostname (no retry) below 99 % over 10 m by 2-of-3 quorum, while the headline rounds may still be good (C-78) — a lost domain, registrar or DNS-provider problem | < 99 % for 10 m | critical | maintainers | `ingest-hostname-degraded` |
| EdgeNodeProbeFailing | TM-DOS-01.M.9 | Direct probes to one edge node address fail by 2-of-3 quorum for 3 consecutive rounds (black-holed or degraded node, C-78) | 3 rounds | warning; critical if the node is still in DNS after 5 m | maintainers | `edge-node-down` |
| FreshnessSLOAtRisk | TM-DOS-04.M.2 | Share of canaries visible ≤ 5 min below 99 % over 1 h; `freshness_ok_ratio_5m_1h < 0.99` (C-28) | < 99 % | warning | maintainers | `freshness-degraded` |
| FreshnessStalled | TM-DOS-04.M.3 | No canary visible within 60 min on a path (the 99.9 % ≤ 60 min objective, C-43, is at risk) | 60 min | critical | maintainers | `freshness-degraded` |
| EdgeNodeDown | TM-DOS-01.M.6 | `up{job="gateway"} == 0` for 2 m (health controller removes it from DNS) | 2 m | warning | maintainers | `edge-node-down` |
| IngestCapacityDegraded | TM-DOS-01.M.7 | Fewer than 2 healthy nodes behind an ingest host, or all nodes of one provider unhealthy (C-25) | < 2 | critical | maintainers | `edge-node-down` |
| HealthControllerNoLease | TM-DOS-05.M.1 | No health-controller instance holds the etcd lease for 2 m | 2 m | critical | maintainers | `dns-health-controller` |
| EngineProxyDown | TM-DOS-04.M.7 | Engine proxy on a core node not ready, or forwarders failing over from it (C-74); visits routed to that core split once | 2 m | warning; critical if both cores | maintainers | `engine-proxy` |
| CacheTokenHitLow | TM-DOS-04.M.8 | Share of forwarded events carrying a cache token falls > 20 points below its 7-day median for 1 h (engine-proxy restart, routing change; visits split, C-74). Replays refused by the 30-minute rule on event timestamps (C-99) are excluded from the denominator and graphed separately | 20 points | warning | maintainers | `engine-proxy` |
| DNSRecordDrift | TM-EDG-06.M.1 | Published records at either DNS provider differ from the intended set: ingest and portal A/AAAA vs the health controller's set; all other records vs the zone files in git (C-27) | 5 m | warning | maintainers | `dns-drift` |
| DNSRecordForeign | TM-EDG-06.M.2 | Any published record for our names points outside our IP inventory | any | critical | security responders | `dns-drift` |
| CertExpiring | TM-DOS-07.M.1 | Node, Caddy or node-mTLS certificate (C-60) past ⅔ of lifetime without renewal; critical at < 7 days | ⅔ / 7 d | warning / critical | maintainers | `certificate-renewal` |
| SupportResponseDue | — | Ticket at 4 business days without maintainer response | day 4 | warning | maintainers | `support-sla` |

#### Data quality

| Alert | Monitor ID | Expression | Threshold | Severity | Notified | Runbook |
|---|---|---|---|---|---|---|
| SpoolAge | TM-DOS-03.M.1 | Oldest unacknowledged spool record age; `max by (node)(spool_oldest_record_age_seconds)` (C-49) | > 1 h warning; > 6 h critical; > 24 h critical, re-sent to both responders and the person on daily watch | warning / critical | maintainers | `spool-backlog` |
| SpoolDepthHigh | TM-DOS-03.M.2 | Spool bytes ÷ spool cap | > 50 % warning; > 80 % critical | warning / critical | maintainers | `spool-backlog` |
| SpoolDiscarded | TM-DOS-03.M.3 | Records or OTLP points discarded at the 72-hour cap (C-18; OTLP: the writer's `undeliverable_72h`, C-112); every discard is a durability exception reported monthly | > 0 | critical | maintainers | `spool-backlog` |
| ForwardErrors | TM-UMA-01.M.1 | Non-2xx from Umami `/api/send` ÷ forwards over 10 m | > 1 % | warning | maintainers | `forwarder-errors` |
| SpoolCorruptFrames | TM-INF-08.M.2 | Spool recovery skipped damaged frames in the middle of a segment (`scf_gateway_spool_corrupt_frames`; size in `scf_gateway_spool_corrupt_bytes`): those events are lost | > 0 | critical | maintainers | `spool-backlog` |
| EventKeyEvictions | TM-INF-08.M.3 | The engine proxy evicts event keys before their 1-hour de-duplication window ends (`scf_engine_proxy_event_key_evictions_total`, plan C1 #11): copies further apart than the shortened window are not recognised | > 0 per hour for 6 h | warning | maintainers | `forwarder-errors` |
| DuplicateForwardsHigh | TM-INF-08.M.1 | Ambiguous-retry (duplicate-forward) counter ÷ forwards over 1 h (ADR-0020) | > 0.1 % | warning | maintainers | `forwarder-errors` |
| DurabilityDiscrepancy | TM-EDG-09.M.2 | Daily reconciliation (C-76): on some node, records fsync'd ≠ acknowledged + expired at 72 h + still queued; or a node stopped reporting its accounting (possible permanent loss of its backlog, C-77) | ≠ 0 | critical | maintainers | `durability-reconciliation` |
| CanaryCountMismatch | TM-EDG-09.M.3 | Canary events counted in Umami for an hour differ from the known hourly count the probe sources sent (C-76) | ≠ 0 after the hour has drained | critical | maintainers | `durability-reconciliation` |
| ReconciliationStale | TM-EDG-09.M.4 | The durability reconciliation job has not succeeded for 26 h | 26 h | warning | maintainers | `durability-reconciliation` |
| WriterDedupeAnomaly | TM-OTL-02.M.1 | Writer de-duplicated batches ÷ batches vs 7-day median | > 3× median | warning | maintainers | `otlp-writer` |
| WriterRejectedData | TM-DOS-06.M.4 | Writer drop counters for reasons `tenant_write_error` (a tenant transaction rolled back on a non-transient SQL error, answered `200`) or `count_overflow` (histogram count beyond int4) increasing (C-112) | > 0 over 15 m | warning | maintainers | `otlp-writer` |
| StreamResetsHigh | TM-OTL-02.M.2 | Cumulative stream resets per tenant per hour | > 20 / h for one tenant | info + portal notice to tenant | tenant | `otlp-writer` |
| RejectedWebSpikePlatform | TM-INF-01.M.1 | Rejected web events by reason, all tenants, vs 7-day same-hour baseline; malformed or signature reasons after a release suggest **our** regression | > 5× baseline for 15 m | warning | maintainers | `verdict-shift` |
| VerifiedShareDropPlatform | TM-INF-02.M.1 | Verified share across all tenants drops > 20 points in 1 h (key rotation or gateway bug, not tenants) | 20 points | critical | maintainers | `verdict-shift` |
| OTLPRejectedSpike | TM-OTL-05.M.1 | OTLP rejections by reason (auth, schema, size, time bounds, rate limit) vs baseline | > 5× for 15 m | warning | maintainers | `otlp-rejections` |
| CardinalityOverflow | TM-OTL-06.M.1 | Tenant routes sent to `{overflow}` in a day | > 0 | portal notice | tenant | `cardinality-overflow` |
| CardinalityOverflowPlatform | TM-OTL-06.M.2 | More than 5 tenants overflowing in a day, or Collector memory-limiter refusals > 0 for 5 m | as stated | warning | maintainers | `cardinality-overflow` |
| RedactedValuesSeen | TM-OTL-11.M.1 | `{redacted}` counter increased for a tenant (value never recorded) | > 0 / day | portal notice | tenant | `redacted-paths` |
| RedactedBurst | TM-OTL-11.M.2 | `{redacted}` increments across tenants vs baseline | > 10× | warning | maintainers | `redacted-paths` |
| CollectorQueueHigh | TM-DOS-06.M.1 | `otelcol_exporter_queue_size` ÷ `queue_size`; oldest batch age uses the same 1 h / 6 h / 24 h marks as `SpoolAge` (C-49). The Collector has no age-based eviction (C-107); the 72-hour cap is enforced by the writer, which drops points received more than 72 h earlier (`scf.received_at_unix_nano`, counted `undeliverable_72h`), with the queue size limit as the second bound (C-112) | > 50 % warning; > 80 % critical | warning / critical | maintainers | `otlp-writer` |
| CollectorExportFailing | TM-DOS-06.M.2 | `otelcol_exporter_send_failed_metric_points` or `otelcol_exporter_enqueue_failed_metric_points` increasing (data dropped or refused by the queue, C-107) | > 0 for 5 m | critical | maintainers | `otlp-writer` |
| CollectorSanitiseDrops | TM-OTL-05.M.3 | Collector self-metrics of `scfsanitize` (C-113): `otelcol_processor_scfsanitize_dropped{signal,reason}` (items dropped, closed reasons — never a tenant or value) vs 7-day baseline; `otelcol_processor_scfsanitize_redactions{kind,location}` and `otelcol_processor_scfsanitize_merged_points` on the dashboard only | > 5× baseline for 15 m | warning | maintainers | `otlp-rejections` |
| CollectorReceivedAtFallback | TM-OTL-05.M.4 | `otelcol_processor_scfsanitize_received_at_fallback` increasing: the gateway forwarded a request without a valid `x-scf-received-at`, so the Collector used its own clock (wire-formats §f.4, C-113) — a gateway bug | > 0 over 15 m | warning | maintainers | `otlp-rejections` |
| CollectorSpanFilterHit | TM-OTL-05.M.5 | `otelcol_processor_filter_spans_filtered > 0`: the `filter/server_local_roots` backstop after `scfsanitize` dropped a span, which means `scfsanitize` let through a span it should have dropped and counted (C-113) — a bug, the drop is not attributed to the tenant | > 0 | warning | maintainers | `otlp-rejections` |
| WriterListenerClosed | TM-DOS-06.M.3 | A writer has closed its OTLP listener because it cannot reach PostgreSQL (C-107), or both writers are unreachable from an edge Collector | 2 m (one); any (both) | warning (one); critical (both) | maintainers | `otlp-writer` |
| KDayRegenerated | TM-DOS-08.M.1 | `K_day` generated by a node other than at the 23:50 UTC hand-over because no peer answered (C-04) | any | warning | maintainers | `visitor-key-regenerated` |
| SiteRateLimited | TM-DOS-02.M.3 | A site answers per-minute rate-limit `429`s, or is marked `over_quota` in the snapshot (C-90); reported per site in the monthly report (C-80). A rise driven by `suspect` traffic is shown with its reason codes so the tenant and SCF operators can annotate it | any | portal notice to the tenant; warning to maintainers if > 10 sites in an hour | tenant; maintainers | `site-quota` |
| SuspectSurgeOnSite | TM-DOS-02.M.4 | One site's `suspect` share rises > 30 points within 1 h without a rise in verified events (possible framing or flooding by a third party, C-80) | 30 points | portal notice to the tenant and `operator_admin`s | tenant; operator_admins | `verdict-shift` |
| SnapshotStale | TM-EDG-10.M.1 | No fresh snapshot accepted by a node for 15 minutes; `max by (node)(snapshot_age_seconds) > 900` (C-62). The node keeps serving its last good snapshot, so revocations do not reach it meanwhile | 15 min | critical | security responders | `snapshot-stale` |
| RangeListsStale | TM-INF-03.M.1 | Network-class range lists (C-38): last successful weekly update (`scf_rangelist_last_success_timestamp_seconds`, textfile of the lean range-list timer) older than 15 d, or a scraped gateway holds no `datacenter` entries (`scf_gateway_rangelist_entries`) for 2 h — every address is then `unknown` and the datacenter/Tor/VPN multiplicity thresholds never apply (bot.ip-multiplicity) | 15 d / 2 h | warning | maintainers | `range-lists` |

#### Security

| Alert | Monitor ID | Expression | Threshold | Severity | Notified | Runbook |
|---|---|---|---|---|---|---|
| CanaryIsolationBreach | TM-ISO-01.M.1 | A canary tenant's session or `op` key restricted to canary A receives any marker of canary B (portal API, adapter-backed endpoints, machine API) | any | critical | security responders | `isolation-breach` |
| CanaryProbeFailing | TM-ISO-01.M.2 | Canary journey cannot run for 30 m (blind spot) | 30 m | warning | maintainers | `isolation-breach` |
| RLSCoverageDrift | TM-ISO-02.M.1 | Scheduled production query: any table or partition in `scf` without RLS + FORCE, any grant on a partition, any view without `security_invoker`, any non-allow-listed `SECURITY DEFINER` function, any role with `BYPASSRLS` | > 0 rows | critical | security responders | `rls-coverage` |
| AdapterForbidden | TM-ISO-05.M.1 | Adapter receives 401/403/404 from Umami for a tenant-scoped call | > 0 in 1 h | warning | security responders | `adapter-errors` |
| UmamiSiteDrift | TM-ISO-05.M.2 | Portal sites and Umami websites out of step (`scf_cp_umami_site_drift{kind}`: orphan, missing, misplaced — the control plane's reconcile, plan C1 #12) | > 0 for 2 h | warning | security responders | `adapter-errors` |
| CrossTenantFanout | TM-ISO-06.M.1 | One session, key or process touches more than N tenants' contexts in 10 m outside allow-listed jobs (from `pg_stat_statements` and application metrics) | N = 20 (tune) | critical | security responders | `cross-tenant-fanout` |
| AuditChainBroken | TM-OPR-03.M.1 | Scheduled hash-chain verification fails | any | critical | security responders | `audit-chain` |
| AuditChainUnverified | TM-OPR-03.M.2 | Chain verification has not succeeded for 26 h | 26 h | warning | maintainers | `audit-chain` |
| AuditAnchorMissing | TM-OPR-03.M.3 | No head hash published in the public evidence repository for the previous UTC day (C-63) | 26 h | warning | maintainers | `audit-chain` |
| AuditAnchorMismatch | TM-OPR-03.M.4 | The recomputed head hash for an anchored day differs from the published anchor (repository or, when enabled, ledger) | any | critical | security responders | `audit-chain` |
| SealHistoryMismatch | TM-D1-06.M.1 | The daily seal's walk of its own ledger transaction history found a rewritten, missing, out-of-order or unknown seal transaction (`scf_seal_history_problems{network}`, plan C1 #10) | > 0 | critical | security responders | `audit-chain` |
| SCFOperatorBulkRead | TM-OPR-01.M.1 | Audited SCF-operator reads (`op_*` calls, C-17) per SCF operator per hour vs that person's 30-day p99 | > 3× p99 | warning | security responders + `operator_admin` notice | `operator-activity` |
| SCFOperatorPrivilegedAction | TM-OPR-04.M.1 | Any tenant removal, restore, purge, enrollment-mode change, SCF-operator allow-list change, `op` key creation or revocation, or tombstone lift (C-08, C-09, C-64) | every event | portal notice to all `operator_admin`s; info | operator_admins | `operator-activity` |
| SCFOperatorAuthAnomaly | TM-OPR-06.M.1 | SCF-operator passkey failures ≥ 5 in 10 m, new passkey registered, recovery by another `operator_admin` or break-glass used (C-20), or step-up failures | as stated | warning | security responders | `auth-anomaly` |
| AuthFailureSpike | TM-AUT-03.M.1 | Failed sign-ins (OAuth errors, SEP-53/SEP-10 verification failures, reused nonces) vs 7-day same-hour baseline | > 5× for 15 m | warning | maintainers | `auth-anomaly` |
| OpKeyAnomaly | TM-ISO-10.M.1 | `op` key: requests with bad checksum, key seen in a URL, rate-limited for 10 m, used from a new network class | any / as stated | warning | security responders | `api-key-anomaly` |
| RevokedTokenStillAccepted | TM-OTL-05.M.2 | Any `op` key accepted more than 5 s after revocation (checked against the database per request, C-06), or any `ing` token accepted more than 60 s after revocation by a node with a fresh snapshot | > 0 | critical | security responders | `revocation-propagation` |
| SnapshotSignatureInvalid | TM-EDG-10.M.2 | An edge node rejects a snapshot signature, or is offered a snapshot with an older sequence number (C-62) | any | critical | security responders | `snapshot-stale` |
| EgressDenied | TM-UMA-01.M.2 | Firewall drop counter for outbound traffic from any component without internet egress under C-10 (engine, writer, Collector, control plane, other jobs), or from the egress network to a destination off its allow-list | > 0 | critical | security responders | `egress-denied` |
| UnexpectedListener | TM-EDG-08.M.1 | Daily external scan (from `probe-d`) and internal scan (from `mon-c`) differ from the exposure table in `security/hardening.md` §2 | any diff | critical | security responders | `unexpected-listener` |
| NodeVerdictDivergence | TM-EDG-03.M.1 | One edge node's verified share or per-tenant traffic share (web events and API points, identified by node certificate, C-60) deviates from its peers by > 4 robust z | > 4 z for 1 h | warning | security responders | `edge-divergence` |
| KDayDivergence | TM-EDG-03.M.2 | More than one `K_day` fingerprint seen among edge nodes for the current day (after a partition; C-04) — that day's uniques are over-counted | any | warning | maintainers | `visitor-key-regenerated` |
| ProxyDenied | TM-EDG-08.M.3 | Engine proxy in front of Umami (C-74) refuses a caller (bad or unknown node certificate, path or parameter not allowed for that caller; C-60) | > 0 in 10 m | critical | security responders | `engine-proxy` |
| TrackerHashDrift | TM-TRK-03.M.1 | Hourly fetch of every released tracker file from every node address (bypassing DNS) does not match the signed manifest, a withdrawn version does not answer `410` (C-37), or the manifest signature does not verify | any | critical | security responders | `tracker-hash-drift` |
| NpmUnexpectedVersion | TM-TRK-02.M.1 | npm lists a version (or staged version) of `@SCOPE/tracker` not in our release list | any | critical | security responders | `tracker-hash-drift` |
| ReproducibleBuildMismatch | TM-TRK-01.M.1 | Independent rebuild of a released tag differs from the manifest | any | critical | security responders | `tracker-hash-drift` |
| CTUnexpectedCertificate | TM-TRK-04.M.1 | Certificate-transparency watch reports a certificate for our names not issued to our ACME account or not in our expected-issuer list | any | critical | security responders | `ct-alert` |
| DependencyAdvisoryUrgent | TM-UMA-04.M.1 | New advisory matching a deployed SBOM component with CVSS ≥ 7, KEV listing or EPSS ≥ 0.1 (ADR-0023) — **the 24 h clock started when it appeared in the watched source** (C-67); the pipeline opens the patch change and pushes both named responders | any | critical | security responders | `vulnerability-response` |
| UmamiUpstreamSecuritySignal | TM-UMA-04.M.2 | Umami GHSA or NVD/VulDB entry, or a `dev`-branch commit mentioning "security"/"vulnerab" | any | warning | security responders | `vulnerability-response` |
| OnchainLedgerAnchorMismatch | TM-DEL-02.M.1 | The mirrored ledger files disagree with Horizon on a day's anchor ledger hash (C-144): the store served a forged or wrong chain; those days were refused | any | critical | security responders | `audit-chain` |
| OnchainLedgerAnchorUnverified | TM-DEL-02.M.2 | Horizon has not confirmed the anchor ledger of complete on-chain days for 26 h; the days wait unused | > 0 for 26 h | warning | maintainers | `audit-chain` |
| DeployVerifyFailed | TM-OPS-04.M.1 | `cosign verify` or attestation verification fails in the deploy playbook (run from a service-operator workstation or a pull-based agent; no hosted runner holds production credentials, C-79) | any | critical | security responders | `deploy-verify` |
| MonitoringNodeAccess | TM-OPS-06.M.1 | Any login, `sudo`, new listener or new inbound flow other than the mesh and the status endpoints on `mon-c` (C-79); any DNS write by the health controller that does not follow a probe-based removal or re-add | every event | critical | security responders | `monitoring-node` |
| SigningAccountChanged | TM-AUT-04.M.1 | SEP-10 `SIGNING_KEY` account or audit-anchor account (C-63): signers, thresholds or `home_domain` change on-chain | any | critical | security responders | `sep10-signing-key` |
| LogPIIDetected | TM-PRV-06.M.1 | Log scanner finds IPv4/IPv6, UA-like strings, bearer tokens or `scfa_` key patterns in VictoriaLogs | any | critical | security responders | `log-pii` |
| SignupBurst | TM-ENR-06.M.1 | Tenant signups per hour vs baseline; rate-limit hits per identity and subnet (C-64) | > 10× | warning | maintainers + `operator_admin` notice | `enrollment-abuse` |
| DomainReclaimed | TM-ENR-03.M.1 | Verification lapse on a host followed by a claim from another tenant, or a claim refused by a tombstone (C-64) | any | portal notice | operator_admins | `enrollment-abuse` |
| VerifierEgressDenied | TM-ENR-07.M.1 | Domain verifier attempted a private, loopback or our own address | > 10 / h | warning | security responders | `verifier-ssrf` |
| SSHSession | TM-OPS-02.M.1 | Any interactive SSH session or `sudo` on a production host (few maintainers, so every event is reviewed) | every event | info (chat) | maintainers | `access-review` |

#### Capacity, database, backup, monitoring

| Alert | Monitor ID | Expression | Threshold | Severity | Notified | Runbook |
|---|---|---|---|---|---|---|
| DiskPredictedFull | TM-DOS-03.M.4 | `predict_linear(node_filesystem_avail_bytes[6h], 24*3600) < 0` | full within 24 h | warning | maintainers | `disk-space` |
| DiskHigh | — | Filesystem used | > 80 % | warning | maintainers | `disk-space` |
| IngestAboveTested | TM-DOS-02.M.1 | Daily events or OTLP points above 5× design target (10× is the tested level, ADR-0026) | > 5× | warning | maintainers | `capacity-review` |
| EdgeCPUHigh | TM-DOS-02.M.2 | p95 CPU per edge node over 1 h | > 70 % | warning | maintainers | `capacity-review` |
| ConnectionsNearMax | — | PostgreSQL connections ÷ `max_connections` | > 80 % | warning | maintainers | `postgres-connections` |
| PatroniNoLeader | TM-DOS-04.M.4 | No leader for 30 s | 30 s | critical | maintainers | `failover-postgres` |
| ReplicationLagHigh | TM-DOS-04.M.5 | Replica lag | > 30 s for 5 m | warning | maintainers | `postgres-replication` |
| EtcdMembersLow | TM-DOS-04.M.6 | etcd members healthy | < 3 for 5 m | warning | maintainers | `failover-postgres` |
| XIDWraparoundRisk | — | Oldest XID age ÷ 2³¹ | > 50 % | warning | maintainers | `postgres-vacuum` |
| WALArchiveFailing | TM-OPS-01.M.1 | `pg_stat_archiver` failures increasing, or archive lag > 5 min | as stated | critical | maintainers | `backup-failure` |
| BackupFullStale | TM-OPS-01.M.2 | Last full backup per repository | > 8 d | warning | maintainers | `backup-failure` |
| BackupDiffStale | TM-OPS-01.M.3 | Last differential backup per repository | > 26 h | warning | maintainers | `backup-failure` |
| BackupCheckFailing | TM-OPS-01.M.4 | `pgbackrest check` fails; or `pgbackrest verify` output contains `missing` or `WARN` lines (its exit code is 0 even with missing files, S-08 — never alert on the exit code alone); or the repository's blob versioning or previous-version lifecycle rule is off, or a database node's credential can delete blob versions (C-108) | any | critical | maintainers | `backup-failure` |
| LogicalDumpStale | TM-OPS-01.M.5 | Weekly `pg_dump` older than 8 d | > 8 d | warning | maintainers | `backup-failure` |
| RestoreDrillStale | TM-OPS-01.M.6 | Last successful restore drill (run on our EU infrastructure, never on GitHub-hosted runners; C-56) | > 8 d | critical | maintainers | `restore-drill` |
| RestoreDrillIntegrityMismatch | TM-OPR-02.M.1 | Drill's integrity checks (row counts and sums per closed partition; external comparison with the SCF-operator metrics API) differ | any | critical | security responders | `restore-drill` |
| Watchdog | — | Always-firing heartbeat from Alertmanager on `mon-c`, published every 5 m where the dead-man's-switch workflow can read it (mechanism fixed at implementation) | n/a | none (heartbeat) | GitHub workflow | `dead-mans-switch` |
| DeadMansSwitchMissed | — | The scheduled GitHub workflow (C-30) finds no heartbeat newer than 15 m, or no restore-drill result newer than 8 d | 15 m (plus GitHub scheduling delay) | critical (raised by the workflow) | maintainers | `dead-mans-switch` |
| NotificationsFailing | — | Alertmanager notification failures | > 0 for 15 m | warning (via the other channel) | maintainers | `alert-delivery` |
| NTPOffset | — | Clock offset on any host | > 100 ms | warning | maintainers | `time-sync` |
| WireGuardStale | TM-EDG-08.M.2 | Handshake age per peer | > 5 m | warning | maintainers | `mesh-health` |

### 4.5 Security monitoring in detail

- **Authentication anomalies.** Sign-in failures by method (GitHub OAuth, SEP-53, SEP-10, passkey), reused nonces,
  step-up failures, new passkey registrations for owners and SCF operators. Rates only; no IPs are stored (ADR-0022).
- **Key use.** For every `op` key: requests, rate-limited events, last-used, network class of last use (coarse),
  bad-checksum attempts and keys seen in URLs (treated as compromised, ADR-0016); acceptance after revocation must be
  zero beyond the 5-second cache (C-06). For `ing` tokens: last use and acceptance after revocation (must be zero after
  60 s on every node with a fresh snapshot; a stale node is covered by `SnapshotStale`, C-62).
- **SCF-operator access.** Every cross-tenant read goes through an `op_*` function that writes an audit row in the
  same transaction (ADR-0013, C-17). Monitors watch volume per SCF operator and privileged actions; all
  `operator_admin`s are notified of every privileged action.
- **Audit-chain verification and anchor.** A job recomputes the hash chain daily and on demand (TM-OPR-03.M.1). The
  head hash is published daily in the public evidence repository and, when enabled, written to the Stellar ledger
  (C-63). The monitor checks that each day's anchor was published (TM-OPR-03.M.3) and that the recomputed head for
  every anchored day still matches it (TM-OPR-03.M.4), so a rewrite of anchored history is detected by us and by
  anyone else. Rows written since the last anchor are not yet covered; this limit is stated.
- **Canary tenants for isolation.** Two synthetic tenants with distinctive markers; every 5 minutes canary A, through
  the public portal API, adapter-backed endpoints and a tenant-restricted `op` key, must never see canary B's markers
  (ADR-0013). The same canaries carry the probe and freshness traffic.
- **Unexpected egress.** Only the components listed in C-10 may open outbound internet connections, from the
  egress-allow-listed network; the engine has no egress except PostgreSQL (ADR-0003). The host firewall logs and
  counts drops per component, and any drop alerts (TM-UMA-01.M.2, `EgressDenied`).
- **Engine proxy and node identity.** Denials at the engine proxy in front of Umami on each core node (unknown
  certificate, disallowed path or parameter; C-60, C-74) and writer requests without a valid node certificate
  alert; per-node shares of web
  events and API points feed `NodeVerdictDivergence`.
- **Monitoring node (`mon-c`).** It holds the health controller's DNS write credential, an etcd member and mesh
  access, so its compromise is rated High impact (C-79). It accepts no inbound traffic except the mesh and the status
  endpoints; every login, new listener or unexpected inbound flow alerts (`MonitoringNodeAccess`), and `probe-d`
  watches it from outside. The OpenTofu state credentials are not stored on it or on any other server (C-79).
- **Snapshot freshness.** Each node reports the sequence number and issue time of its current snapshot; no fresh
  snapshot for 15 minutes is critical, because the node keeps serving the old one and revocations do not reach it
  (C-62).
- **Visitor-key divergence.** Each node exports the SHA-256 fingerprint of its current `K_day` (never the key); more
  than one fingerprint for the same day raises `KDayDivergence` and the day is annotated as over-counted (C-04).
- **Tracker-hash drift against the signed manifest.** Hourly, from `mon-c` and from `probe-d`, every released tracker
  file is fetched from **each node address directly** and through DNS, hashed and compared with the Sigstore-verified
  manifest; withdrawn versions must answer `410` (C-37); the npm tarball of each version is checked the same way daily.
- **Certificate-transparency watch.** CT monitoring of `<domain-a>` and `<domain-b>` (ADR-0023): every new
  certificate is logged; one not issued to our ACME account(s) or by an expected issuer is critical.
- **Dependency and advisory watch.** Daily SBOM-based rescans of deployed digests; GHSA for our repositories,
  `umami-software/umami`, Next.js, React, Prisma, Collector and Go; CISA KEV hourly; EPSS daily; Umami `dev`-branch
  security commits. Details and the clock in `security/vulnerability-response.md`.

### 4.6 Data-quality monitoring in detail

| Signal | Meaning | Where |
|---|---|---|
| Spool age (oldest record) | Spool not draining; alerts at 1 h, 6 h, 24 h (C-49) | D3, SpoolAge |
| Spool depth and 72-hour discards | Backlog, and records lost to the deliberate 72 h cap (C-18) | D3, SpoolDiscarded |
| Duplicate-forward counter | At-least-once retries to Umami whose first attempt may have succeeded; reported monthly (ADR-0020) | D3, DuplicateForwardsHigh |
| Writer de-duplication rate | Collector redeliveries and tenant replays removed by the ledger (ADR-0010) | D5 |
| Rejected-event rates by reason | Web (schema, origin, challenge, bot list) and OTLP (auth, size, time bounds, schema, rate limit) | D4, D5 |
| Cardinality overflow | Routes sent to `{overflow}` per tenant (ADR-0012) | D5, portal notice |
| `{redacted}` counters | Secrets or PII shapes removed from paths per tenant (ADR-0012) | D5, portal notice |
| Stream resets | Cumulative resets (restarts) per tenant and stream (ADR-0010) | D5 |
| Verified/raw ratio (platform) | A platform-wide shift is our bug; a single-tenant shift is a trust-score input | D4 |
| `K_day` regeneration and divergence | Over-counting of that day's uniques (ADR-0007, C-04), annotated on dashboards | D4, KDayRegenerated, KDayDivergence |
| Cache-token hit rate | Share of forwarded events for which the engine proxy held and added Umami's cache token; a low rate means more split visits (C-74). Replays refused by the 30-minute rule on event timestamps and token purges after website deletion are counted separately (C-99) | D7, CacheTokenHitLow |
| Live-window and rollup health | Per site: live window in days, live-query latency (p95) against the ~1 s budget of 250,000 events per query (S-11), live calls that hit the 5 s timeout and fell back to the rollups (`partial_today`, C-112), Umami statements cancelled by `statement_timeout` (C-112), `web_rollup` lag and duration per run (~35 s per closed day for 300 sites, S-11), days not yet final after D-3 (C-109) | D7, D2 |
| Events without visitor identifier | Share of events per site sent to the site's twin Umami website; they count toward page views, country and device only (C-73) | D4 |
| Durability accounting | Per node and day: records fsync'd = acknowledged + expired at 72 h + still queued; canary hourly counts in Umami (C-76) | D3, DurabilityDiscrepancy, CanaryCountMismatch |
| `engine_bot_drop` | Events Umami silently dropped as bots while answering 200; delivered, not lost (C-69) | D3 |
| Site rate limits and quotas | Sites at their per-minute limit or `over_quota`; quotas count verified events only (C-80, C-90) | D4, SiteRateLimited |

### 4.7 Capacity monitoring

Design targets 1 M API requests/day and 1,000,000 web page views/day across tenants, load-tested at 10× (ADR-0026,
C-48). Capacity signals: page views/day and OTLP points/day against those levels; per-node CPU, memory, connections and HTTP/2 streams; spool fsync latency; Collector memory;
writer upsert latency; database size growth per month vs volume size; partition counts; per-tenant quota utilisation.
Reviewed monthly in the SLO report; warnings at 5× design target and 70 % p95 CPU. Measured reference points (C-109,
C-103): Umami grows by ≈ 1.05 GB per day per 1 M page views (77 % indexes), so the database host needs ≥ 250 GB of disk
at the default 90-day event retention (S-11; risk R-27); one Umami container saturates at ≈ 400 events/s, so ≤ 300
events/s per container is the planning figure; the writer used ≈ 0.4 core of PostgreSQL at 10× (S-05).

### 4.8 Backup and restore-drill monitoring

pgBackRest (2.60.0, C-108) exporter metrics per repository (last full, last differential — each repository is
backed up separately, `--repo=1` and `--repo=2` — archive lag, `check` result; C-29); WAL archive failures; weekly
logical dump age. **C-108 replaces C-66's no-delete credential**: pgBackRest cannot complete a backup without delete
rights (S-08), so database nodes may delete current blobs but not previous versions, blob versioning is on and a
lifecycle rule removes previous versions after 14 days (C-110). The check confirms that versioning and that rule are in place
and that the node credential cannot delete a blob version — on real Azure only; Azurite emulates none of it (risk
R-23). `pgbackrest verify` exits 0 even when files are missing (S-08), so its output is parsed for `missing`/`WARN`
lines and the weekly restore drill (an actual restore) is the integrity check. The restore drill (ADR-0021,
`restore-drill.sh` of S-08) runs **on our own EU infrastructure, never on GitHub-hosted runners, and backup keys never
leave it** (C-56); it uses repository 2 with a read-and-list-only credential, runs `pg_amcheck --heapallindexed` and
count checks, prints one `RESTORE-DRILL PASS|FAIL …` line, pushes its result, duration, restored point in time and
integrity outcome, and only that result (pass/fail, timings, checksums) is published. A drill that has not succeeded in 8 days is critical; an integrity mismatch is a security event
(TM-OPR-02.M.1). Monthly drill summaries go to `docs/evidence/`.

### 4.9 Dead-man's switch

The dead-man's switch is a **scheduled GitHub workflow**, `.github/workflows/deadman.yml` (C-30). Alertmanager's always-firing `Watchdog` publishes a
heartbeat every 5 minutes to a place the workflow can read (mechanism fixed at implementation; no visitor data); the
workflow alarms the maintainers through the alert channel and a GitHub notification when the heartbeat is older than
15 minutes, or when no restore-drill result is newer than 8 days. Scheduled workflows can start late, so detection
takes 15 minutes plus GitHub's scheduling delay; we say so. This covers a dead `mon-c`, a broken Alertmanager
configuration and a network partition of the monitoring node. `probe-d` also probes `mon-c`'s Alertmanager health
endpoint.

**While the GitHub-hosted check does not run and in the lean profile:** the status host the workflow reads
is on the same VM as Alertmanager. The lean role therefore also sends the `Watchdog` to an **outside heartbeat monitor**:
`scf_stack_secrets.deadman_ping_url` (SOPS), a "ping URL" of a monitor on other infrastructure that alarms when pings
stop (for example a self-hosted Healthchecks instance, BSD-3-Clause). Once that monitor exists,
`scf_alert_deadman_required: true` makes the deploy refuse to run without it. Until then the lean profile has **no**
working dead-man's switch; we say so. Alertmanager's own delivery is enforced at deploy time: the role refuses a
configuration in which maintainers-critical, maintainers-warning or security-responders has no channel (audit
2026-11-18 finding 2).

---

## 5. What happens when an alert fires?

| Field (SDF template) | Our practice |
|---|---|
| Who | **critical**: maintainers' push channel (security criticals: push notification to the two named security responders, C-67). **Daily watch**: one named person per calendar day, weekends included, checks the advisory feed and the alert channel (C-49). **warning**: e-mail digest + private ops issue. **portal notice**: affected tenant or all `operator_admin`s. SCF operators see tenant-level trust and assurance signals in the portal, not maintainer alerts. |
| Channel | Push via chat webhook and e-mail (Alertmanager receivers); private ops repository issues; portal notifications; public status page (Upptime issues) for user-visible incidents. |
| Automated response | Health controller (on `mon-c` and `core-b`) removes dead or failing edge and core nodes from the ingest and portal records (ADR-0020, C-07, C-27); edge forwarders fall back to the other core's engine proxy and the Collector's dialer to the other writer when a writer refuses connections (C-74, C-107); Patroni fails over the database (ADR-0020); dashboards fall back to read-only from the replica (ADR-0020); per-tenant 429/503 with `Retry-After` (ADR-0009); per-site rate limits and `over_quota` via the snapshot (C-90); adaptive PoW difficulty (ADR-0008); ingest-token revocation propagates via the snapshot (ADR-0016, C-06); records undeliverable for 72 h are discarded and counted (C-18); a 24-hour-class advisory opens the patch change automatically (C-67). Everything else is human. |
| Owner | Each alert's runbook names the owning role. Default: platform maintainers; security alerts: security responders; enrollment notices: `operator_admin`s. |
| Status | Tracked in the private ops issue (open / mitigated / resolved / post-mortem published). |
| Last reviewed | Each runbook carries a `last reviewed` date; reviewed quarterly and after every firing. |

**Response targets without on-call** (honest): "no on-call" stands — there is no paging rotation. Critical alerts
are acted on best-effort as soon as a maintainer sees the push, typically within hours in waking time; the ingest
objective is designed to need no human (ADR-0020/0031). Two things do need a human every calendar day, which is why the daily
watch exists (C-49): the 72-hour spool cap (a backlog alerting at 24 h leaves two days to act) and the 24-hour patch
commitment, which depends on one of the two named responders acting on the push (C-67). The roster must be accepted
by the service operator and is stated in the SLA. Every alert must link a runbook file; the `ops/internal/alertlint`
test fails if one is missing (ADR-0022).

## 6. Did we do a good job?

### 6.1 Testing the monitoring itself

- Alert rules are unit-tested with `promtool test rules`; every alert has at least one firing and one non-firing case.
- The SLO recording rules are hand-maintained in Sloth's output structure from `ops/slo/*.sloth.yaml`.
- **Game days each quarter**: kill an edge node, black-hole an edge node (`EdgeNodeProbeFailing` must fire),
  withdraw one ingest hostname from DNS in staging (`IngestHostnameDegraded` must fire while the headline rounds stay
  good), stop one core's engine proxy (`EngineProxyDown` must fire; forwarders must fail over), drop a canary event
  in staging (`CanaryCountMismatch` must fire), stop the database, stop the forwarder, revoke a token, plant a
  modified tracker file on a staging node, run a canary isolation breach in staging, break the audit chain in staging
  (anchor mismatch must fire), partition the mesh (`KDayDivergence` must fire, C-48), block a node's snapshot pulls
  for 15 minutes (`SnapshotStale` must fire), call Umami through the engine proxy with a disallowed path, silence
  Alertmanager (the GitHub dead-man's-switch workflow must fire). Each produces a dated record in `docs/evidence/`.
- Chaos and restore drills from ADR-0026 double as alert tests.

### 6.2 Metrics of the monitoring

Reported monthly: alerts fired by severity; time to acknowledge critical alerts; false positives (alerts closed as
"no action needed"); incidents detected by users or tenants before an alert fired (**missed detections**, each gets a
new or tuned monitor); probe disagreement between the three sources; probe-based vs server-side SLI disagreement;
days on which the daily watch was not confirmed.

### 6.3 Known blind spots

- **Paid humans and patient farms** (TM-INF-04/05) produce no maintainer-facing signal; they appear, if at all, as L7
  trust-score reason codes for SCF operators.
- **Fabricated OTLP** (TM-OTL-01) is visible only through plausibility and on-chain indicators.
- **An audit-chain rewrite of rows written since the last daily anchor** (C-63) is undetectable until the next
  anchor is published; anchored history is covered.
- **Compromise of a process that legitimately holds cross-tenant capability** (TM-ISO-06) is detectable only through
  volume anomalies.
- **Lean profile (C-123): the local probe measures the VM it runs on**, and the only outside view is the GitHub-hosted
  5-minute checks; no quorum confirms or refutes a bad round (open point P7).
- **Scale-out profile: the SLI's probe sources are all ours** (`mon-c`, `probe-d`, the edges), at three different providers; only the
  GitHub-hosted status-page checks (5-minute resolution, not part of the SLI) and the dead-man's-switch workflow run on
  infrastructure we do not operate (C-30).
- **Fabricated or self-generated API telemetry** still needs a human reading of plausibility codes; it has no
  maintainer alert.

## 7. Log policy and retention of monitoring data

### 7.1 Never logged (ADR-0006, ADR-0022)

IP addresses (full or truncated); User-Agent strings; any request header, including `Authorization`, cookies and
tenant APM-vendor headers; request or response bodies; query strings; tokens, API keys, session identifiers,
passkey material, OAuth codes; `K_day`, the multiplicity key, challenge keys, surrogate addresses, Umami cache tokens; Stellar addresses, XDR,
signatures and SEP-10/SEP-53 challenges; page paths, referrers, custom-event names and properties of web events;
OTLP attribute values; SOPS plaintext. SQL parameter values are not logged (statement logging off; `pg_stat_statements`
keeps normalised statements only).

The end-to-end suites' log output is grepped for IP, UA, bearer-token and `scfa_` patterns; any hit fails the
run. The same patterns run against production logs daily (LogPIIDetected).

### 7.2 What logs may contain

Timestamps, service, node, route class (not the path), status, latency, tenant and site IDs for operational events,
reason codes, error classes, job names and durations, actor IDs on audit events.

### 7.3 Retention

| Data | Retention | Basis |
|---|---|---|
| Prometheus metrics on `mon-c` | 13 months (C-71) | operational; covers a full year of monthly reports |
| VictoriaLogs (operational logs) | 30 days (C-71); host journald 7 days, 1 GB cap | operational |
| Raw probe results | Published monthly with the SLO report and kept in the repository for the life of the service | SLO evidence (ADR-0031) |
| Monthly SLO, patch-latency, restore-drill reports | Life of the service, in `docs/evidence/` | evidence |
| Audit log | Life of the service (ADR-0011) | ADR-0011 |
| Rejected-event counters | 25 months (ADR-0011) | ADR-0011 |
| Alert history | Alertmanager is ephemeral; incidents live in the private ops issues and public post-mortems | — |
| Upptime history | Public repository, indefinitely | ADR-0022 |

## 8. The monthly public SLO report

1. On the 1st of each month the **SLO report generator** (a scheduled job,
   C-83) queries the Sloth recording rules for the calendar month (ingest probe
   rounds, per hostname, per node, OTLP probe, server view, dashboard, freshness), the durability reconciliation
   results (per-node accounting and canary counts, C-76), the raw probe store and
   the support and patch-latency data.
2. It writes `docs/evidence/slo/YYYY-MM.md` plus CSV files: each SLI with numerator and denominator, error budget
   consumed, the probe-based headline with the server-side ratio next to it and an explanation of any difference
   (C-43), freshness at 5 and 60 minutes (C-43), exclusions applied with counts (client 4xx, rejected events outside
   the denominator per C-39, site rate-limit and quota `429`s **per site** per C-80, our own load tests), incidents with links to post-mortems, duplicate-forward and
   durability figures including records discarded at the 72-hour cap (C-18), `engine_bot_drop` counts (C-69) and
   the bound on any backlog lost with an edge node (C-77), support statistics (median first
   response, breaches), patch latency per advisory, restore-drill outcomes (pass/fail, timings, checksums only; C-56),
   and **the raw per-probe results for every probe source** so anyone can recompute the numbers (ADR-0031).
3. The job opens a pull request; a maintainer reviews it and merges it. The status page links the report.
4. The report and its CSV files are signed when they are generated so later edits are detectable (ADR-0031).
5. Any missed objective gets a public post-mortem within 5 business days (ADR-0031).

## 9. Open points

Resolved: MP-01 by C-43 (the probe-based figure is the headline); MP-05 by C-30 (`probe-d` is the third SLI source;
GitHub-hosted checks are an outside view, not part of the SLI); the availability definition and probe cadence by
C-78 (§4.1); MP-02 (monitoring retention) by C-71 (§7.3); MP-03 (signed reports) by ADR-0031; durability measurement
by C-76; the monitors MP-06 waited for on OP-03 and OP-13 are in the catalogue (`NodeVerdictDivergence`,
`ProxyDenied`, `AuditAnchorMissing`/`AuditAnchorMismatch`).

| ID | Open point | What would close it |
|---|---|---|
| MP-04 | Open: the names of the two security responders, the daily-watch roster and the alert channel (C-49 and C-67 decide that they exist). | The service operator naming its approvers, alert channel and daily watch roster. |
| MP-06 | Open: monitors for non-SRI embeds (`TM-TRK-08`) and APM-vendor headers (`TM-OTL-09`) wait for threat-model OP-06 and OP-08. | A register decision on those threat-model points. |
| MP-07 | Open: ADR-0031's full text still describes the ingest probe view in bad minutes and includes the OTLP probe in the headline; this plan and `sla.md` follow C-78. | Aligning ADR-0031's text with C-78. |
| MP-08 | Open: alert thresholds for the per-hostname and per-node figures, `CacheTokenHitLow` and `SuspectSurgeOnSite` are first guesses. | Tuning against staging and early production data (S-01 measured the token behaviour, not a production hit rate). |
| MP-09 | Open: monitor IDs `TM-DOS-02.M.3/.M.4` (competitor flooding), `TM-OPS-06.M.1` (`mon-c`) are keyed to the nearest existing threat rows; re-key them if the threat model gives these threats their own IDs. `TM-DOS-06.M.1/.M.2/.M.3/.M.4` are now defined in the threat model's TM-DOS-06 row (C-107, C-110). | Threat-model update. |
| MP-10 | Open: the backup-protection check (versioning on, previous-version lifecycle rule, node credential unable to delete versions; C-108) cannot run against Azurite and is untested until the first real Azure deployment (risk R-23). | Azure deployment (C-96). |
| P7 | Open (shared with `sla.md` §17 P7): **a second outside probe source for the lean profile.** Today the only independent view is the GitHub-hosted 5-minute checks; the local probe runs on the VM it measures, so there is no 2-of-3 quorum in production (C-123). | A small probe VM in another region or provider (or a third-party monitor) running `scf-ops probe`, restoring a 2-of-3 verdict; a service-operator decision. |
