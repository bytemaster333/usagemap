# S-03 — RLS on a real PostgreSQL 18 behind PgBouncer
**Result:** PARTIAL — every migration block of `docs/data-model.md` applies without error and isolation holds for
every runtime role, with two exceptions. Named jobs running without a tenant can **DELETE** other tenants' rows (one
SQL fix, below). The CI gates have three blind spots.

## Question
Does the schema, role set, RLS pattern and `op_*` design of `docs/data-model.md` (validated only on PGlite, single
user) hold on a real PostgreSQL 18 server, with real separate login roles and connections through PgBouncer in
transaction mode? Specifically:
1. Do the migrations apply as `scf_migrator`?
2. Do research tests T0–T22 reproduce?
3. Do the CI gates G1–G10 catch what they claim to catch?
4. Is there any cross-tenant read or write at SQL level, and do the `op_*` functions audit, threshold (C-95) and
   restrict correctly?

## Method (versions, commands, how to re-run: one command if possible)
- **Server:** `postgres:18-alpine@sha256:9ba53c7d41ea093baf5c1ba635ba5434c4f979880527d49bb7d9237d3193085b`. It reports
  `PostgreSQL 18.6 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit`. Settings:
  `shared_preload_libraries=pg_stat_statements`, `max_connections=300`, `shared_buffers=1GB`, scram-sha-256.
- **Pooler:** `edoburu/pgbouncer@sha256:8638aa563607256d3c7440437534195f1066a92b68015d89ae9d6b935b444a6d`
  (`PgBouncer 1.26.1`). `pool_mode = transaction`, `server_reset_query` empty, `max_prepared_statements = 200`.
  Pools: `scf` (2 server connections), plus `scf_one` and `rlslab` (exactly 1). With one server connection per pool,
  reuse of a server connection across clients is deterministic. `scf_bulk` (16) is used by S-05.
- **Runner:** the same Alpine image plus `py3-psycopg` (psycopg 3) and `py3-numpy`.
- **Stack:** Docker project `scf-s03`, ports `127.0.0.1:18301` (pg) and `:18302` (bouncer).
- **Re-run:** `spikes/s03-rls-real-postgres/run.sh`. It runs every step twice:
  - `verbatim`: the document as written.
  - `fixed`: with `tools/fixes.py` applied.

  Output goes to `out/<mode>/`. `KEEP=1` leaves the stack up. The run takes about 3 minutes.
