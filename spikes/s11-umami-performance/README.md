# S-11 — Umami 3.5.0 on PostgreSQL 18: dashboard latency and ingest at the design web load

**Result:** FAIL. At 1M page views/day, Umami's stats API misses the target (p95 < 1 s for 30 days, < 3 s for 90 days)
for every tenant above about 3k page views/day. It fails with or without the `tag` filter. The largest tenant fails
from 7 days, a 19k/day tenant from 30 days, and only small tenants pass at 90 days. Ingest is fine: about 400
events/s, which is 33× the design average. The fallback works: daily aggregates answer a 90-day dashboard in under
10 ms. **Recommended live window: N = 1 day.**

## Question

Is Umami 3.5.0 on PostgreSQL 18 fast enough to serve tenant dashboards live over the 90-day event-level window at the
design load, including with a filter on the event `tag` column, and how fast does it ingest?
(S-11; C-54, C-73, C-82, ADR-0011, ADR-0024.)

## Method (versions, commands, how to re-run: one command if possible)

**Re-run:** `spikes/s11-umami-performance/run.sh` runs everything in about 3.5 h on this machine: compose up, 300
websites, 90 days of data, all benchmarks, sizes, then `down -v`. Single phases can be run with `./run.sh <phase>…`
(`up setup load_drop load_slices measure_mode sizes warm conc cold cover rollup ingest down`). Secrets (DB password
and `APP_SECRET`) are generated into `.state/`, which is git-ignored.

**Images.**
- `ghcr.io/umami-software/umami:3.5.0@sha256:b64f40400d77bcadd39cf5c62a1e368c99524ca442024f96e1133355a19a5dbc`, the
  source tag v3.5.0 at commit `d3c62a8`.
- `postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` (PostgreSQL 18.6).
  `postgres:18-alpine` was not pulled on this machine, so 18.6-alpine, the current 18.x, was used.
- Compose project `scf-s11`. Ports are bound to loopback only: Umami on 18700, PostgreSQL on 18701.

**Umami env.**
- `TZ=UTC`, `DISABLE_TELEMETRY=1`, `DISABLE_UPDATES=1`, `PRIVATE_MODE=1`, `APP_SECRET`, `DATABASE_URL`.
- Automatic migrations at start.
- Container limits: 2 vCPU, 2 GB.

**PostgreSQL ("small dedicated DB server", Hetzner CCX23 class: 4 vCPU / 16 GB).**
- Container limits: `cpus: 4`, `mem_limit: 16g`. The cgroup limit also caps the OS page cache at 16 GB.
- `shared_buffers=4GB`, `effective_cache_size=12GB`, `work_mem=32MB`, `maintenance_work_mem=1GB`,
  `max_parallel_workers_per_gather=2`, `max_parallel_workers=4`, `random_page_cost=1.1`,
  `effective_io_concurrency=200`, `max_wal_size=8GB`, `wal_compression=lz4`, `pg_stat_statements`. JIT is on (default).
- During seeding only, the limits were raised to 8 vCPU / 24 GB.

**Host.**
- Intel Core Ultra 5 225, 8 cores, 58 GB RAM, cloud VM disk.
- The host is **shared with other projects**: load average was 2–10 at the start.
- The disk delivered about 290 MB/s during index-driven heap reads: 722,763 blocks in 19.3 s in an `EXPLAIN (ANALYZE, BUFFERS)`.

**Data (`sql/gen_slice.sql`, `bench/sites.py`).**
- **Sites.** 300 websites created through `POST /api/websites`. Daily page views follow `pv ∝ 1/(i+1)^1.3`, scaled to
  1,000,000 per day: site 1 = 174,255, site 10 = 18,998, site 150 = 631, site 300 = 257.
- **Window.** 90 daily slices ending at t0 = 2026-11-12 15:00 UTC. The rows were inserted directly with `INSERT … SELECT`,
  8 slices in parallel, each slice ordered by `created_at`, so the heap interleaves tenants as in production.
