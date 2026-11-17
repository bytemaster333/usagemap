# Privacy and compliance strategy

> **Not legal advice.** The authors are engineers, not lawyers. Every legal statement in
> this pack is our reading of the cited sources and must be reviewed by qualified counsel before
> anyone relies on it. A legal review is **not done**: it is for `<OPERATOR-ENTITY>` to commission.
> Status: draft, 2026-11-12. Binding design source: [`docs/adr/README.md`](../adr/README.md) (ADR-0001…0032 and the
> design decisions C-01…C-112, which win where they refine an ADR; a later decision wins over an
> earlier one). The design decisions are engineering
> decisions; none of them settles a legal question.

## At a glance

One screen for anyone checking the design; the sections below are the full strategy, and the [data inventory](data-inventory.md) is
the field-by-field list.

| The platform does | The platform does not |
|---|---|
| Count page views, daily unique visitors, referrer hosts, countries, device classes and browsers, session duration and bounce rate per site | Set cookies or use browser storage (sole exception: the visitor's own opt-out flag) |
| Derive a visitor identifier only per site and per day, with a key held in gateway memory and destroyed at 00:00 UTC; or none at all (`strict` profile, or the site's choice) | Link a visitor across sites, projects or days, or compute a cross-project "reach" |
| Derive the country from a truncated address in memory | Store an IP address (full or truncated), region, city, coordinates or ASN of a visitor |
| Reduce the User-Agent to browser family, major version, OS family and device class in memory | Store raw User-Agent strings, client hints or fingerprints |
| Keep the page path with identifiers folded and secrets redacted | Keep query strings, fragments, campaign parameters, click IDs or page titles |
| Record wallet events as a closed vocabulary of names and enum values | Collect a visitor's wallet address, transaction hash, signature, memo, amount or secret seed |
| Store API request counts, status classes and latency histograms per normalised route | Keep traces, spans, logs, bodies, headers, client addresses or user attributes from APIs |
| Honour Global Privacy Control, Do Not Track and opt-out; offer a consent-gated mode | Send anything from a browser that signals GPC or DNT, after opt-out, or before consent in consent-gated mode |
| Process and store in the EU ([data residency](data-residency.md)) | Use the data for its own purposes or give event-level data to SCF operators |

**Who sees what**

| Who | Sees | Never sees |
|---|---|---|
| Visitor of a measured site | Nothing is shown to them; they can opt out, and GPC or DNT stops all sending | — |
| Project members (the tenant, controller) | Their own project: verified and raw figures (by default breakdown rows under 10 are merged into "Other" and counts rounded to 10), reason codes, API route metrics, data-quality counters, their audit log | Any other project (the same "not found" as for one that does not exist); visitor or session lists, journeys, IP addresses, User-Agents |
| SCF operators (recipient of anonymous aggregates) | Per-project daily aggregates through audited database functions, minimum count 10 and rounded to 10; trust signals with reason codes | Event-level data, the analytics engine's database, any cross-project de-duplicated figure |
| Anyone holding a project's share key, or the public if the project switched public stats on | That project's metrics document and signed snapshots, thresholded and rounded; never the trust score | Anything else |
| Service operator (processor; hosts the platform) | Stored data in its reduced form, under the data-processing agreement; an address for one request, in memory only | IP addresses or raw User-Agents at rest, because none are stored; the daily identifier key after it is destroyed |

This document is UsageMap's full privacy and compliance strategy. Companion
documents in this folder:

| Document | What it answers |
|---|---|
| [`jurisdictions.md`](jurisdictions.md) | Where the solution would not be compliant without end-user opt-in. **Authoritative for classifications** (C-41) |
| [`data-residency.md`](data-residency.md) | Every place data is processed or stored |
| [`erasure.md`](erasure.md) | Right-to-erasure design and tenant-triggered workflow |
| [`data-inventory.md`](data-inventory.md) | Field-by-field inventory, including what we never collect |
| [`dpia-draft.md`](dpia-draft.md) | Data-protection impact assessment draft (WP248 structure) |
| [`ropa-draft.md`](ropa-draft.md) | Art. 30 records: processor record + tenant controller template |
| [`dpa-template.md`](dpa-template.md) | Art. 28 data-processing agreement template + CCPA / Swiss / KVKK addenda |
| [`sub-processors.md`](sub-processors.md) | Sub-processor list and change-notification process |
| [`tenant-privacy-notice.md`](tenant-privacy-notice.md) | Copy-paste notice text and opt-out link for tenants |

Terminology used throughout (C-59; documents never use a bare "operator"):

- **Tenant** — an enrolled project (site and/or API service). Controller for its own analytics.
- **Service operator** — the entity that hosts and runs the service: `<OPERATOR-ENTITY>` during the 12-month
  window, `<SUCCESSOR-OPERATOR>` after handover. **Processor** for tenant analytics; **controller** for portal
  account data and audit logs (C-59).
- **SCF operator** — a person holding the portal role `operator` or `operator_admin` (ADR-0014). Sees the global
  view. In legal terms SCF is a **recipient of anonymous aggregates only** (ADR-0027).
- **Visitor** — an end user of a tenant's website. **End user** of an API — whoever calls the tenant's API.

---

## 1. Principles

1. **Collect the minimum the metrics need, and nothing that identifies a person.** The seven core web
   metrics (pageviews, unique visitors, referrers, session duration, bounce rate, country, device/browser) and the
   API metrics (route, status, latency, volume) can be computed without storing an IP address, a raw User-Agent,
   a cookie, a persistent identifier, a wallet address or a query string.
2. **Reduce before anything touches disk.** IP truncation, geolocation, identifier derivation, User-Agent
   reduction, and path normalisation of both API routes and web page paths happen in process memory at the first
   hop. Spools, queues, databases and logs only ever see the reduced record (ADR-0005, ADR-0006, ADR-0009,
   ADR-0012; C-52).
3. **No identifier survives the day.** Where a visitor identifier is derived at all, it is keyed with a random
   daily key that exists only in gateway memory and is destroyed at the 00:00 UTC switch (ADR-0007; C-04). After
   rotation nobody — including us — can link a stored row to an IP address or device. A site can switch the
   identifier off altogether (`visitor_id`, C-02); the `strict` profile does so by default (C-53). Events without an
   identifier go to a per-site twin Umami website and count towards page views, country and device figures only
   (C-73).
4. **The tenant decides; we process on its behalf.** Tenant = controller, service operator = processor,
   SCF = recipient of anonymous per-tenant aggregates (ADR-0027; C-59).
5. **SCF never sees event-level data, and no cross-tenant visitor de-duplication or "reach" is ever computed**
   (ADR-0027, ADR-0013; C-17).
6. **EU/EEA processing**, on providers described exactly as far as the research verified their ownership, with the
   complete list of exceptions stated openly (ADR-0017; C-26; [`data-residency.md`](data-residency.md)).
7. **Honesty over marketing.** Cookieless does not by itself take the design outside ePrivacy Art. 5(3)
   (EDPB Guidelines 2/2023 v2.0). We never say "100 % GDPR compliant", "no consent needed anywhere", "CNIL
   approved/certified" or "no personal data is ever processed" — overclaims found in other analytics vendors'
   public statements. We say "designed to meet the published
   criteria of …".
8. **Publish the mechanism.** The exact algorithm, key lifecycle, field list and thresholds are public in this
   repository, as the most credible privacy-analytics vendors do.
9. **Public commitment not to re-identify.** The service operator does not attempt, and contractually forbids SCF
   and any recipient from attempting, to re-identify any person from the stored or published data (supports the
   deidentified-data conditions of CCPA §1798.140(m); DPA Addendum A).

## 2. What is collected — and what is deliberately not

Full field list: [`data-inventory.md`](data-inventory.md). Summary:

| Collected (stored in reduced form) | Deliberately **not** collected or stored |
|---|---|
| Page path — no query string, no fragment (discarded at the gateway if still received, C-65); identifier-shaped segments replaced by typed placeholders and secrets/personal identifiers by `{redacted}` before the spool (C-52); the per-site folding setting is `full` or `relaxed` (numbers, dates and slugs kept) — StrKeys, hashes, tokens and e-mail addresses are always folded or redacted (C-70, C-89) | IP address (full or truncated) — memory only, one request |
| Referrer **host** only (`standard` profile) | Raw User-Agent string — memory only, one request |
| Screen-**width class**, primary language subtag (`standard` profile) | Cookies, localStorage/sessionStorage/IndexedDB (sole exception: the opt-out flag) |
| Country (ISO 3166 alpha-2), derived from the truncated IP | Region, city, coordinates, ASN of the visitor |
| Browser family + major version, OS family, device class | Query strings, UTM/campaign parameters (no campaign reporting exists, C-65), ad click IDs (`gclid`, `fbclid`, …) |
| Daily, per-site pseudonymous session/visit IDs (Umami) — only for events with a visitor identifier; events without one go to the site's twin Umami website (C-02, C-73) | Page titles — not collected at all (C-89) |
| Custom-event name + properties (tenant-defined; guarded in the tracker **and** server-side, C-52) | Stellar addresses (G/M/C/…), XDR, signatures, memos, seeds, wallet-availability lists |
| Wallet events: closed-set fields only, user actions only — nothing fires on page load (C-45, C-75) | Umami `distinct_id` / `identify()` traits, session replay, heatmaps, error tracking, web vitals |
| Verdict tag `v` / `s` (verified / suspect; C-73), receipt timestamp | Any cross-site, cross-tenant or cross-day identifier; TLS fingerprints (no JA4 is computed, C-77); other fingerprints |
| API: tenant, service, normalised route, method, status code, latency histograms, counts | API: client IP, `user_agent.*`, `url.full`/`url.query`/raw `url.path`, headers, bodies, `enduser.*`, `user.*`, `session.id`, `service.instance.id` as a dimension (C-22), exemplars, span events, logs |

## 3. The life of a pageview

Where the IP address and User-Agent exist, and for how long. Component names follow the register's
"System at a glance".

| # | Where | What happens | IP address | User-Agent |
|---|---|---|---|---|
| 1 | Visitor's browser | The tenant's page loads the pinned tracker (`/lib/<semver>/<profile>.js`, SRI hash, from our edge node; or bundled from `@SCOPE/tracker`). | Sent by the browser in the TCP/TLS connection, as for any web request | Sent in the request header |
| 2 | Browser | Tracker checks the opt-out flag, `Global Privacy Control` and `Do Not Track`; if any is set, **nothing is sent** (ADR-0004). If the site uses the **consent-gated mode** (`consent: "required"`), nothing is sent until the tenant's consent tool calls `grantConsent()`, and sending stops on `revokeConsent()` (C-55). | — | — |
| 3 | Browser → gateway `POST /v1/c` | One signed challenge per page load (stateless HMAC token bound to site, coarse time window, subnet and UA digest), solved as a small proof-of-work before the first event (ADR-0008 L2/L3; C-35). Runs in **both** profiles (C-33). The token is held in page memory only. | In gateway memory for the request | In gateway memory for the request |
| 4 | Browser → gateway `POST /v1/e` | Event sent with `fetch(keepalive)` (never `sendBeacon`, C-116) to one of two ingest hosts. Each event carries a random per-event ID held in memory only (C-37). | as above | as above |
| 5 | Gateway, in memory | Strict `v1` schema, unknown fields rejected; fields the site's profile does not allow are discarded (C-37); any query string or fragment is discarded (C-65); site resolved from the public site key; `Origin`/`Referer` host checked against verified domains; `Sec-Fetch-*` and client-hint consistency (no JA4 fingerprint is computed in the first release, C-77); token + proof verified (challenge key `K_chal`, memory-only, hourly, C-68); the upstream `isbot` list applied to the **raw** User-Agent before reduction (C-36); retries dropped within a 10-minute in-memory window (C-37); multiplicity counters keyed with the daily, memory-only multiplicity key (C-68) — distinct surrogates per truncated subnet per site, or, for sites with `visitor_id = off`, events per truncated subnet (C-80); memory-only, keyed, no IP kept; per-site rate limits and quotas enforced from the snapshot, quotas counting verified events only (C-90) (ADR-0005, ADR-0008). Client signal booleans are read only from `standard` traffic (C-33). | Used for the checks above | Used for the checks above |
| 6 | Gateway, in memory | Events geolocated to a site's `exclude_countries` are dropped and only counted (C-58). **Derive** the surrogate from the **full** IP and **raw** UA before any reduction (C-34): 96 bits of `HMAC-SHA-256(K_day, site_id ‖ ip ‖ user_agent)` written as an address in `2001:db8::/32` — or, where the site's `visitor_id` setting is `off` (or `off_in` for the visitor's country), a fresh random surrogate per event, and the event is routed to the site's twin Umami website (C-02, C-73). **Truncate** the IP (IPv4 /24, IPv6 /48) → country (DB-IP Lite Country; sapics `user-country` fallback) and ASN class. **Discard the IP.** Reduce the UA to family + major version + OS + device class; **discard the raw string** (ADR-0005/0006/0007). The page path, custom-event names and property values pass the `pathnorm` guard: identifier-shaped segments become typed placeholders, seeds, tokens, JWTs and e-mail addresses become `{redacted}` (C-52). | **Destroyed here** (end of request, milliseconds) | **Destroyed here** |
| 7 | Gateway | Verdict `verified` / `suspect` / `rejected`. Rejected events are not stored; only per-site, per-reason counters, which travel through the spool as counter records (C-39). The rebuilt, allow-listed record (reduced User-Agent, surrogate address, normalised path, referrer host, country and the other allowed fields — no IP, no raw User-Agent) is appended to the local fsync'd spool on the edge node with its tag (`v` or `s`; C-73); the browser gets `202` whatever the verdict (C-39). There is no copy of the spool anywhere else (C-77). | never on disk | never on disk |
| 8 | Forwarder → engine proxy → Umami (private network, per-node mutual TLS, C-60, C-74) | `POST /api/send` with `x-scf-surrogate-ip`, `cf-ipcountry`, a **synthetic** reduced User-Agent, `timestamp` = time of receipt, `tag` = verdict. The forwarder picks the core node by a consistent hash of the surrogate (C-74). The **engine proxy** on that core node keeps Umami's visit cache token per (site, surrogate) in memory for 30 minutes and adds it to that visitor's next event; the token is never written to disk and never sent to the browser (C-74). Client-supplied `ip`, `userAgent`, `timestamp`, `id`, `hostname` never pass through. Spool entry deleted on acknowledgement, never older than 72 hours: anything undeliverable for 72 h is discarded and counted (C-18). An accepted event on a node that is permanently lost before it forwards is lost (C-77). | — | Umami sees only the synthetic reduced UA |
| 9 | Umami (`umami` DB) | Umami hashes surrogate + synthetic UA again with its own daily salt (`SALT_ROTATION=day`) into a session ID and a visit ID (visit = 30 minutes of inactivity when the cache token is replayed, otherwise the clock hour, C-74, C-82); stores the event and session row (country only; region/city NULL). Events without an identifier are stored under the site's twin website (C-73). | — | — |
| 10 | Jobs → `scf` DB | Daily per-site aggregates (totals + top-N breakdowns, verified and raw). If Umami's stats API cannot filter by tag (S-01), the rollup job reads Umami's event table through a read-only, contract-tested SQL view instead (C-82). | — | — |
| 11 | 00:00 UTC | The next day's key, generated at 23:50 by one node and pushed to its peers, takes over; the old `K_day` is destroyed in every gateway node's memory (C-04). Yesterday's surrogates can no longer be recomputed from any IP + UA. | — | — |
| 12 | Retention | Event-level rows deleted after **90 days** by default (settable 30–395 days; 395 days is the hard maximum); older ranges are served from the daily aggregates, which are kept (ADR-0011; C-54). | — | — |

Why the surrogate and not Umami's own hash: Umami v3.5.0 derives its salt from the calendar date and mixes in the
long-lived `APP_SECRET`, so anyone holding `APP_SECRET` could recompute past session IDs from (IP, UA) — those IDs
are pseudonymous indefinitely, not anonymous (verified from source). Feeding Umami a surrogate that is itself keyed with a destroyed random key closes that gap
(ADR-0007). Consequence, stated publicly: unique visitors are per site per UTC day; multi-day "unique visitors" are
sums of daily uniques and labelled so; if every gateway node restarts at once, or a network partition leaves two
keys in use, that day's uniques are over-counted (C-04).

**Key handling** (C-04, C-66, C-68): `K_day`, the daily multiplicity key and the hourly challenge key `K_chal` are
random, exchanged only over a dedicated mutually authenticated port on the private mesh; they live in locked memory; core dumps are disabled and edge nodes have no unencrypted swap, so the key cannot
reach disk through the operating system either.

**Metric semantics** (C-73, C-75): page views are reported verified (tag `v`) and raw (all events, plus the twin
website); unique visitors verified (sessions with at least one verified event) and raw (all sessions of the main
website); visits, bounce rate and session duration as one figure each over all identified, non-rejected events, shown
next to the share of page views that are suspect. A visit with any custom or wallet event is not a bounce.

The surrogate design matches the CNIL self-assessment criterion for fingerprint-derived identifiers — a
site-specific component and a time component in the hash (CNIL "Outil d'auto-évaluation", July 2025). Country
lookup uses the truncated address, which is stricter than the CNIL criterion (which allows city-level localisation
before dropping at least the last octet) and matches the Garante's "mask at least the fourth component" for third
parties (Garante Linee guida cookie, 10 Jun 2021, §7.2). The identifier itself is computed from the full IP in
memory (C-34) and the full IP is destroyed in the same request.

## 4. The two tracker profiles

Both profiles are compiled into each pinned tracker version; there is no remote configuration (ADR-0004). The
tenant chooses the profile per site; the gateway enforces it by discarding fields the profile does not allow (C-37).

| | `standard` | `strict` |
|---|---|---|
| Built to | the intersection of the French (CNIL), Spanish (AEPD) and Italian (Garante) audience-measurement criteria | "as close to a counter as possible" — the fallback for jurisdictions without a recognised exemption |
| Reads through JS APIs for analytics | page path; referrer **host**; screen-**width class**; primary language subtag (e.g. `en`); the opt-out flag; GPC/DNT signals | page path only (plus the opt-out flag and GPC/DNT) (C-33) |
| Challenge + proof-of-work | yes | **yes** — a computation, not a read of device information, so `strict` traffic can be `verified` (C-33) |
| Client signal booleans (`webdriver`, visibility, user activation) | yes (ADR-0008 L4) | **no**; their absence is never a reason for `suspect` (C-33) |
| Referrer | host only | none |
| Visitor identifier | `visitor_id = on` by default | `visitor_id = off` by default; the tenant may deliberately turn it on (C-53) |
| Custom events | yes (guarded client- and server-side) | yes (guarded client- and server-side) |
| Wallet events | Tier 0 (user actions only, default on; C-75) and Tier 1 if attached (C-13) | **no Tier 0**; wallet events only if the tenant explicitly attaches the adapter (Tier 1) (C-13) |
| Server side (identical) | truncated-IP country, ASN class, reduced UA, path scrubbing; surrogate per `visitor_id` | same |
| Metric effect | full web metric set | referrer, screen and language breakdowns absent; with no identifier (the default) events go to the twin website and give page views, country and device counts only — unique visitors, visits, bounce rate and session duration are not computed (§6; C-73) |
| Size budget | ≤ 3.5 kB gzip incl. challenge solver | ≤ 2.5 kB gzip incl. challenge solver (C-32) |

Every JS read and every beacon the tracker triggers is within ePrivacy Art. 5(3) on the EDPB's reading (Guidelines
2/2023 v2.0, paras 32–34, 43–44, 50–55) — the profiles do not avoid the provision; they decide **which national
exemption criteria** the collection is designed to meet. The challenge token held in page memory is also "storage"
in the EDPB sense (para 37–38: RAM counts). The EDPB expressly does not analyse exemptions (paras 4, 40, 56).

Neither profile is a guarantee in Germany. Statements about Germany assume `strict` with **no visitor identifier**
(C-53). Even so, on the DSK's position (OH Digitale Dienste v1.2, Rn. 24, 87–90) `strict` is **contested**, not
defensible, and `standard` is "not without opt-in" ([`jurisdictions.md`](jurisdictions.md), C-41; see §16).

## 5. Opt-out, Global Privacy Control, Do Not Track and the consent-gated mode

- **Opt-out link.** Every tenant must place an opt-out link or button in its privacy policy
  ([`tenant-privacy-notice.md`](tenant-privacy-notice.md) §4). It calls `optOut()`, which stores one flag in the
  visitor's browser storage for that site and stops all sending; `optIn()` removes it. This is the only use of web
  storage (ADR-0004). Storing the user's own choice is treated as exempt "choice" storage by the CNIL (Délibération
  2020-091, para 49) — counsel to confirm for other states.
- **Why a flag at all.** An objection must persist; a daily-rotating identifier cannot carry it across days.
  The CNIL accepts either an opt-out tracer or adding a
  fingerprint to a blocklist; we chose the flag because we refuse to keep any blocklist of fingerprints.
- **Limits stated to tenants:** the flag is per browser and per site; clearing site data removes it.
- **GPC and DNT** are honoured: if `Sec-GPC: 1` / `navigator.globalPrivacyControl` or DNT is set, no events are
  sent (ADR-0004). This is good practice, **not a substitute for the link**: the ICO's final guidance says "You must
  not solely rely on browser settings" (ICO, April 2026). Under the CCPA, GPC is legally triggered only where a
  business sells or shares; we do neither, so honouring it is voluntary.
- **Legal function.** The opt-out is how the design honours the right to object (GDPR Art. 21, which Art. 11(2)
  does not disapply), the CNIL objection criterion, the UK Sch. A1 para 5(1)(e) "simple means of objecting", and the
  Swiss "mandatory option to reject" (FDPIC Guidelines v1.1, §3.7.2).
- **Consent-gated mode** (C-55). The tracker accepts `consent: "required"`: it loads but sends nothing — no
  challenge request, no event — until the tenant's consent tool calls `grantConsent()`, and it stops sending on
  `revokeConsent()`. This is the route for tenants who need visitor opt-in: every jurisdiction classed "Not without
  opt-in" in [`jurisdictions.md`](jurisdictions.md), or any tenant that simply prefers consent. Obtaining, recording
  and proving valid consent is the tenant's job as controller, through its own consent tool; the tracker only obeys
  the signal. The opt-out link and GPC/DNT handling still apply on top. Notice wording:
  [`tenant-privacy-notice.md`](tenant-privacy-notice.md) §3a. Where the obstacle is data localisation rather than
  consent (Russia), consent does not help; see §6.

## 6. Visitor identifier settings and country exclusion

**`visitor_id`** (per site, independent of the profile; C-02): `on` | `off` | `off_in: [countries]`. Recommended
`off` with the `strict` profile, and `off` is the `strict` default (C-53). For events without an identifier the
gateway uses a fresh random surrogate per event and sends the event to a **per-site twin Umami website**, created on
demand; the tag stays `v` or `s` (C-73, which supersedes the `vn`/`sn` tags of C-02/C-03). What still exists:

| Metric | With identifier | Without identifier (twin website) |
|---|---|---|
| Page views | yes | yes |
| Country, device/browser/OS | yes | yes |
| Referrer host, path and custom-event breakdowns | yes | **no** — twin-website events contribute page views, country and device counts only (C-73) |
| Unique visitors, visits, bounce rate, session duration | yes | **no** — computed only from identified events, and the dashboard says so (C-73) |

Where identifiers are off, the multiplicity layer counts events per truncated subnet instead of distinct surrogates
— in memory, with a keyed hash, no IP kept; weaker, and stated (C-80). Whether this per-subnet counting is acceptable
where identifiers are off, and whether the twin website changes the assessment for `strict`, are questions for
counsel ([`jurisdictions.md`](jurisdictions.md) §6).

The country used for `off_in` is decided from the truncated IP before the surrogate step. Limits, stated plainly:

- Determining the country is itself processing of the IP; the list reduces, it does not remove, processing.
- **Quebec** cannot be detected from country-level data; a tenant with material Quebec traffic must choose for all
  of Canada.
- **UK:** `off_in: [GB]` removes the IP/UA-derived identifier that PECR Sch. A1 para 5(2) puts in question (§16).
- `off_in` is **not** a substitute for consent where consent is required; there the consent-gated mode (§5) is the
  route.

**`exclude_countries`** (per site; C-58): events geolocated to those countries are dropped at the gateway and only
counted. This is the **only** measure we offer for jurisdictions where the obstacle is data localisation —
currently **Russia** (152-FZ Art. 18(5) as amended by 23-FZ, in force 1 Jul 2025) — and we say so. It does not cure
the question whether even the transient in-memory processing needed to geolocate and drop the event is "recording"
abroad (counsel question).

## 7. Roles: who is controller, processor, recipient

| Party | Role | Basis of the position |
|---|---|---|
| Tenant | **Controller** for audience measurement of its own site/API | It decides to measure, chooses the profile, `visitor_id`, consent-gated mode, country settings, retention within limits, `anonymous_reports`, public stats, and what to publish |
| Service operator | **Processor** for tenant analytics under a standard DPA ([`dpa-template.md`](dpa-template.md)) | Processes only on the tenant's documented instructions; no reuse for its own purposes |
| Service operator | **Controller** for portal account data and audit logs (C-59); on our reading also for its operational and security logs | It decides these purposes itself |
| SCF (through the SCF operator view) | **Recipient of anonymous per-tenant aggregates**; never given event-level data | Processes no personal data if the aggregates are effectively anonymous |

**Reasoning** (case law not re-read against the official texts,
holdings labelled LIKELY):

1. Every exemption text assumes this configuration: the CNIL "pour le compte exclusif de l'éditeur" (Délibération
   2020-091, para 51), the AEPD "en nombre exclusivo del editor" (guide, Jan 2024), the ICO "must be a processor, not
   a joint controller" (ICO exceptions chapter, April 2026).
2. A processor that processes for its own purposes becomes a controller for that processing (Art. 28(10); EDPB
   Guidelines 07/2020 v2.0). Hence: no reuse, no cross-tenant raw pooling, no own-purpose analytics.
3. SCF's purpose (funding decisions, ecosystem comparison) is not the tenant's audience measurement. If SCF — or the
   service operator for SCF — processed event-level personal data for it, SCF or the service operator would become a
   (joint) controller for a different purpose that has no consent-free ePrivacy route (cf. *Wirtschaftsakademie*
   C-210/16; *Jehovah's Witnesses* C-25/17; *Fashion ID* C-40/17).
4. If SCF receives only anonymous aggregates the tenant already sees, SCF processes no personal data. Supporting
   text: CNIL para 51 bars transmission of "données à caractère personnel collectées", and the CNIL page says
   "données **non anonymes**"; the CNIL self-assessment presumes reuse of effectively anonymised data creates no
   additional harm; CNIL and AEPD explicitly accept **comparative** audience measurement across publishers by one
   processor if data are collected, processed and stored independently per publisher; the Council's Digital Omnibus
   mandate (ST 14756/26, recital 44d) says aggregated information "could be shared with third parties".
5. Contractual structure: tenant DPA (Art. 28); enrollment terms in which the tenant, as controller, **instructs**
   publication of its anonymous aggregates to SCF; SCF data-use terms limiting SCF to the aggregate API and
   forbidding re-identification; a documented anonymisation analysis for the SCF view.

**Uncertainties** (all for counsel): whether the tenant→SCF disclosure makes SCF or the service operator a (joint)
controller for any processing (the *Wirtschaftsakademie* analogy); the UK sharing condition (§16); whether
bot/inflation detection is "reuse for the provider's own account" under the CNIL criterion (§16); the anonymisation
standard (EDPB Guidelines 02/2026 on anonymisation are a consultation draft, not final); whether the CNIL/AEPD
25-month cap reaches genuinely anonymous aggregates.

## 8. Anonymous reports: tenant dashboards and the SCF global view

- **Tenant dashboards** (C-51): per-site setting `anonymous_reports`, **on by default**. Breakdown rows below the
  minimum count (10) are merged into "Other" and displayed counts are rounded to the nearest 10, as the French
  criteria the `standard` profile is built to require ("aggregation and presentation to the nearest ten" or a
  documented anonymity analysis, effective for every filter combination). A tenant may switch it off; the notice
  text we supply then no longer refers to those criteria, and the tenant can no longer rely on the French route as
  designed.
- **SCF source:** only the per-tenant daily aggregates the platform already computes for each tenant's own dashboard,
  read through allow-listed `SECURITY DEFINER` functions `op_*` that apply a **minimum count (default 10) and
  rounding to the nearest 10** (both configurable) and insert the audit row in the same transaction. `scf_app`
  and `scf_metrics_ro` have no cross-tenant SELECT on base tables, so neither the threshold nor the audit row can be
  skipped (ADR-0013 as refined by C-17; ADR-0027).
- **No event-level access:** no SCF-facing API returns events or sessions; SCF operators have no access to the
  `umami` database or raw tables (ADR-0013, ADR-0014; C-12).
- **Comparison, never union:** the view sums or compares per-tenant figures; no ecosystem-wide unique-visitor total
  and no cross-tenant de-duplication is computed. The CNIL and AEPD exclude "toute fonctionnalité visant à croiser,
  dédoubler ou mesurer un taux de couverture (reach) unifié". The surrogate key includes `site_id`, so no cross-site
  identifier exists to join on. Ecosystem percentiles are shown only when at least 20 tenants are active (C-44).
- **Trust indicators** (verified/raw ratio, trust score, reason codes) are computed from aggregates (ADR-0028);
  inputs and weights are versioned and published (C-44).
- **Programme outputs** (ADR-0032; C-14, C-47): a tenant's `metrics_endpoint` returns that tenant's daily aggregates
  with the same minimum-count threshold and rounding, **never** the trust score. It is readable with an SCF operator
  key, with a tenant-created read-only share key (kind `pub`), or publicly **only if the tenant switches public
  stats on** (off by default). Signed traction snapshots carry the same thresholded, rounded figures and are signed
  with an Ed25519 platform key published under `/.well-known/`. The platform `health_endpoint` is public and carries
  no tenant data.

## 9. API analytics

- **Ingest:** tenant SDK or Collector → gateway (TLS, ingest-token auth, per-tenant rate limit) → loopback →
  `scf-otelcol` → metrics-writer → PostgreSQL (ADR-0009). `tenant.id` is set from the token, overwriting the payload.
  Ingest tokens are tenant-scoped, optionally restricted to named services, with no expiry by default (C-21).
- **Sanitise first, before the persistent queue:** `scfsanitize` keeps an allow-list of resource and data-point
  attributes, strips exemplars (which can smuggle filtered attributes), span events and links, and normalises paths
  (ADR-0009). Spans are discarded after metric derivation; logs are refused (`/v1/logs` → 404 / `UNIMPLEMENTED`).
  The Collector queue has the same 72-hour cap as the web spool (C-18).
- **Stored dimensions:** tenant, service, normalised route (with rule-set version), method, status code, source
  stream group, time bucket; counts, sums, min/max, histograms (ADR-0010; C-22). Optional closed-set `rpc.method`
  (ADR-0012). `service.instance.id` identifies cumulative streams only and is not stored as a dimension (C-22).
- **Path normalisation:** a hard-coded, versioned rule set with a closed set of typed placeholders — the vocabulary
  the 451-vector corpus produces, plus `{unknown}` (Collector sanitise step) and `{overflow}` (writer) (C-16, C-89) —
  replaces all ten SEP-23 StrKey types, hashes, UUIDs, numbers, assets etc.; secret seeds, JWTs, API-key-shaped
  strings and e-mail addresses become `{redacted}` and increment a per-tenant counter that records **neither the
  value nor a hash**; a cardinality guard (1,000 routes per service per day, 5,000 per tenant per day, 200 siblings
  per prefix) sends excess routes to `{overflow}` (ADR-0012; C-24). The same rule set now also runs over web page
  paths (C-52). Stellar account keys are personal data where the holder is a natural person (EDPB Guidelines 02/2025
  on blockchain v2.0, para 26, fn 12, glossary item 137).
- **No end-user identifiers by design:** the allow-list drops `client.address`, `network.peer.*`,
  `user_agent.*`, `url.full`/`url.query`/`url.path` (used only transiently as normaliser input), all
  `http.request/response.header.*`, body content, `enduser.*`, `user.*`, `session.id`, exception text and host/process
  resource attributes. We declare API analytics as
  **B2B operational telemetry** to which most of the jurisdiction table does not apply.
- **Tenant vendor keys in headers.** In several SDKs (JS, Python, Rust) environment-configured exporter headers are
  also attached to a second, code-configured exporter, so a tenant's APM credential (`DD-API-KEY`,
  `x-honeycomb-team`, `Authorization: Basic …`) **will** reach our endpoint in some setups. The gateway validates
  only our `Authorization` bearer token and **never logs, stores or forwards any other request header**; if our token
  is missing but a foreign credential is present, it answers 401 with a pointer to the docs; the onboarding guide
  documents the hazard. The tenant's key is the tenant's secret, not personal data of
  end users, but leaking it would be a security incident; it is handled as such.
- **Self-attested:** API telemetry is labelled "self-attested telemetry" with assurance levels A0–A2 (cumulative) and
  a separate A3 badge (ADR-0028; C-44).

## 10. Wallet events

- Tiers (ADR-0029; C-13, C-75): **Tier 0** — address-free DOM signals that send events **only for user actions**
  (modal opened/closed, wallet selected). No event fires on page load: kit presence is not an event and is reported
  only as a per-site counter through the counter path of C-39 (C-75). **On by default in the `standard` profile
  only**; it never runs in `strict`. **Tier 1** (one line, `attachWalletsKit(kit)`) — kit events and wrapped sign
  methods, distinguishing a restored session from a new connection; in `strict` wallet events are sent only when the
  tenant explicitly attaches it. **Tier 2** (passive observation of wallet-extension `postMessage` traffic) —
  **not shipped**, because the listener would be handed transaction data and addresses.
- Events: `wallet_modal_opened/closed`, `wallet_selected`, `wallet_connected`, `wallet_session_restored`,
  `wallet_disconnected`, `sign_requested/completed/failed {kind}`. A visit with any wallet or custom event is not
  counted as a bounce, and the metric definitions say so (C-75).
- An **allow-list serialiser** sends only these fields, all closed sets, never free text (C-45): event type, wallet
  id (`freighter`/`varial` aliased), sign kind, network (`public`/`testnet`/`futurenet`/`other`), modal outcome,
  duration bucket, error class (`rejected`/`timeout`/`unsupported`/`other`). **Never addresses, XDR, signatures,
  memos or error text** — enforced by a test on the outgoing request.
- Never done: reading the kit's localStorage keys (one of them holds the user's address in plain text), enumerating
  injected wallet globals (an extension fingerprint), patching wallet provider objects.
