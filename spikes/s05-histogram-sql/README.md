# S-05 — Histogram SQL accuracy and writer throughput on PostgreSQL 18
**Result:** PARTIAL — the document's histogram SQL is correct: merges are exact, the exp3 error stays within
4.33 %, and explicit15 errors stay within one bucket. The writer sustains the 10× target with p99 = 181 ms. Two
things must change: the cost of converting exp3 rows on the read path, and the `exp3` row size.

## Question
1. Do the `explicit15` and `exp3` layouts and the SQL of `docs/data-model.md` §9 produce the percentile accuracy
   that ADR-0010 states? That is ≤ 4.33 % for exp3, and within a bucket's width for explicit15. Do the following
   hold?
   - element-wise merge across rows and across 1m → 1h → 1d;
   - down-scaling of tenant exponential histograms with scale > 3;
   - the scale < 3 → explicit15 "coarse" path.
2. Can the writer's transaction pattern sustain 10× the design load under RLS through PgBouncer? The pattern is one
   transaction per tenant per batch: ledger, stream state, additive upserts into 1m/1h/1d. What do p99 latency and
   CPU look like, and what does creating a new day's partition with RLS cost? This also covers §19 open point 5:
   the cost of the composite FKs.

## Method (versions, commands, how to re-run: one command if possible)
- **Stack:** the S-03 stack (project `scf-s03`, ports 18301/18302):
  - `postgres:18-alpine@sha256:9ba53c7d41ea093baf5c1ba635ba5434c4f979880527d49bb7d9237d3193085b` (PostgreSQL 18.6,
    `shared_buffers=1GB`, `synchronous_commit=on`, default WAL settings);
  - PgBouncer 1.26.1 (`edoburu/pgbouncer@sha256:8638aa56…`), transaction mode, pool `scf_bulk` = 16;
  - runner: Alpine + psycopg 3 + numpy.

  The database is migrated from `docs/data-model.md` with the S-03 fix F1 applied, and seeded by S-03's `seed.py`.
- **Host:** 8 vCPU, 58 GB RAM, **shared with other projects**. During the runs the load average was 37–60 and the
  CPU about 1 % idle (`top` inside the containers). All throughput numbers are therefore **lower bounds**.
- **Re-run:** `spikes/s05-histogram-sql/run.sh`, about 8 minutes. Variables: `DURATION=120` (target phase),
  `MAXDUR=60`, `KEEP=1` (leave the stack up). Results go to `out/`.
- **`hist_accuracy.py`**:
  - Python implements the writer-side bucketing exactly as §9.1/§9.2 define it:
    - explicit15: `idx(v) = 1 + |{b ∈ B : b < v}|`;
    - exp3: OTLP index `i = ceil(log2 v · 8) − 1`, `k = i + 114` clamped to 1/194;
    - down-scaling: `i3 = i_s >> (s−3)`;
    - scale < 3: log-uniform split into explicit15.
  - All merging and quantiles use **the document's SQL** from migration 0030: `scf.hist_add`, `scf.hist_sum`,
    `scf.hist_exp3_to_explicit15`, `scf.hist_quantile*`, `scf.accuracy_class`.
  - Five distributions of 200,000 samples each (seed 20261112), compared with exact quantiles
    (`numpy.quantile(…, method='inverted_cdf')`).
  - Merge test: each distribution is split into 600 one-minute rows and upserted by `scf_writer` (tenant context,
    via PgBouncer) with the §8.11 upsert into `_1m`, `_1h` and `_1d`. Then the §9.3 tenant range query runs against
    each `*_pref` view as `scf_app`.