- **Sessions and events.**
  - Sessions follow a diurnal profile (N(14:00, 5 h)); weekdays are weighted ×1.08 and weekends ×0.8.
  - Events per session are geometric: mean 2.5, P(1) = 0.4. 5 % of events are custom (`event_type` 2).
  - `visit_id` = hash(session, clock hour), as Umami does it.
- **Tag.** `tag` is `v` for 85 % of sessions and `s` for 15 %, applied per session. The result is 15.0 % of events.
- **Session attributes.** Skewed distributions over 20 countries, 10 browsers, 6 OSes, 4 devices, 8 screens and 10
  languages; regions and cities are synthetic.
- **Paths and referrers.** Paths are Zipf-like over `max(10, min(2000, pv/50))` pages. 45 % of sessions are direct, and
  the rest come from 10 major referrers plus a long tail of 500.
- **Storage conventions.** These follow what Umami itself writes. Before seeding, `/api/send` was probed by hand and
  the result showed:
  - `url_query=''` when the URL has no query;
  - direct visit: all `referrer_*` columns NULL;
  - external referrer: `referrer_path='/'`, `referrer_query=''`;
  - internal navigation: referrer path kept, domain NULL.
- **Indexes.** The 25 Umami indexes and the 2 primary keys were dropped before the load and rebuilt from their exact
  `pg_indexes` definitions. `VACUUM (ANALYZE)` was run afterwards.

**Latency (`bench/latency.mjs`).**
- **Setup.** Admin login, then the overview-page endpoints with `startAt`/`endAt` = t0 − range … t0 and `timezone=UTC`.
  The tag filter is `tag=eq.v`.
- **Endpoints.** `/stats`, plus `/pageviews` with `unit=hour` for 24 h and `unit=day` otherwise, plus
  `/metrics?type=path|referrer|browser|os|device|country|event&limit=10`. That is 9 requests per dashboard load.
- **Sites.** large = site 1 (174k/day, 18 % of all rows), medium = site 10 (19k/day), small = site 150 (631/day).
  Ranges: 24 h, 7 d, 14 d, 30 d, 90 d.
- **warm, c=1.** One warm-up pass is discarded, then 10 passes. The count drops to 3 passes when the warm-up took more
  than 20 s, and to 1 when it took more than 60 s, because some passes take minutes.
- **conc, c=10.** 10 clients each load the full dashboard concurrently: 90 requests per combination. This was run only
  for combinations that pass, or nearly pass, at c=1, because the others already fail.
- **cold.** Before each dashboard load, PostgreSQL is restarted with `debug_io_direct=data`, so neither shared
  buffers nor the OS page cache hold data. This is a pessimistic "nothing cached" case. The first request after a
  restart also pays connection setup.

**Other phases.**
- **Ingest (`bench/ingest.mjs`).** `POST /api/send` as our gateway will send it:
  - a surrogate address from `2001:db8::/32` in `x-forwarded-for`;
  - `cf-ipcountry`;
  - a real browser User-Agent and `tag` v or s;
  - the cache token reused within a visit of 1–5 page views;
  - site choice weighted by volume.

  Runs: closed loop at c = 1, 5, 10, 25, 50, and open loop (Poisson arrivals) at 12/s and 120/s, 120 s each. CPU is
  taken from cgroup v2 `cpu.stat` and reported as cores used.
- **Fallback test (`sql/rollup.sql`).** Daily totals per site, day and tag, plus top-100 values per dimension, built
  from Umami's tables. The test times the one-day job, the 90-day backfill and the 90-day dashboard reads.
- **Side experiment (`sql/covering_index.sql`).** One extra covering index, dropped afterwards.

## Observations (raw facts, with excerpts of output)

**Load** (`results/run.log`):

```
94,645,801 website_event rows, 89,914,324 page views (event_type 1), tag s = 15.0 %, 37,861,072 sessions, 300 sites
generation 267 s; rebuild of 2 PKs + 25 indexes 1,414 s; VACUUM ANALYZE 62 s
```

