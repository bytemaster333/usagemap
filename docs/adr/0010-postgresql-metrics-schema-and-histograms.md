# ADR-0010: PostgreSQL metrics schema and histogram representation

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** api.otlp-to-postgres-metrics, api.attribute-allowlist, api.postgres-metrics, api.attr-status-code, api.attr-latency, capacity.1m-requests-day, dashboard.api-latency-percentiles, dashboard.api-time-ranges; design trade-off DV-04

## Context
UsageMap writes standardised API metrics (counters and histograms) to PostgreSQL, gives tenants a dashboard with
latency percentiles (at minimum p50/p95) for selectable time ranges, gives the SCF operator view that aggregates and
compares the same API metrics across all enrolled projects, and is sized for ≈ 1 M requests/day. All code is
OSI-licensed. Percentiles over arbitrary ranges, routes and tenants need histograms that **merge** exactly.

What research established:
- **OTLP histogram model** (spec v1.62.0 `metrics/data-model.md`): explicit-bucket histograms (bounds, counts, sum,
  optional min/max; bucket `(b[i-1], b[i]]`) and base-2 exponential histograms (`scale`, `offset`, counts,
  `zero_count`; bucket `index` covers `(base^index, base^(index+1)]`, `base = 2^(2^-scale)`). Downscaling by
  `k = scale_src − scale_dst` with `index_dst = index_src >> k` is exact ("perfect subsetting"). The OTLP exporter
  defaults to **cumulative** temporality and **explicit** buckets; exponential is opt-in
  (`OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION=base2_exponential_bucket_histogram`, not implemented by
  Rust `opentelemetry-otlp` 0.33.1). SDK exponential defaults: MaxSize 160, MaxScale 20.
- **Default layouts merge exactly.** SDK default ms bounds `[0,5,10,25,50,75,100,250,500,750,1000,2500,5000,7500,10000]`
  divided by 1000 equal the semconv advisory seconds bounds `[0.005,0.01,0.025,0.05,0.075,0.1,0.25,0.5,0.75,1,2.5,5,
  7.5,10]` apart from the leading 0 (checked programmatically). Old-ms and new-s histograms therefore map onto one
  15-bucket layout without loss; `(-inf,0]` and `(0,5 ms]` fold into the first bucket.
- **Licensing.** TimescaleDB continuous aggregates, compression/columnstore, retention policies and jobs live under
  `tsl/` (Timescale License, not OSI); the toolkit is entirely TSL; no relicensing found (company renamed Tiger Data,
  legal page dated 2025-06-17). `ddsketch` (tvondra) is "not suitable for production use". PostgreSQL 18.6 is
  current (EOL 2030-11-14); 19 is at RC 1.
- **Writer correctness** (from ADR-0009 inputs): OTLP delivers duplicates by design; the Collector queue is
  at-least-once; cumulative streams from several instances must be keyed by `service.instance.id`.

## Options considered
1. **One fixed explicit 15-bucket layout only.** Pros: exact merge of what default SDKs send; native element-wise
   sums; small rows. Cons: no relative error bound — in a 100,000-sample log-normal simulation (median ≈ 82 ms) linear
   interpolation gave p95 **+19.2 %**; buckets such as (0.1, 0.25] s are 2.5× wide.
2. **One exponential layout only (scale 3).** Pros: ≤ 4.33 % relative error. Cons: default tenant data is explicit,
   and explicit → exponential is lossy, so most data would carry an error we cannot bound.
3. **Two fixed-length kinds, labelled per row (chosen).** Pros: default data stays exact at bucket precision;
   exponential and span-derived data get a relative bound; every percentile can state its accuracy. Cons: two code
   paths; mixed aggregates fall back to the coarser kind.
4. **Sketch extensions (t-digest, DDSketch, UDDSketch).** Pros: good accuracy. Cons: inputs arrive already bucketed,
   so a sketch adds nothing; extensions may be absent on a successor's PostgreSQL; UDDSketch is TSL.
5. **TimescaleDB hypertables and continuous aggregates.** Cons: the useful parts are TSL (excluded by ADR-0001); the
   Apache part adds little over native partitioning.