- **Migrations** (`tools/migrate.sh`, `tools/extract_migrations.py`):
  1. Drop and recreate everything.
  2. Run the §3 bootstrap verbatim as superuser (`sql/bootstrap.sql`). The only additions are throwaway passwords
     and `CREATE EXTENSION pg_stat_statements`.
  3. Extract every ` ```sql ` block whose first line is `-- migration:` (23 blocks) and run each one as
     `scf_migrator`, in one transaction (`psql -1`, like dbmate), over a direct connection.
- **Tests** (`tests/`). All runtime-role connections go through PgBouncer; context is set with
  `set_config(…, true)`.

  | File | What it does |
  |---|---|
  | `t_research.py` | Replica of the research setup (`sql/rlslab.sql`); T0–T21, COPY, plus PgBouncer extras X1 and X2 |
  | `seed.py` | Tenants A, B and canary C with rows in **every** table of `scf` (precondition M0 asserts it) |
  | `t_gates.py` | G1–G10 parsed out of `docs/data-model.md` §15; one breakage per gate inside a rolled-back transaction |
  | `t_matrix.py` | Relations enumerated from `pg_class` (68: tables, partitioned tables, partitions, views). For each role × context: count B/C rows visible, then try `UPDATE`/`DELETE` of B rows |
  | `t_ops.py` | Every `op_*` function, positive and negative |

## Observations (raw facts, with excerpts of output)

**1. Migrations: zero errors.** All 23 blocks report `ok` in both modes (`out/verbatim/migrate-verbatim.log`).
`SELECT scf.ensure_partitions()` returned `13`. No SQL syntax or dependency error exists in `docs/data-model.md`
on a real server. The only SQL change proposed (F1 below) is a security fix, not an error fix.

**2. Research tests, re-run** (`out/fixed/t-research.json`, 27/27 behave as in the research):

| # | Real PG 18.6 + PgBouncer 1.26.1 observation | vs research |
|---|---|---|
| T0 | `42501: new row violates row-level security policy for table "web_daily"` | same |
| T1 | parent `(t,t,2)`; partitions `web_daily_2025` and `_2026` `(f,f,0)` | same |
| T2 | owner: parent 0 rows, partition directly 2 | same |
| T3 | fresh pooled connection, GUC never set: 0 rows | same |
| T4 | `SET LOCAL` via bouncer: only a's row; after COMMIT `''` | same |
| T5 | client 1 runs `SET app.tenant_id=b` and disconnects. A **different client** gets the same backend and sees GUC `b` and b's 2 rows | **worse**: crosses clients, not only transactions |
| T5b | after `RESET`: `22P02: invalid input syntax for type uuid: ""` | same |
| T6 | `42501: permission denied for table web_daily_2026` | same |
| T7 | RLS violation on insert for b | same |
| T8 | 0 rows visible, `23505: duplicate key … "sites_hostname_key"` | same |
| T10 / T10b | FORCE: default view 0, invoker view 1. NO FORCE: default view 3, invoker view 1 | same |
| T11 | `42809: ALTER action ENABLE ROW SECURITY cannot be performed on relation "mv"` | same |
| T12 | BYPASSRLS role via bouncer sees 3 | same |
| T13 | `42501: query would be affected by row-level security policy` | same |
| T14 | `InitPlan 1`; `Index Cond: ((tenant_id = ((InitPlan 1).col1)::uuid) AND (day >= …))`; only `web_daily_2026` scanned | same |
| T15 | `=`, `<`, `>=` on uuid/text/date/int8/timestamptz are leakproof; `textlike`, `lower`, `current_setting` are not | same |
| T16 | gate lists `mv`, `web_daily_2025`, `web_daily_2026` | same |
| T17 | definer function owned by the FORCEd owner counts 0 | same |
| T18 | detached partition `(f,f,f)`, a standalone table without RLS | same |
| T19 | GRANT on a partition: partition 2 rows (both tenants), parent 1 | same |
| T20 | `NULLIF(…,'')::uuid` policy with GUC `''`: 0 rows, no error | same |
| T21 | app sets GUC to b and sees b | same |
| T9 | TRUNCATE granted to app_role: b rows left 0 | same |
| COPY | `COPY FROM not supported with row-level security` for app_role and the FORCEd owner; OK for BYPASSRLS | same |
| T22 | **does not exist** in the RLS research test table (the table ends at T21 + COPY; T20 is inside T5b). Replaced by X1 and X2 | — |
| X1 | `set_config(…, true)` in a transaction that errors and rolls back leaves `''` for the next client on that backend | new, OK |
| X2 | Protocol-level prepared statement with a forced generic plan, reused by 6 pooled clients alternating A/B: each saw only its own tenant | new, OK |

**3. CI gates** (`out/fixed/t-gates.json`, 25/25 as expected):
- **Clean database:** all ten gates return 0 rows.
- **One breakage per gate, each caught:**

  | Gate | Breakage | Gate output |
  |---|---|---|
  | G1 | partition via plain `PARTITION OF` | `scf_part.api_metrics_1m_20310101` |
  | G2 | table without a backstop | `scf.g2_bad` |
  | G3 | `GRANT SELECT` on a partition | `(scf_app, scf_part.api_metrics_1h_202611, SELECT)` |
  | G4 | view without `security_invoker` | `scf.g4_bad` |
  | G5 | definer function without `search_path`, PUBLIC EXECUTE | `scf.g5_bad()` |
  | G6 | `LOGIN BYPASSRLS` role | `g6_bad` |
  | G7 | `DROP POLICY app_select` on one partition | `(scf_part.api_metrics_1d_2026, app_select)` |
  | G8 | `GRANT scf_definer TO scf_app` | `scf_app` |
  | G9 | PK `(id, tenant_id)` | `scf.g9_bad` |
  | G10 | single-column FK to `sites(site_id)` | `g10_bad_site_id_fkey` |

  - G10 is reachable because `sites` has `UNIQUE (site_id)`.
  - G8's `pg_stat_statements` half was implemented here: a session `SET app.tenant_id` through PgBouncer shows up
    as `SET app.tenant_id = $1`, and the query catches it.
- **Gaps (gate stays silent):**
  - **G5**: an *unlisted* `SECURITY DEFINER` function with `search_path` set and no PUBLIC EXECUTE, granted to
    `scf_app`, returns 0 rows from every gate. G5 does not compare against `db/definer-allowlist.txt`.
  - **G4**: an owner-semantics view in schema `public` over `scf.sites` returns 0 rows from every gate. G4 only looks
    at schema `scf`.
  - **G8 runtime half**: `set_config('app.tenant_id', $1, false)` from a driver is recorded as
    `SELECT set_config($2, $1, $3)`, so a session-level set is undetectable in `pg_stat_statements`.
  - G1 misses a partition attached from schema `public`, but **G7 catches it** (8 missing parent policies).

**4a. Cross-tenant matrix** (`out/*/t-matrix.json`). 68 relations from the catalog, 52 of which carry `tenant_id` or
`chain_id`. M0: tenant B has rows in every tenant table.

| Context (all via PgBouncer) | B/C rows visible | B rows UPDATE/DELETE-able |
|---|---|---|
| `scf_app` tenant A user; GUC unset; `operator` with tenant A set; `anonymous`; `op_key` with tenant A set | 0 | 0 |
| `scf_writer` tenant A; no tenant | 0 | 0 |
| `scf_metrics_ro` op_key / operator (readable: 7 relations, none with tenant data except own-transaction audit rows) | 0 | 0 |
| `scf_jobs`, each of 17 jobs with tenant A | 0 (except `audit_verify` / `audit_anchor`, which read all audit chains by design) | 0 |
| `scf_jobs` `erasure` / `tenant_purge` with tenant unset (C-87) | 0 | 0 |
| `scf_jobs`, named job with tenant **unset** (verbatim) | cross-tenant reads, as designed | **retention 5, web_rollup 4, trust_scoring 2, public_metrics 1, stream_gc 2** |
| same, **fixed** (F1) | as designed | 0 |

The M13 detail, verbatim mode:
```
!! scf_jobs web_rollup: 3 B rows updatable/deletable in scf.web_daily_breakdowns
!! scf_jobs web_rollup: 1 B rows updatable/deletable in scf.web_daily_totals
!! scf_jobs trust_scoring: 1 B rows updatable/deletable in scf.web_trust_scores   (+ api_service_assurance)
!! scf_jobs retention: … api_ingest_ledger, api_ingest_counters, domain_verifications, tenant_invitations, web_edge_counters
!! scf_jobs public_metrics: … public_metrics_documents     !! scf_jobs stream_gc: … api_route_day, api_stream_state
```
All of these are DELETEs. A cross-tenant UPDATE fails on the backstop's `WITH CHECK`; a DELETE has no `WITH CHECK`.

Other observations from the matrix:
- `scf_app` can update and delete any row of `auth_challenges` in every context. This follows from the global
  `app_global USING (true)` policy; the table is on the allow-list (tenant_id is a reference there).
- No runtime role can read `scf_part` partitions directly: permission is denied for the schema.

**4b. `op_*` functions** (`out/fixed/t-ops.json`, 40/40):
- **Audit rows.** Every read and write function wrote **exactly one** audit row in the calling transaction, with
  the right action. Single-tenant calls (`op_tenant_detail`, writes) land in that tenant's chain; multi-tenant
  reads and `op_lift_tombstone` land in the platform chain. `op_metrics_document` with a key restricted to B and
  asked for A returns NULL and audits `outcome = denied`.
- **C-95.**
  - `op_web_breakdown` is the only thresholded output: XX (3 visitors) is omitted; DE 24 → 20 visitors and 26 → 30
    pageviews; FR 10 → 10.
  - These return exact values, all below k = 10, with `suppressed = false`: `op_web_metrics` (pageviews 7,
    visitors 3), `op_api_metrics` (requests 3), `op_web_verdicts` (3), `op_onchain` (3 / 1).
- **Canary and grouping.** Canary C is excluded unless named (`p_tenants => {C}` returns C). `p_group = 'all'`
  returns `(NULL, 14)`.
- **Key scope and tenant restriction.** A key with `web:read` calling `op_api_metrics`, and a key with only
  `web:read` calling `op_metrics_document`, both fail with `42501`. A key restricted to A gets only A, and asking
  for B gets 0 rows. A key asking `op_projects` for removed tenants gets `42501 status filter not allowed`.
- **Writes.**
  - Without step-up: `42501 step-up required`.
  - `remove` by a plain operator: `operator_admin required`.
  - `op_add_annotation(A, site of B)`: `P0002`.
- **No other way in.**
  - `scf_app` in a user context calling `op_*`: `42501 SCF operator context required`, no audit row.
  - `scf_writer` / `scf_jobs` calling `op_*`: `permission denied for function`.
  - All four runtime roles calling `op_begin` / `op_eligible_tenants`: `permission denied`.
  - `scf_metrics_ro` calling `op_tenant_detail`: denied.
  - The operator context sees 0 rows in `web_daily_totals`.
  - All 19 `op_*` are owned by `scf_op_definer`, with no PUBLIC EXECUTE.
- **Usability.** `scf.op_projects(1, '{active}')` fails with
  `42883: function scf.op_projects(integer, unknown) does not exist`. `p_min_level smallint` needs an explicit
  cast; the same applies to every `op_*` taking `p_min_level`.

**5. Audit chain heads are writable directly.** As `scf_app` via PgBouncer:
`UPDATE scf.audit_chain_heads SET last_hash = … WHERE chain_id = '00000000-…'` returns `UPDATE 1`. The policy
`chain_heads_rw` is `FOR ALL` because the (invoker) trigger needs it. Any runtime role can therefore rewrite the
platform chain head, or its own tenant's head, outside the trigger. `audit_verify` would detect it later; nothing
prevents it.

## Answer to the question
- **Migrations:** apply on real PostgreSQL 18.6 with the real role set, without a single error.
- **Research findings:** all reproduce. Session-level `SET` is confirmed to leak **to another client** through
  PgBouncer transaction pooling, so the `set_config(…, true)` rule is mandatory.
- **Isolation:** holds for every runtime role and every context tested, including the SCF-operator and op_key
  contexts that see no tenant row at all (C-17).
- **The one hole:** named cross-tenant jobs with no tenant set can DELETE any tenant's rows. Fix F1 closes it.
- **`op_*` functions:** audit exactly once, apply C-95 correctly, and are the only route across tenants.
- **Gates:** G1–G10 work as written, but G5, G4 and the runtime half of G8 have blind spots.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)
Confirmed: ADR-0013 (RLS + FORCE + restrictive backstop, `set_config(…, true)`, PgBouncer transaction mode), C-17,
C-72, C-87 (composite keys; `erasure` / `tenant_purge` have no cross-tenant read), C-89 (audit-action FK), C-95.
`docs/data-model.md` §20's "not validated: RLS under real connections and PgBouncer" can be marked validated by
S-03, after these changes:

1. **F1 (must, security) — `docs/data-model.md` §6.2 `scf_admin.apply_tenant_rls`.** After the
   `CREATE POLICY tenant_backstop …` EXECUTE, add:
   ```sql
   EXECUTE format('CREATE POLICY tenant_backstop_delete ON %s AS RESTRICTIVE FOR DELETE '
                  'TO scf_app, scf_writer, scf_jobs, scf_metrics_ro '
                  'USING (%s AND (SELECT scf.tenant_ctx_ok()))', t, tp);
   ```
   Then update the related text:
   - §6.1 item 2: "cross-tenant **reads** only for named jobs; DELETE also requires the row's tenant context".
   - §6.2's illustrative expansion: add the delete backstop.
   - §15 G2: require both policies, `tenant_backstop` and `tenant_backstop_delete`.
   - §6.3: `retention` and `stream_gc` delete **per tenant** (set `app.tenant_id` per tenant, the way `tenant_purge`
     does), and `web_rollup`, `trust_scoring` and `public_metrics` already write per tenant. As written, §6.3's
     claim "the backstop's WITH CHECK requires it" is false for DELETE.

   `secure_partition` copies the new policy automatically; G7 enforces it. Exact text: `tools/fixes.py`.
2. **G5 (must):** add the allow-list comparison to the query, e.g.
   `… OR p.oid::regprocedure::text <> ALL (:'definer_allowlist'::text[])`, with the 27 definer functions of §10–§12 (17 `op_*` + 8 of §12 + 2 partition functions) in
   `db/definer-allowlist.txt`.
3. **G4 (should):** check every non-system schema the runtime roles can `USAGE`, not only `scf`:
   `n.nspname NOT IN ('pg_catalog','information_schema') AND has_schema_privilege('scf_app', n.oid, 'USAGE')`.
   Also add G3-style checks for `public`.
4. **G8 (must, contract change):** `pg_stat_statements` cannot see `set_config(…, false)` (it records
   `set_config($2, $1, $3)`). Make tenant context settable only through one wrapper that is always transaction-local:
   ```sql
   scf.set_ctx(p_tenant text, p_kind text, p_actor text, …) … PERFORM set_config(…, true)
   ```
   Lint-ban `set_config(` and `SET app.` in application code; keep the `SET app.` check in `pg_stat_statements`.
5. **Audit chain head (should, §5):**
   - Make `scf.audit_chain_append()` `SECURITY DEFINER`, owned by a new NOLOGIN role `scf_audit_definer` that has
     `SELECT, INSERT, UPDATE` on `audit_chain_heads`. Add it to the definer allow-list.
   - Then drop `chain_heads_rw` and revoke `INSERT, UPDATE` on `audit_chain_heads` from all runtime roles; keep
     SELECT for `audit_anchor`.
   - Runtime roles then cannot rewrite chain heads. This is a design change, not a syntax fix.
6. **`op_*` signatures (nice):** declare `p_min_level` as `integer` (cast inside), or document that callers must
   pass smallint. Positional `op_projects(1, …)` fails with `42883`.
7. **`auth_challenges`:** confirm the intent that `scf_app` can update or delete any challenge (global table,
   `app_global USING (true)`). The tenant_id it carries is not isolated.

## Values the implementation must use (env vars, headers, config keys, flags, limits)
- PostgreSQL `postgres:18-alpine` (18.6) and PgBouncer ≥ 1.26.1. In `pgbouncer.ini`: `pool_mode = transaction`,
  `max_prepared_statements = 200`; protocol-level prepared statements work, as X2 shows. SQL `PREPARE`, session
  `SET`/`RESET` and session advisory locks are unsupported in this mode.
- Every unit of work is `BEGIN; SELECT set_config('app.tenant_id', $1, true), …; …; COMMIT;`. Never
  `set_config(…, false)` or `SET app.*`.
- `shared_preload_libraries = pg_stat_statements` (G8). `track_utility` stays on (the default), so `SET` is recorded.
- Migrations run per block in one transaction, as `scf_migrator`, over a **direct** connection; dbmate
  `--wait`/transactional mode is fine.

## Open issues
- The `umami` database section (§16) was not exercised; that is S-01.
- The HTTP-level isolation matrix is not part of this spike.
- Load-time RLS behaviour (plan shapes with many partitions) is covered by S-05.
- Fixes 2–5 are proposed but not implemented here; only F1 is applied in `fixed` mode.
- Credentials in `compose.yml` and `pgbouncer/userlist.txt` are throwaway values for a short-lived local container.