- **`throughput.py`** (load model below):
  - 8 or 16 worker processes, each `scf_writer` via PgBouncer with real RLS.
  - Per transaction:
    1. `set_config` × 3;
    2. ledger `INSERT … ON CONFLICT DO NOTHING RETURNING`;
    3. `SELECT … FOR UPDATE` of the 50 stream-state rows (sorted), then an upsert of them;
    4. additive upserts into `_1m`, `_1h`, `_1d`: one multi-row `INSERT … SELECT FROM unnest … ORDER BY key ON
       CONFLICT DO UPDATE` per kind and resolution, with the §8.11 `SET` clause verbatim;
    5. `api_service_day_groups` upsert.
  - Series mix: 80 % explicit15, 20 % exp3.
  - CPU is sampled on the host with `docker stats` (100 % = one core).
  - `partition_bench.py` drops the farthest-ahead daily partition of `api_metrics_1m`. Then, as `scf_jobs`
    (`app.job = partitions`) through PgBouncer, it times `SELECT scf.ensure_partitions()` (creates exactly one day)
    and `scf.drop_expired_partitions()` (one 40-day-old day). It runs idle, and under load during the target phase.

**Load model (assumptions).**
- The design target is 1 M requests/day ≈ 11.6 req/s across about 300 tenants. Writer load is set by **metric
  data points**, not requests: SDKs export every active series at every interval, and cumulative series keep being
  exported while idle.
- 1× assumption: 300 tenants, a 10 s export interval, 5 active series per tenant on average. That gives 150
  points/s.
- **10× = 300 tenants × 50 series / 10 s = 1,500 points/s.** That is 30 tenant transactions/s of 50 points each,
  4,500 metric-row upserts/s, and about 6,000 row writes/s including stream state, ledger and day groups.
- The series cap per tenant (50 here) is bounded by the cardinality guard (C-24).

## Observations (raw facts, with excerpts of output)

**Accuracy.** Relative error of p50 / p95 / p99. Estimates use min/max where the document's SQL accepts them;
`out/accuracy.log` and `out/accuracy.json` have the full data.

| Distribution (n = 200k) | exact p50/p95/p99 | explicit15 | exp3 | SDK scale at MaxSize 160 |
|---|---|---|---|---|
| lognormal, median 82 ms, σ 0.8 | 82.2 / 305.2 / 521.1 ms | +0.91 / **+18.35** / +3.76 % | +2.92 / +1.63 / +0.10 % | 3 |
| bimodal 15 ms (70 %) + 450 ms | 17.8 / 573.6 / 714.2 ms | **+17.04** / +10.79 / +3.70 % | −0.09 / −0.83 / +3.29 % | 4 |
| heavy tail, Pareto α 0.9 from 20 ms (max 32,597 s) | 43.2 / 553.1 / 3,264.8 ms | +6.27 / +3.09 / +13.23 % | −2.21 / +2.84 / −1.44 % | **2** |
| narrow, N(120 ms, 3 ms) | 120.0 / 124.9 / 126.9 ms | +11.32 / +6.93 / +5.24 % (without min/max: +45.8 / +94.1 / +95.8 %) | −0.35 / **−4.28** / +2.73 % | 8 |
| sub-millisecond, median 0.3 ms | 0.300 / 0.682 / 0.954 ms | **+739 / +428 / +277 %** | +1.09 / −3.07 / −2.11 % | 4 |

- **exp3 bound:** worst observed |error| is 4.28 % against the bound `(2^(1/8)−1)/(2^(1/8)+1)` = 4.329 %. The
  bound is **confirmed**. The heavy-tail data put 13 values in the overflow bucket (> 1024 s) and the
  sub-millisecond data put 152 values in the underflow bucket (≤ 61 µs); neither touched p50–p99.
- **explicit15 bound:** every estimate lies within the width of the bucket that holds the exact value
  (`within_bound: True` for all 30 cases). The bound is **confirmed**, but it is a weak bound:
  - +18 % at p95 for the lognormal case reproduces the research's +19.2 %;
  - +739 % for sub-millisecond APIs, because everything sits in bucket 1, (−∞, 5 ms], interpolated from `vmin`
    to 5 ms;
  - without min/max, the narrow case is off by up to +96 %, since `vmax` is NULL for cumulative-derived deltas
    (§9.4) and those carry no min/max.
