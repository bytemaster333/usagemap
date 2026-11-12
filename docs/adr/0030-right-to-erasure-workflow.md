# ADR-0030: Right-to-erasure workflow

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** privacy.minimal-erasure-scope, privacy.tenant-erasure, privacy.erasure-workflow, privacy.strategy-docs, docs.privacy, enrol.operator-removal

## Context
UsageMap is designed to minimise the set of users who can exercise the right to erasure; where personal data subject
to erasure is stored, it provides a practical, tenant-triggered erasure workflow (privacy.minimal-erasure-scope,
privacy.tenant-erasure, privacy.erasure-workflow). Needs counsel review.

What research established:
- **GDPR Art. 11** is the lever. Art. 11(1): no obligation to keep extra information solely to identify a data
  subject. Art. 11(2): where the controller "is able to demonstrate that it is not in a position to identify the data
  subject", **Arts. 15–20 do not apply** unless the data subject supplies information enabling identification
  (statutory text from the official version; EUR-Lex was unreachable, counsel to confirm). **Art. 21 (objection) is
  not disapplied**, so an opt-out is still required (ADR-0004, ADR-0027).
- Our design gives Art. 11 real footing: no IP, no raw User-Agent, no cookie or device storage, and the daily key that
  derives the visitor surrogate exists only in gateway memory and is destroyed at rotation (ADR-0007). After rotation
  nobody, including us, can recompute which rows belong to a device, so a visitor cannot point us to "their" rows.
- Residual personal data can still enter through content: URL paths (e.g. `/users/alice@example.com`), page titles
  (which is one reason they are not collected), custom-event names and properties. Wallet UIs often show addresses in
  titles; EDPB 02/2025 treats public keys as
  personal data. Preventive controls exist (query
  strings never sent and discarded by the gateway, C-65; page titles not collected at all, C-89; tracker guard refusing values shaped
  like e-mails, StrKeys or JWTs, ADR-0004; and the gateway's `pathnorm` scrubbing of web page paths, custom-event names
  and property values, which turns StrKeys, hashes and UUIDs into placeholders and seeds, tokens, JWTs and e-mail
  addresses into `{redacted}` before anything is spooled, C-52) but cannot catch everything, e.g. names.
- CNIL/AEPD cap retention of collected information at 25 months; event-level web data is kept **90 days** by default
  (C-54; settable 30–395 days, 395 days being the hard maximum; ADR-0011). Daily per-site aggregates are kept indefinitely and include top-N breakdowns by path and event name, so a
  leaked value can survive in aggregates after the event rows age out.

