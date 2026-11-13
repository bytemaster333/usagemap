-- Source: docs/data-model.md, block '-- migration: 0030_histograms' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0030_histograms   (validated by S-05; int4[] storage, merge-first reads and the precomputed exp3 map: C-103)
CREATE FUNCTION scf.explicit15_bounds() RETURNS float8[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT '{0.005,0.01,0.025,0.05,0.075,0.1,0.25,0.5,0.75,1,2.5,5,7.5,10}'::float8[] $$;

-- Writer side: element-wise addition of two stored rows (int4[]). The writer never lets it overflow: the upsert's
-- WHERE uses hist_merge_fits() below and skips the merge (count_overflow, C-112(1)); a 1d row at 10× load stays far
-- below 2^31 per bucket (S-05).
CREATE FUNCTION scf.hist_add(a int4[], b int4[]) RETURNS int4[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
  SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a
              ELSE ARRAY(SELECT a[i] + b[i] FROM generate_subscripts(a, 1) AS i ORDER BY i) END
  $$;
-- Read side: sums accumulate in bigint[].
CREATE FUNCTION scf.hist_add8(a bigint[], b bigint[]) RETURNS bigint[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
  SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a
              ELSE ARRAY(SELECT a[i] + b[i] FROM generate_subscripts(a, 1) AS i ORDER BY i) END
  $$;
CREATE FUNCTION scf.hist_acc(s bigint[], h int4[]) RETURNS bigint[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT scf.hist_add8(s, h::bigint[]) $$;
CREATE AGGREGATE scf.hist_sum(int4[]) (SFUNC = scf.hist_acc, STYPE = bigint[], COMBINEFUNC = scf.hist_add8, PARALLEL = SAFE);

-- C-103: the split of each exp3 element into explicit15 buckets is constant; precompute it once (194 rows).
-- frac_lo = share of the element's count that goes to j_lo (1 when j_lo = j_hi).
CREATE TABLE scf.hist_exp3_map (
  k        smallint PRIMARY KEY CHECK (k BETWEEN 1 AND 194),
  j_lo     smallint NOT NULL CHECK (j_lo BETWEEN 1 AND 15),
  j_hi     smallint NOT NULL CHECK (j_hi BETWEEN 1 AND 15 AND j_hi IN (j_lo, j_lo + 1)),
  frac_lo  float8   NOT NULL CHECK (frac_lo > 0 AND frac_lo <= 1 AND (j_hi <> j_lo OR frac_lo = 1))
);
INSERT INTO scf.hist_exp3_map (k, j_lo, j_hi, frac_lo)
SELECT s.k, s.j_lo, s.j_hi, CASE WHEN s.j_lo = s.j_hi THEN 1 ELSE ln(s.b[s.j_lo] / s.lo) / ln(s.hi / s.lo) END
  FROM (SELECT g.k, z.lo, z.hi, z.b,
               CASE WHEN g.k = 1 THEN 1 WHEN g.k = 194 THEN 15
                    ELSE 1 + (SELECT count(*) FROM unnest(z.b) x WHERE x <= z.lo)::int END AS j_lo,
               CASE WHEN g.k = 1 THEN 1 WHEN g.k = 194 THEN 15
                    ELSE 1 + (SELECT count(*) FROM unnest(z.b) x WHERE x <  z.hi)::int END AS j_hi
          FROM generate_series(1, 194) AS g(k),
               LATERAL (SELECT power(2::float8, (g.k - 114) / 8.0) AS lo, power(2::float8, (g.k - 113) / 8.0) AS hi,
                               scf.explicit15_bounds() AS b) z) s;
ALTER TABLE scf.hist_exp3_map ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.hist_exp3_map FORCE ROW LEVEL SECURITY;
GRANT SELECT ON scf.hist_exp3_map TO scf_app, scf_writer, scf_jobs, scf_op_definer;
CREATE POLICY read_all ON scf.hist_exp3_map FOR SELECT TO scf_app, scf_writer, scf_jobs, scf_op_definer USING (true);
CREATE POLICY migrator_seed ON scf.hist_exp3_map FOR ALL TO scf_migrator USING (true) WITH CHECK (true);   -- C-114

-- Same output as the S-05-validated per-call CTE (n_low = round(n·ln(b/lo)/ln(hi/lo)), n_high = n − n_low), at O(1)
-- per non-zero element. STRICT: a NULL input (no exp3 rows in the group) costs nothing.
CREATE FUNCTION scf.hist_exp3_to_explicit15(h bigint[]) RETURNS bigint[] LANGUAGE sql STABLE STRICT PARALLEL SAFE
  AS $$
  WITH p AS (
    SELECT m.j_lo, m.j_hi, h[m.k] AS n, round(h[m.k] * m.frac_lo)::bigint AS n_lo
      FROM scf.hist_exp3_map m WHERE h[m.k] <> 0)
  SELECT ARRAY(SELECT COALESCE(sum(q.c), 0)::bigint FROM generate_series(1, 15) AS g(j)
                 LEFT JOIN (SELECT p.j_lo AS j, p.n_lo AS c FROM p
                            UNION ALL SELECT p.j_hi, p.n - p.n_lo FROM p WHERE p.j_hi <> p.j_lo) q ON q.j = g.j
                GROUP BY g.j ORDER BY g.j)
  $$;

-- Writer only (a key that receives both kinds collapses to explicit15, §8.11 upsert).
CREATE FUNCTION scf.hist_to_explicit15(kind scf.hist_kind, h int4[]) RETURNS int4[] LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT CASE kind WHEN 'explicit15' THEN h ELSE scf.hist_exp3_to_explicit15(h::bigint[])::int4[] END $$;

-- C-112(1): true when merging stored row a (kind ka) with incoming b (kind kb) stays within int4 in every bucket,
-- computed in bigint on the layout the merge would produce (same kind: as is; mixed: both converted to explicit15).
CREATE FUNCTION scf.hist_merge_fits(ka scf.hist_kind, a int4[], kb scf.hist_kind, b int4[]) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM (SELECT CASE WHEN ka = kb OR ka = 'explicit15' THEN a::bigint[] ELSE scf.hist_exp3_to_explicit15(a::bigint[]) END AS x,
                   CASE WHEN ka = kb OR kb = 'explicit15' THEN b::bigint[] ELSE scf.hist_exp3_to_explicit15(b::bigint[]) END AS y) v,
           generate_subscripts(v.x, 1) AS i
     WHERE v.x[i] + v.y[i] > 2147483647)
  $$;

-- Linear interpolation in the bucket holding rank q·N; bucket 1 lower edge vmin; bucket 15 upper edge
-- COALESCE(vmax, 10) (an unbounded tail reports ≥ 10 s); result clamped to [vmin, vmax] when known.
-- C-103: a quantile in bucket 1 with vmin unknown returns the bound 0.005 (displayed "≤ 5 ms"), not an interpolation.
CREATE FUNCTION scf.hist_quantile_explicit15(counts bigint[], q float8, vmin float8 DEFAULT NULL, vmax float8 DEFAULT NULL)
  RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
  WITH c AS (SELECT i, counts[i]::float8 AS n, sum(counts[i]) OVER (ORDER BY i)::float8 AS cum,
                    sum(counts[i]) OVER ()::float8 AS total FROM generate_subscripts(counts, 1) AS i),
  t AS (SELECT i, n, cum - n AS before, total FROM c WHERE n > 0 AND cum >= q * total ORDER BY i LIMIT 1),
  e AS (SELECT t.*, scf.explicit15_bounds() AS b FROM t)
  SELECT CASE WHEN i = 1 AND vmin IS NULL THEN LEAST(b[1], COALESCE(vmax, 'infinity'::float8))
              ELSE LEAST(GREATEST(lo + (hi - lo) * ((q * total - before) / n), COALESCE(vmin, '-infinity'::float8)),
                         COALESCE(vmax, 'infinity'::float8)) END
    FROM e, LATERAL (SELECT CASE WHEN i = 1 THEN COALESCE(vmin, 0) ELSE b[i - 1] END AS lo,
                            CASE WHEN i = 15 THEN GREATEST(COALESCE(vmax, b[14]), b[14]) ELSE b[i] END AS hi) x
  $$;

CREATE FUNCTION scf.hist_quantile_exp3(counts bigint[], q float8, vmin float8 DEFAULT NULL, vmax float8 DEFAULT NULL)
  RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
  WITH c AS (SELECT i, counts[i]::float8 AS n, sum(counts[i]) OVER (ORDER BY i)::float8 AS cum,
                    sum(counts[i]) OVER ()::float8 AS total FROM generate_subscripts(counts, 1) AS i),
  t AS (SELECT i FROM c WHERE n > 0 AND cum >= q * total ORDER BY i LIMIT 1)
  SELECT LEAST(GREATEST(
           CASE WHEN i = 1   THEN COALESCE(vmin, power(2::float8, -14))
                WHEN i = 194 THEN COALESCE(vmax, 1024::float8)
                ELSE 2 * power(2::float8, (i - 114) / 8.0) * power(2::float8, (i - 113) / 8.0)
                       / (power(2::float8, (i - 114) / 8.0) + power(2::float8, (i - 113) / 8.0)) END,
           COALESCE(vmin, '-infinity'::float8)), COALESCE(vmax, 'infinity'::float8))
    FROM t
  $$;

CREATE FUNCTION scf.hist_quantile(kind scf.hist_kind, counts bigint[], q float8, vmin float8 DEFAULT NULL, vmax float8 DEFAULT NULL)
  RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE kind WHEN 'exp3' THEN scf.hist_quantile_exp3(counts, q, vmin, vmax)
                         ELSE scf.hist_quantile_explicit15(counts, q, vmin, vmax) END $$;

CREATE FUNCTION scf.accuracy_class(all_exp3 boolean, all_exp15 boolean, max_quality smallint) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN max_quality = 2 THEN 'coarse' WHEN all_exp3 THEN 'exp3'
                    WHEN all_exp15 AND max_quality = 0 THEN 'explicit15' ELSE 'explicit15_approx' END $$;

GRANT EXECUTE ON FUNCTION scf.explicit15_bounds(), scf.hist_add(int4[], int4[]), scf.hist_add8(bigint[], bigint[]),
  scf.hist_acc(bigint[], int4[]), scf.hist_sum(int4[]),
  scf.hist_exp3_to_explicit15(bigint[]), scf.hist_to_explicit15(scf.hist_kind, int4[]),
  scf.hist_merge_fits(scf.hist_kind, int4[], scf.hist_kind, int4[]),
  scf.hist_quantile_explicit15(bigint[], float8, float8, float8), scf.hist_quantile_exp3(bigint[], float8, float8, float8),
  scf.hist_quantile(scf.hist_kind, bigint[], float8, float8, float8), scf.accuracy_class(boolean, boolean, smallint)
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_op_definer;
