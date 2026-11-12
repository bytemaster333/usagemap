# ADR-0003: Integration strategy — wrap an unmodified private engine

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** engine.umami-base, isolation.tenant-rls, repo.single-monorepo, bot.engine-bot-detection, dashboard.web-tenant, isolation.web-dashboard, security.patch-24h, test.automated-suite

## Context
ADR-0002 chose Umami v3.5.0. UsageMap needs strict tenant isolation (each tenant sees only its own data), an
SCF operator global view, revocable API keys issued for SCF operators, and critical/high vulnerabilities patched
within 24 h. Capability engine.umami-base requires the base engine to stay in the request path, not merely be cited. Research
(code reading at v3.5.0, nothing executed) shows what Umami does and does not give us:

- **Public attack surface.** Unauthenticated routes include `POST /api/send`, `/api/batch` (replays up to 500 items
  with all original headers), `/api/record`, `/api/share/[slug]`, `/q/*`, `/p/*`, `POST /api/auth/login` (no
  brute-force protection), plus `/mcp` when enabled. CORS is
  `Access-Control-Allow-Origin: *` on all `/api/*`.
- **Under a layout where only the collect path is reachable through our gateway, every Umami-core advisory of
  2024–2026 would have been unexploitable from the internet**.
- **Controls that are not controls.** `DISABLE_LOGIN` and `DISABLE_UI` only blank pages; the API keeps working. The
  seeded `admin`/`umami` account works against the API until the password is changed — v3.5.0 enforces the change only
  in the UI (`App.tsx`).
- **Authorisation model.** Global roles `admin`, `user`, `view-only`; team roles owner, manager, member, view-only.
  Read access to a team website is plain team membership at any role. There is no read-only global role, no
  cross-website aggregate (`/api/websites/charts` takes at most 20 ids), and API keys (since v3.4.0) are unscoped,
  non-expiring and act with the owning user's full role; they can only be created by that user with a session
  (`/api/me/api-keys`) and are refused on `/api/users` and `/api/admin`. `team-member` can create
  and delete websites and publish shares; `POST /api/teams/join` admits anyone holding a team access code as member.
- **A known bug at v3.5.0**: `canCreateTeamWebsite` calls async `hasPermission` without `await`
  (`src/permissions/team.ts:115`), so a global view-only user with a team role that includes `website:create` can
  create team websites; the upstream unit test masks it with a synchronous mock.
- **Upstream image.** The official image is built with no signature, attestation or SBOM; actions pinned by tag; the
  runner stage runs an unlocked `pnpm add`; `scripts/build-geo.js` downloads GeoLite2 from an unpinned third-party
  branch; `update-tracker.js` rewrites `public/script.js` at every container start; `prisma migrate deploy` runs at
  start unless `SKIP_DB_MIGRATION`.
- **Phoning home** is on by default: dashboard telemetry pixel, update check, DuckDuckGo favicon fetches; disabled by
  `DISABLE_TELEMETRY`, `DISABLE_UPDATES`, `PRIVATE_MODE` per docs (the favicon part is not traced in code).
- **API stability.** Breaking moves inside 3.x: reports behind `/compat` (v3.4), `shareId` moved (v3.1), `/api/config`
  removed (v3.5); `GET /api/websites/:id/stats` kept its contract v3.0–v3.5. Treat the API as unstable between
  minors.

## Options considered
1. **Fork Umami** and add RLS, scoped keys, an SCF operator role, gateway checks. Pros: one codebase, no adapter. Cons:
   ~190 handlers and every raw-SQL query to change; 100+ upstream commits a month; every security release becomes a
   merge; we would own a Next.js application with a serious advisory history.
2. **Run Umami as shipped, internet-facing, tenants use its UI.** Pros: least work; tenants get funnels and reports.
   Cons: every advisory above applies directly; team roles are too strong; no SCF operator view; no domain check or rate
   limit on ingest; GHSA-3xx8 shows what a public deployment exposes.
3. **Wrap behind our own services, read its database directly** for dashboards and the SCF operator view. Pros: fast at
   hundreds of tenants (the preference of one research strand). Cons: couples us to a schema that changes about every two months;
   re-implements Umami's metric definitions in our SQL; isolation inside Umami's tables rests only on our queries.