6. **Raw OTLP points as JSONB** (the unlicensed `wabb-in/postgresexporter` approach). Cons: no merge-friendly
   rollups; large rows.

## Decision
- **Plain PostgreSQL 18**, no extensions beyond `pg_stat_statements`.
- Tables `api_metrics_1m`, `api_metrics_1h`, `api_metrics_1d`, range-partitioned by time, keyed by `(tenant_id,
  service_id, route_id, method, status_code, source, bucket_start)`, with `request_count`, `duration_sum`,
  `duration_min`, `duration_max`, `hist_kind`, `hist`. The `source` key column identifies the **stream group** —
  (source kind, metric name, instrumentation scope) — so every group reporting for a service is stored separately
  and reads pick one preferred group per service per day (C-22, ADR-0009). `service.instance.id` is part of the
  cumulative-stream identity only and is not a key column. Routes live in a dictionary table carrying the path-rule
  version (ADR-0012). Column types, constraints and indexes are owned by `docs/data-model.md`.
- **Two histogram kinds**, both fixed-length `bigint[]`, so merging is element-wise addition:

| Kind | Layout | Merge | Accuracy statement shown with every percentile |
|---|---|---|---|
| `explicit15` | OpenTelemetry default boundaries, seconds: `(-inf,0.005] (0.005,0.01] … (7.5,10] (10,+inf)` — 14 bounds, 15 buckets | Exact for stable `http.server.request.duration` (advisory bounds) and legacy `http.server.duration` (ms SDK defaults ×0.001) | "The bucket containing the percentile is exact; the interpolated value can be off by up to that bucket's width" (e.g. ≤ 150 ms inside (0.1, 0.25] s; the top bucket is bounded only by `max`). |
| `exp3` | base-2 exponential, scale 3, covering 61 µs (2^-14 s) … 1024 s (2^10 s): 24 octaves × 8 = 192 buckets, plus an **underflow** bucket (below 61 µs, including the exponential zero bucket) and an **overflow** bucket (above 1024 s) (C-23) | Exact (same scale) | "Relative error ≤ 4.33 %" (inside the covered range; a percentile falling in the underflow or overflow bucket is bounded only by `min` / `max`). |
| — | tenant exponential histogram at scale < 3, mapped into `explicit15` | as `explicit15` | Accuracy class **"coarse"** (C-23). |

- **Exponential bound.** With `base = 2^(2^-scale)` and the estimator `x̂ = 2·lo·hi / (lo + hi)` inside the bucket
  `(lo, hi]`, the worst-case relative error of any quantile is `(base − 1) / (base + 1)`. At scale 3,
  `base = 2^(1/8) ≈ 1.0905`, giving `0.0905 / 2.0905 ≈ 4.33 %` (scale 2: 8.64 %; scale 4: 2.17 %). Rank is exact to
  the bucket. In the same simulation scale 3 gave p50 +3.0 %, p95 +0.8 %, p99 −2.6 %.
- **Conversion rules.** Tenant exponential histograms at scale ≥ 3 are down-scaled to scale 3 (exact); at scale < 3
  they cannot be up-scaled without loss and are mapped into `explicit15` with accuracy class "coarse" (C-23).
  Span-derived metrics are produced
  as `exp3`. Other explicit layouts are re-bucketed into `explicit15`; a source bucket that straddles a target
  boundary is split linearly and the row is flagged approximate. A percentile over rows of both kinds is computed in
  `explicit15` (exponential buckets inside one explicit bucket add exactly; the at most 15 straddling buckets are
  split log-uniformly, error confined to one exponential bucket). Every percentile carries its accuracy class.
