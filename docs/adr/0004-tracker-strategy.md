# ADR-0004: Tracker — our own, pinned

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** web.frontend-only-privacy-first, web.frontend-origin-only, tracker.static-html, tracker.spa, tracker.ssr-frameworks, tracker.version-pinned, tracker.no-remote-updates, tracker.intentional-upgrade, security.supply-chain, web.adblock-safe-script-name, privacy.gdpr-no-consent, feature.custom-events,
  slo.ingest-availability

## Context
UsageMap's design goals for the browser tracker: the script or snippet that tenants include is pinned to a specific
version; there are no dynamic remote updates of the tracking code; tenants upgrade intentionally; and the tracker
defends robustly against supply-chain attacks. Integration must be low-friction for a wide variety of sites (static
HTML, SPAs, SSR frameworks); script and endpoints are named so they do not trigger popular ad blockers; the solution
is GDPR-compliant without requiring client-side opt-ins. Custom events are a secondary goal.

What research established:
- **Umami's tracker cannot be used as shipped.** It is `public/script.js`, 9,297 bytes minified / 4,161 bytes gzip at
  v3.5.0, served at an unversioned URL with `Cache-Control: public, max-age=86400, must-revalidate`, no published SRI,
  rewritten by `update-tracker.js` at every container start, and redirectable to a remote URL by
  `TRACKER_SCRIPT_URL` or `CLOUD_MODE`. It also bundles
  error collection and web-vitals code. Its SPA hook patches `pushState`/`replaceState` but has no `popstate`
  listener. Its wire protocol (`{type, payload}` to `/api/send`) is simple and has stayed backward compatible v2–v3.5.
- **What SRI guarantees:** on mismatch the browser refuses to execute;
  cross-origin SRI needs `crossorigin="anonymous"` and CORS; `<script type="module" integrity>` covers only the entry
  module and dynamic `import()` has no integrity parameter — hence a single classic script with no imports.
  Signature-based SRI (`ed25519-…`, Chrome 141 only) would allow "any version signed by key K", i.e. exactly the
  dynamic-update channel the design rules out, so it is not used.
- **Immutable URLs, no aliases**: a floating alias plus SRI breaks every tenant on update; a floating alias
  without SRI is the polyfill.io / Ledger Connect Kit failure mode. With SRI, a hostile future domain owner can at
  worst make the script fail to load — relevant because the domain can be handed over to a new operator.
- **Delivery modes ranked**: bundling from npm (strongest: no third-party script at runtime), self-hosting the
  file, our host plus SRI. **Least-power contract**: no `eval`/`Function`, no dynamic import, no remote config,
  no cookies or web storage, no fingerprinting APIs, no access to `window.freighter*`/wallet globals, zero runtime
  dependencies, enforced by the tracker's tests.
- **Privacy constraints.** EDPB Guidelines 2/2023 v2.0 (7 Oct 2024) paras 33, 44, 51–53: a script instructing the
  browser to send information, including JS-read values (screen, language, title), is "gaining access" under ePrivacy
  Art. 5(3); cookieless alone does not avoid it. The CNIL self-assessment criteria (July 2025) require referrer host
  only, header-derived data minimised (major version), no UTM/campaign identifiers, at most three event types; the
  AEPD and Garante have comparable lists. Germany's DSK
  (OH Digitale Dienste v1.2, Rn. 24, 87–90) treats active JS reads as access and refuses a general exemption, so a
  near-counter "strict" configuration is the most defensible there.
- **Availability.** `fetch(keepalive)` and `sendBeacon` have no request-level retry; a black-holed address can stall a
  connection 21–127 s; therefore an own ~3 s timeout and rotation across a hard-coded endpoint list inside the pinned
  script, which is static configuration, not a remote update.
- **Tenant stacks.** Of 40 SCF-awarded project sites (a sample of the Stellar ecosystem): Next.js 43 %, Vite SPA 20 %, Cloudflare-fronted 48 %, Vercel 23 %; only
  2 send a CSP that restricts scripts; no site uses Umami.