## Options considered
1. **Per-visitor erasure (look up a person's rows).** Pros: matches the usual mental model of Art. 17. Cons:
   impossible by design — it would require keeping the identifying link we deliberately destroy; building it would
   enlarge the set of people who can exercise erasure, the opposite of the design goal.
2. **Requests handled by the service operator by e-mail, manual SQL.** Pros: no product work. Cons: not "tenant-triggered", not
   practical at scale, error-prone, unaudited; direct SQL by people is exactly what ADR-0003 limits.
3. **Tenant-triggered, content-based deletion with preview, run as an audited job (chosen).** Pros: covers the data
   that can actually be personal; self-service; auditable; reuses retention machinery. Cons: must know where every
   copy lives (engine, aggregates, backups); deletion from backups is by expiry only.
4. **Rewrite instead of delete** (replace matching values by a placeholder). Pros: keeps totals intact. Cons: still a
   form of erasure of the value, and pointless for event rows, which can simply be deleted. Relevant only to aggregate
   breakdowns; not adopted — matching breakdown rows are deleted and site totals remain (C-46).

## Decision
**Scope.** Erasure concerns personal data that leaks into **paths, custom-event names and properties** (page titles
are not collected, C-89), in web event data, in our daily web aggregates and in **API routes** (C-46). Visitor-level
requests are answered with the Art. 11 statement and the opt-out mechanism.

**Who.** A tenant `owner` or `admin` (ADR-0014), for its own sites only. Every site or service identifier in the
request body is resolved under the caller's tenant context, and the job looks sites up by `(tenant_id, site_id)`, so
a foreign identifier behaves like a missing one (C-87; RLS, composite foreign keys and the isolation matrix apply).
**Confirming an erasure needs a fresh sign-in at most 10 minutes old** by the member's own method — a passkey
assertion if one is registered (C-87).
SCF operators can run the same job for tenant removal (ADR-0015) and record the reason.

**Selectors** (combinable): site; time range (`start` inclusive, `end` exclusive, UTC — C-86); path pattern; event name; property key; and, for API data, service
and route pattern (C-46). The pattern language and request schema are specified in `docs/api/` and
`docs/contracts/`, not here.

**Flow.**
1. **Preview.** The request shows a count of matching events (and matching aggregate rows) before anything is
   deleted; the tenant confirms. Previews read only the tenant's own data.
2. **Job.** A queued job in `services/jobs`, running under the tenant's own context (C-87), deletes matching rows —
   in the site's main Umami website and, if it exists, its twin website for events without a visitor identifier
   (C-73) — in the `umami` database through the
   `scf_umami_maint` role (DELETE on the event, session and their data tables only; C-12 — ADR-0003 allows direct SQL
   only for retention and erasure). In `scf` it **deletes** matching daily-aggregate breakdown rows (path, event name
   or property); **site totals remain**, so totals stay consistent with what was counted (C-46). Route entries
   matching an API route pattern are erased as well (C-46). The job is idempotent and resumable; it records counts per
   store.
3. **Audit.** Request, preview count, confirmation, start, per-store counts and completion are written to the
   hash-chained audit log (ADR-0014). **The audit log records the selector type and the counts, never the literal
   value** (C-88). **Selectors are not kept:** the literal selector (a path, an event name, a property key) is stored
   on the request only until the job has finished plus 56 days — matching the backup window, so any restore can
   re-apply every erasure — and is then replaced by its type and length (C-88 as corrected by C-111, C-112).
   Audit rows reference user IDs, not names: when a portal account is deleted its profile fields are removed and a
   tombstone keeps the ID, so the hash chain stays valid and the log no longer names the person (C-57). Portal account
   data and audit logs are the service operator's own data as controller (C-59), so this is the service operator's
   erasure path, not the tenant's.
4. **Report.** The tenant sees completion and per-store counts, and a statement of what was not erased immediately
   (backups), with the date by which the last backup copy expires.

**Backups.** Backups are not edited (database nodes write them with credentials that cannot delete or overwrite;
expiry is by bucket lifecycle, C-66 — superseded by C-108: versioned containers, previous versions deleted after 14 days); erased data disappears as backups expire on the retention schedule of ADR-0021
(C-29: weekly full and daily differential pgBackRest backups with a 35-day point-in-time window; weekly logical dumps
kept 5 weeks). Erased or expired data therefore leaves all backups **within 56 days** (35-day retention + up to 7 days until the
next full + 14 days as a previous version, `docs/data-model.md` §14; C-112), which the completion report
states with the date. Transient stores already have short
bounds: gateway spool ≤ 72 h, deleted on acknowledgement; there are no spool copies in object storage (ADR-0011,
C-77);
logs never contain request content (ADR-0022).

**Whole site or tenant.** Removing a site or tenant uses the same machinery with selector "everything", after the
30-day grace period for removals by an SCF operator (ADR-0015, C-08). A removed tenant leaves tombstones for its
domains, GitHub identity and Stellar accounts that block re-enrollment until an `operator_admin` lifts them (C-64);
they hold identifiers of the tenant, not of visitors.

**End users** are directed to the tenant, which is the controller. The platform gives the tenant notice text
explaining the Art. 11 position, the opt-out, what can be erased (content leaked into paths and custom events)
and how; plus a response template for Art. 15–17 requests. The service operator's own channel (security/privacy
contact) forwards any request about tenant analytics to the tenant without storing the personal data in a public
tracker, and handles requests about portal accounts itself.

## Consequences
Positive: the set of people who can exercise erasure is reduced to those whose details leaked into content, and for
them the tenant can act without help from the service operator; the same job serves tenant removal and retention.

Negative: after 35 days the tenant can no longer see exactly what an old erasure targeted, only its type, length
and counts (C-88); totals shown before and after erasure can differ, and historical aggregates computed from since-expired
event rows cannot be recomputed; erasure from backups is delayed until expiry; a broad pattern can delete legitimate
analytics, which the preview mitigates but cannot prevent; the job depends on Umami's table layout, which is not a
public API.

Must do: a test that the literal selector is gone after completion plus 56 days (C-112) and never appears in the audit log
(C-88); a test that a foreign `site_id` in the request body is refused like a missing one (C-87); contract tests for
the erasure job against the pinned Umami image and nightly against upstream's newest tag
(ADR-0003, ADR-0026); an e2e test that seeds leaked values, runs preview and job, and asserts they are absent from
engine, aggregates (breakdown rows gone, site totals unchanged), API routes and API responses; documentation in `docs/privacy/erasure.md`.

Revisit if: counsel does not accept the Art. 11 position for event-level pseudonymous rows; Umami changes its schema
in a way that makes direct deletion unsafe (then contribute an upstream deletion API or move erasure behind the
`patches/` queue).

Unproven: no part has run. Direct SQL against Umami v3.5.0 tables has been read at source level only; Docker was
unavailable at design time, so the environment behind **S-01**/**S-02** has not been exercised either.

## Open points
1. Open: **Metric rows of an erased API route.** C-46 brings API routes into scope but does not say whether their
   counts and histograms are deleted with the route or kept under a placeholder route (the web rule "site totals
   remain" suggests the latter). Closed by fixing it in `docs/data-model.md`.

(Web aggregates are settled by C-46; backup expiry by C-29; departed users in the audit log by C-57; selector
retention by C-88; tenant scoping and fresh sign-in by C-87.)