- **Writer.** The writer **splits each batch by tenant and commits one transaction per tenant** under that tenant's
  RLS context (ADR-0013); the de-duplication ledger key is **(batch, tenant)** (C-23), the batch being identified
  by a hash of its content (stream identities, times, counts, sums, buckets). Inside each tenant
  transaction it (1) records the (batch, tenant) ledger row — a unique-key conflict means the part was already
  applied and is skipped; (2) converts cumulative streams to deltas using per-stream state in PostgreSQL —
  stream identity includes resource attributes (with `service.instance.id`), scope, metric name and point
  attributes; the state rows are **locked for update** inside the transaction; a changed start time or a decreasing
  count is a reset; points with `time ≤ last_time` are ignored; `duration_min`/`duration_max` are NULL for deltas
  taken from cumulative values; the first sighting of an already-running stream is dropped (as
  `cumulative_to_delta initial_value: auto`); (3) applies **additive upserts to all three resolutions in the same
  transaction** (`INSERT … ON CONFLICT … DO UPDATE` adding counts and arrays, `least` / `greatest` on min/max), with
  keys sorted to avoid deadlocks. No rollup jobs and no watermarks: late data lands in every resolution by
  construction. The ledger keeps 7 days (C-18).
- **Two writers, active-active (C-07).** A writer runs on each core node and reaches the current PostgreSQL primary
  through a local proxy that follows Patroni; each edge Collector exports to the writers directly with failover
between `core-a` and `core-b` if S-04 confirms it, otherwise through the gateway on loopback (C-77, ADR-0009). The
  ledger's unique key prevents double application when the same batch reaches both writers, and the row locks on
  per-stream state serialise cumulative→delta for one stream.
- **S-05: none of the SQL has been executed.** The element-wise add, the custom aggregate, the quantile function and
  upsert throughput were reviewed as sketches; the maths was checked in a Python model only. Postgres 18 could not
  be started (host disk was full at the time). *Depends on S-05.*

## Consequences
- Positive: exact merges across time, routes, services and tenants for both kinds; honest, per-series accuracy
  labels; portable to any PostgreSQL ≥ 17 a successor runs; no licence traps.
- Positive: idempotent under at-least-once delivery, multiple Collector nodes, two active writers and restarts,
  because dedupe and delta state live in the database rather than in a Collector or a writer.
- Negative: a batch spanning several tenants can be partly applied (some tenant transactions committed, others
  not); the per-(batch, tenant) ledger makes the retry apply only the missing parts.
- Negative: a duplicate arriving more than 7 days after the original is no longer recognised by the ledger; the
  48 h late-arrival bound and the 72 h queue cap (ADR-0009) keep this from happening in normal operation.
- Negative: most tenants will send `explicit15` data, whose p95 can be noticeably off (the +19 % example). The
  onboarding guide recommends exponential histograms; Rust tenants need a View because the env var is missing.
- Negative: dropping the first sighting of a running cumulative stream loses up to one export interval per stream
  (default 60 s) after every writer state loss.
- Negative: write amplification (three upserts per point) and per-stream state rows; estimated ≈ 270 B per row on
  disk; 1d rows ≤ ~5 GB/year in the high scenario (planning numbers, not measurements).
- Must do: detect "unit `s` with ms-default buckets" (an SDK ignoring the advisory) and flag the series as low
  resolution; record the `otel.metric.overflow=true` series under the `{overflow}` route, which only the writer
  assigns (C-89); an absent route arrives from the Collector already as `{unknown}` (C-16).
- Revisit if: S-05 shows the upsert path too slow at 10× load (fallback: write 1m only and recompute 1h/1d from 1m
  for dirty hours); PostgreSQL 19 GA changes the target; operators find bucket-width precision unacceptable.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- PostgreSQL metrics histograms: §3.1 histogram model and layout observation; §3.2 merge
  rules and cumulative→delta; §3.3 error formula and simulation; §3.4 representation options; §3.5 SQL sketches
  (unexecuted); §3.6 schema, partitioning, transactional fan-out, dedupe key; §3.7 sizes; §3.8 TimescaleDB licence.
- OTel semconv SDK dual export: §3.1 default boundaries, temporality, histogram
  aggregation env var, cardinality overflow series; §3.3 SDK bucket hazard; §3.6 single-writer requirement.
- OTel collector pipeline: §3.6 writer options, PostgreSQL exporter status; §3.8 traps.
- Multitenancy RLS isolation: §3.2 `ON CONFLICT` needs SELECT policies; COPY test.
- Research synthesis: H-OTEL-4, conflict X-9, spike S-05.

## Open points
None outstanding. (Execution of the SQL and the throughput figures remain unproven until S-05, as stated above.)
