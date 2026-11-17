# Data-protection impact assessment — draft

> **Not legal advice.** Engineer-prepared draft following the structure of the Article 29
> Working Party Guidelines on DPIA (WP248 rev.01, endorsed by the EDPB) — used for its structure only. Not yet reviewed by counsel or a DPO. Design as decided in the design-decision register
> C-01…C-112 (a later decision wins over an earlier one). The service operator completes one
> DPIA for the platform which tenants can adopt for their own processing.

| | |
|---|---|
| Processing | Web and API analytics for Stellar ecosystem projects (multi-tenant platform) |
| Assessment owner | `<OPERATOR-ENTITY>` — the service operator (processor; prepares the platform DPIA) |
| Controllers adopting it | Each tenant, for its own audience measurement (adapt §1.4 and §6) |
| Version / date | 0.1 draft, 2026-11-12 |
| Review cycle | Before go-live; on every change to the design decisions touching ADR-0004…0012, 0017, 0027–0030; at handover; at least yearly |

## 0. Is a DPIA required?

Art. 35 GDPR. On the WP248 criteria the processing arguably meets **systematic monitoring** (audience measurement of
visitors across a site) and possibly **large scale** (ecosystem-wide, many sites); a possible third is **innovative use**
(new combination of bot detection with privacy-preserving identifiers). Two criteria make a DPIA "likely required"
under the WP248 heuristic (LIKELY). Conclusion: carry out the DPIA; low cost, high value to tenants and to anyone checking the platform.

## 1. Systematic description of the processing

### 1.1 Nature

Collection of page views and custom/wallet events from visitors' browsers through a pinned, cookieless tracker;
optionally gated on the visitor's consent (C-55); in-memory reduction at an EU gateway (IP truncation, country,
daily keyed identifier unless switched off per site, User-Agent reduction, path and custom-event scrubbing, bot
verdict; C-02, C-52); a local fsync'd spool on each edge node holding only the reduced record (no IP, no raw
User-Agent), deleted on acknowledgement and never older than 72 hours, with no copies elsewhere (C-77); storage of
reduced events in Umami — events without a visitor identifier under a per-site twin website (C-73) — for 90 days by
default, settable 30–395 days, 395 days being the hard maximum (C-54); and of daily aggregates in PostgreSQL (kept, serving older ranges); ingestion of tenant OpenTelemetry
metrics/spans, reduced to normalised-route metrics (and, where enabled, closed-set client metrics of the tenant's own
systems: Stellar SDK client, partner API calls, agent payments, anchors); optional per-site daily counts of browser
Stellar RPC / Horizon calls and of self-attested app events (no visitor, device or session identifier stored); tenant dashboards with anonymous reports on by default (C-51); an
SCF global view and programme outputs built from thresholded, rounded per-tenant aggregates (C-17, C-47); optional
on-chain correlation from public ledger data. Full flow:
[`strategy.md`](strategy.md) §3, §9–§11; fields: [`data-inventory.md`](data-inventory.md).

### 1.2 Scope

- **Data subjects:** visitors of tenant websites (worldwide); end users of tenant APIs (indirectly, no identifiers
  stored); tenant users and SCF operators (accounts).
- **Data:** see the inventory. No special-category data is intended; it could arrive only by tenant error in paths or
  event properties.
- **Volume:** design target ≈ 1 M API requests/day and 1,000,000 page views/day across tenants, load-tested at 10×
  (C-48); 90 days of event-level web data by default (C-54).
- **Geography:** processing and storage in the EU/EEA ([`data-residency.md`](data-residency.md)).

### 1.3 Context

Visitors do not expect to be identified by a project's analytics; many visitors of Stellar projects are crypto users
sensitive to wallet-address linkage. The tenant — not the SCF operators — is the party visitors deal with. SCF operators use aggregates for
funding decisions; tenants have an incentive to inflate their own numbers (hence the anti-inflation design).

### 1.4 Purposes

1. Audience measurement of the tenant's own site/API (controller: tenant).
2. Accuracy of those statistics: detecting bots and artificial inflation, per tenant, in memory (controller: tenant;
   processor on instruction).
3. Providing anonymous per-tenant aggregates to SCF on the tenant's instruction (controller: tenant; recipient: SCF).
4. Running, securing and supporting the platform: portal accounts, audit logs, operational logs (controller: service
   operator, C-59).

### 1.5 Assets / systems

Tracker (browser), gateway and local spool (edge nodes), `scf-otelcol`, metrics-writer, engine proxy (core nodes,
C-74), Umami (private), control plane, jobs, portal, PostgreSQL (`scf`, `umami`), object storage for backups and
OpenTofu state, monitoring node, probe node; providers Hetzner, UpCloud, OVHcloud and a
probe-only fourth EU provider (C-25) ([`sub-processors.md`](sub-processors.md)); services outside the EU-hosted data
path, none receiving visitor-derived data, in [`data-residency.md`](data-residency.md) §4 (C-26).