- **exp3 → explicit15 (`scf.hist_exp3_to_explicit15`):** the total count is preserved, and only 0.000–0.225 % of
  counts move bucket. Resulting errors are within 0.2 percentage points of direct explicit15.
- **Mixed kinds in one key:** the upsert collapses to explicit15 with `hist_quality = 1`, giving `accuracy_class`
  `explicit15_approx` at 1m, 1h and 1d alike. Errors match explicit15.
- **Merges:** 600 one-minute rows → `_1m`, `_1h`, `_1d`. The merged histogram is **identical** to the unsplit one
  at every resolution, for both kinds and all five distributions. Request counts are 200,000 everywhere, and p50,
  p95 and p99 are equal across 1m, 1h and 1d. `accuracy_class` is `explicit15` / `exp3` as expected.
- **Down-scaling** `i_s >> (s−3)` from scales 4, 5, 6, 8, 12 and 20: **0 mismatches** against direct scale-3
  bucketing on 1,000,000 values.
- **Scale < 3 → explicit15 ("coarse"):**
  - Errors relative to direct explicit15 are small at scales 2 and 1 (lognormal p99 +3.84 % and +3.99 % against
    +3.76 %). At scale 0 the bimodal case reaches +22.6 / +25.1 / +31.9 %.
  - At **scale 0 one source bucket straddles 2 explicit bounds** (e.g. (0.0625, 0.125] contains 0.075 and 0.1). The
    document's single-bound split (§9.2, which is written for exp3) does not apply there; the spike's writer uses a
    general multi-bound split.
- **SDK scale:** a heavy-tailed series (20 ms … 32,597 s, 20.6 octaves) makes an SDK at MaxSize 160 settle on
  **scale 2**. Such tenants land on the coarse path, not exp3. Scale ≥ 3 is guaranteed only when max/min ≤ 2^20.
- explicit15's minimum ratio between adjacent bounds is 1.3333 (> exp3 base 1.0905), so §9.2's claim "at most one
  bound per exp3 bucket" holds.

**Throughput** (`out/throughput-*.json`, `out/cpu-*.log`):

| Phase | Workers | Txn/s | Points/s | Metric-row upserts/s | Row writes/s | Latency p50 / p95 / p99 / max (ms) | pg CPU avg / max | Runner CPU avg |
|---|---|---|---|---|---|---|---|---|
| **10× target**, 120 s, paced (1 txn / tenant / 10 s) | 8 | 30.0 | **1,499.7** | 4,499 | 6,059 | 63 / 125 / **181** / 300 | **43 % / 76 %** | 31 % |
| max, 60 s | 8 | 77.0 | 3,850 | 11,550 | 15,554 | 99 / 171 / 209 / 305 | 92 % / 116 % | 73 % |
| max, 60 s | 16 | 76.7 | 3,834 | 11,500 | 15,487 | 199 / 341 / 438 / 797 | 105 % / 134 % | 76 % |
| max, 60 s, **FKs dropped** (9 composite FKs on `api_metrics_*`) | 16 | 70.2 | 3,508 | 10,523 | 14,171 | 221 / 371 / 457 / 586 | 93 % / 122 % | 68 % |
| max, 30 s, direct (no PgBouncer) | 8 | 73.1 | 3,653 | — | 14,757 | 104 / 186 / 225 / 307 | — | — |
| max, 30 s, PgBouncer | 8 | 82.3 | 4,116 | — | 16,629 | 92 / 163 / 201 / 274 | — | — |

- Zero duplicates and zero errors in every phase.
- Throughput does not grow from 8 to 16 workers; latency doubles. Sampling `pg_stat_activity` during a max run
  showed the waits: `IO:WalSync` and `LWLock:WALWrite` on the commit path, writer backends `idle in transaction`
  waiting for the client, and an over-committed host.
- The ceiling is therefore the shared host's CPU plus the commit fsync path, not PostgreSQL CPU (~1 of 8 cores),
  PgBouncer (3.5 % CPU, faster than direct) or the FKs.
