# ADR-0024: Portal stack

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** dashboard.web-tenant, dashboard.web-pageviews, dashboard.web-visitors, dashboard.web-referrers, dashboard.web-session-duration, dashboard.web-bounce-rate, dashboard.web-country, dashboard.web-device-browser, dashboard.time-ranges, isolation.web-dashboard, operator.web-global-view, operator.web-compare, operator.web-filter, operator.web-sort, operator.web-side-by-side, dashboard.api-tenant, dashboard.api-volume, dashboard.api-status-codes, dashboard.api-latency-percentiles, dashboard.api-time-ranges, isolation.api-dashboard, operator.api-global-view, operator.api-compare, operator.api-usage-ranking, operator.global-view-credentials, enrol.self-service-open, enrol.operator-removal, enrol.approval-mode, keys.operator-api-keys, keys.revocation, privacy.tenant-erasure, docs.quickstarts-run, adoption.operator-view-live, docs.tenant-walkthrough-video, slo.dashboard-availability

## Context
The portal is the only user interface: tenants see a private web and API dashboard "for selectable time ranges"
(dashboard.web-tenant, dashboard.web-pageviews, dashboard.web-visitors, dashboard.web-referrers, dashboard.web-session-duration, dashboard.web-bounce-rate, dashboard.web-country, dashboard.web-device-browser, dashboard.time-ranges, dashboard.api-tenant, dashboard.api-volume, dashboard.api-status-codes, dashboard.api-latency-percentiles, dashboard.api-time-ranges); SCF operators get a "unified view that aggregates and compares … supporting filtering, sorting,
and side-by-side comparison" (operator.web-global-view, operator.web-compare, operator.web-filter, operator.web-sort, operator.web-side-by-side, operator.api-global-view, operator.api-compare, operator.api-usage-ranking); and it hosts enrollment, keys, erasure and onboarding. Umami's
own UI is never exposed (ADR-0003): it has no SCF-operator role or cross-website aggregate, and its CSP allows
`'unsafe-inline' 'unsafe-eval'` in `script-src` (Umami's `src/lib/csp.ts`). Dashboard availability is
99.9 % (slo.dashboard-availability) and must survive a database primary loss in read-only mode (ADR-0020). The portal will be handed to
a community service operator, so fewer moving parts matter.

**The security history behind "no server-side rendering".** Server frameworks put a large, fast-moving runtime on
the public internet:
- **React2Shell, CVE-2025-55182** (react.dev, 2025-12-03): unauthenticated remote code execution, CVSS 10.0, in the
  React Server Components packages used by Next.js; follow-up DoS and source-exposure CVEs in December 2025 and
  CVE-2026-23864 (2026-01-26) (VERIFIED). Exploitation within hours was reported
  (LIKELY, secondary sources).
- **2026 Next.js advisories** (VERIFIED from nextjs.org and OSV ranges): Next.js moved to scheduled monthly security
  releases in July 2026 with out-of-band releases on 2026-09-22 and 2026-10-14; critical RCEs include
  GHSA-vcvr-r3jv-pc5j (`next/og`, ≥ 16.2.0 < 16.3.6), GHSA-2xp9-vwfh-vxw4 (image optimizer via AVIF, fixed 16.3.3),
  GHSA-2464-fhr4-w9xw (SVG image optimizer, fixed 16.4.1) and GHSA-673q-mjm6-r5xr (`use cache`, fixed 16.4.1).
- Umami itself is a Next.js app: v3.0.0–v3.0.1 shipped React2Shell-vulnerable versions, v3.2.0–v3.4.0 shipped Next.js
  versions with the 2026 critical RCEs above, and v3.4.1 (2026-10-23) was a security hotfix to Next 16.4.2
 . We already
  carry that risk inside the private engine; we do not want a second copy on the public internet.

A static single-page app has no server runtime of its own: its public attack surface is the static file server and
the control-plane API (Fastify, ADR-0025), which we must secure anyway. SCF-awarded projects mostly use Next.js (17 of 40
surveyed sites, 43 %) and Vite SPAs (20 %); that shapes the onboarding wizard, not our
own portal.

## Options considered
1. **Static Vite + React + TypeScript SPA calling only the control-plane API (chosen).** Pros: no server code in the
   portal; deployable as files behind Caddy on both core nodes; read-only mode is just the API refusing writes;
   shares types with the API through the OpenAPI document; one TypeScript toolchain (ADR-0025). Cons: client-side
   rendering only (no SEO, which a logged-in dashboard does not need); first load is heavier than server-rendered
   HTML; all authorization lives in the API, which must be right regardless.
2. **Next.js (App Router, SSR/RSC).** Pros: the most common framework in the ecosystem; familiar to contributors.
   Cons: a public server runtime with the advisory history above; monthly security releases to track in addition
   to Umami's; harder handover; more ways to leak server data into client bundles.
3. **Another SSR framework (React Router 7 framework mode, SvelteKit, Astro with islands).** Pros: smaller than
   Next.js. Cons: still a Node server on the public path; SvelteKit/Astro add a second UI paradigm to the repo.
4. **Extend Umami's UI.** Pros: existing charts. Cons: requires modifying Umami (ADR-0003 forbids it); no SCF-operator
   model; weak CSP; exposes the engine.
5. **Grafana for dashboards.** Pros: no chart code. Cons: AGPL server on the public path; no tenant isolation model
   matching ours; no enrollment, keys or erasure flows.
6. **Server-rendered templates in the control plane (htmx-style).** Pros: very small client. Cons: mixes UI into the
   API service; rich comparison views need substantial client code anyway.

## Decision
- **Stack:** Vite + React + TypeScript, built to static files and served by Caddy on `core-a` and `core-b`
  (ADR-0018). **TanStack Router** (typed routes, search-parameter state for filters and time ranges, so every view is
  a shareable URL) and **TanStack Query** (caching, retries, stale-while-revalidate against the API). **uPlot** for
  time series. Breakdowns are **accessible HTML tables** (sortable, keyboard-navigable, with a text alternative for
  every chart) rather than chart-only widgets.
- **Data access:** only the control-plane REST API (OpenAPI 3.1, `docs/api/`); a typed client generated from it. The
  portal never talks to Umami, PostgreSQL or any third party. Behind the API the tenant web dashboard has **two
  read paths** (C-54): ranges inside the event-level window (90 days by default, settable 30–395 days by an
  `operator_admin`; 395 days is the hard maximum) are served **live and filterable through Umami** via the adapter; older
  ranges are served from **our daily aggregates** (totals and top-N breakdowns, kept indefinitely).
  Response shapes are owned by `docs/api/` and `docs/contracts/`, not by this ADR. Every time range the portal sends
  is `start` (inclusive) and `end` (exclusive), RFC 3339 in UTC (C-86).
- **No server-side rendering and no Next.js.**
- **Security headers:** strict CSP with `script-src 'self'` (no inline script, no `eval`), `connect-src` limited to the
  API host and our two ingest hosts, `frame-ancestors 'none'`, `require-trusted-types-for 'script'` (supported in
  Chrome 83+, Firefox 148+, Safari 26+); **no third-party scripts, fonts or CDNs**.
  Session handling follows ADR-0014. The portal is served from a different host than the tracker and ingest hosts.
- **Dog-fooding:** the portal embeds our own tracker (pinned version, SRI) like any tenant; its numbers appear as an
  internal tenant.
- **Views:**
  - Tenant **web dashboard**: page views, unique visitors (labelled per ADR-0007), referrers (by host; no UTM
    reporting, C-65), session duration, bounce rate, countries, devices, browsers, OS, custom events, wallet events;
    no page titles (they are not collected, C-89); preset and custom time ranges over the two read paths above
    (C-54). **Metric semantics (C-73):** page views and unique visitors show a **verified** and a **raw** figure side
    by side; visits, bounce rate and session duration show **one figure each**, computed over all identified,
    non-rejected events, next to the **share of page views that are suspect**. Visitor-based metrics come from
    identified events only, and the dashboard says so; page views, countries and devices also include the site's
    twin website (events without a visitor identifier). The metric definitions state that a visit with any custom
    or wallet event is not a bounce (C-75). If the S-01 fallback of C-82 is active, the dashboard says which figures
    come from our rollup.
    **Anonymous reports by default** (C-51): per-site setting `anonymous_reports`, on by default — breakdown rows
    below the minimum count (10) are merged into "Other" and displayed counts are rounded to the nearest 10; a
    tenant may switch it off. An installation-check page shows verdict and reason counters per site and day (C-39),
    kit-presence counts (C-75) and `429` answers caused by the site's rate limit or quota (C-80, C-90).
  - Tenant **API dashboard**: per service, normalised endpoints with request volume, status-code distribution and
    error rate, p50/p95/p99 with their accuracy class; "self-attested" label and assurance level (A0–A2, with A3
    as a separate badge or "not applicable", C-44); the preferred stream group per service and day, with a warning
    when more than one exists (C-22).
  - **SCF operator web and API dashboards** (thresholded and rounded through the `op_*` functions, C-17):
    ecosystem totals and per-project tables over identical definitions and
    windows; filter (verification level, SCF round/category, trust band, thresholds), sort by any metric,
    side-by-side comparison of 2–N projects, verified vs raw, trust score and API assurance indicators, high/low
    usage and inactivity flags, CSV/JSON export; ecosystem percentiles only when at least 20 tenants are active
    (C-44).
  - **Enrollment and verification**: sign-up, site and service registration, domain and Stellar verification steps,
    SCF-operator moderation (approve, suspend, remove, restore before purge — C-08) and the enrollment-mode switch;
    privileged actions require a fresh passkey assertion (C-09).
  - **Keys**: tenant ingest tokens (create, rotate, revoke); SCF-operator metrics API keys (scopes,
    expiry, last use); tenant read-only share keys (`pub`) and the public-stats switch for the `metrics_endpoint` (C-14).
  - **Audit**: tenant's own audit trail; SCF-operator audit log of reads and privileged actions.
  - **Erasure**: request by site, time range, path pattern, event name or property key, with count preview and
    completion status (ADR-0030); confirming needs a fresh sign-in at most 10 minutes old (C-87); the report states
    that erased data leaves all backups within 56 days (C-29 as corrected by C-112). Transferring ownership, removing the tenant and
    deleting an account need the same fresh sign-in (C-87).
  - **Onboarding wizard**: generates the SRI-pinned snippet or npm instructions per framework, and OpenTelemetry
    configuration per language and platform, with a "data received" check.

## Consequences
Positive: no portal server to patch for framework RCEs; the portal survives a database failover as long as the API
answers in read-only mode; a successor service operator deploys files, not a runtime; the CSP is enforceable because we
control every script.

Negative: we build our own dashboard components and accessibility instead of reusing Umami's; all business rules and
isolation sit in the control plane (tested by the isolation matrix, ADR-0013/0026); the portal is unusable without
JavaScript; React and Vite still bring a sizeable dependency tree into the build (ADR-0023 controls apply)
; ranges older than the
event-level window offer only the totals and top-N breakdowns the daily aggregates hold, so some filters are
unavailable there (C-54).

Revisit if: a server-only requirement appears (e.g. public, crawlable tenant stats pages for share.signed-usage-report — those could be
static exports instead); Trusted Types prove incompatible with a chosen library; uPlot stops being maintained.

Unproven: React, TanStack and uPlot under `require-trusted-types-for 'script'`; dashboard latency when the API reads
Umami with a verdict `tag` filter at ~1 M events/day (S-11); a seamless view across the boundary between the live
window and the aggregate path; the read-only fallback path end to end (ADR-0026).

## Deviation as built (C-117)
- **Charts:** the time series are drawn by a small hand-made SVG component (`apps/portal/src/components/LineChart.tsx`)
  instead of uPlot. Reasons: the dashboard needs one line chart (page views/visitors over time); SVG elements created
  through React need no Trusted Types policy and no `style-src 'unsafe-inline'` under the CSP of
  `docs/security/hardening.md` §10, which removes the "uPlot under Trusted Types" unknown above; one dependency fewer
  to review. Every chart keeps its accessible table alternative. Revisit when the dashboard needs interactive zoom,
  many series or very long series (then uPlot, tested under the production CSP).