## 2. Necessity and proportionality

| Question | Answer |
|---|---|
| Lawful basis | Tenant: Art. 6(1)(f) legitimate interest (EDPB Guidelines 1/2024 v2.0, 10 Nov 2026), with the ePrivacy route answered first and separately (para 10). Mitigations that the EDPB lists — an unconditional opt-out from the outset (para 54) — are built in. Where the jurisdiction table requires opt-in: consent, collected by the tenant's consent tool and enforced by the consent-gated mode (C-55). Service operator: own basis for portal account, audit and security processing (C-59). |
| ePrivacy | Within Art. 5(3) (EDPB 2/2023 v2.0). Consent-free only where a national route exists — [`jurisdictions.md`](jurisdictions.md); elsewhere the consent-gated mode (C-55); for Russia only country exclusion (C-58). |
| Purpose limitation | No reuse by the processor for its own purposes; no cross-tenant pooling of raw data; SCF receives anonymous aggregates only (ADR-0027). Bot detection framed as accuracy of the tenant's own statistics (contested in France — risk R6). |
| Data minimisation | Each web metric mapped to the least data that computes it; referrer host only; width class; language subtag; country only; UA reduced; no query strings or campaign parameters (C-65); page paths and custom events scrubbed at the gateway, redaction not switchable (C-52); `strict` profile with no client booleans (C-33) and no visitor identifier by default (C-53); per-site `visitor_id` (C-02) and `exclude_countries` (C-58); events without identifier counted for page views, country and device only (C-73); wallet Tier 0 only in `standard`, user actions only, closed-set fields, nothing on page load (C-13, C-45, C-75); no page titles (C-89); no JA4 fingerprint (C-77). |
| Accuracy | Verified vs raw counts shown side by side; documented metric semantics (C-73): daily uniques; visits, bounce rate and duration as one figure over all identified, non-rejected events with the suspect share shown; clock-hour visits when the visit cache token cannot be replayed (C-74, C-82); a visit with a custom or wallet event is not a bounce (C-75); no uniques, visits, bounce or duration for events without identifier (C-73). |
| Storage limitation | IP/UA in memory only; local edge spool ≤ 72 h, no copies (C-18, C-77); visit cache token 30 minutes in engine-proxy memory (C-74); event-level 90 days by default, settable 30–395 days (395 days the hard maximum, inside the CNIL/AEPD cap; still not "immediate" for the Swiss route — counsel) (C-54); aggregates, trust scores and on-chain counts indefinitely on the anonymity position (counsel; C-71); erasure selectors until the job has finished plus 56 days (C-88, C-111, C-112); backups 56 days (35-day retention + up to 7 days until the next full + 14 days as a previous version, data-model §14; C-29, C-112); operational logs 30 days, monitoring metrics 13 months (C-71); portal accounts removed within 30 days of deletion (C-71); audit log for the life of the service with tombstones for departed users (C-57). |
| Transparency | Notice snippets for tenants (short/long, per profile, consent-gated mode, per jurisdiction additions); public documentation of the algorithm, key lifecycle, thresholds and trust-score inputs (C-44). |
| Data-subject rights | Objection: opt-out link + GPC/DNT; consent withdrawal via `revokeConsent()` where the consent-gated mode is used. Access/erasure on visitor rows: Art. 11(2) position; content-based erasure workflow for residual PII in paths/props, covering daily aggregates and API routes (C-46); erased data leaves backups within 56 days (C-29, C-112) ([`erasure.md`](erasure.md)). |
| Processors | Art. 28 DPA with each tenant; sub-processor list and notification process. |
| Transfers | EU/EEA hosting on EU-based providers; complete list of services outside the EU-hosted data path disclosed, none receiving visitor-derived data (C-26); restore drills and backup keys stay on EU infrastructure and build automation holds no production credentials (C-56, C-79); location of the configured Stellar RPC/Horizon hosts open (strategy OP-26); non-EU staff access → counsel. |

## 3. Risks to the rights and freedoms of data subjects

Likelihood and severity before measures: **Remote / Possible / Likely** and **Minimal / Significant / Serious /
Severe**. The ratings are the engineers' estimate.

