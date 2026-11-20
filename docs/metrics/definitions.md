# Metric definitions

How every web and API number the platform shows is computed, and what is known to bias it.

- **Status:** draft, checked against the code on 2026-11-13. Parts that are not built yet are
  marked **planned**. Each statement gives its source (register entry, contract section, or file).
- **Audience:** tenants reading their dashboards, SCF operators comparing projects, anyone checking the figures.
- **Terms:** "SCF operator" is a portal user with the `operator` or `operator_admin` role; the "service operator"
  is whoever hosts the platform (C-59). All times are UTC.

## 1. Rules that apply to every figure

| Rule | What it means for the numbers | Source |
|---|---|---|
| UTC days | Days, hours and months are UTC. A "day" is 00:00–24:00 UTC, whatever the visitor's or tenant's time zone. | ADR-0007, C-86 |
| Half-open ranges | Every range is `[start, end)`: `start` inclusive, `end` exclusive. There are no inclusive end dates. | C-86; `services/control-plane/src/web/range.ts` |
| No query strings, no titles | Only the page path is collected; there is no campaign (UTM) reporting and no page-title report. | C-65, C-89; `tracker/README.md` |
| Rejected traffic is never counted | Events the gateway rejects are not forwarded. They exist only as per-site, per-reason counters on the installation-check page. | ADR-0005, C-39 |
| Verified and raw side by side | Where both exist, "verified" counts only events that passed the anti-inflation checks; "raw" counts every event that was not rejected. | ADR-0008, C-73 |

## 2. Web analytics

### 2.1 Where an event comes from and what decides its verdict

1. The browser tracker sends a page view on load and on every History-API navigation that changes
   `location.pathname`; query-only, fragment-only, same-path `replaceState` and hydration changes do not count, and a
   page restored from the back/forward cache is not counted again (`tracker/README.md`, e2e `fixtures.spec.ts`).
   Custom events are sent only when the page calls `track(name, props)`; nothing else fires automatically (C-75).
2. The tracker sends nothing at all when Global Privacy Control or Do Not Track is on, when the visitor opted out, or
   in consent-gated mode before `grantConsent()` (C-55; e2e `privacy.spec.ts`). The gateway also drops events whose
   request carries `Sec-GPC: 1` or `DNT: 1` and counts them as `drop/gpc_dnt` (`services/gateway/internal/ingest/server.go`).
3. The gateway gives every event a verdict (wire-formats §h): **verified** (valid challenge and proof, no suspect
   reason), **suspect** (at least one suspect reason, e.g. `proof_missing`, `net_datacenter`, `domain_unverified`,
   `multiplicity_high`, `transport_mismatch`, `origin_missing`), or **rejected** (e.g. `ua_bot`, `origin_mismatch`, `challenge_missing`,
   `proof_invalid`). The full closed list of reason codes is in `docs/contracts/wire-formats.md` §h.2.
4. Accepted events are forwarded to the engine (Umami 3.5.0) with tag `v` (verified) or `s` (suspect) (C-73,
   wire-formats §c.4). Events with a visitor identifier go to the site's main engine website; events without one go
   to the site's **twin** website (C-73).

### 2.2 Totals

| Figure | Definition | Computed by |
|---|---|---|
| **Page views — verified** | Page views tagged `v` in the main website **plus** those tagged `v` in the twin website. | `web_daily_totals.pageviews_verified` (`db/migrations/0018_web.sql`); live: `composeTotals` in `packages/umami-adapter` |
| **Page views — raw** | All page views of the main website plus all page views of the twin website. | `pageviews_raw` |
| **Page views without visitor identifier** (`pageviews_unidentified`) | The twin website's page views (verified: tag `v`; raw: all). Already included in the two figures above. | `pageviews_unidentified_*` |
| **Unique visitors — verified** | Distinct engine sessions of the **main** website that have at least one verified event. | `visitors_verified` |
| **Unique visitors — raw** | All distinct sessions of the main website. | `visitors_raw` |
| **Visits** | Engine visits of the main website that contain at least one page view, counted over **all identified, non-rejected events** (verified and suspect together). One figure only — there is no verified variant (§2.4). | `visits` |
| **Bounces** | Visits with exactly one page view **and no custom event**. A visit with any custom or wallet event is not a bounce. | `bounces`; S-01 visit V3 |
| **Bounce rate** | `100 × bounces ÷ visits`, one decimal; empty when there are no visits. | `visitMetrics()` in `services/control-plane/src/web/figures.ts` |
| **Average visit duration** | `total duration ÷ visits`, in seconds, one decimal. A visit's duration is the time from its **first to its last page view**; custom events do not extend it; single-page-view visits count as 0 s. | `figures.ts`; S-01 (`totaltime` = Σ(max − min page-view time) per visit) |
| **Suspect share of page views** | `1 − verified page views ÷ raw page views`, four decimals; shown next to the visit figures because those include suspect events. | `figures.ts` `suspect_pageview_share` |
| **Visitors (sum of daily uniques)** | Unique visitors counted per UTC day and summed over the days of the range; a person who visits on three days counts three times, because the visitor key rotates every UTC day (C-110). | `visitors_sum` |
| **Events by verdict** | Events the gateway received for the site, each counted once under its worst verdict: verified (counted everywhere), suspect (raw figures only) or rejected (never counted). | `web_edge_counters` counter `verdict` |
| **Traffic not counted** | Share of the events received that are not in the verified figures: (suspect + rejected) ÷ (verified + suspect + rejected). Suspect events still appear in raw figures; rejected events nowhere. The reasons behind them are listed below it; one event can have several reasons. On the public card, reasons below the minimum count are left out and counts are rounded. | `web_edge_counters` counters `verdict`, `reason` |
| **Page views with Stellar Wallets Kit** | Page views whose page-view event reported that Stellar Wallets Kit was present on the page (standard tracker profile only). Counted at the gateway, never forwarded as an event. | `web_edge_counters` counter `kit_present_pageviews` |
| **On-chain invocations** | Successful invocations of the project's verified contracts on mainnet in the range, from public ledger data; shown only when on-chain correlation is switched on. | `onchain_daily` |