**Storage** (`results/sizes.txt`). Indexes are freshly built, so these are a lower bound; organically grown B-trees are
larger.

| table | rows | heap | indexes | total | bytes/row |
|---|---|---|---|---|---|
| website_event | 94.7 M | 15 GB | 56 GB (15 indexes; largest `…created_at_hostname` 6.1 GB) | 71 GB | 800 |
| session | 37.9 M | 4.9 GB | 18 GB (12 indexes) | 23 GB | 654 |
| **90-day window** | | | | **94 GB** | |

That is **≈ 1.05 GB per day** of growth (about 1 GB per million page views), or 379 GB per year if kept. Indexes are
77 % of the footprint.

**Dashboard latency.** Per-request p95 over the 9 dashboard endpoints, in seconds, with the slowest endpoint (almost
always `stats`) in brackets. Full tables, including p50 and per-endpoint values, are in
`results/latency-summary.md`; the raw data (3,834 requests, all HTTP 200, none timed out) is in `results/latency.csv`.

| site (pv/day) | range | warm c=1, no filter | warm c=1, `tag=eq.v` | c=10 no filter / tag | cold no filter / tag |
|---|---|---|---|---|---|
| large (174k) | 24 h | 0.36 (0.38) | 0.51 (0.52) | 4.58 / 2.79 | 3.31 / 3.54 |
| large | 7 d | 3.34 (3.75) | 4.57 (5.01) | — | 17.7 / 8.5 |
| large | 14 d | 14.2 (15.3) | 7.1 (7.5) | — | — |
| large | **30 d** | **31.5 (43.1)** | **21.3 (30.9)** | — | — |
| large | **90 d** | **23.6 (24.3)** | **22.6 (23.5)** | — | — |
| medium (19k) | 24 h | 0.07 | 0.08 | 0.38 / 0.29 | 1.48 / 1.45 |
| medium | 7 d | 0.42 | 0.56 (0.64) | 3.28 / 2.19 | 2.75 / 2.92 |
| medium | 14 d | 0.81 | 1.53 (1.63) | 5.32 / 6.32 | 6.07 / 6.77 |
| medium | **30 d** | **10.0 (10.5)** | **4.8 (5.7)** | — | — |
| medium | **90 d** | **34.0 (35.9)** | **120.9 (183.4)** † | — | — |
| small (631) | 24 h | 0.02 | 0.02 | 0.19 / 0.16 | 0.19 / 0.18 |
| small | 7 d | 0.04 | 0.05 | 0.27 / 0.22 | 0.75 / 0.85 |
| small | **30 d** | **0.08** | **0.11** | 2.19 / 0.42 | 3.04 / 3.36 |
| small | **90 d** | **0.18** | **0.19** | 0.82 / 0.79 | 1.28 / 4.48 |

† A single sample (the adaptive rule allowed 1 rep). `stats` with an event filter uses a different SQL branch, which
joins visit-level aggregates (`getWebsiteStats.ts`).

**Why it is slow.** `EXPLAIN (ANALYZE, BUFFERS)` of Umami's own `getWebsiteStats` SQL for the large site over 30 days:

```
Index Scan using website_event_created_at_idx … Rows Removed by Filter: 26217685   (all tenants' rows in the range)
Buffers: shared hit=86399 read=722763 (5.5 GiB) … I/O Timings: shared read=19264 ms
HashAggregate … Batches: 33 Disk Usage: 325216kB; Sort Method: external merge Disk: 159528kB
Execution Time: 27305 ms
```

- **No covering index.** None of the 14 indexes covers `(session_id, visit_id, event_type)`, so every event in range
  costs a heap visit. For a large tenant the planner prefers the `created_at` index and filters out every other
  tenant's rows.
- **`/stats` runs twice.** It always runs the query a second time for the comparison period
  (`api/websites/[websiteId]/stats/route.ts`), which roughly doubles the cost: 58–87 s via the API against 27 s for
  one direct SQL run.
