# ADR-0015: Enrollment and verification

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** enrol.self-service-ecosystem, tenancy.sites-and-services, enrol.self-service-open, enrol.operator-removal, enrol.approval-mode, operator.real-usage-ranking

## Context
Enrollment in UsageMap is self-service and open to any project built on Stellar. SCF operators can remove projects
that are not part of the ecosystem, and the system supports a later transition to an approval-required enrollment
model. Existing ecosystem tools answer "which projects claim to build on Stellar?" but not "which of those projects
are actually being used?" — the question UsageMap exists to answer. "Built on Stellar" cannot be proven automatically for every project, so the
platform must collect evidence and let SCF operators decide.

What research established:
- **Domain control** patterns: DNS TXT (strongest; same as ACME DNS-01 and Google Search Console domain properties),
  an HTTP `/.well-known/` file (ACME HTTP-01 style), an HTML meta tag (must be in the served HTML, not injected by
  JS). Search Console "periodically checks if your verification token is still present". A tracker snippet with the
  public site key proves nothing (anyone can paste it). RFC 8555 §10.2 warns about catch-all redirects and shared
  `.well-known` write access; §10.4: validation queries "can only be sent to servers on the public Internet" (SSRF).
  The Public Suffix List (2026-11-11) makes `*.vercel.app`, `*.github.io`, `*.pages.dev` separate registrable domains.
- **Stellar linkage** (SEP-1 Active v2.7.0): "By setting the home_domain of your Stellar account to the domain that
  hosts your stellar.toml, you can create a definitive link"; `ACCOUNTS` lists accounts the domain controls. SEP-1 has
  no generic contract list (only `[[CURRENCIES]] contract`); SEP-55 (Draft 0.4.1) puts `home_domain` in Wasm meta,
  which on its own is a unilateral claim. Proof of key: SEP-53 (Final) or SEP-10 (Active), see ADR-0014.
- **Registries.** Stellarlight "Stellar Scout" API v1.9.135: public, no auth, ~60 req/min/IP, 907 public records of
  which 598 are SCF-awarded, per-row `scfRoundAwards`, `scfAsOf`, `scfConfidence`; **no data licence** stated; one
  website per project; SCF #45 coverage was 24 of ≥ 40 until fixed on 2026-11-12 (issue #1903, PR #1946) — about ten
  days of lag. PG Atlas API v0.7.0: public, MPL-2.0, 841 projects, DAOIP-5 ids. communityfund.stellar.org has no
  documented API and was unreachable from our network (read via Wayback).

## Options considered
1. **Approval-required from day one.** Pros: no junk tenants. Cons: contradicts "self-service … open to any project";
   SCF operators become a bottleneck.
2. **Open enrollment, registry membership as a gate.** Pros: automatic. Cons: registries lag (days to weeks), carry
   one domain per project, have no data licence; SDF products and new awardees would be locked out.
3. **Open enrollment with a verification ladder shown to SCF operators, registries as evidence, SCF operator removal
   and a one-flag approval mode (chosen).** Pros: meets all three enrollment goals above; low-evidence tenants cannot distort
   rankings. Cons: abuse controls and evidence lifecycle to build.
4. **Tracker-installation check as proof.** Rejected: proves only that someone embedded a public key.

## Decision
- Self-service by default (`enrollment_mode = open`); a single flag switches to `approval_required` with no
  migration. The switch is an `operator_admin` action, audited, and needs a fresh passkey assertion (C-09).
  **Switching affects new enrollments only**; existing tenants keep their state (C-19).
- **Tenant states (C-08):**

| State | Entered when | Ingest | Data |
|---|---|---|---|
| `pending` | new tenant while `enrollment_mode = approval_required` | refused, counted as `tenant_pending` | the tenant can configure sites and services and complete verification |
| `active` | new tenant in `open` mode (at level L0), or approved from `pending` | accepted | visible |
| `suspended` | SCF operator action | stopped | kept |
| `removed` | SCF operator removal | stopped | hidden; `purge_after` = removal + 30 days; an `operator_admin` can restore the tenant until the purge runs; after purge it is irreversible |

- Verification ladder shown to SCF operators:

| Level | Name | Evidence |
|---|---|---|
| L0 | unverified | signed-in user created the tenant |
| L1 | domain control | DNS TXT, `/.well-known/` file, or meta tag; re-checked periodically |
| L2 | Stellar-linked | an **account** signature (SEP-53, or SEP-10 for hardware wallets and multisig) where the signer meets the account's **medium threshold**, the account's `home_domain` is a **verified domain of the tenant**, and that domain's `stellar.toml` lists the account (C-19) |
| L3 | registry-matched | Stellarlight primary, PG Atlas secondary; nightly sync with provenance |
| L4 | operator-approved | explicit SCF operator decision with a note |

- **Declared contracts (C-19).** Contract IDs a tenant declares are marked **"verified"** only when the ledger shows
  a verified account of the tenant (L2) as the contract's deployer or current admin; otherwise they are shown as
  **"declared"**. A contract cannot itself establish L2; SEP-45 (contract-account auth) stays behind a flag. The
  check is run by the contract-verification job, whose only egress is the configured Stellar RPC/Horizon hosts (C-10).
