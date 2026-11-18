# integration-ecosystem — which integrations reach the most SCF projects, and a badge + feed prototype

**Result:** PASS — (1) a reproducible coverage table over the 370 SCF-funded projects of rounds #30–#45 ranks
integrations by reach per unit of effort; (2) the project card's numbers render as SVG badges, Shields.io endpoint JSON
and one bulk JSON feed keyed by DAOIP-5 id, straight from `metrics-endpoint/1` documents of the DEMO cohort, with no
network and no database.

## Question

1. How do SCF-funded projects split across wallets, DeFi/Soroban, anchors/payments, infra/dev tools, NFT/gaming and
   RWA; which Stellar surfaces do they use; and therefore which UsageMap integration reaches the most of them?
2. Can a project's public numbers flow to ecosystem consumers (README badges, PG Atlas, Stellarlight) in a form they
   can read without our servers seeing their visitors, and without leaking anything the card does not already show?

## Method (versions, commands, how to re-run)

Python 3.13 (standard library only), Node 24.22.3 (TypeScript run directly, no dependencies), TypeScript 7.0.2 for the
type check. Nothing installed; no network.

| What | Command (from the repo root) |
|---|---|
| Coverage table (needs a local SQLite copy of the SCF awards data, not in the repository) | `python3 -I spikes/integration-ecosystem/coverage/coverage.py <scf_awards.db> [--csv out.csv]` |
| Coverage tests (fixture DB, no internal data) | `python3 -I -m unittest discover -s spikes/integration-ecosystem/coverage -p 'test_*.py'` |
| Badge + feed outputs for the 20 DEMO projects | `node spikes/integration-ecosystem/badge-feed/run.ts [outDir]` (default `badge-feed/out/`, git-ignored) |
| Badge + feed tests | `node --test spikes/integration-ecosystem/badge-feed/test/*.test.ts` |
| Type check | `node_modules/.bin/tsc --noEmit -p spikes/integration-ecosystem/badge-feed/tsconfig.json` |

**Coverage rules** (`coverage/coverage.py`): awards are de-duplicated by project name (390 awards → 370 projects;
several awards = union of their signals). Category comes from the enrichment `product_type`
(`wallet` → Wallets, `defi_protocol` → DeFi, `anchor_ramp_payments` → Anchors/payments, `api_sdk_devtool` +
`infrastructure` → Infra/dev tools, `rwa_tokenization` → RWA; web dApps, mobile apps and marketplaces whose text says
NFT/game → NFT/gaming; the rest → other consumer apps). Each integration has an explicit applicability rule over
`has_web_frontend`, `has_public_api`, `stellar_surface`, the regex `signals` and the application text. Effort is our
rough estimate (S = 1, M = 2, L = 3). The output carries **aggregate counts only, never a project name** (a test checks
this), so it can be committed although the DB cannot.

**Badge + feed** (`badge-feed/`): `src/demo-metrics.ts` builds `scf-analytics/metrics-endpoint/1` documents
(wire-formats §i.1) for the DEMO cohort with the seed's own generators (`tools/demo-seed`: `buildPlan`, `siteHistory`,
`apiDayTotal`), for a fixed day (2026-11-19, 30-day window). `src/badge.ts` reuses the portal's web badge generator
(`apps/portal/src/lib/badge.ts`) unchanged and adds an API badge and Shields endpoint JSON. `src/feed.ts` builds the
bulk feed `usagemap/ecosystem-feed/0`. Demo ids use the grant-system segment `demo` (`daoip-5:demo:project:<name>`), so
they can never collide with a real `daoip-5:scf:…` id.

## Observations

### 1. Coverage (DB sha256 prefix `799373b8da4df838`, run 2026-11-19)

370 distinct projects. Web frontend 81 %, public API 46 %, Soroban 72 %, mainnet claimed at award time 28 %.
**Web tracker or OTLP (the two intake paths already built): 339 of 370 = 92 %.**

| Category | Projects | Share | Web frontend | Public API | Soroban | Wallet integration | Mainnet claimed |
|---|---|---|---|---|---|---|---|
| Wallets | 32 | 9 % | 59 % | 25 % | 72 % | 28 % | 41 % |
| DeFi / Soroban protocols | 58 | 16 % | 100 % | 33 % | 95 % | 50 % | 14 % |
| Anchors / payments / ramps | 82 | 22 % | 84 % | 51 % | 34 % | 33 % | 28 % |
| Infra / dev tools | 103 | 28 % | 65 % | 85 % | 81 % | 20 % | 31 % |
| NFT / gaming | 18 | 5 % | 100 % | 17 % | 89 % | 56 % | 11 % |
| RWA | 20 | 5 % | 100 % | 15 % | 90 % | 65 % | 25 % |
| Other consumer apps | 57 | 15 % | 84 % | 16 % | 74 % | 35 % | 33 % |