- Open (counsel): whether custom events plus wallet events in `standard` stay within the CNIL self-assessment's limit
  of three event types (§17). Until counsel answers, the tenant notice claims the French audience-measurement
  criteria only for sites that send page views alone (C-71;
  [`tenant-privacy-notice.md`](tenant-privacy-notice.md)).

## 11. On-chain correlation

Optional per tenant, off by default (ADR-0017, ADR-0028; C-26). It uses **public ledger data keyed by the tenant's
own declared contracts only**: daily counts per declared contract from SDF's public Hubble dataset on Google
BigQuery (dataset location to be confirmed), or, as the rebuildable fallback, public ledger files on AWS Open Data
read by our own Go command `/services/onchain-reader` (C-42). We send only the tenant-declared contract IDs and
receive daily aggregates (transaction counts, distinct source-account **counts**, fees). A declared contract is
shown as "verified" only when the ledger shows a verified account of the tenant as deployer or current admin,
otherwise "declared" (C-19). We never store invoking addresses, per-address series, or any join between web
visitors and on-chain accounts — such a join would re-identify visitors. Public ledger data remains personal data where
it relates to natural persons; the correlation is recorded as a separate processing activity in the RoPA. We state
that on-chain activity can be bought cheaply and is an indicator, not proof.

## 12. Retention