- **L0 quotas (C-19):** 2 sites, 1 API service, 50,000 web events per day, 100 API routes. L0 tenants are excluded
  from SCF operator rankings by default.
- **Web quotas and rate limits at the edge (C-90, C-80).** The snapshot carries each site's per-minute rate limit and
  daily quota. Each edge node enforces its share (limit ÷ number of live edge nodes) locally; the control plane adds
  up the counter records and, when a daily quota is exceeded, marks the site `over_quota` in the next snapshot, so
  enforcement is exact within about a minute. Quotas count **verified events only**, so a flood of `suspect` events
  sent with a competitor's public site key cannot exhaust that competitor's quota; `429` answers caused by a site's
  quota are reported per site.
- **Abuse controls (C-64).** Sign-up and site/service creation are rate-limited per identity and per source subnet.
- The **domain verifier** is a separate worker in the egress-allow-listed network (C-10): no private, loopback,
  link-local, CGNAT or our own addresses; no redirects followed; connects to the address it resolved (no
  re-resolution); bounded response size and time; response bodies never echoed to the user. Registry sync runs in
  the same egress-allow-listed network.
- Registry matching uses normalised registrable domain and GitHub organisation, never the project name alone; each
  match stores source, source id, fetched-at and the source's own as-of date so SCF operators see provenance.
- **Suspension and removal.** Suspending or removing a tenant stops ingest at every edge node within **60 s** through
  the signed snapshot (C-06, ADR-0005/ADR-0016). An edge node that has had no fresh snapshot for 15 minutes raises an
  alert and keeps serving from its last good snapshot, so a suspension does not reach that node until it reconnects —
  a stated residual risk (C-62). Removal hides the data at once and purges it (our tables and the tenant's Umami
  websites) after the **30-day grace period**; removing or restoring a tenant needs a fresh passkey assertion
  (C-09), and an owner removing its own tenant needs a fresh sign-in at most 10 minutes old (C-87); the purge job
  runs under the tenant's own context (C-87); every step is audited. Purged data leaves all backups within 56 days (C-29 as corrected by C-112, ADR-0021).
- **Re-enrollment block (C-64).** Removing a tenant leaves tombstones for its domains, GitHub identity and Stellar
  accounts that block re-enrollment until an `operator_admin` lifts them.
- **Appeals (C-19)** go through the issue tracker or the private channel and are decided by an `operator_admin`.
- Wire formats and tables are owned by `docs/data-model.md` and `docs/api/`.

## Consequences
- Positive: any Stellar project can start in minutes; SCF operators see evidence, not a single trust flag; fake or
  empty tenants cannot enter funding comparisons by default; the approval model is a configuration change that does
  not disturb existing tenants.
- Positive: registries are used without being trusted, so their lag and missing licences do not block anyone.
- Positive: L2 rests on checks anyone can repeat against the ledger and the tenant's own domain; contract claims are
  labelled "declared" rather than silently trusted.
- Negative: verification lapses must be handled (research: re-check daily for a week, then weekly; warn, grace
  period, then downgrade), and a lapse followed by a new claimant is a domain-takeover case for SCF operator review.
- Negative: a host can be verified by one tenant at a time; global uniqueness checks must not leak who holds a host
  (RLS side channel, ADR-0013).
- Negative: contracts deployed by a factory or by an account the tenant has not linked stay "declared"; projects whose
  contracts are only reachable through SEP-45 cannot reach L2 through them.
- Negative: edge quota enforcement is approximate for up to about a minute (per-node shares until the `over_quota`
  mark arrives, C-90), and a node cut off from the core enforces only its share.
- Negative: L0 quotas are small on purpose; a genuine project hits them quickly and must verify a domain (L1) or
  link an account (L2) to grow.
- Negative: tombstones block legitimate re-enrollment (for example a domain that changed hands) until an
  `operator_admin` acts; the appeal path is the remedy.
- Negative: the registry sync depends on third-party APIs without licence or SLA; the sync must alert when a source
  returns zero rows or per-round counts drop; an official export from the programme would remove this dependency.
- Negative: "part of the ecosystem" is a policy judgement; UsageMap provides mechanism and evidence, the SCF operators provide policy.
- Revisit if: the SCF programme publishes an official awarded-projects feed; SEP-45 becomes Final; abuse volume forces approval
  mode.
- **Unproven:** nothing here has run; the verifier's SSRF guard needs adversarial tests (rebinding, redirects,
  IPv6-mapped addresses); the 60 s snapshot bound has not been measured.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Enrollment verification API keys: §3.1 domain proofs, SSRF rules, granularity,
  re-verification, uniqueness; §3.2 Stellar linkage signals; §3.4 ladder; §3.5 state machine, approval mode,
  removal; §3.6 abuse controls and quotas.
- Stellar ecosystem registries: §3.1 Stellarlight; §3.3 PG Atlas; §3.8 oracle matrix;
  §4 H-STL-2; §6 sync design and gaps.
- Auth SEP-10 SEP-45 passkeys: §3.4 SEP-53 limitation and signer-weight check.
- Research synthesis: H-STL-2, H-STL-5.

## Open points
None outstanding.