### 2.3 Visitors and visits: the identifier and the visit rule

- **Visitor identifier (ADR-0007, C-34).** The gateway derives a surrogate address from `HMAC-SHA-256(K_day, site ‖
  full IP ‖ raw User-Agent)`, in memory, and then discards the IP and the User-Agent. `K_day` is random, exists only
  in gateway memory and is replaced at 00:00 UTC. The engine hashes the surrogate again with its own daily salt.
- **Consequence 1 — unique visitors are per site per UTC day.** No visitor is recognised across days or across sites,
  by the engine, by our rollups, or by anyone else (S-01 case F).
- **Consequence 2 — multi-day unique visitors are the sum of daily unique visitors (C-110).** A person who visits on
  three days counts three times in a 7-day figure. The live engine answer and the rollup give the same figure. Read
  "unique visitors (7 days)" as "visitor-days". This also applies to month buckets of a time series.
- **Consequence 3 — the identifier groups by network and browser.** People behind one address with the same browser
  build (an office NAT, a carrier NAT) share one identifier that day: they are **under-counted**. One person who
  changes network or browser during the day gets a second identifier: **over-counted**.
- **Key regeneration.** If every gateway node restarts at once, a new `K_day` is generated and that day's uniques are
  over-counted; the same happens if two keys exist after a network partition (C-04). On the **single-VM profile
  (C-123) there is one gateway, so every gateway restart** (deploy, crash, host reboot) re-keys the rest of that UTC
  day: a visitor seen before and after the restart is counted twice. Keys are never written to disk (C-04), so this
  is accepted and made visible instead: the gateway exports `scf_gateway_kday_regenerated_total` and a public
  fingerprint `scf_gateway_kday_fingerprint_info`; the alerts `KDayRegenerated` and `KDayDivergence` fire and the day
  is annotated (C-124). Deploys avoid it where they can: with a second gateway running (multi-node profile, or a
  rolling deploy that starts the new gateway before stopping the old one so it adopts the keys over §n), no key is
  regenerated.
- **Visit rule (C-99, C-110(7), C-113).** The engine proxy keeps, per (website, surrogate), Umami's visit token and the
  time of the last event, in memory only, and passes the token on only when the new event is at most **1,800 s** from
  the last one. So a visit ends after **30 minutes of inactivity**. Verified on the real engine: 10:55 and 11:05 are one
  visit; a 31-minute gap starts a new one (`services/engine-proxy/README.md`, integration test).
- **Where visits split anyway:**
  - at **00:00 UTC** (new identifier and new engine salt, S-01 case F) — a visit across midnight counts as two;
  - when the engine proxy's memory is lost (restart, failover to the other core, eviction beyond 500,000 entries):
    Umami then falls back to its own clock-hour rule, so a visit that crosses a full hour is split once (C-74, C-99);
  - a forwarded backlog event more than 1,800 s older than the visitor's last event opens its own visit (C-113).
- **Visits with only custom events** are neither visits nor visitors (S-01 visit V6, C-99). Because nothing fires
  automatically on load (C-75), this only happens when the page view itself was not sent.
- **Events without a visitor identifier (C-73).** When a site has `visitor_id = off` (or `off_in` for a listed
  country), each event gets a fresh random surrogate and goes to the twin website. Such events add to page views,
  country and device/browser/OS counts **only**; they never add to unique visitors, visits, bounce rate or duration.
  **A site on the `strict` profile has `visitor_id = off` unless the tenant turns it on (C-53;
  `services/control-plane/src/domain/sites.ts`), so a default strict site shows page views but no visitors and no
  visit figures.**

### 2.4 Why visits, bounce rate and duration have no "verified" variant (C-73)

Filtering events inside a visit changes the visit: in S-01 a visit with a verified and a suspect page view became a
one-page "bounce" when only verified events were counted, and duration dropped. So visits, bounces and duration are
computed once by the engine over all identified, non-rejected events, never by adding filtered results, and are shown
with the suspect share of page views next to them. If that share is high, read the visit figures with care.

### 2.5 Breakdowns

Dimensions: **referrer** host, **country**, **device**, **browser**, **OS**, **path**, **event** name
(`services/control-plane/src/web/rollup.ts`).

| Field | Definition |
|---|---|
| visitors per value | Distinct sessions with at least one page view matching the value (for `event`: with that event). Verified rows use tag `v`. |
| page views per value | Matching page views, main + twin (verified: tag `v`). |
| visits per value | Raw rows only: (session, visit) groups with at least one matching page view. Verified rows have none (C-73). |
| events per value | `event` dimension only: matching custom events, main + twin. |
| order | By visitors (events for `event`), then page views, then value. |
| `share_pct` | The row's ranking count as a share of the sum over the rows shown, one decimal. |

What each dimension really contains:

- **Referrer** — the referring page's **host only**, sent by the `standard` profile only, on the first page view of a
  page load only (SPA navigations do not repeat it, C-100), and only when it is not one of the site's own declared
  domains (`buildRecord` in `services/gateway/internal/ingest/server.go`). Direct visits, `strict` sites, and links
  from pages whose referrer policy sends nothing make no referrer row. No UTM parameters (C-65).
- **Country** — see §2.8.
- **Device, browser, OS** — the gateway reduces the User-Agent to browser family, major version, OS and device class,
  discards it, and sends the engine a **synthetic** User-Agent from a fixed template table (wire-formats §c.3). The
  engine parses that template, so the resolution is the template table's: for example Safari on iPhone is reported as
  browser `ios`, and any browser the table does not know is reported as **Firefox on Linux**. In the `standard`
  profile the device also uses the screen-width class (`s`/`m`/`l`/`x`, sent as a fixed resolution per class); `strict`
  sends no screen width.
- **Path** — the normalised path (§2.7). Identifier-shaped segments are folded into placeholders, so one row may stand
  for many real pages (`/accounts/{account}`).