- **Breakdowns join `session`.** Country, browser, OS and device breakdowns join the `session` table
  (`getSessionMetrics.ts`).
- **The tag filter is not the cause.** Filtered and unfiltered queries are the same order of magnitude; the cost
  scales with the events in range per tenant. The empirical bound for p95 < 1 s warm is roughly **≤ 250k events per
  query**, e.g. large 24 h ≈ 180k → 0.4–0.5 s; medium 14 d ≈ 280k → 0.8–1.6 s; large 7 d ≈ 1.2M → 3.8–5 s.
- **The working set does not fit.** A 30-day range of a large tenant touches nearly every heap page of those 30 days,
  which exceeds the 16 GB cache. Repeated runs therefore stay slow. Large 90 d is faster than large 30 d because the
  planner switches to a parallel sequential scan.

**The tag filter is correct.** For the small site over 7 days, the API returned `pageviews` 4,449 unfiltered, 3,685
with `tag=eq.v` and 764 with `tag=s`. SQL ground truth: v = 3,685, s = 764.

**Side experiment: covering index** (`results/covering-index.txt`). Index:
`CREATE INDEX … ON website_event (website_id, created_at) INCLUDE (session_id, visit_id, event_type, tag)`, size
7.75 GB, build time 81 s. Times are for one run of the stats SQL, warm, before → after:
- large 7 d: 1.3 s → 0.73 s;
- large 30 d: 17.3 s → 4.4 s;
- large 90 d: 15.6 s after;
- medium 30 d: 0.68 s → 0.32 s;
- medium 90 d: 1.1 s after.

Remember that `/stats` runs this SQL twice and the breakdowns still join `session`. The index therefore helps
mid-sized tenants but does not fix the largest one, where the query is CPU-bound on aggregating 5.5M rows.

**Fallback: daily aggregates** (`results/rollup.txt`).
- **Daily job** for the most recent day, all 300 sites:
  - totals per site, day and tag: 2.5 s (600 rows);
  - top-100 per dimension (7 dimensions, joined with `session`): 31 s (65,812 rows).
- **Backfill** of the 89 other days, totals only: 166 s.
- **Size.** Totals for 90 days: 8.7 MB. Top-N for 90 days: 542 MB, 5.9M rows.
- **90-day reads, largest site:**
  - totals (`tag='v'`): **6 ms**;
  - daily series: **1.4 ms**;
  - top-10 paths: **0.6 ms**, top-10 countries: **2.1 ms**.

**Ingest** (`results/ingest.jsonl`; all 211,659 requests answered 200 with a cache token; 0 errors):

| load | events/s | p50 ms | p95 ms | p99 ms | Umami CPU (cores) | DB CPU (cores) |
|---|---|---|---|---|---|---|
| open loop 12/s (design average) | 11.9 | 15 | 24 | 31 | 0.07 | 0.04 |
| open loop 120/s (10× burst) | 120.4 | 21 | 49 | 83 | 0.58 | 0.23 |
| closed c=1 | 100.5 | 9 | 17 | 23 | 0.46 | 0.12 |
| closed c=5 | 333.3 | 13 | 29 | 37 | 0.97 | 0.35 |
| closed c=10 | **424.3** | 20 | 42 | 51 | 1.10 | 0.44 |
| closed c=25 | 385.1 | 45 | 125 | 144 | 1.07 | 0.40 |
| closed c=50 | 388.3 | 80 | 257 | 281 | 1.14 | 0.41 |

One Umami container saturates at **about 400 events/s**, limited by Node's single event loop at about 1.1 cores, not by
PostgreSQL. This ran against the 94.7M-row table with all 14 indexes in place.

## Answer to the question

