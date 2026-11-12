# ADR-0011: Retention and rollups

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** retention.aggregates-24m, retention.raw-metrics, dashboard.api-time-ranges, privacy.gdpr-no-consent, privacy.minimal-erasure-scope, privacy.tenant-erasure, dashboard.time-ranges

## Context
UsageMap retains aggregated views for at least 24 months (preferably longer); raw-metric retention is set for
operational troubleshooting. Dashboards offer selectable time ranges; the platform is GDPR-compliant and minimises the
set of users who can exercise the right to erasure.

What research established:
- **Privacy.** CNIL recommendation 2020-092 (consolidated 16 Jan 2026) and the AEPD guide keep, for consent-exempt
  audience measurement, a tracer life of ≈ 13 months and **at most 25 months for collected information**. Aggregates
  with small-cell suppression are anonymous if singling out, linkability and inference are excluded (Recital 26),
  which is what allows aggregates beyond 25 months; whether the 25-month cap reaches anonymous aggregates is a
  counsel question. The privacy stream recommended a short event-level default (30–90 days).
- **Volume.** Umami event-level data was estimated at 35–70 GB/year (planning estimate), i.e. roughly
  9–17 GB for a 90-day window. API rows are ≈ 270 B on disk; 1h rows for 24 months are 14–94 GB depending on series
  count; 1d rows ≤ 10 GB for 24 months even in the high scenario; 1m rows ≤ 270 MB/day worst case (≤ 9.5 GB for
  35 days). Planning numbers, not measurements.
- **Mechanics.** Plain PostgreSQL: dropping a partition is instant and avoids vacuum bloat; TimescaleDB retention
  policies are TSL and excluded. A detached partition keeps no RLS flags (test T18), so it must be dropped at once.
  Umami has no retention feature; its tables are Prisma-managed and not partitioned by us.

## Options considered
1. **Short raw, long aggregates, short event-level web data (chosen).** API 1m short, 1h medium, 1d indefinitely;
   web event level 90 days by default (settable 30–395 days; 395 days is the hard maximum) with daily aggregates
   indefinitely. Pros: meets ≥ 24 months for every aggregate; bounded disk; the smallest event-level personal-data
   footprint that still leaves tenants a quarter of live, filterable history. Cons: tenants lose Umami's native
   session and funnel views and arbitrary filters beyond the event-level window; older ranges show only totals and
   the stored top-N breakdowns.
2. **Event-level web data for 13 months by default (up to 25), daily aggregates indefinitely.** Pros: tenants keep
   Umami's event-level reports for a full year. Cons: four times the event-level footprint of option 1; the earlier
   draft default, replaced by C-54.
3. **Keep everything for 25 months, delete after.** Pros: simple, one number. Cons: event-level web data for
   25 months multiplies web storage and personal-data exposure; nothing beyond 25 months although longer aggregate history is
   preferred.
4. **Recompute rollups from raw by scheduled jobs.** Cons: rollups vanish when raw is dropped unless frozen; more
   moving parts than the writer's transactional fan-out (ADR-0010).

## Decision

| Data | Where | Retention | Enforced by |
|---|---|---|---|
| API 1-minute rows | `scf.api_metrics_1m` | 35 days | dropping partitions |
| API 1-hour rows | `scf.api_metrics_1h` | 25 months | dropping partitions |
| API 1-day rows | `scf.api_metrics_1d` | **indefinitely** (design minimum 24 months) | — |
| Web event-level data | `umami` database | **90 days** default; settable **30–395 days** platform-wide by an `operator_admin` (395 days is the hard maximum); a tenant may choose a shorter period per site (C-54, C-18) | scheduled delete job as `scf_umami_maint` (C-12) |
| Web daily per-site aggregates: totals plus top-N breakdowns by referrer host, country, device, browser, OS, path, event name; page views and unique visitors verified and raw, visits, bounce rate and duration one figure each with the suspect page-view share (C-73) | `scf` | **indefinitely** | — |
| Gateway spool entries (local) | edge disk | deleted on acknowledgement; an event not delivered within **72 h** is discarded and counted (C-18) | gateway |
| Collector persistent queue | edge disk | a metric batch not delivered within **72 h** is discarded and counted (C-18) | Collector queue configuration |
| Writer de-duplication ledger | `scf` | **7 days** (C-18) | delete job |
| Rejected-event and verdict/reason counters (per site, per day) | `scf` | 25 months | dropping partitions / delete job |
| Audit log (including every SCF operator read of tenant data) | `scf` | life of the service; departed users are tombstoned, not deleted (C-57) | — |
| Trust scores, assurance levels, on-chain daily counts | `scf` | **indefinitely**, with the aggregates; none is personal data (C-71) | — |
| Erasure request selectors (path, event name, property key) | `scf` | until the job has finished **plus 56 days** (C-111, C-112), then replaced by their type and length; the audit log records only the selector type and counts (C-88) | delete job |
| Portal accounts | `scf` | until deleted by the member, then removed within **30 days**; a tombstone keeps the ID (C-71, C-57) | delete job |
| Operational logs | VictoriaLogs on `mon-c` | **30 days** (C-71) | log retention setting |
| Monitoring metrics | Prometheus on `mon-c` | **13 months** (C-71) | Prometheus retention setting |
| Re-enrollment tombstones for removed tenants (domains, GitHub identity, Stellar accounts) | `scf` | until an `operator_admin` lifts them (C-64) | — |
| Backups (pgBackRest, two repositories) | UpCloud and OVHcloud object storage | 35-day point-in-time window (weekly full, daily differential); weekly logical dumps kept 5 weeks (C-29) | pgBackRest expiry / bucket lifecycle (ADR-0021) |