| # | Risk | Source | Likelihood | Severity | Inherent |
|---|---|---|---|---|---|
| R1 | Re-identification of a visitor by linking events over time or across sites | Persistent or cross-site identifiers | Possible | Serious | High |
| R2 | Linking web activity to a Stellar address (wallet de-anonymisation, financial profiling) | Wallet events, addresses in paths, on-chain join | Possible | Severe | High |
| R3 | Personal data in URLs / event properties (e-mails, names, tokens, seeds) stored and shown | Tenant implementation | Likely | Significant–Serious | High |
| R4 | Exposure of one tenant's data to another tenant | Application bug | Possible | Significant | Medium |
| R5 | SCF or the service operator using data for a different purpose (funding) → loss of the exemption; unexpected processing | Global view design | Possible | Significant | Medium |
| R6 | Bot/inflation detection treated as processor reuse; or as profiling of visitors via IP multiplicity | Anti-inflation design vs CNIL criterion | Possible | Significant | Medium |
| R7 | Device access without a valid ePrivacy route (e.g. Germany, consent-required states) | Tenant choice of profile | Likely | Significant | High |
| R8 | Breach of event-level data or backups | Attack, misconfiguration | Possible | Significant | Medium |
| R9 | Non-EU access to personal data (staff, build automation, provider) | Operations | Possible | Significant | Medium |
| R10 | Small-count aggregates singling out a visitor | Tenant/SCF dashboards with filters | Possible | Significant | Medium |
| R11 | Visitors unaware of analytics / unable to object | Tenant notice missing | Possible | Significant | Medium |
| R12 | Supply-chain compromise of the tracker turning it into a data-exfiltration script on many sites | Release pipeline | Remote | Severe | Medium |
| R13 | Tenant APM credentials arriving in headers being logged and leaked | SDK header merge | Possible | Significant (security) | Medium |

## 4. Measures

| Risk | Measures (register reference) |
|---|---|
| R1 | Surrogate keyed with random `K_day`, memory-only, destroyed daily; `site_id` in the key; no IP/UA stored; Umami salt daily; no `distinct_id`; no cross-tenant de-duplication (ADR-0006, 0007, 0027) |
| R2 | Wallet allow-list serialiser with closed-set fields + outbound test; Tier 0 only in `standard`; Tier 2 not shipped; no kit localStorage reads; on-chain correlation keyed by tenant contracts only, aggregates only, no join (ADR-0029, 0028; C-13, C-45); `pathnorm` replaces StrKeys in API routes **and web page paths** before the spool (ADR-0012; C-52); signing, submit, smart-wallet and passkey events are daily counts only, never stored per visit, so their time cannot be matched to a ledger transaction (C-137); Registered Footprint accounts are project-declared; the platform keeps only accounts a project proved are its own, and for at most 30 days the account of an open claim under verification (a rejected or removed account is deleted at the next hourly retention run, C-144); machine keys never see an unverified one (C-137) |
| R3 | No query strings, discarded at the gateway (C-65); client-side **and** server-side guard on custom-event names and props (C-52); `{redacted}` for seeds/tokens/JWTs/e-mails in API routes and web paths, not switchable; folding only `full` or `relaxed`, StrKeys, hashes, tokens and e-mails always folded or redacted (ADR-0012; C-52, C-89); page titles not collected (C-89); tenant guidance; erasure workflow incl. aggregates and API routes, whose literal selectors are kept only until the job has finished plus 56 days (C-111, C-112) and never enter the audit log (ADR-0004, 0030; C-46, C-88) |
| R4 | RLS forced on every table and partition, no `BYPASSRLS`, isolation test matrix, canary tenants, per-tenant Umami view-only users with encrypted credentials (ADR-0003, 0013; C-85); every identifier in a request resolved under the caller's tenant context, composite tenant keys, erasure and purge jobs run under the requesting tenant's context (C-87); fresh sign-in for sensitive tenant actions (C-87) |
| R5 | SCF only through allow-listed `op_*` functions with min-count 10 and rounding to 10 and an audit row in the same transaction; no cross-tenant SELECT on base tables (C-17); `metrics_endpoint` and snapshots thresholded and rounded, no trust score, public only on tenant opt-in (C-14, C-47); no event-level API; tenant instruction in enrollment terms; SCF data-use terms (ADR-0013, 0027) |
| R6 | Detection per tenant, on that tenant's traffic, in memory; keyed hashes (daily multiplicity key, C-68), short windows; for sites with identifiers off, events counted per truncated subnet, memory-only, keyed, no IP kept (C-80); no JA4 (C-77); only verdicts and reason codes persisted; trust score from aggregates; counsel questions logged (ADR-0008) |
| R7 | Jurisdiction table; consent-gated mode (C-55); `strict` profile without identifier by default (C-53); `visitor_id` / `off_in` (C-02); `exclude_countries` for localisation regimes (C-58) (ADR-0004, 0027) |
| R8 | Umami not internet-reachable, reachable only through the engine proxy with per-node mutual TLS and path allow-lists (C-60, C-74); egress only to named destinations through an egress proxy (C-10); WireGuard mesh; SOPS secrets; build automation never holds production credentials, `mon-c` rated High impact and hardened (C-79); encrypted backups written with credentials that cannot delete or overwrite (C-66); no spool copies outside the edge node (C-77); edge keys in locked memory, no core dumps, no unencrypted swap (C-04, C-66, C-68); passkeys and step-up for SCF operators (C-09); 24-h patching with daily watch duty (C-49, C-67); logs without IPs/UAs (ADR-0003, 0014, 0019, 0021, 0022, 0023) |
| R9 | EU/EEA providers; EU-located administrators for event-level data or SCCs + TIA; build automation receives no visitor data and holds no production credentials or backup keys; restore drills only on our EU infrastructure (ADR-0017; C-26, C-56, C-79) |
| R10 | Thresholds + rounding for SCF and programme outputs (C-17, C-47); `anonymous_reports` on by default in tenant dashboards (C-51); ecosystem percentiles only with ≥ 20 active tenants (C-44); Stellar event-property counts below 10 omitted from every output that leaves the tenant, cohort figures below 10 withheld and cohorts below 5 projects suppressed (C-137) |
| R11 | Notice snippets; mandatory opt-out link; GPC/DNT honoured; onboarding wizard checks (ADR-0004) |
| R12 | Pinned versions, SRI, no remote config, reproducible build, signed manifest, staged npm publish with human 2FA, two-person release, SLSA L3 provenance (ADR-0004, 0023) |
| R13 | Gateway validates only our bearer token; never logs, stores or forwards other headers; 401 with guidance on foreign credentials (strategy §9) |