| # | Integration | Projects | Coverage | Effort | Reach/effort | Status |
|---|---|---|---|---|---|---|
| 1 | Paste-a-URL into SCF `analytics` field + evidence pack | 370 | 100 % | S | 370 | built |
| 2 | Web tracker (script tag / npm) | 299 | 81 % | S | 299 | built |
| 3 | OTLP API recipes | 172 | 46 % | S | 172 | built |
| 4 | Contract/account registration | 280 | 76 % | M | 140 | partly built |
| 5 | Wallet adapters (Wallets Kit + direct wallets) | 129 | 35 % | S | 129 | built |
| 6 | js-stellar-sdk RPC/Horizon hook in a web dApp | 255 | 69 % | M | 128 | planned |
| 7 | Docs-site plugin (Docusaurus/GitBook/Mintlify) for dev-tool docs | 67 | 18 % | S | 67 | guide only |
| 8 | Anchor SEP-6/24/31 funnel adapter (B8) | 114 | 31 % | M | 57 | planned |
| 9 | Passkey / smart-wallet adapter | 57 | 15 % | S | 57 | built |
| 10 | Mobile native / React Native over OTLP/HTTP | 57 | 15 % | M | 29 | not built |
| 11 | Telegram mini-app guide | 11 | 3 % | S | 11 | not built |
| 12 | x402 / MPP server hooks (B7) | 7 | 2 % | S | 7 | planned |
| 13 | Scaffold Stellar template | 4 | 1 % | M | 2 | planned |
| 14 | WordPress plugin | 3 | 1 % | M | 1.5 | snippet documented |

Coverage tests: `Ran 5 tests … OK`.

### 2. Badge + feed

`run.ts` → `20 demo projects → 4 in feed.json; 9 API badges`. Example outputs (DEMO data):

```text
web  SVG : measured usage | 48,178 verified visitors / 30 d          (portal generator, unchanged)
API  SVG : API requests (self-attested) | 241.3k / 30 d · A2
Shields  : {"schemaVersion":1,"label":"measured usage","message":"48.1k verified visitors / 30d","color":"1f5fae"}
feed key : "daoip-5:demo:project:alder_remit" → {stellarlight_slug, usagemap_slug, verification_level,
           web:{verified_pageviews, verified_visitors_sum, raw_pageviews, suspect_pageview_share},
           api:{label:"self-attested telemetry", requests, assurance_level}, card_url, metrics_url, badge:{svg, shields_endpoint}}
```

Of 7 projects with public stats, 5 are registry-linked; 1 of those did not opt in to the feed and is absent; 4 remain.
Tests: `tests 12 · pass 12 · fail 0`, covering: §i.1 key set, determinism, number formatting, endorsement wording,
"self-attested" on every API badge, XML escaping of names, Shields required fields, the inclusion rule, figures equal
the metrics documents, **no strkey / 64-hex hash / IPv4 / per-day or per-path field in the feed**, DAOIP-5 id
validation (accepts both PG Atlas forms `daoip-5:scf:project:…` and `daoip-5:scf:application:…`), duplicate-id
rejection. `tsc --noEmit`: clean. (Biome ignores `spikes/`.)

## Answer to the question

1. The two built intake paths already reach 92 % of SCF-funded projects; the cheapest *additional* reach is the
   js-stellar-sdk hook (69 %) and finishing contract registration (76 %), then docs-site plugins for dev-tool
   projects (18 %), the SEP funnel (31 %), and a mobile OTLP path (15 %). WordPress, Webflow and Framer are almost absent
   from SCF projects (≤ 1 %); the existing snippet guide is enough.
2. Yes. Every number on the card can be served as (a) a static SVG badge, (b) Shields endpoint JSON so README viewers
   only ever contact Shields, and (c) one DAOIP-5-keyed bulk document that PG Atlas or Stellarlight could poll. Nothing
   beyond the card's 30-day aggregates leaves; consent to the feed is separate from public stats.

## Consequences / what changes

- Production: add `GET /public/v1/projects/{slug}/badge.svg` and `/badge.json` (Shields endpoint), same access and
  caching rules as `metrics.json` (§i.1), and a consent-gated `GET /public/v1/ecosystem/feed.json` keyed by
  `canonical_daoip5_id` (data-model §8.5). Contract changes: wire-formats §i (new §i.5 feed, §i.6
  badges), a `feed_consent` tenant flag.
- The portal badge's hover text still carried the old working name (`apps/portal/src/lib/badge.ts` L32); it should
  name UsageMap.
- Limits: categories and surfaces come from an automated reading of application text (LIKELY), not live products; regex
  rules for Telegram/mobile/WordPress are upper bounds of mention, not of use. Effort figures are estimates.