## Options considered
1. **Umami's `script.js`, pinned by us** (copy each release to a versioned URL). Pros: zero tracker code to write.
   Cons: 4.2 kB gzip carrying error and vitals code we do not want; reads `localStorage`; no `popstate`; reads more
   than the CNIL criteria allow; we would still have to change it, so it is our tracker in all but name.
2. **GoatCounter `count.vN.js` (ISC) adapted to Umami's protocol.** Pros: proven frozen-file model. Cons: a different
   wire protocol and feature set; nearly a rewrite.
3. **Our own tracker, served from a URL that tracks the latest release** (`/lib/latest.js`) for convenience.
   Pros: tenants never edit snippets. Cons: violates "pinned" and "tenants must intentionally upgrade" by design.
4. **Our own tracker, immutable versioned URLs + SRI + npm package, two privacy profiles** (chosen). Pros: meets the
   pinning goal literally; small enough to review; the profile split gives an honest answer per jurisdiction. Cons: we own a
   browser library for the life of the service, including every old version we ever served.

## Decision
- A **single classic script** with **zero runtime dependencies**, no `eval`, no dynamic import, no remote
  configuration, no cookies, no web storage (one exception: the opt-out flag), and no access to wallet objects.
- **Two pinned profiles per version:** `standard`, built to the French/Spanish/Italian audience-measurement criteria
  (referrer host only, screen-width class, primary language subtag), and `strict` (nothing read through JS APIs
  beyond the page path; no referrer).
  - `strict` reads nothing for analytics beyond the page path. It **does** fetch and solve the challenge and
    proof-of-work (computation, not a read of device information), so `strict` traffic can be `verified`. It does
    **not** read the client signal booleans (`webdriver`, visibility, user activation); those belong to `standard`
    only, and their absence is never a reason for `suspect` (register C-33, ADR-0008).
  - The profile is independent of the per-site `visitor_id` setting (C-02), but a site on `strict` has
    `visitor_id = off` unless the tenant deliberately turns it on (C-53).
  - Stellar Wallets Kit Tier 0 (DOM signals) runs only in `standard`; in `strict` wallet events are sent only if the
    tenant explicitly attaches the adapter (C-13, ADR-0029).
  - The gateway enforces the site's configured profile by discarding fields that profile does not allow (C-37), so a
    site configured `strict` that embeds `standard` still stores only `strict` data.
- **Delivery:** immutable URLs `/lib/<semver>/<profile>.js` with `Cache-Control: immutable` and an SRI hash. **No
  `latest` alias exists**; unknown versions return 404. Also an npm package (`@SCOPE/tracker`, ESM) for bundling into
  the tenant's app, which removes the third-party script entirely.
- **Upgrades:** tenants change version + hash (or bump the dependency). Every released version stays served for the
  life of the service; the wire protocol is versioned (`v1`) and backward compatible. Wire format: `docs/contracts/`.
- **Withdrawal:** a released version is withdrawn only for a security defect. Its URL then returns `410 Gone` (pages
  that pin it stop sending analytics and are otherwise unaffected) and an advisory is published (C-37, C-39).
- **Behaviour:** pageviews (History API aware, hydration-safe), custom events `track(name, props)` with a client-side
  guard that refuses values shaped like e-mails, StrKeys or JWTs (the gateway applies the same guard server-side,
  C-52); `optOut()` / `optIn()`; GPC and DNT honoured (no events sent). Apart from the page view, the tracker fires
  **no automatic event on page load**: Umami does not count a visit that contains a custom event as a bounce, so an
  automatic event would erase bounces (C-75, ADR-0029). **Page titles are not collected** (C-89).
- **Path only:** the tracker sends the page path only — never a query string or fragment, which the gateway also
  discards if it still receives one. There is consequently no campaign-parameter (UTM) reporting; referrers are
  reported by host (C-65).
- **Consent-gated mode:** the tracker accepts `consent: "required"`; it then sends nothing until the tenant's consent
  tool calls `grantConsent()`, and stops on `revokeConsent()` (C-55). This lets tenants use the service lawfully where
  opt-in is required.