- **Event** — the custom-event name. Event properties are stored by the engine, but no property breakdown is offered
  by the tenant API as built. Wallet events (ADR-0029; Stellar event schema v1, C-136) are counted in their own rollup
  (§2.11); only the five that cannot coincide with a ledger transaction appear here. Tracker 1.0.0 sends a Wallets Kit
  presence flag on the page view (`standard` profile), which the gateway counts per site (`kit_present_pageviews`) and
  does not forward to the engine (C-93).

**Top-N bias in long ranges.** For days outside the live window (§2.6) breakdowns come from daily rollups that keep
only the **top 50 values per site, day, variant and dimension** (setting `web_breakdown_top_n`, default 50); no
"Other" row is stored (`services/jobs/src/rollup/compute.ts`). A value that missed the top 50 on some days is missing
those days' counts in a multi-day breakdown. Per-value visitors over several days are, like totals, sums of daily
values.

### 2.6 Live window and rollups (C-109, C-110(6), C-112)

The engine cannot answer long ranges fast enough at the design volume (S-11: p95 24–43 s for 30–90 days on the
largest site), so a request is split at a UTC midnight:

- **Live part** — answered by the engine through the tenant's own view-only key. Its length per site is
  `clamp(floor(250,000 ÷ daily events), 1, max)` days, where daily events is the larger of the 28-day average and
  today's count projected to a full day, and `max` = min(90, the site's event retention) (function
  `scf.web_live_window_days` in `db/migrations/0018_web.sql`; settings `web_live_events_budget` 250,000 and
  `web_live_window_max_days` 90). A site with no history yet gets 1 day. The live window is day-aligned and includes
  today; a range that starts within the last 24 hours is answered live in full.
- **Rollup part** — everything before the live window comes from `scf.web_daily_totals`, `scf.web_daily_breakdowns`
  and `scf.web_hourly_totals`, written by the `web_rollup` job (`services/jobs`). Rollups are computed per site and
  UTC day with the same C-73 semantics, from Umami's tables through a read-only view; a test compares every stored
  figure with Umami's own API answers (`services/jobs/README.md`).
- **Refresh and finality.** Today and (until 02:00) the previous day are re-rolled hourly; at 01:30 the job re-rolls
  D-1, D-2 and D-3 and marks D-3 final; the last 7 days are caught up if a run was missed (`services/jobs/README.md`). A day's rollup can therefore still change for about three days, e.g. when a spool backlog is
  delivered late.
- **Every response says where it came from**: `source` = `live`, `rollup` or `mixed` (also in header `x-scf-source`).
- **Fallback.** Each engine call has a 5 s timeout. If the live part cannot be answered (timeout, engine error, tenant
  not provisioned yet), it is answered from the rollups with `source: rollup` and `partial_today` (C-112(6)). Today's
  part then comes from hourly rows: page views are exact, **visitors are an upper bound** (a visitor active in two
  hours is counted twice) and visit figures and breakdowns for that part are not available.
- **Event retention.** Event-level data stays in the engine 90 days by default (30–395 days, C-54; setting
  `web_event_retention_days`); daily rollups are kept indefinitely (ADR-0011). Ranges older than the event retention
  are always rollup ranges.

### 2.7 Whole UTC days for custom ranges (DV-38)