4. **Wrap behind our own services, read through Umami's stats API with per-tenant identities** (chosen). Pros: metric
   definitions stay Umami's; isolation is enforced twice (our tenant mapping, then Umami's own team check). Cons:
   N calls per SCF operator aggregate; tag-filtered query cost unmeasured (S-11); a provisioning job must keep Umami's
   users, teams and keys in step with ours.

## Decision
- **Umami runs unmodified and is never reachable from the internet.** We build the image ourselves from the pinned
  commit (fetched by SHA, checksum-verified) with `SKIP_BUILD_GEO=1`. `vendor/umami/patches/` is an **empty patch
  queue** kept so a fix can ship within 24 h when upstream has none.
- **Internal access — the engine proxy (C-74, C-60):** Umami listens only behind the **engine proxy**, a small Go
  service on each core node (`/services/engine-proxy`). It terminates the per-node mutual TLS (private CA managed in
  the IaC), applies a path allow-list per caller, and holds Umami's cache token per (site, surrogate) in memory for
  30 minutes, adding `x-umami-cache` to that visitor's next event so a visit lasts until 30 minutes of inactivity.
  The token is never sent to the browser and never written to disk.
- **Write side:** only the gateway's forwarder calls `POST /api/send` (ADR-0005), through the engine proxy; edge
  forwarders pick the core by a consistent hash of the surrogate and fall back to the other core on failure, so a
  visit may split once at a failover (C-74). Edge certificates may reach `POST /api/send` and the control plane's
  internal edge endpoints (snapshot pull, counter upload) and nothing else (C-60). When Umami silently drops an event
  as a bot (it still answers 200), the forwarder treats it as delivered and counts it as `engine_bot_drop` (C-69).
- **Read side:** the control plane calls Umami's stats API through one adapter package (`packages/umami-adapter`);
  the proxy lets the control plane and jobs reach only the endpoints and parameters listed in the adapter contract.
  The adapter authenticates as a **per-tenant view-only Umami user**: one Umami team, one view-only user and one API
  key per tenant, provisioned by the control plane with an admin identity used for provisioning only (the only identity the
  proxy lets reach Umami's admin endpoints). The per-tenant Umami API key **and that user's random password** are
  stored in `scf`, encrypted with a key held outside the database (C-40, C-85): creating an API key in Umami needs the
  user's own login, so the provisioning worker uses the password only to rotate the key. A mapping bug in our code
  therefore still cannot make Umami return a website outside the calling tenant's team.
- **Websites per site (C-73):** each site has one main Umami website for events with a visitor identifier and, created
  on demand, a **twin website** for events without one (`visitor_id = off` or `off_in`); the twin contributes page
  views, country and device counts only. Tags are `v` (verified) and `s` (suspect); rejected events never reach Umami.
- **Reporting (C-73):** page views and unique visitors are read twice — verified (tag `v`) and raw (all; page views
  also include the twin). Visits, bounce rate and session duration are read once, over all identified, non-rejected
  events in a single query, never by adding filtered results; the dashboard shows them next to the share of page
  views that are suspect.
- **Live window:** event-level web data stays in Umami for **90 days** by default (settable 30–395 days by an
  `operator_admin`; 395 days is the hard maximum; C-54). Tenant dashboards are live and filterable through the adapter for
  that window; older ranges are served from our daily aggregates in `scf` (ADR-0011).
- **Direct SQL** against the `umami` database is limited to two jobs — **retention and erasure** (tenant and site
  purge use the erasure machinery, ADR-0030) — through the narrow role `scf_umami_maint` (DELETE on the event,
  session and their data tables only). Jobs that act for a tenant resolve its websites under that tenant's context
  (C-87). The engine's own role `umami_app` owns its schema; no other role of ours connects to that database (C-12;
  ADR-0011, ADR-0030), except the read-only fallback view of C-82 if it is ever activated. Contract tests cover the
  retention and erasure SQL as well as the adapter's API calls (C-69).
- **Fallbacks if S-01 fails (C-82):** if Umami's stats API cannot filter by `tag`, verified and raw page views and
  visitors are computed hourly by our rollup job from Umami's event table through a read-only, contract-tested SQL
  view, and live dashboards show Umami's unfiltered figures plus our verified counts. If cache-token replay does not
  work, live views follow Umami's clock-hour visit rule and our daily aggregates compute visits, bounce rate and
  duration by 30-minute-gap sessionisation over the event table. Either fallback is recorded as a design trade-off with its
  effect on the numbers.