- **Proof before the first event:** the tracker fetches the challenge and solves it before sending its first event
  (target ≤ 500 ms, S-07). If the page is hidden first, the event is sent with the token but no proof and is
  `suspect` (`proof_missing`); later events in the same page load reuse the proof up to a per-token event cap
  (C-35, ADR-0008).
- **Sending:** `fetch(keepalive)` + 3 s timeout + bounded retries across a **fixed list of two ingest hosts on two
  domains**; `fetch(keepalive)` on page hide, never `sendBeacon` (filter lists block third-party pings, C-116). Each event carries a random per-event ID held in memory only (not a visitor
  identifier); the gateway uses it to drop retries within a 10-minute window (C-37).
- **Size budget enforced by the tracker's tests:** `strict` ≤ 2.5 kB gzip, `standard` ≤ 3.5 kB gzip, both including the ~1 kB
  challenge solver (ADR-0008, C-32). The research's "≤ 2 kB" referred to the core without the solver; `strict` was
  raised from 2.0 kB because it also runs the solver (C-33).
- **Naming:** script path, ingest path and hosts are chosen to pass a check against EasyList,

  EasyPrivacy, uBlock Origin, AdGuard and Brave lists.

## Consequences
Positive:
- tracker.version-pinned/10/11 hold technically: bytes for a version cannot change without breaking SRI, and nothing in the script can
  fetch code. Combined with the reproducible build and signed manifest (ADR-0023) a tenant can verify what it embeds.
- The npm path suits the 63 % of surveyed sites on Next.js or Vite; the script tag suits static sites; the CSP step is
  needed for roughly 5 % of tenants.
- `strict` (with no visitor identifier, its default — C-53) gives German, Belgian or Nordic tenants a documented
  lower-risk configuration: risk reduced, not removed. For Germany and Belgium `docs/privacy/jurisdictions.md` is
  authoritative: `standard` is "not without opt-in" in both; `strict` is "contested" in Germany and "not assessed" in
  Belgium (C-41); where opt-in is required, the consent-gated mode applies (C-55).
- `strict` traffic can still be `verified`, because the challenge and proof run in both profiles (C-33).
- Retries do not double-count: the per-event ID lets the gateway drop duplicates (C-37).

Negative / costs:
- Every version is served for the life of the service unless withdrawn for a security defect, so the gateway carries
  a growing allow-list of files; the `v1` protocol cannot break while any version is in use. A withdrawal (`410`)
  silently stops analytics for every tenant still pinning that version until they upgrade.
- Honouring DNT/GPC and blocking by filter lists mean real visitors go uncounted; counts are a lower bound.
- `strict` produces weaker numbers (no referrer, fewer breakdowns, and — with no visitor identifier, its default —
  events go to the site's twin Umami website and yield page views, country and device counts only, no unique
  visitors, visits, bounce rate or duration, C-53/C-73) and has fewer request-consistency signals than `standard` (no client booleans).
- No UTM or campaign reporting at all (C-65).
- The proof-of-work runs before the first event; a visitor who hides the page before it completes is counted as
  `suspect` (`proof_missing`), and S-07 decides whether the ≤ 500 ms target holds on low-end phones.
- Naming that passes the lists today can be added to a list tomorrow; the scheduled check detects this but a new
  name means a new tracker version that tenants must adopt.
- Without device storage, every full page load on a multi-page site is a new page context with its own challenge
  (ADR-0008); visit continuity across page loads comes from the engine proxy's cache-token memory, not from the
  browser (C-74, ADR-0003).

Revisit if: a regulator publishes criteria our `standard` profile does not meet; the filter-list check fails for all
candidate names; S-07 shows the solver cannot fit the 2.5 kB (`strict`) or 3.5 kB (`standard`) budget or the phone
timing budget.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Umami ingest datamodel tracker: Umami tracker size, serving, protocol.
- Supply chain security: SRI, immutable URLs, delivery modes, least-power contract.
- Privacy EU UK law: Art. 5(3), CNIL criteria, DSK, profiles.
- SLA availability engineering: timeout, retry, endpoint rotation.
- Stellar project stacks: frameworks, hosting and CSP among SCF-awarded projects.
- Goatcounter deep dive: frozen `count.vN.js` precedent.

## Open points
None outstanding.
