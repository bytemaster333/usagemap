# Measurement methodology `scf-methodology/1.0.0`

How the platform turns browser events, API telemetry and public ledger data into the numbers SCF programmes read:
what each number means, which advisory signals sit next to it, when a number is withheld, what a signature and a seal
prove, and how a project contests a flag.

| | |
|---|---|
| Version | `scf-methodology/1.0.0` (every traction snapshot names the version it was computed under) |
| Status | first published version, 2026-11-16 |
| Applies to | traction snapshots (schema 2), the per-project `metrics.json`, the public project page, programme cohorts, the tenant and SCF-operator views |
| Detailed definitions | [Metric definitions](../metrics/definitions.md) — every figure, its source and its known biases |
| Source of truth for the algorithms | the code it names below; where this page and the code differ, the code is what ran, and the difference is a defect in this page |

## Wording

**The platform describes a measurement, never an endorsement.** No page, badge, card, snapshot, API answer or
pasteable text says or implies that SCF, the Stellar Development Foundation or anyone else verified, approved,
endorsed or certified a project or its numbers. The SCF Official Rules forbid implying such approval.

- "**Verified**" always means one of two things, and the text says which:
  - a *web event* that passed the platform's anti-inflation checks (a valid challenge and proof of work, no suspect
    reason); or
  - a *contract* whose ownership the platform checked on the ledger (its deployer or admin is a proven account of the
    project).
- "**Raw**" means every event that was not rejected.
- API figures are always labelled "**self-attested telemetry**": the project's own servers report them.
- On-chain figures are "**measured from public ledger data over the project's verified contracts**".
- A seal is "**tamper-evidence of published numbers**", never "proof the numbers are genuine".
- Every snapshot's text ends with: *"Verified" means passed our bot checks, not endorsed by SCF or SDF.*

Allowed: "Measured by <platform>", "12,400 verified page views (passed bot checks)". Not allowed: "SCF verified",
"SDF approved", "certified usage", "genuine users".

## Metric definitions

The full definitions are in [Metric definitions](../metrics/definitions.md). The figures programme outputs carry:

| Family | Figures | Notes |
|---|---|---|
| Web | page views and the sum of daily unique visitors, each **verified** and **raw**; visits, bounces, bounce rate, average visit duration; suspect page-view share | UTC days; visitors are counted per day and summed (no cross-day identity exists); no query strings, titles or per-visitor records |
| Wallet events | daily counts per event, wallet type and network from the closed Stellar event vocabulary (version 1) | signing, submit, smart-wallet and passkey events are counted only, never attached to a visit ([why](../onboarding/wallets.md#counted-only-events)) |
| API | requests, 5xx error rate, p95 latency, the accuracy class of the latency, assurance level A0–A2 and the on-chain consistency badge | self-attested; derived only from `http.server.request.duration` or root SERVER spans |
| On-chain | invocations, successful invocations, distinct invokers per day (summed over days) of the project's **verified** contracts | see [On-chain figures](#on-chain-figures) |

Every figure in these outputs is exact (no rounding), except where a [small-count floor](#small-count-floors)
withholds it.

## Small-count floors

| Output | Floor |
|---|---|
| Web breakdown rows (pages, referrers, countries, …) seen by anyone but the project | rows below 10 are merged into "Other"; displayed breakdown counts are rounded to 10. Totals are never rounded |
| Wallet-event daily counts that leave the project (operator views, public pages, cohorts, snapshots) | a per-day, per-value count below 10 is omitted. The project's own view is exact |
| Programme cohorts (by SCF round, category, award stage) | no figures for a cohort of fewer than 5 projects; in a shown cohort a figure below 10 is withheld; on-chain figures only when at least 5 of its projects have on-chain data |
| Trust score | no score below 10 raw page views in the window (`insufficient_data`) |
| Ecosystem percentiles of trust components | only with at least 20 active projects |
| Snapshot confidence | `insufficient` below 10 raw page views in the period when there is neither API nor on-chain data |

The cohort floor is a floor for statistical comparison, not a privacy boundary: SCF operators can read each
project's exact totals.

## Trust score `trust/1.0.0`

An **advisory** score from 0 to 100 per website and day (windows of 1 and 28 days), computed from aggregate counters
only. It never changes a count, never blocks anything and is never published in snapshots or on public pages. The
project sees its score and reasons exactly as SCF operators do. Implementation: `services/jobs/src/trust/algorithm.ts`
(algorithm) and `services/jobs/src/jobs/trust-scoring.ts` (job, daily at 03:00 UTC for the day before and three days
before).

    T = round(100 − Σ wᵢ · pᵢ),   Σ wᵢ = 100,   pᵢ = clamp((valueᵢ − loᵢ) / (hiᵢ − loᵢ), 0, 1)

| Component | Input value | lo | hi | Weight | Reason code when p > 0 |
|---|---|---|---|---|---|
| `proof_coverage` | 1 − verified ÷ raw page views | 0.10 | 0.60 | 25 | `proof_coverage_low` |
| `network_quality` | share of events from datacenter, VPN or Tor networks | 0.10 | 0.50 | 15 | `network_datacenter_share_high` |
| `multiplicity` | share of events in the `high` multiplicity bucket | 0.05 | 0.30 | 15 | `multiplicity_share_high` |
| `engagement` | share of events with automation, hidden-page or no-user-activation signals (signals collected only) | 0.20 | 0.70 | 15 | `engagement_low` |
| `mix` | larger Jensen–Shannon divergence of the day's device or country mix from the previous 28 days | 0.10 | 0.50 | 10 | `mix_divergent_device` / `mix_divergent_country` |
| `temporal` | larger of *step* (day ÷ median of previous 28 days; lo 3, hi 10) and *burst* (largest hourly share of the day; lo 0.25, hi 0.75) | — | — | 10 | `step_change` / `burstiness_high` |
| `pow_latency` | share of proofs of work solved implausibly fast (under 100 ms) | 0.05 | 0.50 | 5 | `pow_latency_implausible` |
| `cross_signal` | neutral in 1.0.0 (always p = 0) | — | — | 5 | — |

- The weights are the platform setting `trust_weights`; the values above are the defaults. Changing them changes the
  algorithm version and follows the [per-round freeze](#per-round-freeze).
- A component without input (a `strict` site sends no client signals; fewer than 7 days of history) is **omitted**
  and contributes nothing: a missing signal never lowers a score.
- The thresholds are absolute and not yet calibrated against real traffic; ecosystem percentiles are shown for
  information only. Worked examples with every number: [Metric definitions §6.1](../metrics/definitions.md#61-web-trust-score-web_trust_scores-windows-1-and-28-days).
- API services get assurance levels instead (A0 valid token, A1 plausibility checks, A2 liveness probe, A3 on-chain
  consistency badge): [Metric definitions §6.2](../metrics/definitions.md#62-api-assurance-api_service_assurance-a1-100).
  A1 says API numbers are plausible, not that they are true.

## On-chain figures

- **Source:** public Stellar ledger files (the network's own archived ledger data), read by the platform; a secondary
  source (Hubble) may fill days that ledger files do not cover and never replaces a ledger-file day. A snapshot
  states which source it used (`ledger_files`, `hubble` or `mixed`).
- **Scope:** only contracts in the project's footprint that are **verified** (deployer or current admin is a proven
  account of the project), on the platform's network, and not in conflict. A contract verified for two projects is
  counted for neither until an SCF operator resolves it. Claimed and rejected contracts are never counted.
- **Figures:** per contract and UTC day: top-level invocations, invocations in successful transactions, and distinct
  invokers (operation source, else transaction source). Distinct invokers are counted per day and summed over days;
  they are a lower bound of end users (a relayer or a shared account counts once) and include the project's own
  accounts.
- **Never stored:** invoker addresses. They are held in memory to count distinct values and discarded.
- Only complete days (contiguous ledgers) are stored; a snapshot's coverage block says how many days were complete.
- Account and WASM-hash footprint items are not counted in 1.0.0.

## Snapshot confidence

Every traction snapshot (schema 2) carries a confidence level and its reasons, computed when the snapshot is signed:

| Level | Rule |
|---|---|
| `insufficient` | raw page views in the period below 10, and neither API nor on-chain data |
| `high` | otherwise, no reason applies |
| `medium` | exactly one reason applies |
| `low` | two or more reasons apply |

| Reason | Applies when |
|---|---|
| `few_events` | raw page views < 10 × days in the period |
| `partial_coverage` | days with web events < 80 % of the days in the period |
| `days_not_final` | some days of the period are not yet final on every site |
| `high_suspect_share` | suspect share of page views > 0.30 |
| `open_anomaly_flags` | at least one anomaly flag in the period is open |
| `domain_unverified` | the project is at verification level L0 |
| `no_verified_contracts` | on-chain correlation is on but no contract is verified |

Open anomaly flags are reported as two **counts** (web, API) only: a snapshot never names a reason code, a day or a
site. A flag stops being open when the project's annotation explains it or an SCF operator marks it explained (see
[Flags and appeals](#flags-and-appeals)).

## Signatures, series and seal

- **Signature:** every snapshot is signed by the platform (Ed25519 over the canonical JSON). Anyone can check it with
  the published keys. A signature proves the platform issued exactly this document; it says nothing about whether the
  underlying traffic was real beyond the checks described above.
- **Series:** snapshots are numbered 1, 2, 3, … per project, each carrying the hash of the one before, and all of
  them (revoked ones included) are listed publicly. A withheld or deleted snapshot shows as a gap or a broken link, so
  picking the best of many windows is visible.
- **Seal (opt-in):** once a day the platform publishes one Stellar transaction whose memo is the root of a Merkle tree
  over the previous day's root, the platform's audit-log anchor and a salted hash of each snapshot signed that day by
  a project that opted in. With the inclusion proof, anyone can check that a snapshot existed unchanged no later than
  that ledger, and that earlier days were not rewritten without breaking the chain.
- **Limits of the seal:**
  - It is **tamper-evidence of published numbers, never proof that they are genuine.** A seal over an inflated
    number is a valid seal.
  - It is currently written to **Stellar testnet**. Testnet is reset several times a year, so a testnet seal is a
    demonstration, not durable evidence; every page and answer that shows a seal says so. Moving to mainnet needs an
    explicit decision and a funded operator key.
  - It covers snapshots of projects that opted in, from the day they opted in. The seal of a day exists only after the
    day ends (up to about 25 hours after a snapshot is issued).

## Per-round freeze

- The methodology version (this document's semver, which covers the metric definitions, the trust algorithm and its
  weights, the assurance rules and the confidence rule) **in force at an SCF round's application deadline applies to
  that round.** A change published after the deadline takes effect from the next round.
- Every snapshot records the methodology version it was computed under; a later version never re-computes a signed
  snapshot.
- Versioning: a change that can move a project's figure, score or confidence is a new **minor** version (1.1.0), or a
  **major** one (2.0.0) when a definition changes meaning; corrections of wording are patch versions. Each version is
  published as its own file next to this one, and old versions stay published.
- This freeze is the platform's commitment. Whether and how SCF applies a methodology version to its decisions is
  SCF's choice.

## Flags and appeals

An anomaly flag is a trust-score or assurance reason code on a day. Flags are advisory: they inform whoever reviews the figures, they
never change a count, and a project is never ranked or excluded by the platform because of them.

1. **The project sees every flag** with its reason codes and inputs in the portal, exactly as SCF operators do.
2. **The project explains it**: an annotation on the period (portal: **Trust** → **Annotate**, for example "launch
   campaign on 3 March") listing the reason codes it explains. An annotation that lists a code closes that flag in
   snapshot counts; the annotation itself is visible to SCF operators.
3. **An SCF operator reviews**: the operator records a decision as an operator annotation, either marking the flag
   explained or leaving it open with a reason the project can read. Operator actions are recorded in the audit log.
4. **Final decisions belong to SCF.** The platform provides the record; SCF decides what a flag means for a programme.
   Target: an operator answer within 10 business days (a target the platform proposes, to be agreed with SCF).

A project can also contest a category or cohort assignment and a footprint conflict the same way; footprint conflicts
are resolved by an SCF operator rejecting the wrong claim.

## Known limits

- Web "verified" raises the cost of inflation; it cannot prove that a human visited. Determined attackers with real
  browsers on residential networks can pass the checks.
- API telemetry is reported by the project's own servers and cannot be proven genuine; assurance levels describe
  plausibility and consistency only.
- Visitors are daily counts: the sum over days counts a returning visitor once per day.
- Distinct invokers include relayers, sponsors and the project's own accounts; they are a lower bound of end users,
  not a count of people.
- The trust thresholds are not yet calibrated against real traffic.

## Changelog

| Version | Date | Change |
|---|---|---|
| `scf-methodology/1.0.0` | 2026-11-16 | First version: web, wallet-event, API and on-chain definitions; trust score `trust/1.0.0` with default weights; assurance `A1-1.0.0`; snapshot confidence rule; small-count floors; seal on testnet; per-round freeze; appeals path |
