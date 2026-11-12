# ADR-0002: Base project — Umami

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** engine.umami-base, bot.engine-bot-detection, metric.pageviews, metric.unique-visitors, metric.referrers, metric.session-duration, metric.bounce-rate, metric.country, metric.device, metric.browser, security.patch-24h

## Context
UsageMap builds on an existing open-source web-analytics engine rather than writing its own, and the two candidates
were Umami and GoatCounter; the choice has to be justified. The engine must provide seven minimum web metrics (page
views, unique visitors, referrers, session duration, bounce rate, country, device and browser), and UsageMap builds
on the base project's existing bot detection. Both projects were read at source: Umami **v3.5.0** (commit `d3c62a8`, tag
2026-11-11, release page "12 Nov") and GoatCounter **v2.7.0** (`7e91d8a`, 2025-12-15) plus GoatCounter `main`
(`c031008`, 2026-09-28). Nothing below has been executed; the Umami integration spike is S-01.

Facts that decide the choice:
- **Metrics.** Umami computes all seven natively (`src/queries/sql/getWebsiteStats.ts:42-74`): pageviews = type-1
  events; visitors = `count(distinct session_id)`; bounces = visits with one pageview and no custom event; visit
  duration = first-to-last pageview per visit. GoatCounter
  counts "visits", not pageviews (v2.4.0 changelog, migration `2022-11-03-1-uncount.sql`); site-level "visitors" is a
  sum of per-path first visits (`hit_list.go:147-161`), so a reader of five pages counts five times; there is no
  bounce rate and no session duration anywhere in the code; raw hits are off by default since v2.6.0, so neither can
  even be derived without a setting change.
- **Maintenance.** Umami: company-backed, 1,300+ commits in 12 months, two core maintainers ≈ 70 %, a minor release
  every 6–8 weeks. GoatCounter: one maintainer (371 commits since
  2024 against 4 for the next person), core libraries by the same person, an 18-month release gap before v2.6.0, no
  commits since 2026-09-28, and a no-AI-contributions policy.
- **Licence.** Umami MIT. GoatCounter: modified EUPL-1.2 (see ADR-0001), plus a bundled GeoLite2 file.
- **Security.** Umami had several serious 2026 issues: CVE-2026-4317 (authenticated SQL injection, first fixed in
  **v3.1.0**, not 3.0.3 as INCIBE states), GHSA-3xx8 (cache token usable as share token, fixed v3.2.0),
  CVE-2026-121582 (`/api/record` cross-site write) and CVE-2026-121531 (required 2FA not enforced), both fixed only in
  **v3.5.0**, plus silent fixes such as a 2FA partial-token bypass (v3.3.x) and an API-key route bypass (v3.4.x).
  Framework emergencies were patched in 0–1 days, Umami's own bugs in 22–84 days. GoatCounter: CVE-2026-108740 (HIGH, read-only user can become
  superuser via mass assignment on `/user/pref`), with the vulnerable pattern still on `main` — LIKELY unfixed; no
  security policy; unsigned releases.

## Options considered
The weighted comparison (each criterion rated 0–5 against UsageMap's goals, weights sum to 100):

| # | Criterion | Weight | Umami | GoatCounter | Deciding facts |
|---|---|---:|---:|---:|---|
| 1 | Minimum web metrics out of the box | 20 | 5 | 1 | Umami all seven; GoatCounter no bounce, no duration, no raw pageviews, no de-duplicated uniques |
| 2 | Effort and risk to close gaps without forking | 12 | 4 | 1 | Umami's gaps sit around the engine; GoatCounter's sit inside it (sessions, schema, jobs, UI) |
| 3 | Fit as a wrapped private engine | 10 | 4 | 4 | Umami: `CLIENT_IP_HEADER` + `cf-ipcountry` + `tag`; GoatCounter: clean `POST /api/v0/count` |
| 4 | Multi-tenancy primitives | 8 | 3 | 1 | Umami teams, team roles, per-user API keys; GoatCounter per-account roles, host-per-site, no user API |
| 5 | Existing bot detection to build on | 5 | 2 | 2 | Both a User-Agent list check (`isbot`) |
| 6 | Tracker pinning as shipped | 5 | 1 | 4 | GoatCounter frozen `count.vN.js` with SRI; Umami unversioned mutable `script.js` |
| 7 | Privacy posture as shipped | 8 | 3 | 3 | Umami salt recomputable; GoatCounter writes UA+IP session keys to DB on shutdown |
| 8 | Licence fit | 8 | 5 | 2 | MIT vs modified EUPL-1.2 with network copyleft |
| 9 | Maintainer and continuity risk | 8 | 3 | 1 | Small company vs one person |
| 10 | Security track record and response | 8 | 2 | 1 | Neither can carry a 24-hour patch promise alone |
| 11 | Operations and HA | 4 | 4 | 2 | Umami stateless against PostgreSQL; GoatCounter single active instance |
| 12 | PostgreSQL fit | 4 | 4 | 3 | Umami PostgreSQL-only; GoatCounter PostgreSQL or SQLite |
| | **Weighted total (max 500)** | 100 | **363** | **186** | |

Sensitivity: doubling the weights of criteria 3, 5, 6 and 7 — the only ones where
GoatCounter ties or wins — and halving criterion 1 gives 392 vs 270 of 590. The order does not depend on the weights.

**What GoatCounter does better, stated fairly.** It is a single static Go binary with embedded assets and optional
ACME; it stores aggregates only by default and sets no cookies; its tracker is shipped as frozen `count.v1.js` …
`count.v5.js` with published sha384 SRI hashes and a server contract "guaranteed to remain compatible"; and its
`POST /api/v0/count` accepts a caller-computed `session`, `location` and `bot` value, so a gateway can keep real IPs
away from it entirely — a cleaner wrap point than Umami's header conventions. Its resource use is likely small (not
benchmarked). We adopt the first three ideas in our own design: frozen versioned tracker files with SRI (ADR-0004),
an explicit gateway-to-engine contract carrying our own identifier, country and verdict (ADR-0005), and restraint in
what the tracker collects.