## 5. Residual risk

| # | Residual | Rationale |
|---|---|---|
| R1 | Low | After rotation no key exists to link rows to a person; same-day linkage needs `K_day` + exact IP + UA |
| R2 | Low | Addresses in web paths are now replaced at the gateway (C-52); residual: free text the scrubber cannot recognise |
| R3 | Low–Medium | Identifier-shaped values and secrets scrubbed server-side (C-52); free text still depends on tenant behaviour; mitigated by erasure and guidance |
| R4 | Low | Defence in depth; RLS protects against application bugs, not a compromised application |
| R5 | Low–Medium | Contested in the UK (para 5(1)(c)) |
| R6 | Medium | Open legal question in France; per-subnet counting where identifiers are off is a further counsel question (C-80) |
| R7 | Medium–High in consent-required jurisdictions if tenants ignore guidance; Low elsewhere | Tenant's controller responsibility |
| R8 | Low | |
| R9 | Low–Medium until counsel settles the transfer position | Restore-drill key exposure removed (C-56); build automation holds no production credentials (C-79) |
| R10 | Low | Medium only for a tenant that switches `anonymous_reports` off (C-51) |
| R11 | Low–Medium | |
| R12 | Low | |
| R13 | Low | |

No residual risk is assessed as high. The former open points OP-1, OP-2 and OP-8 are resolved by C-51, C-52 and C-56.
R5 and R6 depend on legal questions that only counsel can answer (UK sharing; the CNIL "no reuse" criterion); if
counsel's answer is unfavourable, the controller should reassess them and consider whether prior consultation
applies. R7 for `strict` in Germany also depends on whether sending identifier-free events to a per-site twin website
(C-73) changes the assessment — a counsel question ([`jurisdictions.md`](jurisdictions.md) §6). A tenant that switches `anonymous_reports` off or turns the identifier on in `strict` should re-run §3–§5
for its own processing.

## 6. Consultation

| Party | Status |
|---|---|
| DPO of `<OPERATOR-ENTITY>` (if designated) | `<pending>` |
| External counsel (EU; UK; German counsel for §25 TDDDG) | Planned, not commissioned |
| Tenants (first projects) | `<pending>` — review of notice snippets and profile choice |
| Data subjects / representatives | `<pending>` — public comment on the documentation in the repository issue tracker |
| SCF operators | `<pending>` — acceptance of thresholds and of no ecosystem-wide unique-visitor total |
| Supervisory authority (prior consultation) | Not foreseen unless residual risk stays high after measures |

## 7. Sign-off

| Role | Name | Decision | Date | Signature |
|---|---|---|---|---|
| Measures approved by | `<NAME, TITLE>` | | | |
| Residual risks approved by | `<NAME, TITLE>` | | | |
| DPO advice | `<NAME>` | `<summary of advice>` | | |
| DPO advice accepted / overruled (reasons) | `<NAME>` | | | |
| Counsel review | `<COUNSEL>` | | | |
| Tenant adoption (per tenant) | `<TENANT CONTROLLER>` | adopted / adapted | | |
| Next review due | | | `<date>` | |
