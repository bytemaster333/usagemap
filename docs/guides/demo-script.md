# Demo script: the tenant's experience (screen capture)

**Status: draft.** A scene list for recording a tenant-perspective walkthrough of UsageMap (docs.tenant-walkthrough-video). Scenes 1–7 can be recorded on the local Compose stack once the gateway and portal are wired into
`docker compose up` (`docs/guides/self-hosting.md`); scenes marked **planned** wait for features not built yet.
Never record real visitor data, real tokens or real wallet addresses; use a test tenant and a demo site.

| # | Scene (≈ duration) | What to show | Narration points | Built? |
|---|---|---|---|---|
| 1 | Sign in (0:30) | Portal → sign in with GitHub, or with a Stellar wallet (SEP-53 message signing) | no passwords, no e-mail; GitHub scope `read:user` only | yes (wallet: not yet tried with a real Freighter extension) |
| 2 | Create tenant and site (0:45) | Tenants → create; tenant page → add site, choose profile `standard` or `strict` and the visitor-identifier setting | the site key is public; `strict` sends the path only and has no visitor identifier by default | yes |
| 3 | Verify the domain (0:45) | Site → Settings → add domain → DNS TXT / file / meta tag → Check | undeclared origins are rejected, unverified ones suspect | yes |
| 4 | Install the snippet (0:45) | Site → Snippet: HTML with SRI, consent-mode and npm variants; paste into the demo page | immutable versioned URL, SRI hash, no cookies, nothing sent with GPC/DNT or before consent | yes |
| 5 | Installation check (0:30) | Site → Installation: verified / suspect / rejected and reason codes after a few page loads | rejected events are only counted; why a hidden tab gives `proof_missing` | yes |
| 6 | Web dashboard (1:30) | Site → Dashboard: verified vs raw page views and visitors, visits, bounce rate, duration with the suspect share, time series, breakdowns, CSV export, anonymous reports on/off | multi-day uniques are sums of daily uniques; whole-UTC-day rule for long custom ranges; point to `docs/metrics/definitions.md` | yes |
| 7 | Privacy controls (0:30) | Opt-out (`optOut()`), consent mode on the demo page, the site's `exclude_countries` | the tenant is controller; notice text in `docs/privacy/tenant-privacy-notice.md` | yes |
| 8 | API onboarding (1:00) | Create an ingest token, copy the OpenTelemetry config for one stack (e.g. the tenant Collector fan-out), send traffic from a sample app | dual export keeps the tenant's APM; only HTTP server duration or root SERVER spans; self-attested telemetry | **planned** (OTLP front door, ingest tokens) |
| 9 | API dashboard (1:00) | Requests, 5xx rate, p50/p95/p99 with accuracy class, routes with `{unknown}` / `{overflow}` / `{redacted}`, data-quality counters | percentile accuracy classes; routes are normalised | **planned** |
| 10 | Erasure (0:45) | Request deletion of a path pattern → count preview → confirm (fresh sign-in) → completion report | erased data leaves backups within 56 days | **planned** |
| 11 | Leaving (0:20) | Remove tenant (fresh sign-in) | data hidden at once, purged after 30 days | API only (`removeOwnTenant`); portal button **planned** |

Recording notes: record at UTC so dates on screen match the narration; use the `24h` and `7d` presets (they are always
valid); blur nothing — use only demo data so nothing needs blurring.
