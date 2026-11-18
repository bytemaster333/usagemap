# Tenant onboarding guide

From sign-in to the first verified page view and to the first API request on your dashboard.

- **Status:** checked against the code (operations, portal pages and settings named below exist). Where a step is available through the API but not yet as a portal screen, it says
  so. The web path is exercised end to end by `tests/e2e/web/10-web.e2e.test.ts`, the API path by
  `tests/e2e/api/30-api.e2e.test.ts` (sample services with unmodified SDK recipes), the portal wizard by
  `apps/portal/e2e/mock/wizard.spec.ts`. Host names (`portal.example.invalid`,
  `ingest-a.example-analytics.org`, `ingest-b.example-analytics.net`, `ingest.scf.example`) and the npm scope
  `@scf-analytics` are placeholders; replace them with your deployment's names.
- **Per-stack recipes:** [`quickstarts/`](quickstarts/README.md).
- **Tenant documentation (first 10 minutes per stack, wallet adapters, dev origins and debug mode, footprint,
  troubleshooting decision tree):** [`../onboarding/`](../onboarding/README.md). Public methodology:
  [`../methodology/scf-methodology-1.0.0.md`](../methodology/scf-methodology-1.0.0.md).
- **How the numbers are computed:** [`../metrics/definitions.md`](../metrics/definitions.md).

**Cost: none.** The service charges no fees to tenants, operators or anyone else (cost.zero-fees): there are no paid
tiers, no billing and nothing you must buy from a third party to use it.

## 0. Before you start: two privacy decisions

1. **Tracker profile.** `standard` sends the page path plus the referrer host, a screen-width class, the primary
   language and a few client signals; `strict` sends the page path only (`tracker/README.md`). Pick by the
   jurisdictions of your visitors: `docs/privacy/jurisdictions.md` is authoritative (C-41). In short, for the
   `standard` profile Germany and Belgium are "not without opt-in"; for `strict` Germany is "contested". The whole
   privacy pack is marked "needs counsel review".
2. **Consent.** Where opt-in is required, use consent-gated mode (`data-consent="required"` or
   `init({ consent: "required" })`): nothing is sent until your consent tool calls `grantConsent()` (C-55). See
   [`quickstarts/web-consent-mode.md`](quickstarts/web-consent-mode.md).

You are the controller for your site's analytics; the service operator is your processor (ADR-0027). The notice text
you can adapt is in `docs/privacy/tenant-privacy-notice.md`; the DPA template in `docs/privacy/dpa-template.md`.

## 1. Sign in

| Method | Status | Notes |
|---|---|---|
| GitHub | built; **not configured on the live host** (no OAuth App registered there: it answers "GitHub sign-in is not configured") | OAuth App with the `read:user` scope only (C-20) |
| Stellar wallet, SEP-53 message signing | built | the deployment fixes the network (`SCF_STELLAR_NETWORK`, default `public`, C-114); not yet tried with a real Freighter extension |
| Stellar SEP-10 challenge (hardware wallets, multisig) | built in the API | `authStellarChallenge` / `authStellarVerify` with a SEP-10 transaction; signatures must reach the account's medium threshold (`services/control-plane/src/auth/sep10.ts`); the portal's sign-in page offers SEP-53 only so far |
| Passkey (WebAuthn) | built | optional second factor for tenants; mandatory for SCF operators (C-09) |

There are no passwords and no e-mail sign-in (ADR-0014). Sessions: 12 h idle, 14 days absolute (C-20).

## 2. Create your tenant

Portal: **Tenants → create** (operation `createTenant`, `POST /v1/tenants`).

- If the platform runs in `open` enrollment mode (the default), the tenant is `active` at verification level **L0**
  at once. In `approval_required` mode it is `pending`: you can configure sites and verify domains, but events are
  refused and counted as `tenant_pending` until an SCF operator approves (C-08).
