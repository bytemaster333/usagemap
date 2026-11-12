# ADR-0028: Trust score, API assurance levels and on-chain correlation

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** trust.verified-vs-raw, operator.real-usage-ranking, bot.anti-inflation-strategy, bot.ip-multiplicity, operator.web-global-view, operator.web-compare, operator.web-filter, operator.web-sort, operator.web-side-by-side, operator.api-global-view, operator.api-compare, operator.api-usage-ranking, operator.api-fair-comparison

## Context
Ecosystem programmes that fund projects rely heavily on self-reported metrics, and UsageMap aims to make fair
cross-project comparison possible. The threat is the tenant inflating its own numbers to win funding (threat model). Two facts bound what any design can claim:

- **Fabricated API telemetry cannot be prevented.** OTLP is a push protocol; every count, bucket, route and timestamp
  is produced by software the tenant controls. A tenant can synthesise metrics, multiply real counters, replay an
  export, or run a load generator against its own API, in which case the telemetry is genuine and only the demand is
  fake. TEEs and signed receipts do not help: the signing key or attested binary still counts self-generated load
.
- **Web inflation can be made costly and visible, not impossible.** A real headless browser on residential proxies
  passes L0–L5 of ADR-0008. PoW at tracker-tolerable difficulty (W = 2¹⁹ PBKDF2 iterations) costs an attacker about
  **$0.01–0.02 per 1M sessions on a GPU** and **~$3.5 on a 16-thread CPU**; the dominant cost is network realism —
  ~**$10–80 per 1M sessions** with curl-impersonate on residential proxies at $1–8/GB, ~**$300–16,000** with a
  headless browser fetching real pages (vendor prices, LIKELY).

Prior art: no funding programme found a way to prevent fabricated self-reported telemetry; Optimism/OSO, Gitcoin and
Electric Capital fall back on detection, longitudinal views and human judgement. The MRC classes "incentivized human invalid
activity: self-directed activity to benefit self" as SIVT, needing "advanced analytics, multi-point corroboration"
(MRC IVT Addendum, June 2020, §1.1.2).

## Options considered
1. **Show raw counts only, with a disclaimer.** Pros: simple. Cons: recreates the self-reported-metrics problem.
2. **Hard gating: reject or delete traffic judged inflated.** Pros: clean numbers. Cons: false positives destroy real
   data; MRC: datacenter traffic must be "known to be invalid in order to be filtered"; no appeal path.
3. **Advisory score with reason codes, verified and raw side by side, plus labelled API assurance levels and
   optional on-chain consistency (chosen).** Pros: explainable; tenant can respond; honest about limits. Cons: a
   number readers may over-trust; thresholds can be gamed once published.
4. **Independent request counting: operator-run reverse proxy in front of tenant APIs.** Pros: counts observed by
   operator infrastructure. Cons: still cannot tell real demand from a load generator; adds latency, residency and SPOF
   burden to every tenant; conflicts with the 99.99 % objective. Not adopted.
5. **On-chain as the primary usage measure.** Pros: public, permanent. Cons: read-only APIs leave no trace; activity
   can be bought cheaply (below); not usage of the web or API.

## Decision
**Web trust score.** Daily per site, 0–100, advisory, with reason codes; also a rolling 28-day value. It never
deletes or hides data. Inputs, all from aggregates the platform already stores (no event-level reads):
- verified ÷ raw ratio of page views and unique visitors, and suspect share by reason code (ADR-0008 verdicts; visits,
  bounce rate and duration have one figure each, so they enter only through the baselines below — C-73);
- proof statistics: proof coverage, server-measured issue→redeem latency distribution;
- ASN mix: datacenter, VPN and Tor share (Apple Private Relay and mobile carriers excluded from the numerator);
- multiplicity flags: share of sessions with a `high` multiplicity bucket (for sites with `visitor_id = off`, share
  of events from subnets over the per-subnet event threshold — C-80);
- robust baselines of ratios that are hard to fake coherently: session-duration shape, pageviews per session,
  device/browser/country mix, hour-of-day profile, step changes before deadlines; robust z-score
  (median/MAD over 28 days), S-H-ESD, two-window ratio/CUSUM, Jensen–Shannon divergence against the tenant's own
  baseline and the ecosystem.

Every penalty emits a code, its value and, where available, its percentile (e.g. `NET_DC_SHARE=0.41 (p97 eco)`).
Trust-score **inputs and weights are versioned and published in the repository** (C-44), as are the thresholds
(ADR-0008); every score records the version it was computed with. **Ecosystem percentiles are shown only when at least
20 tenants are active** (C-44); below that, components are compared with the tenant's own baseline only. Client
signal booleans (`webdriver`, visibility, user activation) exist only for the `standard` profile; for `strict` traffic
the components that use them are omitted, never scored as missing (C-33). SCF operators see the score, components,
codes, raw and verified series and annotations; the tenant sees its own components with plain-language explanations
and can **annotate** dated events (launches, booths); an SCF operator can mark an anomaly "explained", recorded in the
audit log. The trust score is never published through a tenant's `metrics_endpoint` (C-47).

**Framing by others (C-80).** Anyone can send events with a tenant's public site key, so a sudden rise in `suspect`
events may be a competitor's flood rather than the tenant's own inflation. Such a surge is shown with its reason
codes, the tenant and SCF operators can annotate it, and quotas count verified events only, so it cannot exhaust the
tenant's quota. We detect and explain this; we do not prevent it.

**API assurance levels.** All API data is labelled **"self-attested telemetry"** in every view and export.
**A0–A2 are cumulative** (each requires the previous one). **A3 is a separate badge**, not a fourth step (C-44).

