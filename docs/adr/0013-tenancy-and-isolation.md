# ADR-0013: Tenancy and isolation

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** isolation.tenant-vs-operator, tenancy.multi-tenant-model, tenancy.sites-and-services, isolation.tenant-rls, isolation.web-dashboard, operator.web-global-view, isolation.api-metrics, isolation.api-dashboard

## Context
UsageMap is multi-tenant by design: independent teams register sites, properties and APIs. Isolation is strict: each
tenant sees only its own data, and designated SCF operators hold credentials for the global view. (In this document
"SCF operator" is a portal user with the `operator` or `operator_admin` role; the hosting entity is the "service
operator" — C-59.) Both the web and the API dashboard give a tenant no access to any other tenant's data, and the
quality of the multi-tenant isolation and access-control design is a core property of the product. Expected scale is
100–500 tenants.

What research established:
- **PostgreSQL 18.6** is current (EOL 2030-11-14). RLS rules from the PG 18 docs: superusers and `BYPASSRLS` roles
  bypass; owners bypass unless `FORCE`; no applicable policy means default-deny; permissive policies OR, restrictive
  AND; `TRUNCATE`/`REFERENCES` and unique/foreign-key checks bypass RLS; `INSERT … ON CONFLICT DO UPDATE` also needs
  SELECT policies; `row_security = off` errors instead of bypassing.
- **Tests T0–T22 were executed** on PostgreSQL 18.6 via PGlite 0.5.16 (Docker unavailable); the pitfalls below were
  observed, not inferred. They must be re-run on a real `postgres:18` (S-03).
- **Umami** enforces isolation only in handler code, has no read-only global role (`admin` is all-powerful), no
  cross-website aggregate, and a history of authorisation bugs (CVE-2026-121582 cross-website write, 2FA bypasses).
- **PgBouncer** 1.26.1 (2026-10-14) is current; transaction pooling does not support session `SET`/`RESET`; custom
  GUCs are not tracked parameters, so a session `SET` leaks to the next client on that server connection.

## Options considered
1. **Shared schema + `tenant_id` + forced RLS with a per-transaction GUC (chosen).** Pros: database-enforced, one
   migration path, trivial SCF operator aggregation. Cons: protects against application bugs, not a compromised
   application that can set any tenant id (T21).
2. **Role per tenant with `SET LOCAL ROLE`.** Cons: the pooled login role must be a member of every tenant role, so the
   protection equals option 1 while adding role churn and `CREATEROLE` in the control plane.
3. **Schema per tenant.** Cons: 500× DDL per migration, catalogue bloat, SCF operator reads as 500-way `UNION ALL`.
4. **Database per tenant.** Strongest isolation; 500 pools, backups and migrations; the SCF operator view needs
   FDW/ETL.
5. **Application-only filtering (Umami's model).** Cons: one missed `WHERE` is a leak; exactly the bug class in
   Umami's advisory history.

## Decision
- One shared schema in database `scf`; every **tenant-owned** table carries `tenant_id` (global tables — users,
  sessions, settings, registry, keys, tombstones, the platform audit chain — have their own policies and grants,
  listed in `docs/data-model.md`, C-72); **RLS enabled and forced on every table and every partition**; a RESTRICTIVE tenant policy as backstop; tenant context set per transaction with
  `set_config('app.tenant_id', …, true)` and read as
  `(SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid)`.
- **Tenant-scoped identifiers (C-87).** Every identifier a request carries — in the path, the query or the body — is
  resolved under the caller's tenant context, so a foreign identifier behaves like a missing one (same status).
  Tenant-owned tables reference each other with **composite foreign keys that include `tenant_id`** (for example
  `(tenant_id, site_id) REFERENCES sites`), so a row can never point at another tenant's row. Jobs that act for a
  tenant (erasure, purge) run under that tenant's context and look sites up by `(tenant_id, site_id)`.
- Roles (no runtime role has `BYPASSRLS`):

| Role | Login | Used by | Rights |
|---|---|---|---|
| `scf_migrator` | tests/deploy only | migration tool | owner of tables; DDL only; FORCE means it cannot read or write tenant rows (T0) |
| `scf_definer` | **no** | — | owns the allow-listed `SECURITY DEFINER` functions, including every `op_*` function, and nothing else; holds the SELECT grants and the cross-tenant read policies those functions need, and INSERT on the audit log |
| `scf_app` | yes | control plane | tenant-scoped reads/writes under RLS; **EXECUTE on the `op_*` functions** for SCF operator portal views; **no cross-tenant SELECT on base tables** |
| `scf_writer` | yes | metrics-writer | inserts and upserts API metrics under a tenant context; no bypass |
| `scf_jobs` | yes | jobs service | explicit cross-tenant policies for named jobs only; each job holds a PostgreSQL advisory lock so one core node runs it (C-07) |
| `scf_metrics_ro` | yes | SCF operator metrics API (`op` keys, ADR-0016) | **EXECUTE on the `op_*` functions only**; no SELECT on any base table |

  The `umami` database is engine-owned and has exactly two roles (C-12): `umami_app` (the engine's own role, owner
  of its schema) and `scf_umami_maint` (DELETE on the event, session and their data tables only; used by the
  retention and erasure jobs). No other role of ours connects to that database. Inside Umami, each tenant is a team
  read through its own view-only user, whose API key and password are stored in `scf` encrypted with a key held
  outside the database (C-40, C-85). If the S-01 fallback of C-82 is ever activated, a read-only, contract-tested SQL
  view over Umami's event table is added for the rollup job; it is recorded as a deviation.
- Policy pattern for tenant tables (illustrative; definitions owned by `docs/data-model.md`):

```sql
ALTER TABLE api_metrics_1h ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_metrics_1h FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_rw ON api_metrics_1h TO scf_app, scf_writer
  USING      (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY tenant_backstop ON api_metrics_1h AS RESTRICTIVE TO scf_app, scf_writer
  USING      (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid));
-- every request: BEGIN; SELECT set_config('app.tenant_id', $1, true); …; COMMIT;
```

  The `(SELECT …)` wrapper makes the planner evaluate the setting once as an InitPlan, usable as an index condition
  with partition pruning (T14). Every key and index leads with `tenant_id`.
- **SCF operator read path (C-17).** Cross-tenant reads are **not views**. They are allow-listed `SECURITY DEFINER`
  functions `op_*`, with a fixed `search_path`, owned by the non-login role `scf_definer`. Each function, in one
  transaction, inserts the audit row (actor, function, arguments) into the hash-chained audit log (ADR-0014) and
  returns only aggregates with the minimum-count threshold and rounding applied (ADR-0027: minimum 10, rounded to
  10, configurable). `scf_app` and `scf_metrics_ro` have EXECUTE on these functions and **no** cross-tenant
  SELECT on base tables, so neither the threshold nor the audit row can be skipped: if the audit insert fails, the
  read fails with it. Cross-tenant sums (ecosystem totals) are produced inside `op_*` functions that add **unrounded**
  values and round once (C-89). Time ranges follow the single convention of C-86: `start` inclusive, `end`
  exclusive, RFC 3339 in UTC; daily resources require both to be midnight UTC. Tenant-facing views stay
  `security_invoker`.

```sql
-- illustrative only; the real functions, names and audit columns are owned by docs/data-model.md
GRANT SELECT ON scf.api_metrics_1d TO scf_definer;               -- parent table only, never a partition (gate 2)
CREATE POLICY op_definer_read ON scf.api_metrics_1d FOR SELECT TO scf_definer USING (true);
                                                               -- the restrictive backstop is TO scf_app, scf_writer

CREATE FUNCTION scf.op_api_daily(p_start date, p_end date)    -- start inclusive, end exclusive (C-86)
  RETURNS TABLE (tenant_id uuid, service_id uuid, day date, requests bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO scf.audit_log (action, detail)                  -- same transaction as the read
    VALUES ('operator.read.api_daily', jsonb_build_object('start', p_start, 'end', p_end));
  RETURN QUERY
    SELECT m.tenant_id, m.service_id, m.bucket_start::date,
           (round(sum(m.request_count) / 10.0) * 10)::bigint  -- rounding (ADR-0027)
    FROM scf.api_metrics_1d m
    WHERE m.bucket_start >= p_start AND m.bucket_start < p_end
    GROUP BY 1, 2, 3
    HAVING sum(m.request_count) >= 10;                         -- minimum count (ADR-0027)
END $$;

ALTER FUNCTION scf.op_api_daily(date, date) OWNER TO scf_definer;
REVOKE ALL ON FUNCTION scf.op_api_daily(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_api_daily(date, date) TO scf_app, scf_metrics_ro;
-- no GRANT SELECT on api_metrics_* to scf_metrics_ro; no cross-tenant policy for scf_app or scf_metrics_ro
```
- PgBouncer in transaction mode; session-level `SET` is banned in our code.
- Writes under RLS use multi-row `INSERT` (COPY is refused under RLS); the writer therefore needs a SELECT policy on
  its own tenant's rows for `ON CONFLICT DO UPDATE`.
- **Database gates (tests):** (1) every table and partition has RLS enabled and forced and a restrictive backstop policy;
  (2) no grants on partitions, and none of `TRUNCATE`, `REFERENCES`, `TRIGGER` to runtime roles; (3) every view is
  `security_invoker`, and no view is the SCF operator read path; (4) every `SECURITY DEFINER` function is on the
  allow-list, is owned by `scf_definer` (or, for partition DDL, the table owner), sets a fixed `search_path`, has
  EXECUTE revoked from `PUBLIC` and granted only to the roles the allow-list names; every `op_*` function is tested to
  write exactly one audit row per call, to return nothing below the minimum count and only rounded values, and to
  fail as a whole when the audit insert fails; (4a) `scf_app` and `scf_metrics_ro` hold no cross-tenant SELECT: as
  each role, every base table returns only rows of the tenant in context (none without one), and `scf_metrics_ro`
  has no table privilege at all; (5) only the bootstrap superuser has `rolsuper` and no role has `rolbypassrls`
  except a non-runtime maintenance role for backups and replication; (6) a data-isolation property test over every
  table found in `pg_class`; (7) the HTTP isolation
  matrix — every endpoint × every role × own / foreign / missing / malformed IDs, **in the path, the query and the
  body** (C-87), generated from the OpenAPI document's machine-readable role field (C-89) with a declarative
  expected-outcome table; foreign and missing IDs return the same status; a new endpoint without a
  row fails the tests; plus (8) canary tenants in production, probed through the public API, alerting if canary A ever sees
  canary B's markers.
- We state plainly: RLS protects against application bugs, not against a compromised application.
  *Re-run S-03 on real PostgreSQL 18.*

**Pitfalls verified by test (PGlite, PostgreSQL 18.6):**

| Test | Observation | Our control |
|---|---|---|
| T1, T2 | Partitions do not inherit RLS flags or policies, whether created by `PARTITION OF` or `ATTACH`; reading a partition by name returned both tenants' rows | ENABLE + FORCE + policies on each partition; gate 1 |
| T19 | One `GRANT SELECT` on a partition gave a full cross-tenant read | no grants on partitions; gate 2 |
| T18 | A detached partition is a plain table without RLS | drop in the same transaction |
| T10, T10b | An owner-semantics view over an unforced table returned all rows; `security_invoker` returned one — and a `security_invoker` view gives no protection beyond the invoker's own table rights, so it cannot enforce a threshold or an audit row | gate 3; SCF operator reads through `op_*` functions (C-17) |
| T11 | Materialised views cannot have RLS | none in tenant-reachable schemas |
| T3, T5b | Unset GUC → NULL → 0 rows; after `RESET` the GUC is `''` and `''::uuid` errors | `NULLIF(…, '')`: fails closed without error |
| T4, T5 | `SET LOCAL` ends at commit; a session `SET` persisted into the next transaction | `set_config(…, true)` per transaction; lint ban on session `SET` |
| T8 | A global unique constraint revealed another tenant's hostname | global claims through an allow-listed `SECURITY DEFINER` function returning a generic result |
| T9 | A granted `TRUNCATE` wiped another tenant's rows | gate 2 |
| T21 | A role that sets the GUC to another tenant sees that tenant | stated limit; application-layer typed tenant context |

## Consequences
- Positive: isolation is enforced by the database and checked by the database gate tests on every migration; a forgotten `WHERE` or a
  wrong join cannot cross tenants; SCF operator reads are a small, reviewed set of functions over the same tables,
  and the threshold, rounding and audit row are properties of the database, not of the control-plane code.
- Positive: no runtime role can bypass RLS, so a leaked writer or app credential is still tenant-bounded per
  transaction (but can choose the tenant); a leaked `scf_metrics_ro` credential yields only thresholded, rounded,
  audited aggregates.
- Negative: every new SCF operator view or metrics-API query needs a new allow-listed function in a migration;
  ad-hoc cross-tenant queries are impossible by design (the weekly `pg_dump` role is not a runtime path).
- Negative: `SECURITY DEFINER` functions run with their owner's rights; a mistake inside one (missing threshold,
  dynamic SQL, mutable `search_path`) is a cross-tenant leak, which is why gate 4 tests each function's behaviour and
  not only its declaration.
- Negative: every partition needs its own policy set, created by the partition-maintenance code; forgetting it fails
  the tests rather than production, but only if the gate runs on the real migration path.
- Negative: multi-row INSERT instead of COPY; throughput is unmeasured (S-05).
- Negative: Umami's database has no RLS; isolation there rests on the per-tenant Umami identity, our adapter, and
  the engine proxy that admits each caller only to its allow-listed Umami endpoints (C-60, C-74, ADR-0003), and
  jobs that delete there resolve websites under the tenant's context (C-87).
- Revisit if: S-03 on real PostgreSQL 18 differs from PGlite; tenant count grows past ~5,000; PostgreSQL changes
  partition RLS semantics.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Multitenancy RLS isolation: §3.2 RLS rules; §3.3 tests T0–T22 and COPY; §3.4 pooling
  and `set_config`; §3.5 tenancy models; §3.6 Umami tables; §3.7 SCF operator access; §6.1–6.6 roles, policy template,
  side channels, database gates, defence in depth,
 HTTP matrix.
- Umami authorisation API multitenancy: §4.5 Umami isolation and missing global read role;
  §6.1 unscoped Umami keys; §14 recommendations.
- Research synthesis: finding 7, conflict X-5, spike S-03.

## Open points
1. Open: the writer runs without `BYPASSRLS` (research had proposed it), using multi-row `INSERT … ON CONFLICT`
   under RLS. Whether that sustains 10× the design load is unmeasured. Closed by S-05 (and the RLS re-run in S-03).