- **The 72-hour cap is deliberate (C-18).** An event or metric batch that cannot be delivered for 72 hours is
  discarded and counted. The durability objective therefore reads "no accepted event is lost unless it could not be
  delivered for more than 72 hours" (ADR-0031). Spool-age alerts fire at 1 h, 6 h and 24 h, and a named person
  checks the alert channel once per calendar day (C-49).
- Rollups for API data are produced by the writer's additive upserts (ADR-0010), so 1h and 1d rows exist before 1m
  rows are dropped. Web daily aggregates are produced by the `jobs` service reading Umami through the adapter
  (ADR-0003), from each site's main and twin websites (C-73), and written to `scf` under RLS; if S-01 fails, the
  same job computes them from Umami's event table through the read-only view of C-82; the job holds a PostgreSQL advisory lock, so only one core node runs it
  (C-07). Every retention job takes the same kind of lock.
- **Dashboards.** API dashboards pick the resolution from the requested range: 1m inside 35 days, 1h inside
  25 months, 1d beyond. Tenant web dashboards are live and filterable through Umami for the event-level window;
  older ranges are served from the daily aggregates (totals and top-N breakdowns) (C-54).
- **Backups.** Erased or expired data leaves all backups within 56 days (C-29 as corrected by C-112; `docs/data-model.md` §14);
  the erasure report states this (ADR-0030).
- **No spool copies to object storage** (C-77; C-11 is withdrawn). The only copy of an undelivered web event is the
  edge node's local spool; an event on a node that is permanently lost before it forwards is lost (ADR-0020).
- Partition drops run in the same transaction as any `DETACH`; no detached partition is left standing.
- Exact table and partition definitions are owned by `docs/data-model.md`.

## Consequences
- Positive: "aggregated views ≥ 24 months" is met by 1d (API) and daily aggregates (web) with no end date; storage
  stays bounded; event-level web data is kept for 90 days by default and can never exceed the CNIL/AEPD 25-month
  figure.
- Positive: retention for API data costs nothing at run time (partition drop); no rollup cron to fail silently.
- Negative: after the event-level window (90 days by default) a tenant can no longer see sessions, paths outside the
  stored top-N, or arbitrary filters for old periods; multi-day unique visitors remain sums of daily uniques
  (ADR-0007). The dashboard must make the switch from live to aggregate data visible.
- Negative: an outage longer than 72 hours between an edge node and every core node loses the undelivered events and
  metric batches; they are counted and reported, not silently dropped.
- Negative: 1h for 25 months is up to ≈ 95 GB in the high scenario; against the 150 GB volumes in ADR-0018 this is
  the largest single consumer and must be watched.
- Negative: indefinitely kept web aggregates include paths and event names. Web page paths are scrubbed by
  `pathnorm` at the gateway before anything is stored (C-52, ADR-0012), and erasure selectors also delete matching
  breakdown rows in our daily aggregates and matching API routes, leaving site totals (C-46, ADR-0030). In the
  tenant's own dashboard, rows below the minimum count are merged into "Other" and counts rounded to 10 while
  `anonymous_reports` is on, which is the default (C-51); a tenant that switches it off sees exact small counts.
- Negative: deleted data persists in backups for up to 35 days (C-29); the privacy pack states that window.
- Must do: test each retention job (rows
 older than the limit absent; newer rows untouched), including the
  per-site shorter period and the 395-day ceiling; alert when a partition drop or delete job fails; test the
  72-hour discard path and its counter.
- Revisit if: counsel says the 25-month cap applies to our aggregates; measured volumes differ materially from the
  estimates; operators want longer hourly history; tenants consistently ask for a longer event-level window.
- **Unproven:** the volume estimates (load spike, S-05) and the Umami delete job against the real schema (part of
  the contract tests, S-01/S-02 environment).

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- PostgreSQL metrics histograms: §3.6 partitioning and retention by partition drop;
  §3.7 size table and recommendation (1h 13 months, 1d forever).
- Privacy EU UK law: source S16 (CNIL 2020-092 consolidated 16 Jan 2026, 13/25
  months); findings on pseudonymised event rows vs anonymous aggregates; §6 item 5 retention recommendation.
- Multitenancy RLS isolation: §3.3 test T18 (detached partitions lose RLS).
- SLA availability engineering: spool design and backlog sizing (7 days of peak).
- Umami ingest datamodel tracker: Umami has no retention feature.
- Research synthesis: the event-level volume estimate.

## Open points
1. Open: the retention of the writer's per-stream cumulative-state rows (ADR-0010) is not stated; a stream that has
   been silent longer than the 48 h late-arrival window needs no state. Closed when S-05 fixes the expiry rule in
   `docs/data-model.md`.
2. Open: whether the 25-month cap also reaches anonymous aggregates kept indefinitely. Closed by counsel.