| Level | Condition | What we claim |
|---|---|---|
| A0 | Valid ingest token only (tenant bound server-side, ADR-0009/0016) | "Reported by the project" |
| A1 | Plausibility checks pass: structural consistency (histogram `sum(bucket_counts) == count`, monotonic cumulative sums), time bounds, latency shape, status mix, seasonality, route cardinality vs volume | "Reported; no anomalies detected" |
| A2 | The declared API base URL answers a probe run by the service operator (≤ 1 request / 5 min per tenant, documented in the terms) | "Reported; API confirmed live" — **liveness only, not volume** |
| A3 badge ("on-chain consistent") | Available only to services with **verified** declared contracts or accounts; daily on-chain activity is consistent with the reported telemetry | "Reported; consistent with public on-chain activity" |

A permanent footnote on API views: "API metrics are produced by the project's own software and cannot be
independently verified; indicators show consistency, not proof." For services without verified contracts or
accounts — including read-only APIs such as oracles and indexers, which leave no trace — the interface shows the A3
badge as **"not applicable"**, never as a failure or a lower level (C-44).

**On-chain correlation** (optional per tenant, off by default; ADR-0017). Daily UTC counts per declared contract:
transactions whose root invocation is the contract (total and successful), distinct source and fee-source accounts,
contract events, fees in XLM; and per declared account, transactions sourced by it. Only **verified** identifiers
count (C-19): an account is verified by the L2 account signature (SEP-53, or SEP-10 for hardware wallets and
multisig, meeting the medium threshold, with matching `home_domain` and `stellar.toml`); a contract ID is "verified"
only when the ledger shows a verified account of the tenant as its deployer or current admin, otherwise it stays
"declared" and does not count. Sources:
- **Primary:** SDF's public Hubble dataset `crypto-stellar.crypto_stellar` on BigQuery (Sandbox: 1 TiB/month query,
  no billing account), one batched query per table per day for all tenants, D-1 with a D-2 re-run; dry-run and a
  bytes-billed cap on every query. Only tenant-declared public identifiers are sent; nothing from web analytics.
- **Fallback (rebuildable):** our own reader of the public ledger data lake (Galexie `LedgerCloseMeta` files, e.g.
  `s3://aws-public-blockchain/v1.1/stellar/ledgers/pubnet/` on AWS Open Data, mirror Lightsail Quasar), same metrics
  and semantics. It is a small Go command, `/services/onchain-reader`, run by the jobs scheduler, because ledger
  decoding uses the Go Stellar SDK (C-42; ADR-0025).
- Both sources are outside the EU-hosted data path and receive public identifiers only; the BigQuery dataset location
  is still to be confirmed (C-26; ADR-0017).
- If both fail for a day the value is stored as unavailable, never zero. StellarExpert (now HTTP 402 / x402 on
  mainnet) and Horizon (end-of-life, no contract filter) are not dependencies.

**Cost to fake on-chain activity** (live data 2026-11-12: XLM $0.145, base fee 100 stroops, base reserve 0.5 XLM;
"Soroban-like" = 10,113 stroops, median of transactions > 1,000 stroops in a 200-transaction sample):

| Fake transactions/day | Classic (100 stroops) | Soroban-like (~10,113 stroops) |
|---|---|---|
| 1,000 | ≈ $0.04/month | ≈ $4.40/month |
| 10,000 | ≈ $0.44/month | ≈ $44/month |
| 100,000 | ≈ $4.35/month | ≈ $440/month |

Faking distinct accounts costs capital, not fees: 1 XLM minimum balance each, ~$1,450 locked for 10,000 accounts,
recoverable by merging, and it leaves a funding graph. We state plainly that **on-chain activity can be bought
cheaply and is an indicator, not proof**; its value is that it is public, permanent and auditable afterwards.

## Consequences
Positive: SCF operators get explainable evidence instead of a single number; tenants can see and contest why they were
flagged; API data can never be mistaken for verified usage.

Negative: publishing thresholds lets an inflator tune to them (we rely on the cost of coherence across many
dimensions); a funded tenant buying real human traffic is undetectable by design; ecosystem baselines need enough
tenants to mean anything (hence the 20-tenant floor for percentiles); a flood of `suspect` events sent by someone
else lowers a tenant's verified ÷ raw ratio until it is annotated (C-80); fee-bump relayers and smart wallets collapse many users into one source account, so
"distinct accounts" undercounts passkey dApps.

Watch: false-positive rate and decision rate (MRC-style) are published with the score; trust signals feed each other
(web verified visitors vs API volume vs on-chain vs wallet connects) only as consistency, never as a penalty for
missing data.

Revisit if: a privacy-preserving device attestation usable by an independent service appears (none today: Privacy
Pass/PAT need a big-tech attester); early-tenant data shows the weights mis-rank known-good tenants.

Unproven: **S-10** (BigQuery dry run; the ≤ 30 GB/month estimate is unmeasured), **S-07** (PoW timing that underlies
proof statistics), **S-01** (verdict stored in Umami's `tag`; C-82 fallback if the stats API cannot filter by it); the Hubble data licence is not stated by SDF; the
score weights have never been calibrated on real traffic.

## Open points
1. Open: **Initial weight values.** C-44 fixes that inputs and weights are versioned and published, not their values.
   The research's candidate (proof coverage 25, network 15, multiplicity 15, engagement 15, mix 10, temporal 10, PoW
   latency 5, cross-signal 5) is the candidate first version; it has never been calibrated. Closed by calibration on
   early-tenant traffic and the PoW timings from **S-07**, before the first version is published.