- **Composite FKs:** no measurable cost. With FKs: 3,834 points/s; without: 3,508 points/s, within the run-to-run
  noise of this host.

**New day's partition with RLS** (`out/partitions-*.json`):
- `scf.ensure_partitions()` creates one daily partition of `api_metrics_1m` in `scf_part` with ENABLE + FORCE and
  **9 of 9** parent policies (8 from the document + F1). It takes **13–32 ms idle** and **70–191 ms under the 10×
  load**.
- `drop_expired_partitions()` (DETACH + DROP) takes 20–40 ms idle and 24–129 ms under load.
- The writer's p99 during the target phase, with 5 creations and 5 drops inside it, stayed at 181 ms.

**Storage** (`out/sizes.json`, after the runs, not vacuumed):
- Average tuple size in `api_metrics_1h`: **266 B for explicit15** (the estimate was about 270 B) and **1,698 B for
  exp3**. `hist` is `bigint[194]`, 1,552 B of payload, so an exp3 row is 6.4× an explicit15 row.
- On-disk bytes per live row right after the run: 1,440 (1m), 1,967 (1h), 1,896 (1d). These include the PK and
  time indexes and dead tuples from the 6–360 updates per row, before autovacuum.

**Read path** (`out/readbench.json` plus ad-hoc timings on the loaded data: 15,303 rows in `_1h`, 3,058 of them exp3):
- `op_api_metrics` for one day, all 302 tenants, `p_group = 'service'`: **3.8–4.0 s**. Hourly, `'all'`: 2.6–3.8 s.
- A tenant's p95 per route from `_1m_pref` over 6 h: 79–86 ms.
- Where the time goes:

  | Query | Time |
  |---|---|
  | `scf.hist_sum(hist)` over 12,245 explicit15 rows | 62 ms |
  | `unnest … WITH ORDINALITY` + `sum` instead | 36 ms |
  | `hist_sum(hist_to_explicit15(hist_kind, hist))` over all 15,303 rows (the path a mixed group takes) | **749 ms** |
  | merge exp3 first, then convert once per group | 709 ms for 300 groups, ~2 ms per call |

  The cost is `scf.hist_exp3_to_explicit15`, which runs a CTE per call and pays per non-zero bucket: about
  0.25 ms per sparse row.
- Extrapolated to `op_api_metrics` over 31 days of `_1h` at this load (~11 M rows, 20 % exp3), this is minutes.

## Answer to the question
1. **Correctness:**
   - The §9 SQL is correct.
   - Element-wise merges are exact across rows and across 1m → 1h → 1d.
   - Down-scaling from scale > 3 is exact.
   - exp3 stays within **≤ 4.33 %**; the worst observed error is 4.28 %.
   - explicit15 stays within the stated bucket-width bound. That bound means +18 % at p95 for typical lognormal
     latencies, and several hundred percent for sub-5 ms APIs.
   - The scale < 3 path works, but needs a multi-bound split at scale ≤ 0.
2. **Throughput:**
   - The writer pattern under RLS through PgBouncer sustains the **10× target of 1,500 points/s** (4,500
     metric-row upserts/s) with **p99 = 181 ms** at about 0.4 core average on PostgreSQL.
   - It reached at least **3,850 points/s, 2.6× the 10× target**, on a host that was otherwise saturated.
   - Composite FKs cost nothing measurable.
   - Creating a day's partition with full RLS takes under 200 ms, even under load.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)
- **Confirmed:**
  - ADR-0010's two-kind design, exact merges and the 4.33 % bound.
  - C-23: down-scaling and coarse mapping.
  - The transactional fan-out, with no rollup jobs (no need for the "write 1m only" fallback).
  - §19 open point 5, composite FKs: **closed, keep them**.
  - §10 partition functions under load.
