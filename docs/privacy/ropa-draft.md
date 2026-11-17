# Records of processing activities (GDPR Art. 30) — drafts

> **Not legal advice.** Engineer-prepared; not reviewed by counsel. Part A is the
> service operator's record as **processor** (Art. 30(2)) plus its own controller activities (portal account data and
> audit logs, C-59); Part B is a template a tenant adapts for its own **controller** record (Art. 30). Design as
> decided in the design-decision register C-01…C-112. Placeholders in `<ANGLE BRACKETS>`.

## Part A — Service operator

### A.1 Processor record (Art. 30(2))

| Item | Entry |
|---|---|
| Processor | `<OPERATOR-ENTITY>`, `<OPERATOR-ADDRESS>`; contact `<PRIVACY-CONTACT>`; representative (Art. 27, if non-EU) `<REPRESENTATIVE or n/a>`; DPO `<DPO or n/a>` |
| Controllers on whose behalf we act | Every enrolled tenant — list generated from the `scf` database (tenant name, legal entity, contact, country, DPA acceptance date, DPA version) and exported monthly to `<location>` |
| Categories of processing carried out for each controller | (1) Web audience measurement: receipt of tracker events (after consent where the tenant uses the consent-gated mode, C-55), in-memory reduction (IP truncation, country lookup, country exclusion, daily keyed identifier unless switched off per site, UA reduction, path and custom-event scrubbing; C-02, C-52, C-58), bot/inflation verdicts (per-subnet event counting where identifiers are off, in memory, C-80), a local edge spool deleted on acknowledgement and never older than 72 hours (C-77), storage of reduced events (events without identifier under a per-site twin website, C-73) and daily aggregates, dashboards with anonymous reports on by default (C-51); optional per-site daily counts of browser Stellar RPC / Horizon calls (closed cells) and of self-attested app events from native apps and Telegram Mini Apps (enum-token cells, no device or session identifier stored). (2) API analytics: receipt of OpenTelemetry data, sanitisation, path normalisation, derivation and storage of metrics; optional closed-set client metrics of the tenant's own systems (Stellar SDK client, partner API calls, agent payments, anchors) stored apart from API usage. (3) Optional on-chain correlation from public ledger data for tenant-declared contracts. (4) Provision of anonymous, thresholded and rounded aggregates to SCF, and — only if the tenant switches public stats on or creates a share key — through the tenant's `metrics_endpoint` (C-14, C-47), on the tenant's instruction. (5) Erasure, retention and backup. |
| Sub-processors | [`sub-processors.md`](sub-processors.md) |
| Transfers to third countries | None for visitor or API data. Services outside the EU-hosted data path, none receiving visitor-derived data (complete list, C-26; [`data-residency.md`](data-residency.md) §4): GitHub (USA; including GitHub sign-in), Let's Encrypt (USA), npm (USA), the Stellar network when audit-chain anchoring is enabled (a hash only), optional on-chain sources (Google BigQuery public dataset — location to be confirmed — or AWS Open Data; public ledger data only), alert channels `<chosen by the operator>`. Configured Stellar RPC/Horizon hosts: `<location to be fixed — strategy OP-26>`. Staff access from outside the EU/EEA: `<none / SCCs Module 3 or 4 + TIA — counsel>` |
| Technical and organisational measures | [`dpa-template.md`](dpa-template.md) Annex 2 |

### A.2 Controller activities of the service operator

| Activity | Purpose | Data subjects | Data categories | Recipients | Transfers | Retention | Legal basis (placeholder) |
|---|---|---|---|---|---|---|---|
| Portal accounts and authentication | Provide the service, sign-in, roles | Tenant users, SCF operators | GitHub id/login (`read:user` scope only) or Stellar sign-in account, passkey credentials, optional contact e-mail, session ids, roles | — | GitHub as identity provider (USA) when used | Until deleted by the member, then removed within 30 days (tombstone per C-57; C-71); sessions: tenants idle 12 h / absolute 14 days, SCF operators idle 30 min / absolute 12 h (C-20) | `<legal basis — counsel>` |
| Audit log | Accountability, security, tenant trust | Tenant users, SCF operators, API-key holders | Actor id, action, target, time, request id; after account deletion only a tombstone ID (C-57) | Tenants (own entries), auditors; the daily head hash is public (GitHub evidence repository, optionally the Stellar ledger) and contains no personal data (C-63) | — (head hash only, no personal data) | Life of the service (ADR-0011; C-57). Erasure entries record the selector type and counts, never the literal selector (C-88) | `<legal basis — counsel>` |
| Operational logs and monitoring | Availability, security | Account holders (ids in logs), no visitors | Service logs without IP/UA/headers/tokens; monitoring metrics without per-visitor labels | — | — | Logs 30 days; monitoring metrics 13 months (C-71) | `<Art. 6(1)(f)>` |
| Support (public issue tracker; private security/privacy channel) | Support, vulnerability handling | Reporters | GitHub identity, message content | Public (issues) | GitHub (USA) | `<to be fixed>` | `<Art. 6(1)(f)>` |
| Enrollment verification | Ecosystem membership (domain, Stellar linkage, registry match) | Tenant representatives | Domains, signing account, registry entries | SCF operators | — | Life of tenant | `<Art. 6(1)(f)>` |
| Enrollment abuse prevention | Block re-enrollment of removed tenants; rate-limit sign-up | Representatives of removed tenants | Tombstones of domains, GitHub identity, Stellar accounts (C-64); per-identity and per-subnet rate-limit counters (in memory) | SCF operators (`operator_admin` lifts tombstones) | — | Until lifted by an `operator_admin` `<counsel: proportionality of an open-ended period>` | `<Art. 6(1)(f)>` |