Options:
1. **Umami, wrapped as an unmodified private engine.** Pros: all seven metrics native; MIT; maintained by a team;
   PostgreSQL-only, so one database technology. Cons: a large Next.js application whose 2026 advisory history means it
   must never be internet-facing; session salt is recomputable; hour-bucketed visits; schema migration in almost
   every minor release.
2. **GoatCounter, wrapped.** Pros: small, simple, privacy-minimal, excellent ingest API. Cons: three of seven metrics
   (bounce, duration, true pageviews) and site-level uniques would have to be built outside it — a parallel
   aggregation path — or by forking a single-maintainer project under modified EUPL; single active instance only.
3. **GoatCounter, forked to add the missing metrics.** Pros: one engine computes everything. Cons: touches memstore,
   cron, schema, templates and `count.js`; the fork stays under modified EUPL for ever; upstream acceptance unlikely.
4. **Neither as the real engine (cite one, build our own).** Rejected: UsageMap builds on one of them, and capability
   engine.umami-base requires the engine to stay in the request path.

## Decision
The base project is **Umami v3.5.0, commit `d3c62a8`**, integrated as described in ADR-0003. v3.5.0 is the
**minimum safe version**: every earlier release carries at least one of CVE-2026-121582 (≤ 3.4.1), CVE-2026-121531
(3.3–3.4.1), the API-key rewrite bypass (3.4.x), the 2FA partial-token bypass (3.3.x), GHSA-3xx8 (≤ 3.1.x),
CVE-2026-4317 (≤ 3.0.3) or a Next.js RCE (≤ 3.4.0). No pinned Umami version below 3.5.0 is accepted.
 Umami's own
`isbot` check stays enabled as a backstop, and the gateway applies the same upstream `isbot` list, at the version
pinned by this Umami release, to the raw User-Agent before it is reduced (bot.engine-bot-detection, ADR-0008, register C-36,
design trade-off DV-08). Metric definitions shown to tenants are Umami's, documented with our caveats.

## Consequences
Positive: the seven required web metrics come from an engine many people run, not from our own SQL; building on the
base project's bot detection is done by applying Umami's own bot list (`isbot@5.2.2` at v3.5.0) at the
gateway on the raw User-Agent, with a parity test against Umami's function, and by leaving Umami's check enabled —
though Umami itself only sees the reduced User-Agent (C-36); licence and upgrade path are clean.

Negative / what we must now do:
- **Umami cannot be exposed.** `/api/send` trusts client `ip`, `userAgent`, `timestamp`, `id` and `hostname`; there
  is no domain check, no rate limit and CORS `*`. ADR-0003 and
  ADR-0005 exist because of this.
- **Metric caveats we must publish:** a visit is effectively a (session, clock-hour) bucket when no cache token is
  presented, which biases bounce rate up and duration down around the hour (§3.8 caveat 1). The engine proxy on the
  core nodes therefore replays Umami's cache token from a memory-only cache keyed by (site, surrogate), and edge
  forwarders pick the core by a consistent hash of the surrogate (C-74, ADR-0003), so a visit normally lasts until
  30 minutes of inactivity whichever edge node handled each event; it can split once at a core failover or restart.
  The effect of spool delay on Umami's visit logic is measured in S-01. Single-page visits add 0 s to duration but
  count in the denominator; a visit with any custom or wallet event is never a bounce (C-75); breakdown lists count
  visitors, not pageviews. Events without a visitor identifier go to a per-site twin Umami website and contribute
  page views, country and device counts only (C-73).
- **"Verified" vs "raw"** (C-73): page views and unique visitors have a verified figure (tag `v`) and a raw figure;
  visits, bounce rate and session duration have one figure each, computed by Umami over all identified, non-rejected
  events in one query, shown next to the suspect share of page views. This depends on S-01 (tag filter) and S-11
  (latency); if the tag filter fails, the C-82 fallback applies.
- **Upstream patch latency** of 22–84 days for Umami's own bugs means our 24-hour commitment (security.patch-24h) rests on
  network isolation and our own patch queue (ADR-0003, ADR-0023), not on upstream.
- **Scanners will flag v3.5.0** for a while: the GHSA database still listed CVE-2026-121531/-121582 as "patched:
  Unknown" on 2026-11-12, so a reviewed VEX statement is needed.
- **Schema churn:** migrations 15–27 arrived across 2026 minors; every upgrade needs the contract tests of ADR-0003,
  and Umami's migrations run as an explicit one-shot deploy step, never at container start (`SKIP_DB_MIGRATION=1`,
  C-40).

Revisit if: S-01 shows the surrogate-IP/country/`tag` integration does not work on the real image; S-11 shows the
stats API cannot serve tag-filtered queries at ~1M events/day; Umami changes licence or stops maintenance;
GoatCounter gains bounce rate, session duration and site-level uniques.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Base project scorecard: scorecard, sensitivity, what we adopt from GoatCounter.
- Umami ingest datamodel tracker: version, `/api/send` trust, metric SQL.
- Umami authorisation API multitenancy: project health, licence, bus factor.
- Umami security advisories: advisories, first-fixed releases, patch latency.
- Goatcounter deep dive: metrics gap, licence, CVE, wrap point.

## Open points
1. **Open: GoatCounter CVE-2026-108740 fix status** is LIKELY-unfixed, not verified. Closed by
   re-checking GoatCounter's `main` and the advisory database before any document cites it.