- **L0 limits** (platform settings, C-19): 2 sites, 1 API service, 50,000 verified web events per day shared by your
  sites, 100 API routes per day, 600 web requests per minute per site. L0 tenants are excluded from SCF-operator
  rankings by default.
- Invite colleagues through the API (`createInvitation`, `acceptInvitation`, `listInvitations`, `revokeInvitation`;
  the portal has no invitation screens yet). Roles: `owner`, `admin`, `member`, `viewer`.

Higher verification levels (ADR-0015): **L1** a verified domain (step 4); **L2** Stellar-linked — an account signature
whose `home_domain` is one of your verified domains and whose `stellar.toml` lists the account (C-19) — built in the
API (`verificationStellarChallenge`, `verificationStellarVerify`; `services/control-plane/src/verify/ladder.ts`), no
portal screen yet; **L3** registry-matched — candidates from the SCF project registry (`listRegistryCandidates`),
confirmed by an SCF operator (`operatorDecideRegistryLink`); **L4** approved by an SCF operator
(`operatorApproveTenantLevel`). Your current level is shown on the tenant page.

## 3. Create a site

Portal: **tenant page → add site** with a name, the tracker profile and the visitor-identifier setting
(`createSite`). Other settings are changed through the API (`updateSite`) until the portal exposes them:

| Setting | Values | Default | Effect |
|---|---|---|---|
| `tracker_profile` | `standard`, `strict` | `standard` | which fields the gateway accepts; extra fields from the wrong build are stripped and counted (`drop/profile_field_stripped`) |
| `visitor_id` | `on`, `off`, `off_in` (+ `visitor_id_off_countries`) | `on`; **`off` for `strict`** unless set explicitly (C-53) | without an identifier events count toward page views, country and device only — no visitors, visits, bounce rate or duration (C-73) |
| `exclude_countries` | ISO country codes | none | events from these countries are dropped at the gateway and only counted (C-58) |
| `path_folding` | `full`, `relaxed` | `full` | `relaxed` keeps numbers, dates and slugs in page paths; StrKeys, hashes, tokens and e-mail addresses are always folded or redacted (C-89) |
| `event_retention_days` | 30 … platform maximum | platform default (90) | event-level retention in the engine; daily aggregates are kept indefinitely (C-54) |
| `opt_out_page_url` | URL | none | the page where your visitors can opt out (they call the tracker's `optOut()`) |
| `anonymous_reports` | on/off (portal: site settings) | on | breakdown rows below 10 merged into "Other", counts rounded to 10 (C-51) |

The **site key** shown on the site page is public — it is in your page source — and is not a secret (ADR-0016).

## 4. Declare and verify your domains

Portal: **site → Settings → Add a domain** (optionally "Include subdomains"), then **Start verification** with one of
three methods (`services/control-plane/src/verify/`):

| Method | What to publish |
|---|---|
| DNS TXT | a TXT record at `_scf-verify.<host>` with the value `scf-verify=<token>` |
| File | `https://<host>/.well-known/scf-verify.txt` answering `200` with the token as its body |
| Meta tag | `<meta name="scf-site-verification" content="<token>">` in the `<head>` of `https://<host>/` |

Then press **Check**. The verifier fetches over the public internet only (no private addresses, no redirects).

Why it matters (`services/gateway/internal/ingest/server.go`): events from a page whose origin is **not declared** are
`rejected` (`origin_mismatch`); from a declared but **unverified** domain they are `suspect` (`domain_unverified`);
only verified domains can produce `verified` events.

## 5. Install the tracker

Portal: **site → Snippet**. Pick a format and a tracker version; the snippet carries your site key, the file URL for
your site's profile and its SRI hash (`getSnippet`). Formats: HTML script tag, HTML with consent mode, npm package,
Next.js, Vite, Astro, Angular.

| Your stack | Recipe |
|---|---|
| Any HTML page | [`web-script-tag.md`](quickstarts/web-script-tag.md) |
| Bundled app (npm) | [`web-npm.md`](quickstarts/web-npm.md) |
| Next.js | [`web-nextjs.md`](quickstarts/web-nextjs.md) |
| Vite + React SPA | [`web-vite-react.md`](quickstarts/web-vite-react.md) |
| Vue | [`web-vue.md`](quickstarts/web-vue.md) |
| Nuxt, SvelteKit, Astro, React Router / Remix | [`docs/onboarding`](../onboarding/README.md) (each with a tested example app) |
| Static site generators (Eleventy, Hugo, Jekyll, Docusaurus) | [`web-static-site-generators.md`](../onboarding/web-static-site-generators.md) |
| WordPress, Webflow, Framer, Ghost | [`web-cms.md`](../onboarding/web-cms.md) |
| Opt-in jurisdictions | [`web-consent-mode.md`](quickstarts/web-consent-mode.md) |
| Strict profile | [`web-strict-profile.md`](quickstarts/web-strict-profile.md) |

Every released tracker version stays served at its immutable URL; there is no `latest` alias. Upgrading means changing
the version **and** the integrity hash (ADR-0004). A version withdrawn for a security defect answers `410 Gone`: pages
that pin it stop sending analytics and keep working (C-37).

Content Security Policy: allow `connect-src` to both ingest hosts, and for the script tag `script-src` the first host
(or use a nonce). No `worker-src`, `blob:` or `'unsafe-eval'` is needed (`tracker/README.md`).

## 6. Check the installation

Portal: **site → Installation** (`getInstallationCheck`). It shows, per UTC day for the last 24 h / 7 d / 30 d, how many
events were `verified`, `suspect` and `rejected`, the reason codes, and the drop labels (for example `gpc_dnt`,
`country_excluded`, `path_redacted`, `profile_field_stripped`, `rate_limited`, `quota_exceeded`). The gateway uploads
these counters about once a minute (`GW_COUNTER_PERIOD`). The **Tracker version** panel compares the version your pages
load with the latest release and says "Update available" when a newer one exists; your pages keep working with the old
version until you change the snippet (tracker.intentional-upgrade). Until the gateway reports the version it sees (open item, C-129), the
panel shows "not reported" and only the latest release.

| You see | Likely cause | Fix |
|---|---|---|
| nothing at all | GPC/DNT on in your test browser, or consent mode without `grantConsent()`, or an ad-blocker | test in a clean profile; call `grantConsent()` |
| `rejected` / `origin_mismatch` | the page's domain is not declared | add the domain (step 4) |
| `suspect` / `domain_unverified` | domain declared, not verified | finish verification |
| `suspect` / `proof_missing` | the page was hidden or closed before the proof-of-work finished | normal for very short visits; see the metric definitions §2.9 |
| `rejected` / `tenant_pending` | the platform requires approval | wait for an SCF operator |
| `drop` / `profile_field_stripped` | the page loads the `standard` build but the site is `strict` (or the reverse) | use the snippet the portal generates |

## 7. Read your dashboard

Portal: **site → Dashboard**: page views (verified and raw), unique visitors (verified and raw), visits, bounce rate,
average visit duration with the suspect share next to them, time series and breakdowns by referrer, country, device,
browser, OS, path and event. Read [`../metrics/definitions.md`](../metrics/definitions.md) before quoting a number — in
particular: multi-day unique visitors are sums of daily uniques (C-110), and custom ranges older than the site's live
window must be whole UTC days (DV-38). A daily CSV export is available (`exportWebDaily`).

## 8. API analytics (OpenTelemetry)

Built end to end: ingest tokens (portal **project → Ingest tokens**, `createIngestToken`; creating and revoking needs a
recent sign-in, C-119), the per-stack configuration (portal **API service → OpenTelemetry set-up**, `getOtelConfig`), the gateway's
OTLP front door, the Collector's sanitise step, the metrics writer and the API dashboard (portal **API service →
Dashboard**). The recipes in [`quickstarts/`](quickstarts/README.md) were measured in spikes S-06a and S-06b and run
unchanged against the real front door in `tests/e2e/api/30-api.e2e.test.ts` (Node/Express, Python/FastAPI,
Go/net/http, Rust/axum).

