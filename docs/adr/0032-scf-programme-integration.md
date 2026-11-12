# ADR-0032: SCF programme integration

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** trust.verified-vs-raw, operator.real-usage-ranking, share.signed-usage-report, keys.operator-api-keys, operator.web-side-by-side, operator.api-usage-ranking, operator.api-fair-comparison, slo.ingest-availability

## Context
The problem UsageMap exists to solve: ecosystem programmes rely heavily on self-reported metrics when they assess
eligibility for follow-on programmes such as Growth Hack, the Public Goods Award or the traction requirements of the
Integration Track, and builders spend too much time assembling and defending usage reports. The SCF operator global
view and SCF operator API keys alone do not say how a number reaches a programme's assessment.

What those programmes ask for today (public SCF handbook, commit `4cc1fae`):
- **Growth Hack** ranks on on-chain WAA, weekly transaction volume and TVL (Dune), and also asks "Off-chain: set up
  a dashboard on a preferred platform and share access with SDF. Weekly metric updates"; retention payment requires
  metrics to "remain within 30% of competition levels"; "Bot Traffic or Fake Engagement… strictly prohibited".
- **Public Goods Award** renewals every 3 months must "Demonstrate measurable impact (e.g., usage …)". The PG
  Maintenance Working Group already **polls** a project's `health_endpoint` for uptime and its `metrics_endpoint` —
  "a public URL returning counts you consider meaningful, as JSON" (PG maintenance programme instructions, commit `8992dc1`). The motivation, in the programme lead's words: "Declaring the URL lets the program do
  the polling, so the figure is ours rather than self-reported" (commit `d46de41`, 2026-10-05).
- **Integration Track** final payouts depend on on-chain metrics; applications must show traction that is
  verifiable from the application itself; the handbook notes "A shared per-project dashboard keeps the threshold check
  transparent". SCF #39 delegates asked for "standardized traction verification".
- Today's evidence is screenshots and self-defined metrics: Cloudflare unique IPs, GA behind consent, CLI install
  ids, Scarf downloads — no shared definition of a unique visitor. PG Atlas defers "Sybil-resistant usage signals"
  and its per-project `analytics` field is a self-reported URL.
- Prior art: GOV.UK's Performance Platform was retired in 2021 because nothing depended on it; a metrics service
  survives when its numbers are used in decisions.

## Options considered
1. **Minimum only: SCF operator dashboards and SCF operator API keys.** Pros: least scope. Cons: tenants still assemble
   screenshots for each programme; the platform is not wired into processes SCF already runs.
2. **Integrate with the existing PG polling conventions plus verifiable snapshots and campaign exports (chosen).**
   Pros: plugs into a process that already exists; no new behaviour asked of programme assessors; addresses
   trust.verified-vs-raw, operator.real-usage-ranking and share.signed-usage-report. Cons: a
   public endpoint per tenant widens the privacy surface; depends on the PG Working Group accepting it.
3. **Public leaderboard of all tenants.** Pros: maximum ecosystem visibility. Cons: publishes data tenants did not
   choose to publish; invites gaming; conflicts with the aggregates-to-SCF-only posture (ADR-0027).
4. **Anchor snapshots on-chain** (hash in a Stellar transaction). Pros: public timestamp. Cons: costs fees and a
   funded account to hand over; adds nothing a published signing key does not, for this purpose. (The audit-chain
   head is a different matter and is anchored separately, C-63.)
5. **Push metrics into PG Atlas or SCF tooling directly.** Pros: tight coupling. Cons: needs their write APIs and
   agreements; couples our availability to theirs. A read-only SCF operator API key for such consumers already exists
   (keys.operator-api-keys).