**No.** Umami 3.5.0 on PostgreSQL 18, on a 4 vCPU / 16 GB database server, cannot serve the 90-day window live at
1M page views/day.
- **Who fails.** The criterion (30 d < 1 s, 90 d < 3 s) is met only by small tenants. The medium tenant (19k pv/day)
  misses at 30 d (10.5 s) and 90 d (36 s), and the largest (174k pv/day) at 30 d (43 s) and 90 d (24 s). The largest
  is already over 3 s at 7 d.
- **Filtering.** Filtering by `tag` works (`tag=eq.v`) but does not change the picture.
- **Concurrency and cold cache.** Ten concurrent dashboard loads, or a cold cache, multiply latency by 3–10×. At c=10
  even the largest tenant's 24-hour view reaches a p95 of 4.6 s.
- **Fallback.** Serving ranges older than N days from our own daily aggregates fixes it: 90-day reads take under
  10 ms.
- **Choice of N.** The live part must stay under about 250k events per query. With a single platform-wide value,
  **N = 1 day** (the last 24 hours/today) is the only one that passes for the largest tenant at c=1 (0.52 s with the
  tag filter). If N may depend on the site's volume, it is N = clamp(⌊250,000 / daily events⌋, 1, 90) days: about
  13 days for a 19k/day site, and 90 days for sites under about 2.8k/day (most of the long tail).
- **Ingest** is not a constraint. One Umami instance sustains about 400 events/s, 33× the design average and 3.5× the
  10× burst. At the 10× burst it uses 0.6 cores with p95 49 ms.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)

1. **C-54 must change.** Replace "Tenant dashboards are live and filterable for that window through Umami" with:
   "Tenant dashboards query Umami live only for the most recent **24 hours** (the live window, setting
   `web_live_window_days`, default 1). All older days in the 90-day event-level window, and all ranges beyond it, are
   served from our aggregates." Event-level retention stays at 90 days: the raw data is still needed for erasure, for
   rebuilding aggregates and for drill-down exports.
   The configurable maximum of 395 days needs a **storage note**: at about 1.05 GB/day it means about 415 GB for
   Umami alone (lower bound).
2. **C-82's first fallback becomes the primary path** for ranges older than the live window, independent of S-01's
   outcome. The read-only, contract-tested SQL view over `website_event` and `session` feeds an **hourly** rollup.
   Daily rows alone cannot draw the 7-day hourly chart. It covers:
   - totals per site, hour (or day) and tag;
   - top-N breakdowns by path, referrer, country, device, browser, OS and event.

   Measured costs: totals 2.5 s per day for all sites; top-N 31 s per day.
3. **C-73 must be amended.** For ranges older than the live window, visits, bounce rate and visit duration cannot be
   "computed by Umami in a single query". Our rollup job must compute them with Umami's exact definitions. Those are
   reproduced in `sql/rollup.sql`, from `getWebsiteStats.ts`: one visit = (session_id, visit_id); a bounce = 1
   pageview and no custom event.
   **Unique visitors are not additive across days.** The tenant-facing definition for multi-day ranges must be decided
   (see Open issues).
4. **ADR-0011.** Web rollups need an hourly grain for at least the 90-day window (or 7 days) next to the indefinite
   daily rows. They are written by an hourly job over the Umami view, using the shape in `sql/rollup.sql`.
5. **ADR-0024 / control-plane API.**
   - The portal never calls Umami for a range starting more than 24 h ago. The control-plane API splits a request into
     a live part (Umami, last 24 h) and an aggregate part, then merges them.
   - Do not call Umami's `/stats` for ranges the portal does not need: `/stats` always runs a second comparison query.
6. **Database sizing.**
   - The 90-day window is 94 GB of Umami tables, and that is a lower bound. With WAL, the aggregates, our `scf` tables
     and headroom, the database host needs at least **250 GB of disk**.
   - The Lean tier's CPX32 (160 GB) is too small. The CCX23 class (160 GB) also needs an attached volume.
   - The working set exceeds 16 GB RAM; more RAM helps cold and warm latency only up to a point.