| Data | Retention | Source |
|---|---|---|
| IP address, raw User-Agent, `Referer` URL | memory only — one request | ADR-0005/0006/0008 |
| Multiplicity counters (distinct surrogates, or events where identifiers are off, per truncated subnet; keyed hashes) and per-subnet rate-limit counters | memory only — short window; no IP kept | ADR-0008; C-80, C-90 |
| Per-event retry IDs | memory only, 10-minute window | C-37 |
| Umami visit cache token | engine proxy memory on the core nodes, 30 minutes per (site, surrogate); never written to disk, never sent to the browser | C-74 |
| `K_day`, multiplicity key, `K_chal` | memory only (locked); `K_day` and the multiplicity key destroyed at the daily switch, `K_chal` rotated hourly | ADR-0007; C-04, C-68 |
| Gateway spool entries (local fsync'd spool on edge nodes only; no copies elsewhere) | deleted on acknowledgement, never older than 72 hours: anything undeliverable for 72 h is discarded and counted | ADR-0011; C-18, C-77 |
| Collector persistent queue / writer de-duplication ledger | 72 h cap / 7 days | C-18 |
| Web event-level data (`umami` DB, including twin websites) | **90 days** default, settable 30–395 days by an `operator_admin` (395 days is the hard maximum); a tenant may choose a shorter period per site | ADR-0011; C-54 (C-18) |
| Daily per-site web aggregates (`scf` DB) — serve every range older than the event-level window | indefinitely | ADR-0011; C-54 |
| Trust scores, assurance levels, on-chain daily counts | kept with the aggregates, indefinitely (none is personal data on our reading) | C-71 |
| API 1-minute rows / 1-hour rows / 1-day rows | 35 days / 25 months / indefinitely | ADR-0011 |
| Rejected-event counters | 25 months | ADR-0011; C-39 |
| Portal accounts | until deleted by the member, then removed within 30 days (tombstone per C-57) | C-71 |
| Erasure-request selectors (literal path, event name, property key) | until the job has finished plus 56 days, then replaced by type and length; never in the audit log | C-88, C-111, C-112 |
| Audit log | life of the service; departed users' profile fields removed, tombstone keeps the ID (C-57) | ADR-0011; C-57 |
| Re-enrollment tombstones of a removed tenant (domains, GitHub identity, Stellar accounts) | until an `operator_admin` lifts them | C-64, C-70 |
| Operational logs | 30 days | C-71 |
| Monitoring metrics (no per-visitor labels) | 13 months | C-71 |
| Database backups | pgBackRest weekly full + daily differential, **35-day** point-in-time window; previous blob versions kept 14 days; weekly logical dumps kept 5 weeks — erased or expired data leaves all backups within **56 days** (35-day retention + up to 7 days until the next full + 14 days as a previous version, data-model §14) | ADR-0021; C-29, C-108, C-112 |

Tenant dashboards are live and filterable through Umami for the event-level window; older ranges are served from
the daily aggregates (totals and top-N breakdowns) (C-54). The CNIL recommendation (consolidated 16 Jan 2026) keeps
information collected by exempt audience measurement for at most 25 months; event-level data stays within that,
because its hard maximum is 395 days (C-54). Aggregates are kept beyond it on the position that effectively anonymous
aggregates are outside the GDPR (Recital 26) — counsel to confirm. The 90-day default is still not "immediate"
anonymisation in the sense of the Swiss FDPIC guidance (§16).

## 13. Security measures (summary; full list in the DPA Annex 2)

Tenant isolation with PostgreSQL RLS enabled and forced on every table and partition, no runtime role with
`BYPASSRLS`, isolation test matrix and canary tenants (ADR-0013); cross-tenant reads only through allow-listed `op_*`
functions that enforce threshold, rounding and audit (C-17); Umami unmodified, never reachable from the internet,
reachable internally only through the engine proxy, which authenticates callers by per-node mutual TLS and applies
per-caller path allow-lists, no egress, per-tenant view-only identities whose password and API key are stored
encrypted (ADR-0003; C-40, C-60, C-74, C-85); every identifier in a request resolved under the caller's tenant
context, composite tenant keys between tenant-owned tables, and jobs that act for a tenant (erasure, purge) run under
that tenant's context (C-87); only named components may open outbound connections, to named destinations through an
egress proxy (C-10); passkeys mandatory for SCF operators, with step-up for sensitive actions (ADR-0014; C-09); a
fresh sign-in (≤ 10 minutes, passkey if registered) for sensitive tenant actions — confirming an erasure,
transferring ownership, removing the tenant, deleting an account (C-87); build automation builds, tests, signs and publishes only
and never holds production credentials (C-79); hash-chained audit of every SCF-operator read and privileged action,
whose head hash is published daily (C-63); peppered HMAC storage of API keys and ingest tokens with separate peppers
per key kind and a recorded pepper version (ADR-0016; C-05, C-81); operator keys checked on every request, ingest-token revocation at the edge within 60 s
(C-06; residual risk for a node without a fresh snapshot, C-62); private WireGuard mesh between nodes (ADR-0018);
secrets in SOPS + age (ADR-0019); encrypted backups in two EU providers written with credentials that cannot delete
or overwrite (ADR-0021; C-29, C-66); edge keys in locked memory, core dumps disabled, no unencrypted swap (C-04, C-66, C-68);
logs never contain IPs, User-Agents, request headers or tokens (ADR-0022); pinned tracker with SRI, reproducible
build, signed manifest, two-person release (ADR-0004, ADR-0023); 24-hour patch process for critical/high
vulnerabilities, which depends on the daily watch duty and two named responders (ADR-0023; C-49, C-67).

## 14. International access

EU-only hosting does not end the transfer analysis: remote access by staff located in a third country to personal
data in the EU is a transfer (EDPB Guidelines 05/2021, final Feb 2023 — LIKELY, not re-read). Until counsel
answers the access question: administrators with access to event-level data (the `umami` DB, backups, spool) are EU/EEA-located,
or such access is covered by SCCs (Module 3 processor → sub-processor or Module 4, depending on structure) plus a
transfer impact assessment; staff outside the EU/EEA work only with aggregate/anonymous data. Restore drills run on
our own EU infrastructure, never on GitHub-hosted runners, and backup keys never leave it; only pass/fail, timings
and checksums are published (C-56, C-79). Build automation never holds production credentials; deployments run from a
service-operator workstation or a pull-based agent on the nodes (C-79). The complete list of services outside the EU-hosted data path — none of which
receives visitor-derived data — is in [`data-residency.md`](data-residency.md) §4 (C-26). The daily audit-chain head
hash published on GitHub and optionally on the Stellar ledger is a single hash value and contains no personal data
(C-63). A non-EU tenant that monitors EU visitors may itself need an Art. 27 representative (Art. 3(2)) — that is
the tenant's obligation; a non-EU service operator would need one too.

## 15. What a tenant must do

1. **Choose the profile and identifier setting** per site: `standard` where the jurisdiction table says
   "Defensible"; `strict` (no identifier by default), the consent-gated mode, or both where it says otherwise.
   Review `visitor_id` / `off_in` and `exclude_countries` (§6).
2. **Use the consent-gated mode** (`consent: "required"`, §5) wherever the jurisdiction table says "Not without
   opt-in" for the visitors you measure, or wherever you choose consent; wire it to your consent tool.
3. **Keep `anonymous_reports` on** if you rely on the French criteria (§8).
4. **Update the privacy notice** with the snippet for the chosen profile and mode, naming the service operator as
   processor and stating that SCF receives only anonymous aggregates ([`tenant-privacy-notice.md`](tenant-privacy-notice.md)).
   If you switch public stats on, say that rounded daily totals are public.
5. **Add the opt-out link** to the privacy policy.
6. **Sign the DPA** (accepted at enrollment) and, where relevant, the addenda (CCPA, Swiss, KVKK).
7. **Keep personal data out of paths and custom events** even though the gateway scrubs identifier-shaped values
   (C-52): a name or free-text value cannot be recognised by shape. Set `http.route` in API middleware where finer
   control is needed.
8. **Handle data-subject requests** as controller, using the erasure workflow for content-based removal
   ([`erasure.md`](erasure.md)).
9. **Record the processing** in its own Art. 30 record ([`ropa-draft.md`](ropa-draft.md) Part B) and, where
   needed, adopt the DPIA ([`dpia-draft.md`](dpia-draft.md)).

## 16. Honest statement of legal uncertainty

- **ePrivacy applies.** Cookieless is not an exemption (EDPB Guidelines 2/2023 v2.0, adopted 7 Oct 2024). Consent-free
  operation rests on national exemptions, which exist with published criteria in France, Spain, Italy and the
  Netherlands, and as opt-out-based statutory routes in the UK and Switzerland. Elsewhere in the EU/EEA there is no
  recognised exemption, or we could not verify one; there the consent-gated mode is the route (§5).
- **The French "no reuse, including fraud prevention" criterion vs the anti-inflation design.** The CNIL
  self-assessment excludes "aucune réutilisation des données pour le propre compte du prestataire et quelle que soit
  la finalité (amélioration de son service, lutte contre la fraude, etc.)". UsageMap is built to detect bots and to be
  sceptical of many fingerprints from one IP. Our framing: filtering bots at ingest is part of producing
  *accurate* statistics for the tenant (Art. 5(1)(d) accuracy); it runs per tenant, on that tenant's own traffic, in
  memory, keeps no cross-tenant state; trust scores for the SCF view use aggregates only (ADR-0008, ADR-0027). This framing is
  ours, not the regulator's; the multiplicity counting that uses the IP is the riskiest element — including, for
  sites with identifiers off, the per-subnet event counting of C-80 (memory-only, keyed, no IP kept). **Unresolved —
  counsel.**
- **UK caveat 1 — sharing (PECR Sch. A1 para 5(1)(c)).** The statistical exception (in force 5 Feb 2026, SI
  2026/82) requires that information collected "is not shared with any other person except for the purpose of
  enabling that other person to assist with making improvements to the service or website". On a literal reading,
  statistics given to SCF for funding decisions fall outside it; the ICO's gloss reinforces that. Counter-argument:
  anonymous aggregate outputs are new information created by the controller. **We do not represent the UK as clean
  for the SCF view.**
- **UK caveat 2 — automatically emitted information (para 5(2), reg. 6(2)(b)).** The exception does not cover
  "collecting or monitoring information automatically emitted by the terminal equipment". If IP and User-Agent in an
  HTTP request count as automatically emitted, the IP/UA → identifier step is not covered by para 5. The ICO's only
  example is Wi-Fi probe requests. **Open, material.** Mitigation available today: `visitor_id = off_in: [GB]` (§6).
- **Germany.** TDDDG §25 has no analytics exemption; the DSK (OH Digitale Dienste v1.2, Nov 2024) treats active JS
  reads as access (Rn. 24) and declines to exempt audience measurement in general (Rn. 87–90). `standard` is not
  without opt-in; `strict` with no visitor identifier (its default, C-53) is the most defensible configuration but
  **still contested** — it still delivers a script, sends a beacon and runs the JS challenge and proof-of-work
  (C-33). Whether sending identifier-free events to a per-site twin website (C-73) changes that assessment is a
  question for counsel. German counsel is needed; meanwhile the consent-gated mode is the route for tenants who want
  certainty.
- **Switzerland.** The FADP Art. 31(2)(e) route expects data anonymised as soon as the purpose permits, "usually …
  immediately" (FDPIC v1.1 §3.8.2). The 90-day event-level default (C-54) is far shorter than the default it replaced
  but is **not** immediate; tenants can shorten it to 30 days. Whether that suffices is for counsel.
- **Event-level data is personal data** for the tenant and the processor for its whole retention (pseudonymised;
  singling-out remains; paths and properties may carry PII that the scrubber cannot recognise by shape). We do not
  claim the stored event data is anonymous — only that it is designed so that, once the daily key is destroyed, rows
  can no longer be linked to an IP or device.
- **Sources not reached.** EUR-Lex and CURIA were blocked during the research: the Art. 5(3) wording is taken
  from the EDPB's verbatim reproduction, the GDPR Art. 11 wording is from memory of the official text, and the
  C-413/23 P paragraph numbers rest on secondary sources. 13 EU member-state rows (and Iceland, Liechtenstein) were
  filled from prior knowledge without a primary source; several more rest on secondary sources only. See
  [`jurisdictions.md`](jurisdictions.md).
- **Law in motion.** The Digital Omnibus (COM(2025) 837, procedure 2025/0360(COD)) is at "awaiting committee
  decision" in Parliament; even on the fastest path new consent-free audience measurement would apply around 2029.
  We track it and do not rely on it. India's DPDP duties start ~May 2027; Chile's law enters into force 1 Dec 2026.

## 17. Open points

The first drafts raised OP-1…OP-15 and the consistency pass OP-16…OP-25. The design decisions (C-01…C-90)
resolved most of them as engineering decisions; the legal questions they touch remain with counsel
([`jurisdictions.md`](jurisdictions.md) §6).

**Resolved** (the pack now describes the decided design):

| # | Point | Resolved by |
|---|---|---|
| OP-1 | Tenant dashboards not thresholded | C-51 — `anonymous_reports` on by default (§8) |
| OP-2 | Web page paths not scrubbed server-side | C-52 — `pathnorm` over web paths and custom events at the gateway, redaction not switchable; C-65 — no query strings, no campaign parameters (§2, §3) |
| OP-3 | `strict` profile scope | C-33 — challenge and proof-of-work run, no client booleans; C-53 — no identifier by default; C-02 — `visitor_id` setting (§4, §6) |
| OP-4 | Former event-level default (longer than 90 days) | C-54 — 90 days default, 30–395 days, 395 days the hard maximum; aggregates for older ranges (§12). Swiss question stays with counsel |
| OP-5 | Wallet Tier 0 on by default | C-13 — Tier 0 only in `standard`; C-45 — closed-set field allow-list (§10). The CNIL event-type count is still open (below) |
| OP-6 | No consent-gated mode | C-55 (§5) |
| OP-7 | Gcore DNS called "EU" | C-26 — providers described as "EU-based"; "EU-owned" claimed for none; second DNS provider chosen from providers whose ownership is verified |
| OP-8 | Build automation holds backup keys | C-56 — restore drills only on our EU infrastructure; keys never leave it; C-79 — build automation never holds production credentials |
| OP-9 | Audit log for life, no path for departed users | C-57 — tombstones keep the ID, profile fields removed; C-63 — daily published head hash |
| OP-10 | Not-compliant list | C-41 — `jurisdictions.md` is authoritative (India, Quebec included); summaries must match |
| OP-11 | No-identifier list and Russia | C-58 — `exclude_countries` is the only measure for localisation regimes, and we say so (§6). Legal reach stays with counsel |
| OP-12 | Service operator's own controller role | C-59 |
| OP-13 | Other SCF-facing outputs | C-14, C-47 — `metrics_endpoint` and snapshots thresholded and rounded, no trust score, public only on opt-in; C-17 — `op_*` functions |
| OP-14 | Spool copies in object storage | C-77 — withdrawn: no spool copies exist; only the local edge spool, never older than 72 hours (C-11 superseded) |
| OP-15 | Role naming | C-59 — "SCF operator" vs "service operator" |
| OP-22 | Retention of portal accounts, operational logs, trust scores and on-chain daily counts not fixed | C-71 (§12) |
| OP-23 | Register entries that predated the later design decisions read differently (ADR-0013, 0017, 0018, 0027; C-18; C-26's list of exceptions) | The register now reads consistently with those decisions, and C-26 lists GitHub sign-in and Stellar audit anchoring; ADR-0030's backup wording is made precise by C-29 |
| OP-24 | Belgium `strict`: C-41 said "contested", the table "Not assessed" | C-41 as reworded — Belgium `strict` is "not assessed"; the table is unchanged |

**Still open:**

| # | Open point | What would close it |
|---|---|---|
| OP-16 | Open: whether custom events plus wallet events in `standard` fit the CNIL self-assessment's limit of three event types (the first drafts suggested mapping wallet events to a "feature use" type; not decided). Interim rule (C-71): the tenant notice claims the French criteria only for sites that send page views alone | Counsel (France), then a maintainers' decision on the event-type mapping |
| OP-17 | Open: the second authoritative DNS provider and the two ingest domains (Gcore is not described as EU-owned) | Choice of provider |
| OP-18 | Open: non-EU staff access to event-level data and the service operator's establishment | Counsel |
| OP-19 | Open: BigQuery dataset location and the GCP project owner for optional on-chain correlation | The operator; dataset location verified at implementation |
| OP-20 | Open: thresholds the SCF programme accepts for its view (default k = 10, rounding to 10) | Agreement with the SCF programme |
| OP-21 | Open: the alert channels and the dead-man's switch recipients that appear in the sub-processor list | The operator's choice |
| OP-25 | Open: the daily watch duty and two named responders on which the 72-hour spool cap and 24-hour patching depend | Named people |
| OP-26 | Open: C-10 allows the control plane and the contract-verification job to reach "the configured Stellar RPC/Horizon hosts" (sign-in, L2 and contract verification), but C-26's list of services outside the EU-hosted data path does not name them and their location is not fixed. The requests carry the account or contract IDs being checked (public ledger identifiers; a sign-in account may belong to a natural person) and no visitor-derived data | A maintainers' decision on which RPC/Horizon hosts are configured and where; then [`data-residency.md`](data-residency.md) §4 is updated |