What you need:

1. An **ingest token** (`scfa_ing_<id>_<secret><crc>`, shown once, up to 5 active per tenant so you can rotate with
   overlap; optionally restricted to named services) (ADR-0016, C-21).
2. Your services report **HTTP server duration metrics** (preferred) or, for frameworks that only produce spans
   (Next.js), **root SERVER spans** — and nothing else — to `https://<otlp-host>/v1/metrics` or `/v1/traces` with
   `Authorization: Bearer <token>`. Logs are refused (`404`) (wire-formats §f).
3. **Dual export:** keep your own APM. Every recipe sends to your APM as before and adds a second, filtered export to
   the platform.
4. Services are registered automatically on first sight, up to your quota (default 20; L0: 1) (C-21).
5. API figures are labelled **self-attested telemetry** (ADR-0028): the platform cannot prove your servers' numbers
   are genuine.

## 9. Share your figures with SCF programmes

Portal: **project → Sharing** and **project → Traction snapshots** (share.signed-usage-report, ADR-0032).

- **Public statistics** (off by default): when on, anyone can read your project's metrics document
  (`/public/v1/projects/<slug>/metrics.json`, rebuilt hourly, last 30 complete UTC days, API figures labelled
  self-attested) and its page `/p/<slug>` in the portal. It never contains your trust score, routes, referrers or
  anything about individual visitors.
- **Share keys** (`scfa_pub_…`, shown once): give read access to the same document while it is private — for a
  grant programme or anyone you choose. Readers send it as `Authorization: Bearer <key>` or paste it into `/p/<slug>`; never in a
  URL. Creating and revoking needs a recent sign-in (C-129); revocation takes effect at once.
- **Traction snapshots**: a signed statement of your figures over a period, for an application. Anyone can check one
  at `/verify/<snapshot id>` in the portal, or by hand with the published keys (`/.well-known/scf-snapshot-keys.json`,
  wire-formats §i.3).

Which URL goes into SCF's own `analytics` field and into a Public Goods `metrics_endpoint`:
[paste this URL into SCF](../onboarding/share-with-scf.md).

## 10. Leaving

- Remove your tenant: `POST /v1/tenants/{tenantId}/removal` (`removeOwnTenant`; no portal button yet); this needs a fresh sign-in (≤ 10 minutes, C-87). Ingest
  stops, data is hidden, and it is purged after 30 days unless an SCF operator with the `operator_admin` role restores it first; a restored tenant
  returns as `suspended` until it is reinstated (C-08, C-94).
- Erasure of specific paths, event names or properties (ADR-0030): portal **project → Data erasure** (`createErasureRequest`;
  preview, confirmation with a fresh sign-in, completion report; [`../privacy/erasure.md`](../privacy/erasure.md)).
  The same selectors are re-applied after 72 hours for events still on the spool; erased data leaves backups within
  56 days (C-112(2)).

## Sources checked

`apps/portal/src/pages/{SignIn,Tenants,TenantHome,SiteSettings,Snippet,Installation,SiteDashboard}.tsx`,
`apps/portal/src/lib/search.ts`; `services/control-plane/src/{lifecycle/handlers.ts,domain/sites.ts,verify/handlers.ts,
verify/verifier.ts,auth/stellar.ts,tracker.ts}`; built/501 status of every operation from
`services/control-plane/src/app.ts` + handler maps; `services/gateway/internal/ingest/server.go`,
`services/gateway/README.md`; `db/migrations/0006_settings.sql` (L0 defaults); `tracker/README.md`; register C-08,
C-09, C-19, C-20, C-21, C-37, C-41, C-51, C-53–C-55, C-58, C-73, C-87, C-89, C-110, C-112, C-114; design trade-off DV-38 (`docs/capabilities.md`).