## Part B — Tenant controller record (template)

> Adapt and keep with your own records. Delete rows that do not apply (e.g. API analytics if you only use web).

| Item | Entry |
|---|---|
| Controller | `<TENANT LEGAL ENTITY>`, `<ADDRESS>`, contact `<CONTACT>`; representative (Art. 27) `<if you are outside the EU and monitor EU visitors>`; DPO `<if any>` |
| Processing activity | Web audience measurement of `<site(s)>` / API usage analytics of `<service(s)>` |
| Purposes | Measure the audience and usage of our own site/API (page views, unique visitors per day, referrer hosts, session duration, bounce rate, country, device/browser; API request volume, status codes, latency); keep those statistics accurate (bot and inflation filtering); publish anonymous aggregate statistics to the SCF programme (through the platform's SCF operator view) for programme evaluation |
| Categories of data subjects | Visitors of our website(s); end users of our API (no identifiers stored) |
| Categories of personal data | Transiently processed: IP address, User-Agent (not stored). Stored, pseudonymous: daily per-site session/visit identifiers (not created where the visitor identifier is off; such events are counted for page views, country and device only), page path (scrubbed of identifiers and secrets), referrer host (`standard`), screen-width class and language (`standard`), country, browser/OS/device class, timestamps, custom-event names and properties `<list yours>`, wallet event types and wallet ids. API: normalised routes, methods, status codes, latencies, and closed-set client-metric dimensions ([`data-inventory.md`](data-inventory.md) §3) — no end-user identifiers |
| Tracker configuration | Profile `<standard / strict>` per site; consent-gated mode `<on / off>`; `visitor_id` `<on / off / off_in: [countries]>`; `exclude_countries` `<list>`; `anonymous_reports` `<on (default) / off>`; public stats `<off (default) / on>` |
| ePrivacy route relied on | `<e.g. CNIL audience-measurement exemption (FR) — only if your site sends page views alone, no custom or wallet events, until counsel answers the three-event-type question (C-71); PECR Sch. A1 para 5 (UK); FADP notice + opt-out (CH); consent through the consent-gated mode elsewhere>` — see [`jurisdictions.md`](jurisdictions.md) |
| Legal basis (GDPR) | `<Art. 6(1)(f) legitimate interest — LIA reference>` |
| Recipients | Processor: `<OPERATOR-ENTITY>`, the service operator (and its sub-processors). Recipient of anonymous aggregates only: the SCF programme (SCF operator view); `<the public, if you switched public stats on>` |
| Transfers to third countries | None by the processor for visitor/API data; `<your own, if any>` |
| Retention | IP/User-Agent: not stored. Event-level data: `<90>` days (platform default; 30–395 days, 395 days the hard maximum; you may choose a shorter period per site). Daily aggregates: kept (anonymous). Backups: erased or expired data leaves them within 56 days (C-29, C-112) |
| Data-subject rights | Objection: opt-out link `<URL>` + GPC/DNT; withdrawal of consent through `<your consent tool>` where the consent-gated mode is used. Erasure of content in URLs/events: platform erasure workflow (also covers daily aggregates). Access/erasure of visitor rows: Art. 11(2) response template |
| Security measures | Processor TOMs (DPA Annex 2); our own: `<roles of our team members on the platform, passkeys, …>` |
| DPIA | `<adopted platform DPIA v… / own DPIA reference>` |
| Date / version | `<date>` / `<version>` |