- **Must change, read path (`docs/data-model.md` §9.3 and §11 `op_api_metrics`, and the §9.3 range query):**
  - Merge each kind first, then convert once per group:
    ```sql
    scf.hist_add(scf.hist_sum(hist) FILTER (WHERE hist_kind = 'explicit15'),
                 scf.hist_exp3_to_explicit15(scf.hist_sum(hist) FILTER (WHERE hist_kind = 'exp3')))
    ```
    This replaces `scf.hist_sum(scf.hist_to_explicit15(hist_kind, hist))`.
  - Rewrite `scf.hist_exp3_to_explicit15` as a fixed linear map: a precomputed 194 × 15 weight table, or an
    IMMUTABLE `float8[]` constant, applied with one `unnest … GROUP BY`. That gives O(1) per bucket instead of a
    CTE per call.
  - Long ranges must read `_1d` (already the rule beyond 31 days); budget `op_api_metrics` against a timeout.
- **Must change, storage (§8.11):**
  - `exp3` as `bigint[194]` makes the row 1.7 kB, against 266 B for explicit15. Store `hist` as **`int4[]`**: a
    per-row count of 2^31 per bucket is plenty for a 1d bucket at 10× load. That halves both kinds.
  - Or store exp3 sparse (`offset int2` + trimmed `int4[]`); typical rows use 10–40 of the 194 buckets.
  - Either way, revise the size estimates of the histogram research and
    ADR-0010 ("≈ 270 B per row" holds only for explicit15).
- **Must state, accuracy wording (ADR-0010 table, API `accuracy_class` docs):**
  - explicit15 errors of +17–18 % at p50/p95 are normal for real distributions. For APIs faster than 5 ms,
    explicit15 percentiles are meaningless (the whole distribution is in bucket 1); show "< 5 ms" instead of an
    interpolated value when the quantile falls in bucket 1 and `vmin` is unknown.
  - Strengthen the onboarding recommendation for exponential histograms.
- **Must specify, writer (wire-formats / writer spec, C-23):**
  - The scale < 3 → explicit15 conversion must split a source bucket across **every** explicit bound it straddles.
    At scale 0 that is up to 2 bounds; at negative scales, more. §9.2's single-bound rule is written for exp3 only;
    say so.
  - Tenants with max/min > 2^20 (≈ 20 octaves, e.g. 1 ms … 17 min) are pushed by their SDK to scale ≤ 2, and so
    land on the coarse path.

## Values the implementation must use (env vars, headers, config keys, flags, limits)
- explicit15 bounds (s): `{0.005,0.01,0.025,0.05,0.075,0.1,0.25,0.5,0.75,1,2.5,5,7.5,10}`, upper-inclusive.
- exp3: `k = clamp(ceil(log2(v)·8) − 1 + 114, 1, 194)`; from scale s ≥ 3: `i3 = i_s >> (s − 3)` (arithmetic shift).
- Writer batch: one transaction per tenant; stream-state keys sorted and locked `FOR UPDATE`. One multi-row
  `INSERT … SELECT FROM unnest(…) ORDER BY <pk> ON CONFLICT DO UPDATE` per (kind × resolution). explicit15 and
  exp3 rows go in separate statements, because a 2-D array cannot hold rows of 15 and 194 elements.
- PgBouncer pool for the writer: 8–16 server connections is enough; more workers do not add throughput.
- Sizing for 10× (measured): about 0.4 core average and 0.8 core peak of PostgreSQL CPU at 1,500 points/s, plus
  WAL fsync capacity for about 30 commits/s.

## Open issues
- Throughput was measured on a shared, over-committed host; repeat on a dedicated node for absolute ceilings.
  Autovacuum and bloat over days of 360 updates per row per hour were not observed: runs are minutes long.
- The proposed linear-map rewrite of `hist_exp3_to_explicit15` and the `int4[]`/sparse storage change were not
  implemented or benchmarked here.
- Cumulative→delta logic (§9.4) is writer code; the spike only exercised the state-row lock and upsert pattern.
- The other exploratory outputs in `out/` come from manual runs of the same scripts:
  - `throughput-smoke.json`, `throughput-probe.json`;
  - `throughput-direct8.json` and `throughput-bouncer8b.json` (the PgBouncer A/B).