## Decision
1. **Per-tenant `metrics_endpoint` JSON** (C-14, C-47). Each tenant has a cacheable JSON document of its own
   thresholded daily aggregates that it can paste into its PG project page as `metrics_endpoint`. It is readable
   with an SCF operator key (`op`), or with a **read-only share key of kind `pub`** that the tenant creates (e.g. for
   the PG poller), or **publicly if the tenant switches public stats on** (the tenant, as controller, instructs
   publication; share.signed-usage-report "public visibility is opt-in"). Every response applies the minimum-count threshold and
   rounding of the SCF view (ADR-0027) and **never includes the trust score**; it carries verified and raw page views
   and unique visitors side by side, and visits, bounce rate and session duration as one figure each with the suspect
   page-view share (C-73), the API assurance level with its label ("self-attested telemetry") and the window it covers. The shape is
   specified in `docs/contracts/` and kept compatible with what the PG programme polls (the PG instructions mandate
   no schema).
2. **Platform `health_endpoint`** (public, C-14). A public endpoint reporting ingest and dashboard health that the PG programme's
   poller (or any third party) can register, so our availability is also measured by someone other than us
   (ADR-0031). It reports health only, never tenant data.
3. **Signed traction snapshots.** A tenant `owner`/`admin` can generate a snapshot of its metrics for a stated window
   to attach to a Growth Hack, Public Goods or Integration Track application. The snapshot carries verified and raw
   counts, the trust score and reason-code summary, API assurance level and label, rule-set and tracker versions, the
   window (`start` inclusive, `end` exclusive, UTC — C-86) and generation time, and is **signed with an Ed25519 platform key** whose public half is published in the
   repository and under `/.well-known/` on the service domain (old keys stay listed after rotation) (C-47). Anyone
   verifies it two ways: offline against the published key, and online by fetching the snapshot from the platform, which confirms it exists, was not
   revoked, and shows any later SCF operator annotation (e.g. "under review"). Format and verification procedure live in
   `docs/contracts/`; generation and verification are audited.
4. **SCF operator exports for campaign-versus-baseline comparison.** SCF operators can export, per tenant or selection, weekly
   series for a campaign window against a baseline window (e.g. 4-week acquisition and 4-week retention as in Growth
   Hack), with the metric semantics of C-73 (verified and raw where they exist), as CSV and JSON (operator.web-side-by-side); ecosystem
   sums are produced inside the `op_*` functions from unrounded values and rounded once (C-89); with retention-style metrics preferred over spikes.

## Consequences
Positive: numbers reach programme assessments through channels SCF already uses; anyone can check a snapshot without
trusting the tenant; the platform becomes a dependency of real decisions, which is what keeps a shared service alive.

Negative: public per-tenant endpoints are scrapable and comparable by anyone, which some tenants will not want (hence
public stats are off unless the tenant switches them on, and a `pub` share key is the narrower alternative) and which a UK tenant's audience exemption may not cover (PECR Sch. A1 para 5(1)(c) restricts sharing;
ADR-0027); the Ed25519 traction-snapshot signing key (distinct from the edge snapshot-signing key of ADR-0016) becomes a
high-value secret that must be handed over (handover.repo-transfer) and rotated; snapshots can be
quoted out of context, so they always carry labels and the self-attested caveat; on-chain programme thresholds
(Integration Track, Growth Hack ranking) remain on-chain and are not replaced by our numbers.

Must do: ask the PG Working Group whether it accepts our per-tenant JSON as a recognised `metrics_endpoint` source
(possible conflict of interest to check first); document "metrics inform decisions, they do not determine them" in
the SCF operator docs; include the snapshot key in the handover inventory.

Revisit if: the PG programme defines a `metrics_endpoint` schema (adopt it); SCF publishes an official awarded-projects
export or review tooling with an ingest API; counsel objects to public per-tenant aggregates.

Unproven: no PG assessor has been asked; programme assessors may never verify a signature in practice, so the
snapshot's contents must stand on their own inside an application.

## Open points
None outstanding. (Access to and content of the `metrics_endpoint` are settled by C-14 and C-47; the signing scheme
by C-47.) Still to be done, not to be decided: asking the PG Working Group whether it accepts the endpoint (after the
conflict-of-interest check).