Unique visitors, visit figures and breakdowns are not additive within a day, and rollups are daily. Therefore a
**custom range whose part before the site's live window is not made of whole UTC days is answered `400
validation_failed`**, naming the live-window boundary (`planRange` in `range.ts`; test
`services/control-plane/test/integration/web.test.ts` "a custom range whose rollup part is not whole UTC days is 400
naming the boundary (DV-38)"). All presets comply: `24h` is rolling (now − 24 h … now) and always live; `7d`, `30d`,
`90d`, `12m` and `all` end at the end of today and are day-aligned. Hourly page-view and visitor series are exempt.
Time series of visits, bounces, bounce rate and duration exist for `unit=day|month` only; `unit=hour` with those is
`400` (C-112(4)). Comparison ranges (`compare=previous`) follow the same rules; when one cannot be composed,
`previous` is `null` with `comparison_unavailable` (C-112(5)).

### 2.8 Country

- Resolved at the gateway from the address **truncated to /24 (IPv4) or /48 (IPv6)** with DB-IP IP to Country Lite
  (CC BY 4.0), then the address is discarded (ADR-0006, C-106). Unknown → `XX`.
- **Accuracy (S-12, measured 2026-11-12 on 3 × 1,000,000 generated addresses):** truncation changes the country for
  0.10–0.17 % of IPv4 and 0.27 % of IPv6 addresses. Country databases themselves disagree for **4–12 %** of addresses
  (DB-IP Lite vs. sapics `user-country`: 4.3 % IPv4 address-weighted, 8.8 % IPv4 range-weighted, 11.7 % IPv6), mostly
  between neighbouring countries or towards the US. There is no ground truth, so neither database is known to be
  right; one database is used for every lookup so that shares do not jump.
- Visitors using a VPN, Apple Private Relay or a corporate proxy are counted in the egress country.
- `exclude_countries` (per site) drops events from the listed countries at the gateway; they are only counted
  (`drop/country_excluded`, C-58).

### 2.9 What the verdict can and cannot tell you (ADR-0008)

- **Verified ≠ human.** A real headless browser on residential proxies passes the challenge, the proof-of-work and the
  request-consistency checks; it is only *detectable* by multiplicity counting and the daily anomaly detection. We
  say this plainly (ADR-0008).
- **Proof-of-work timing biases verified counts against very short visits and slow devices.** The tracker solves the
  proof before its first event; if the page is hidden first, the event is sent without proof and is `suspect`
  (`proof_missing`, C-35). The default work took a median of 288 ms (Chromium) / 314 ms (WebKit) and p95 418 / 608 ms
  on 1/6 of a desktop core in emulation (S-07); **no real phone was measured** (risk R-24). Adaptive difficulty doubles
  the work (up to 8×) for networks that look abusive, which makes `proof_missing` more likely there.
- **Network class.** Traffic from datacenter address ranges is `suspect` (`net_datacenter`); real people behind cloud
  VPNs are affected. The range lists are fetched weekly by the range-list updater on each edge node; with no lists
  present every address is class `unknown` and this reason never fires (C-38; `services/gateway/README.md`).
- **Multiplicity** is counted per gateway node in memory over 10-minute windows (wire-formats §b.4); spreading over
  several nodes divides apparent multiplicity. On sites without a visitor identifier it counts page loads per subnet
  instead of distinct visitors — weaker (C-80). Addresses in no range list (`unknown`, nearly everyone without
  eyeball lists) use the `eyeball_mobile` thresholds (40 distinct visitors per address, 160 per /24, in 10 minutes)
  so carrier-NAT and campus audiences are not marked suspect; a site or the platform can run multiplicity in
  **shadow** mode, where would-be flags are only counted (`multiplicity/high_shadow`) and the verdict is unchanged
  (C-124). The false-positive rate of the thresholds is not yet measured on real traffic; shadow periods exist to
  measure it.
- **Transport fingerprint.** A client whose TLS or HTTP/2 stack does not match the browser its User-Agent claims —
  e.g. a Go, Node, Python or curl script sending a Chrome User-Agent — is `suspect` (`transport_mismatch`, C-124).
  This catches default HTTP libraries, **not determined attackers**: TLS and HTTP/2 stacks can be imitated
  (curl-impersonate, uTLS) or a real browser can be driven. It can also mark real people suspect behind
  TLS-intercepting corporate proxies or antivirus HTTPS scanning. It never rejects an event on its own.
- **Third parties can send suspect traffic for your public site key** ("framing or flooding"). Origin binding, the
  challenge and per-subnet rate limits bound it; what remains shows up as a rise in the suspect share with reason
  codes (C-80).
- **Unverified domains.** Events from a declared but not yet verified domain are `suspect` (`domain_unverified`); from
  an undeclared domain `rejected` (`origin_mismatch`) (`server.go`). Verify every domain the site runs on.
- **Bots that the engine recognises.** The gateway applies the same `isbot` list as Umami before reducing the
  User-Agent (`ua_bot`, rejected); Umami's own check stays on and may still drop an event, counted as
  `engine_bot_drop` (C-36, C-69).
- **Not counted at all:** visitors with GPC/DNT, visitors who opted out, visitors without consent in consent-gated
  mode, and visitors whose ad-blocker blocks the tracker. The filter-list check passes for the placeholder host names
  (`tracker/scripts/filter-list-check.ts`); real-world blocking rates are not measured.
- **Trust score** (daily, advisory, ADR-0028) is **planned** (P1).

### 2.10 Small-count protection (C-51, C-95)

- **Tenant dashboard, `anonymous_reports` on (the default):** breakdown rows whose ranking count is below 10 are
  merged into "Other", and displayed breakdown counts are rounded to the nearest 10 (`presentBreakdown()` in
  `figures.ts`). Totals are not rounded. A tenant may switch it off per site.
- **SCF-operator view, operator metrics API, programme endpoint:** the minimum count 10 and rounding to 10 apply to
  web **breakdown rows** only — never to web totals, API metrics, verdict counters or on-chain counts (C-95). Sums
  across tenants add unrounded values and round once (C-89). The database functions exist
  (`db/migrations/0040_op_functions.sql`); the operator HTTP endpoints are **planned**.

- **Stellar wallet-event counts (C-137):** the tenant's own wallet funnel is exact. Any output of these counts that
  leaves the tenant (SCF-operator views, public pages, cohorts, snapshots) omits a per-day, per-value count below 10
  (`op_min_count`), as for breakdown rows. Cohort figures (§2.11) apply the same floor to every figure.

### 2.11 Stellar wallet events and the wallet funnel (C-136, C-137)

- **Source of truth.** Wallet-funnel figures come **only** from the daily property rollup `web_event_property_daily`
  (per site, UTC day of receipt, event, network, property value, verdict), filled from the gateway's per-minute counter
  records. They are **not** read from the engine's event table, and the two will differ: the rollup includes the
  counted-only events below, counts by day of receipt and can miss up to 60 s of counts of an edge node that dies
  before writing its minute's record; the engine holds only the forwarded wallet events, after a delay of up to 72
  hours, filtered again by its own bot check.
- **Counted only, never stored per visit:** `sign_requested`, `sign_approved`, `sign_rejected`, `tx_submitted`,
  `smart_wallet_created`, `passkey_used`. They can coincide with a public ledger transaction, so they never enter a
  visit (no path, time or device next to them); they do not change visits, bounces or duration and do not count
  towards the daily quota.
- **Forwarded as custom events** (and therefore visible in the event breakdown and making a visit a non-bounce):
  `wallet_modal_opened`, `wallet_modal_closed`, `wallet_selected`, `wallet_connect`, `wallet_disconnect`.
- `verified` / `raw` as for page views; `dev` and `rejected` events are never counted.
- **Cohorts (SCF operators):** cohorts with fewer than 5 projects show no figures; in a shown cohort a figure below 10
  is withheld, and on-chain figures need at least 5 projects with on-chain data. This is a floor for comparison, not a
  privacy boundary (operators see each project's exact totals).

### 2.12 Confidence on the project overview (C-138)

The overview's "verified usage" panel shows a confidence level computed with the snapshot rule of methodology
`scf-methodology/1.0.0` (wire-formats §i.3.2), so a project sees what a snapshot of the same period would say, with
one difference: the reason **`days_not_final` is never shown on the overview**. That reason says that a day of the
period was still inside the live window when a snapshot was **signed**; the overview is not signed and is recomputed
on every visit, so it has nothing to freeze. A snapshot of the same period can therefore be one level lower than the
overview (for example `medium` with `days_not_final` where the overview says `high`) while its last days are not
final. The other reasons and the `insufficient` rule are the same.

### 2.13 Web reports: funnel, goals, journeys (C-148)

Read live from the analytics engine (wire-formats §j.3 R6–R8) for the site's main website. They cover the site's live
window only: earlier days are left out, never estimated, and an engine timeout answers "not available" rather than a
partial figure. Retention cohorts and UTM campaign reports are not offered: the visitor key rotates every UTC day
(C-110), so a returning visitor cannot be recognised, and query strings — where UTM parameters live — are never stored
(C-65).

| Figure | Definition | Computed by |
|---|---|---|
| **Funnel step visitors** | Visitors who reached this funnel step after all earlier steps, in order, each step within the chosen number of minutes of the previous one. A visitor is counted once per UTC day (the visitor key rotates daily), so over several days this is a sum of daily visitors. With "Verified", the first step must be a verified event. "withheld" = below the minimum count while anonymous reports are on. | engine funnel report (wire-formats §j.3 R6) |
| **Funnel conversion** | Visitors of this step as a share of the visitors of the first step, from the counts shown (rounded when anonymous reports are on). | `src/web/reports.ts` |
| **Funnel step conversion** | Visitors of this step as a share of the visitors of the previous step, from the counts shown. | `src/web/reports.ts` |
| **Goal visitors** | Visitors who viewed the goal's page path (`*` matches any run of characters) or sent the goal's custom event at least once in the range, counted once per UTC day. "withheld" = below the minimum count while anonymous reports are on. | engine goal report (R7) |
| **Goal conversion** | Goal visitors as a share of all visitors in the range (visitors with any page view or event). | `src/web/reports.ts` |
| **Goal denominator visitors** | Visitors with any page view or custom event in the range on this website, counted once per UTC day and summed over the days; the denominator of every goal conversion. | engine goal report (R7) |
| **Journey visits** | Visits whose first events (page paths, or custom event names where an event was sent) followed exactly this sequence; consecutive repeats of the same page count once. A visit ends after 30 minutes without an event. Only sequences followed by at least the minimum count of visits (default 10) are shown, so no single visitor's path is visible; counts are rounded when anonymous reports are on. | engine journey report (R8) |
| **Other journey visits** | Visits whose journeys were each followed by fewer visits than the minimum count: counted here, never listed. | `src/web/reports.ts` |

## 3. API analytics (OpenTelemetry)

Built today: the Collector distribution with its sanitise step (`collector/`), the metrics writer (`services/metrics-
writer`), the storage and percentile functions (`db/migrations/0030_histograms.sql`). **Planned:** the OTLP front door
in the gateway, ingest-token issuance in the control plane, the tenant and operator API dashboards and read endpoints,
and assurance levels. The definitions below are what the built components compute.

### 3.1 Self-attested telemetry

API figures come from the tenant's own servers. The platform authenticates the sender (ingest token) and checks
plausibility, but **cannot prove that the numbers are genuine**: a tenant can send fabricated metrics. API data is
therefore labelled **"self-attested telemetry"** everywhere, with assurance levels A0 (token only), A1 (plausibility
checks pass), A2 (declared base URL answers an operator-side probe — liveness only) and A3 (consistent with on-chain
activity of declared contracts, which can itself be bought cheaply) (ADR-0028, C-44). Assurance levels are
**planned**.

### 3.2 What is ingested

- Only the HTTP **server** duration histogram — `http.server.request.duration` (seconds) or the legacy
  `http.server.duration` (milliseconds, converted to seconds) — and **SERVER spans that are local roots**, which the
  Collector turns into duration histograms and then discards. Client metrics, other metrics, logs, span names, span
  events and links never get through (`collector/README.md` §"The sanitise step").
- **One count per request (C-22).** Each (source kind, metric name, scope) is a stream group. Per service and UTC day
  the read side uses one preferred group: SDK stable-name metric, else SDK legacy metric, else span-derived. The
  tenant sees a warning when more than one group reports. Send either the metric or the spans for a service, not both
  (the quickstarts in `docs/guides/quickstarts/` do this).
- **Span-derived counts** honour the sampling threshold in `tracestate` (`ot=th`), capped at 1,024 per span: if you
  sample spans, span-derived request counts are **estimates**. Spans longer than 24 h are dropped as malformed.
- **Time bounds.** Points more than 5 minutes in the future or more than 48 hours before receipt are dropped (`future`,
  `too_old`); points received more than 72 hours before the writer could store them are dropped
  (`undeliverable_72h`); points before the service's registration (minus 10 minutes) are dropped
  (`before_registration`). All are counted per tenant.

### 3.3 Requests, errors, latency

| Figure | Definition |
|---|---|
| **Requests** | Sum of histogram counts per (service, route, method, status code, source) and time bucket. Cumulative SDK streams are converted to deltas per stream; a stream's first point counts in full when it starts at or after the service was first seen, otherwise it only seeds the state (C-112(3)); a restart is a new stream, never a negative delta (C-105). |
| **Status classes / 5xx error rate** | By `http.response.status_code` (legacy `http.status_code` renamed). Errors are derived from the status code, **not** from `error.type`, which Go and Rust do not send (S-06b). A missing or invalid status is stored as 0. |
| **Method** | Upper-cased known HTTP methods; anything else `_OTHER` (absent → `_OTHER`). |
| **Latency mean** | `duration_sum ÷ request count`. |
| **Latency p50 / p95 / p99** | From the **merged** histogram of every row in the range (merge first, then compute; C-103), with linear interpolation inside the bucket that holds the rank (`scf.hist_quantile*`). Always shown with its accuracy class. |
| **Time resolution** | 1-minute rows kept 35 days, 1-hour rows 25 months, 1-day rows indefinitely (ADR-0011). Buckets are UTC. |
| **Client errors (4xx) rate** | Requests answered with a 4xx status code as a share of all requests, from `http.response.status_code`. |
| **Days with traffic** | UTC days of the range on which the services reported at least one request. |
| **Availability (SLO)** | Share of requests with a status code that were not answered 5xx, over the shown range, against the service's objective (default 99.5 %, set per service). Requests without a status code are left out and reported. Measured only from the telemetry the service sent: it is not an uptime probe. |
| **Error budget used** | 5xx responses in the range ÷ the 5xx responses the objective allows ((100 % − objective) × requests with a status code). Above 100 % the objective was missed. |
| **SLO coverage** | UTC days of the range with any request ÷ days of the range. A day without data counts neither as up nor as down, so a low coverage means the availability says little. |
| **Requests by Stellar surface** | Requests grouped by the versioned mapping `stellar-surfaces/1.0.0`: Horizon by resource, Stellar RPC by JSON-RPC method (when the service reports it), SEP endpoints by SEP number, other routes by their first segment. Percentiles are merged per group from the stored histograms. |

**Accuracy classes** (`AccuracyClass` in `docs/api/control-plane.openapi.yaml`, `scf.accuracy_class()`):

| Class | When | Error of a percentile |
|---|---|---|
| `exp3` | every contributing row is the base-2 exponential histogram at scale 3 (span-derived data, or tenant exponential histograms at scale ≥ 3) | ≤ 4.33 % relative (4.28 % worst measured, S-05) |
| `explicit15` | every contributing row uses the 15-bucket OpenTelemetry default bounds (`0.005 … 10 s`) — what every SDK in S-06a/b sends by default | within the bucket width; measured **+17–18 % at p50/p95** for realistic distributions; for APIs faster than 5 ms only "≤ 5 ms" can be said (a percentile in the first bucket is reported as 0.005 s); above 10 s only "≥ 10 s" |
| `explicit15_approx` | as above, but some input was interpolated into the 15 buckets (mixed `exp3` + explicit rows, or tenant buckets that straddle our bounds) | as `explicit15`, plus the interpolation |
| `coarse` | tenant exponential histograms at scale < 3 contributed | worse; treat as indicative only |

**Fast APIs under `explicit15` (observed in the end-to-end runs, C-122):** when at least half of an API's requests
finish within 5 ms, its p50 lies in the first bucket `(0, 0.005 s]` and is reported as **0.005 s** — the bucket's upper
bound, i.e. "≤ 5 ms" — and the same holds for p95/p99 when they fall in that bucket. This is the stated accuracy of the
`explicit15` class, not a measurement error; a tenant who needs finer latency for fast APIs exports exponential
histograms (scale ≥ 3 gives `exp3`, ≤ 4.33 %) or relies on the span-derived series.

### 3.4 Routes and the special placeholders

Routes come from the tenant's `http.route` (framework placeholders `:id`, `{id}`, `[id]` canonicalised to `{id}`),
otherwise from the request path, normalised by the versioned rule set `scf-path-rules/1.1.0` (`packages/pathnorm`; 1.1.0 folds single-digit segments too, C-141):
query and fragment always removed, identifier-shaped segments folded into typed placeholders (`{account}`,
`{contract}`, `{hash}`, `{uuid}`, `{int}`, … — 24 entries in `pathnorm.Vocabulary`). The rule-set version is stored with
every route.

| Placeholder | Meaning | Where assigned |
|---|---|---|
| `{redacted}` | The segment looked like a secret seed, JWT, API key, e-mail address, federation address, phone number or IP address and was removed. The value is never stored, not even as a hash; only a per-tenant counter increases (`route_redacted` for API; `drop/path_redacted` for web page paths, where the event is kept with the placeholder). Redaction cannot be switched off. | `pathnorm` in the Collector and in the gateway (C-52) |
| `{unknown}` | The request had no route and no path at all — in practice an **unmatched request** (e.g. a 404 the framework did not route). `http.route` values `""` (Rust tracing) and `/**` (Spring catch-all) are treated as absent (C-105). Such requests are counted under `{unknown}`, not dropped. | Collector sanitise step only (C-16, C-101) |
| `{overflow}` / `<prefix>/{overflow}` | The cardinality guard was hit: more than 1,000 distinct routes per service per day, 5,000 per tenant per day (100 per tenant per day at verification level L0), or 200 literal children under one prefix. Excess requests are counted under the overflow route (`route_overflow`). | metrics writer only (C-24) |
| `{not_allowed}` | Not a route: the **service name** under which the Collector reports data it dropped because the ingest token does not allow that service (`service_not_allowed`). The writer books those drop counts to the all-zero placeholder service id; no metric data from that service is stored (C-70, C-115). | Collector, writer |

A web page path uses the same rule set with the site's `path_folding`: `full` (default) or `relaxed`, which keeps
numbers, dates and slugs literal; StrKeys, hashes, tokens and e-mail addresses are always folded or redacted (C-70,
C-89, C-101).

**Stellar surfaces (`stellar-surfaces/1.0.0`, C-148).** The tenant API dashboard groups routes by the public Stellar
interface they belong to. The mapping is versioned (every response that uses it names the version; any change of an
output is a new version) and reads only the stored route and the JSON-RPC method it carries, never a raw path. Rules,
first match wins (segments compared case-insensitively, placeholders such as `{account}` skipped):

1. `{unknown}` / `{overflow}` → `placeholder` (group = the placeholder).
2. A JSON-RPC method on the row → Stellar RPC (`soroban_rpc`), group = the method (e.g. `getLedgerEntries`); a route
   whose last literal segment is `rpc`, `soroban-rpc` or `soroban_rpc` without a method → `soroban_rpc`, group
   "(method not reported)" (switch on the service's RPC method dimension to see methods).
3. `/.well-known/stellar.toml` → SEP-1.
4. An explicit SEP segment anywhere (`sep6`, `sep-6`, `sep10`, `sep12`, `sep24`, `sep31`, `sep38`, …) → that SEP; the
   group is the rest of the route after the segment (or `/`).
5. Distinctive anchor paths without a prefix: `…/transactions/deposit/interactive`, `…/transactions/withdraw/interactive`
   → SEP-24; `/auth` → SEP-10; `/customer`, `/customers` (and below) → SEP-12; `/deposit`, `/withdraw`,
   `/deposit-exchange`, `/withdraw-exchange`, `/fee` → SEP-6; `/quote`, `/quotes`, `/price`, `/prices` → SEP-38;
   `/info`, `/transaction` (singular) → "SEP-6/24/31 shared endpoint".
6. Horizon resources (first literal segment): `accounts`, `assets`, `claimable_balances`, `effects`, `fee_stats`,
   `ledgers`, `liquidity_pools`, `offers`, `operations`, `order_book`, `paths`, `payments`, `trade_aggregations`,
   `trades`, `transactions`, `transactions_async` and the root `/` → Horizon, group = the resource (`/transactions`
   without a SEP marker is Horizon's; an anchor's SEP transactions list is recognised only under a SEP prefix).
7. Anything else → `other`, group = the first literal segment.

The source of truth is `services/control-plane/src/api/stellar-surfaces.ts` (header and unit tests).

### 3.5 Data-quality counters

Everything dropped or altered on the API path is counted per tenant and reason, never with the value: the closed list
is in wire-formats §h.3 (e.g. `service_quota_exceeded`, `metric_not_allowed`, `client_metric_ignored`,
`span_not_server`, `span_not_local_root`, `route_overflow`, `route_redacted`, `route_seed_redacted` (a secret seed in
the route: the tenant sees a rotate-your-key warning until an admin acknowledges it), `cumulative_reset`, `duplicate_batch`,
`hist_layout_approx`, `exp_scale_coarse`, `malformed_point`, `count_overflow`, `tenant_write_error`). The tenant-facing
view of these counters is **planned** with the API dashboard.

## 4. Known biases at a glance

| Figure | Direction | Cause |
|---|---|---|
| Unique visitors over several days | higher than distinct people | sum of daily uniques (C-110) |
| Unique visitors, one day | lower (shared NAT + same browser) or higher (network/browser change, key regeneration) | identifier = HMAC of IP and UA per day (ADR-0007, C-04) |
| Visits | slightly higher | split at 00:00 UTC; split once at an engine-proxy restart or core failover (C-74, C-99) |
| Bounce rate, duration | include suspect events | one figure over all identified events (C-73) |
| Strict sites | no visitors or visit figures by default | `visitor_id = off` with `strict` (C-53) |
| Verified page views | lower for very short visits and slow devices | proof-of-work must finish before the first event (C-35, S-07) |
| Verified page views | lower for visitors on datacenter/VPN egress | `net_datacenter` (ADR-0008) |
| All web figures | lower than real traffic | GPC/DNT, opt-out, consent mode, ad-blockers |
| Long-range breakdowns | long tail missing | top 50 per day in rollups |
| Today's figures after a live fallback | visitors over-counted | hourly sums (`partial_today`) |
| Country | 4–12 % database disagreement; 0.1–0.3 % truncation effect | S-12 |
| Browser/OS/device | coarse; unknown browsers shown as Firefox/Linux | synthetic UA templates (wire-formats §c.3) |
| API percentiles | up to ~18 % high for default explicit buckets | `explicit15` bucket width (S-05) |
| API figures | may be fabricated by the tenant | self-attested telemetry (ADR-0028) |
| Span-derived API counts | estimates when the tenant samples spans | `ot=th` adjustment, capped at 1,024 |

## 5. Sources

Register `docs/adr/README.md` (ADR-0006/0007/0008/0010/0011/0012/0028, C-04, C-22, C-24, C-35, C-38, C-51, C-52, C-53,
C-54, C-58, C-65, C-70, C-73–C-75, C-80, C-86, C-89, C-95, C-99–C-115); design trade-off DV-38 in `docs/capabilities.md`; contracts
`docs/contracts/wire-formats.md` §b, §c, §f, §h, §j; `docs/data-model.md` §8.9; spikes S-01, S-05, S-06a/b, S-07,
S-11, S-12 (`spikes/*/README.md`); code: `services/control-plane/src/web/{figures,range,rollup,live,handlers}.ts`,
`db/migrations/0018_web.sql`, `db/migrations/0030_histograms.sql`, `services/jobs/src/rollup/compute.ts`,
`services/gateway/internal/ingest/server.go`, `services/engine-proxy/README.md`, `collector/README.md`,
`services/metrics-writer/README.md`, `packages/pathnorm/README.md`, `tracker/README.md`.

## 6. Trust score `trust/1.0.0` and API assurance A0–A3

Advisory signals, never a verdict on a project (ADR-0008 L7, ADR-0028, C-44, wire-formats §h.4). Computed daily
at 03:00 UTC by the job `trust_scoring` for D-1 and D-3, from **aggregates only** (no event-level reads); source of
truth: `services/jobs/src/trust/algorithm.ts` and `services/jobs/src/jobs/trust-scoring.ts`, reference examples in
`services/jobs/test/unit/trust.test.ts` (the tests assert every number below).

### 6.1 Web trust score (`web_trust_scores`, windows 1 and 28 days)

    T = round(100 − Σ w_i · p_i),   Σ w_i = 100,   p_i = clamp((value_i − lo_i) / (hi_i − lo_i), 0, 1)

Weights are the platform setting `trust_weights` (default below); the version is the setting
`trust_algorithm_version`. Each component's `p` grows linearly from 0 at `lo` to 1 at `hi`.

| Component | Value (per site and window) | lo | hi | Default weight | Reason code (when p > 0) |
|---|---|---|---|---|---|
| `proof_coverage` | 1 − verified ÷ raw page views (`web_daily_totals`) | 0.10 | 0.60 | 25 | `proof_coverage_low` |
| `network_quality` | (datacenter + vpn + tor) ÷ all ASN-class counts (relay and mobile are not in the numerator) | 0.10 | 0.50 | 15 | `network_datacenter_share_high` |
| `multiplicity` | `high` ÷ all multiplicity counts | 0.05 | 0.30 | 15 | `multiplicity_share_high` |
| `engagement` | (webdriver + hidden + no_activation) ÷ (all verdicts − `not_collected`), capped at 1 | 0.20 | 0.70 | 15 | `engagement_low` |
| `mix` | the larger Jensen–Shannon divergence (base 2) of the day's device or country page-view mix against the site's previous 28 days | 0.10 | 0.50 | 10 | `mix_divergent_device` / `mix_divergent_country` |
| `temporal` | the larger of *step* (day page views ÷ median of the previous 28 days; lo 3, hi 10) and *burst* (largest UTC-hour share of the day's raw page views in `web_hourly_totals`; lo 0.25, hi 0.75); a tie goes to step | — | — | 10 | `step_change` / `burstiness_high` |
| `pow_latency` | `lt100ms` ÷ proof-of-work latency counts except `none` | 0.05 | 0.50 | 5 | `pow_latency_implausible` |
| `cross_signal` | neutral in 1.0.0 (p = 0): a signal that is not configured is never penalised | — | — | 5 | — |

Rules:

- **Omitted, never missing (C-33).** A component without input — no counters, a `strict` site without client signals,
  fewer than 7 days of history for `mix` and the step half of `temporal`, no hourly rows of the day for the burst half
  — is `omitted` and contributes p = 0. `temporal` is omitted only when both halves are; burst needs no history.
- **Small sites.** Below `op_min_count` raw page views in the window the score is `NULL` with the single code
  `insufficient_data` and no components.
- **28-day window.** Sums the counters and totals of the 28 days ending with the day; `mix` and `temporal` are
  day-level signals and are omitted there.
- **`decision_rate`** = (suspect + rejected) ÷ all verdict counts (reported alongside, not part of T).
- **Ecosystem percentiles** (`eco_percentile`) are attached only when at least `ecosystem_percentile_min_tenants`
  (20) tenants are active (C-44) and are informational in 1.0.0; canary tenants never enter them. The thresholds are
  absolute because they are not calibrated yet (ADR-0028 open point 1).
- **Burstiness** reads the day's hourly raw page views from `web_hourly_totals` (the job's read access is migration
  `0057`), summed per UTC hour of the day; hours of other days never enter it.

Worked examples (default weights, `op_min_count` = 10):

| # | Situation | Inputs (abridged) | Result |
|---|---|---|---|
| E1 | Clean site | 1,000 raw / 980 verified page views; 5 % datacenter; 2 % high multiplicity; 3 % hidden; 1.1 % `lt100ms`; no 7-day history | **100**, no codes, `decision_rate` 0.02; `mix` omitted |
| E2 | Inflated site | 1,000 raw / 400 verified; 30 % datacenter; 17.5 % high multiplicity; 45 % webdriver; 27.5 % `lt100ms` | 25·1 + 15·0.5 + 15·0.5 + 15·0.5 + 5·0.5 = 50 → **50**, codes `proof_coverage_low`, `network_datacenter_share_high`, `multiplicity_share_high`, `engagement_low`, `pow_latency_implausible`; `decision_rate` 0.6 |
| E3 | Step change and device shift against a 10-day baseline of 100/day | 650 page views, all desktop (baseline 50/50 desktop/mobile) | `mix` JSD 0.3113 → p 0.5282 → 5.28; step 6.5 → p 0.5 → 5; 100 − 10.28 → **90**, codes `mix_divergent_device`, `step_change` |
| E4 | Too small | 9 raw page views | **NULL**, `insufficient_data`, no components; `decision_rate` 1 |
| E5 | `strict` site | 100 raw = verified; every client signal `not_collected` | `engagement` omitted (not scored as missing) → **100** |
| E6 | Burst without history | 100 raw = verified; 60 page views in one hour, 10 in each of four others; no 7-day history | burst 0.6 → p 0.7 → 7; step omitted → **93**, code `burstiness_high` |
| E7 | Step against burst | E3's 650 page views and baseline, all in one hour | step 6.5 → p 0.5; burst 1 → p 1 → 10 → **90**, code `burstiness_high` (split evenly over two hours: burst 0.5 → p 0.5 = step's p → `step_change`) |

### 6.2 API assurance (`api_service_assurance`, `A1-1.0.0`)

Per API service and UTC day with data. A0–A2 are cumulative levels; A3 is a separate badge.

| Level | Meaning | How it is decided | Reason codes |
|---|---|---|---|
| **A0** | The service reported data with a valid ingest token that day (tenant bound server-side) | every stored row has it | — |
| **A1** | Plausibility (`A1-1.0.0`) | structural: no `malformed_point` / `negative_value` / `count_overflow`, status codes 100–599, 0 ≤ `duration_min` ≤ `duration_max`; latency: not ≥ 1,000 requests with a mean below 0.1 ms; seasonality: requests not above 10 × the median of ≥ 7 previous days; route cardinality: no `route_overflow` | `a1_status_mix_implausible`, `a1_latency_implausible`, `a1_rate_implausible`, `a1_route_profile_implausible` |
| **A2** | Liveness of the declared base URL | needs a probe result; the jobs service has no egress, so A2 is `not_probed` (never passed) or `no_base_url` | `a2_no_base_url` |
| **A3** (badge) | Consistency with on-chain activity | `not_applicable` (read-only API, or no verified declared contract); `unavailable` (no on-chain rows that day); `inconsistent` (requests reported but no successful invocation of any verified contract); else `consistent` | `a3_not_applicable`, `a3_no_verified_contract`, `a3_onchain_inconsistent` |

Examples (from the tests): a plausible service with 5,000 requests and a verified contract with 40 successful
invocations → level **A1**, badge `consistent`, no codes, A2 `not_probed`. The same service with a 2 µs mean latency,
50,000 requests against a 1,000/day median, three malformed points and route overflow, and no successful invocation
→ level **A0** with `a1_status_mix_implausible`, `a1_latency_implausible`, `a1_rate_implausible`,
`a1_route_profile_implausible`, `a3_onchain_inconsistent`.

Telemetry stays self-attested (§3.1): A1 says the numbers are plausible, not that they are true.