- **Hardening:** `DISABLE_TELEMETRY`, `DISABLE_UPDATES`, `PRIVATE_MODE`, `SALT_ROTATION=day`, `TZ=UTC`,
  `CLIENT_IP_HEADER=x-scf-surrogate-ip`, `SKIP_DB_MIGRATION=1` — Umami's migrations run as an explicit one-shot deploy
  step, never at container start (C-40); default admin password replaced at bootstrap; no internet egress from the
  engine network (C-10); MCP off; shares never created.
- **Upgrades:** contract tests run the adapter against the real pinned container on every change and nightly against
  upstream's newest tag. An upgrade is adopted only when they pass.

## Consequences
Positive:
- The internet-facing surface of Umami is zero; its own authorisation bugs become defence-in-depth issues, not
  breaches. This is what makes a 24-hour patch commitment credible for the engine.
- Tenants, roles, keys, audit and the SCF operator view live in our control plane (ADR-0013 to ADR-0016), where RLS and
  our isolation matrix apply.
- The rebuilt image removes the unpinned GeoLite2 download and the unlocked install step from our supply chain;
  migrations become a reviewed, explicit step rather than a side effect of a container restart.
- Even inside the private network a compromised edge node can only submit events and use the internal edge
  endpoints: the engine proxy's per-caller allow-list keeps it away from the stats, admin and share routes (C-60).
- Visit continuity no longer depends on which edge node handled an event: the cache-token memory sits on the core
  that the surrogate hashes to (C-74).

Negative / limits stated honestly:
- The "mapping bug cannot cross tenants" property protects against a wrong website id or a wrong query; it does
  **not** protect against our code selecting the wrong tenant's credential altogether. The isolation matrix
  (ADR-0013) must cover that case.
- Provisioning has sharp edges: creating users needs an admin *session* (API keys are refused on `/api/users`); a
  tenant's API key can only be minted by logging in as that tenant's user, which is why its password is kept
  encrypted (C-85) — a leak of the database plus the outside key exposes view-only access to that tenant's websites; the view-only user must hold the
  `team-view-only` role (a team role with `website:create` would expose the missing-`await` bug); the seeded admin must
  be neutralised before the container is reachable even internally, with a check that `admin`/`umami` no longer logs in.
- Umami API keys never expire; rotation is our job (provisioning worker, C-85).
- The engine proxy is one more service of ours on the core nodes, on the write path of every web event; a core
  restart or failover splits the visits in flight once (C-74).
- Each site with identifiers switched off for some or all visitors has two Umami websites to provision and erase.
- The SCF operator global view and daily rollups fan out over per-tenant calls; performance over the 90-day live
  window is unproven (S-11). If S-11 fails, the window served live by Umami is shortened and more is served from our
  daily aggregates — the second read path exists anyway (C-54).
- Two read paths mean two places where a metric is defined: live ranges use Umami's definitions, older ranges our
  daily aggregates of them.
- Our rebuilt image is ours to keep patched (Node base image, Prisma, Next.js), including during the service year.

Must now do / watch: S-01 (surrogate IP, `cf-ipcountry`, `tag` filter end to end, cache-token replay through the
engine proxy and the effect of spool delay on visits; fallbacks per C-82), S-02 (read-only root filesystem,
startup migrations, `PRIVATE_MODE` external calls), S-11 (stats latency with `tag` filter at ~1M events/day over
the 90-day window); watch GHSA for `umami-software/umami`, `vercel/next.js`, `react-server-dom-*`, and Umami's `dev` branch for unannounced
security fixes.

Revisit if: S-11 shows API fan-out cannot meet dashboard latency; upstream adds scoped keys, a read-only global role
or a cross-website aggregate; a needed fix forces a non-empty patch queue for more than one release.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Umami authorisation, API and multitenancy: route surface, roles, API keys, the `canCreateTeamWebsite` bug, API stability across 3.x.
- Umami security advisories: advisories, exposure if only collect is public.
- Umami ingest datamodel tracker: start-up behaviour, env vars, migrations.
- Supply chain security: upstream image findings; compensating controls.
- Base project scorecard: fork vs patch queue vs wrap.
- Research synthesis: API reads vs direct DB reads.

## Open points
None outstanding. (Credential custody for key rotation is settled by C-85; the contract-test scope for the SQL jobs by
C-69.) Still to be proven, not decided: S-01 and S-11, with the C-82 fallbacks if S-01 fails.