7. **ADR-0026 load test at 10× is confirmed feasible for the ingest path.** 120 events/s gives p95 49 ms on one Umami
   container.

## Values the implementation must use (env vars, headers, config keys, flags, limits)

- **Tag filter on every Umami stats endpoint:** query parameter `tag=eq.v` (also accepted: `tag=v`, `tag=neq.s`, or a
  comma list `tag=eq.v,s`). It is parsed by `parseFilterValue` in `src/lib/params.ts`. Column mapping: `tag` → `tag`
  (`FILTER_COLUMNS`).
- **Range parameters:** `startAt` and `endAt` in epoch milliseconds, `timezone=UTC`, `unit=hour|day` for `/pageviews`.
  `period` may not be combined with an explicit range (zod refine in `src/lib/schema.ts`).
- **Overview endpoints:**
  - `GET /api/websites/{id}/stats`, which also runs the comparison period;
  - `/pageviews`;
  - `/metrics?type=path|referrer|browser|os|device|country|event|…&limit=10`.
- **Live window:** `web_live_window_days = 1` (default). Do not exceed about **250k events per live query** (p95 ≈ 1 s
  warm, c=1, on 4 vCPU / 16 GB).
- **Ingest capacity:** plan for **≤ 300 events/s per Umami container**, which is about 75 % of the measured 400/s
  saturation at about 1.1 cores. Scale horizontally beyond that.
- **Storage planning:** 1.05 GB per day per 1M page views for `website_event` + `session` (800 B per event row and 654 B
  per session row, including indexes).
- **PostgreSQL baseline used** (as in `compose.yml`): `shared_buffers=4GB`, `effective_cache_size=12GB`,
  `work_mem=32MB`, `maintenance_work_mem=1GB`, `random_page_cost=1.1`, `effective_io_concurrency=200`,
  `max_parallel_workers_per_gather=2`, `max_wal_size=8GB`, `pg_stat_statements` preloaded.

## Open issues

- **Hardware and data are approximations.**
  - This is a shared cloud VM with other workloads (load average 2–10) and a disk of about 290 MB/s, not the ordered
    Hetzner host.
  - Indexes were freshly built: no B-tree bloat, and a heap without updates or deletes. A production table that grows
    organically and is pruned by a daily delete job will be larger and slower.
  - Both factors could move the numbers by perhaps ±2×. The conclusion would not change: the largest tenant is
    20–40× over budget at 30 days.
- **The cold method** (`debug_io_direct=data`) bypasses kernel readahead, so it is pessimistic. The first request after
  a restart also includes connection setup, which is why "cold small 30 d stats" is 4.5 s.
- **Not every combination was measured.**
  - c=10 and cold were not run for combinations that already fail at c=1, because they can only be worse.
  - The large and medium 30 d/90 d warm figures rest on 1–3 passes each.
  - The 14 d pass mark of < 1 s is my own choice; the plan defines only 30 d and 90 d.
- **Unique visitors over multi-day ranges from aggregates.** The options are the sum of daily uniques (inflated),
  HyperLogLog sketches per day (the `postgresql-hll` extension, approximate but mergeable), or showing "average daily
  visitors". This needs a product decision and an update to the metric definitions. Note that Umami's own visitors are
  already per salt period (month).
- **Umami ClickHouse mode was not tested.** It is Umami's own answer, a pre-aggregated hourly table. It would reopen
  the erasure question: ClickHouse deletion is not implemented, see the Umami data-model reference §3.11.
- **The covering index helps mid-sized tenants** (medium 90 d stats SQL 1.1 s). Adopting it would be a deviation from
  Umami's schema (+7.75 GB, extra write cost, and it must be re-checked on every Umami upgrade). It is not needed if
  N = 1.
- **Whether tenants see Umami's own UI.** If tenants ever see Umami's UI directly rather than our portal, its date
  picker allows 90-day ranges that will take tens of seconds and load the shared database. The UI must stay internal,
  or the database needs a `statement_timeout` for the Umami role (not tested).
