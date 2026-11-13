# `db/` — database `scf` (PostgreSQL 18.6)

Specification: [`docs/data-model.md`](../docs/data-model.md) (the contract; every migration block there
is a file here, verbatim), ADR-0010/0011/0013 and the register clarifications (C-103, C-109, C-110, C-112, C-114).

| Path | What it is |
|---|---|
| `migrations/NNNN_name.sql` | Plain-SQL migrations, applied once each, in order, in one transaction, as `scf_migrator`. `0001`–`0041` are the 23 `-- migration:` blocks of `data-model.md`; `0050_retention` adds the §14 retention rules and two invoker helpers; `0051`–`0056` are later blocks of the same document (`0053`–`0056`: labels in `op_*` rows, today's verified events in `op_tenant_detail`, `op_key_url_exposed`, the erasure queue's sweeps and re-claims — C-119) |
| `bootstrap/roles.sql` | §3 bootstrap (roles, attributes, memberships, database, `pg_stat_statements`), superuser, **idempotent**; passwords are set afterwards by `migrate.sh` (below) |
| `umami/scf_ro.sql` | §16: `scf_ro` views (owned by the NOLOGIN, non-superuser, non-BYPASSRLS role `scf_umami_view_owner`), roles `scf_umami_ro` / `scf_umami_maint` (DELETE incl. `revenue`), `umami_app` statement timeout — run in the `umami` database after every Umami migration (C-112(12)); `umami-views` then runs gate G12 there |
| `umami/drop_scf_ro.sql` | Drops `scf_ro` before an Umami migration (§16.3 upgrade procedure) |
| `gates/g*.sql` | Database gates G1–G12 of §15 (as amended by C-103 and C-114; G12: no superuser- or BYPASSRLS-owned definer function or owner-semantics view, fixed `search_path` — run in `scf` and in `umami`); each must return zero rows |
| `definer-allowlist.txt` | The 43 `SECURITY DEFINER` functions allowed (gate G5) |
| `rls-allowlist.txt` | Tables without `tenant_id` (global tables, C-72) — gate G11 (the G2 companion) |
| `migrate.sh` | The runner (POSIX sh + `psql`), used locally and as the image entrypoint |
| `Dockerfile` | Two targets from one pinned `postgres:18.6-alpine` digest: `server` (the PostgreSQL server image: krb5-libs/libxslt/zlib upgraded to fixed, pinned versions, `gosu` removed, runs as uid 70 — zero HIGH/CRITICAL at Trivy + Grype) and the default `migrate` (one-shot `db-migrate`, built on `server` for a matching `psql`; uid 70) |
| `tests/` | Go module `github.com/bytemaster333/usagemap/db/tests`: the gate suite (below) |

## Running migrations

The runner needs a **direct** connection (it holds a session advisory lock — never point it at PgBouncer).

```sh
# images (as Compose services postgres and db-migrate do)
docker build --target server -t scf-postgres db/      # server: run it as user 70:70 (there is no gosu)
docker build -t scf-db-migrate db/
docker run --rm -e PGHOST=… -e SCF_DB_BOOTSTRAP=1 -e SCF_DB_SUPERUSER_PASSWORD=… -e SCF_MIGRATOR_PASSWORD=… \
  -e SCF_APP_PASSWORD=… -e SCF_WRITER_PASSWORD=… -e SCF_JOBS_PASSWORD=… -e SCF_METRICS_RO_PASSWORD=… scf-db-migrate
# locally, with a PostgreSQL 18 psql on PATH
PGHOST=localhost PGPORT=5432 SCF_MIGRATOR_PASSWORD=… db/migrate.sh migrate
```

Commands: `migrate` (default: optional bootstrap → pending migrations → `scf.ensure_partitions()` → optional gates),
`bootstrap`, `gates`, `status`, `umami-views` (then G12 in `umami`), `umami-gates`, `umami-views-drop`. Exit code 0 means done; anything else failed.

| Variable | Default | Meaning |
|---|---|---|
| `PGHOST`, `PGPORT` | `localhost`, `5432` | server (direct, not PgBouncer) |
| `SCF_DB_NAME` | `scf` | platform database |
| `SCF_MIGRATOR_USER` / `SCF_MIGRATOR_PASSWORD` | `scf_migrator` / — | owner of every object; migrations run as it |
| `SCF_DB_SUPERUSER` / `SCF_DB_SUPERUSER_PASSWORD` | `postgres` / — | only for `bootstrap`, `umami-views`, `umami-views-drop` |
| `SCF_DB_BOOTSTRAP` | `0` | `1`: run the bootstrap first (roles, passwords, database) |
| `SCF_APP_PASSWORD`, `SCF_WRITER_PASSWORD`, `SCF_JOBS_PASSWORD`, `SCF_METRICS_RO_PASSWORD`, `SCF_DUMP_LOGIN_PASSWORD` | unset = unchanged | login passwords set by the bootstrap |
| `SCF_DB_RUN_GATES` | `0` | `1`: run the gates after migrating; a finding fails the run |
| `SCF_DB_WAIT_SECONDS` | `60` | wait for the server to accept connections |
| `UMAMI_DB_NAME` | `umami` | database of the `umami-views*` commands |
| `SCF_UMAMI_RO_PASSWORD`, `SCF_UMAMI_MAINT_PASSWORD` | unset = unchanged | passwords of `scf_umami_ro` / `scf_umami_maint` |
| `SCF_DB_DIR` | script directory (`/db` in the image) | where `migrations/`, `gates/`, … live |

Every `*_PASSWORD` can be given as `*_PASSWORD_FILE` (a Docker secret). **Passwords never reach the server as clear
text (C-114):** after `roles.sql` (and after `umami/scf_ro.sql`) the runner sets each password with psql's `\password`
under `setsid` — libpq computes the SCRAM-SHA-256 verifier client-side and sends only that, in a session with
`pg_stat_statements.track_utility` and statement logging off. The password goes to psql on stdin from the shell's
`printf` builtin, never on a command line. A password must not contain a newline.

**Guarantees.** One `psql` session holds `pg_advisory_lock(7426010411)` for the whole run, so concurrent runners
serialise; each pending migration runs in one transaction together with its ledger row in
`scf_migrations.applied (version, sha256, applied_at, applied_by)`, re-checked under the lock. A migration whose file
changed after it was applied stops the run (write a new migration instead). A failing migration leaves nothing
behind. After the migrations `SELECT scf.ensure_partitions()` runs every time (§10).

**Umami step (C-112(12)).** Run `db-migrate umami-views` as a one-shot after `umami-migrate` and before
`web_rollup` starts. Upgrading Umami: `umami-views-drop` → `umami-migrate` → `umami-views` → view contract test.

**Production notes.** The bootstrap is what Ansible runs once per cluster; it is safe to repeat. `scf_migrator`
gets `pg_read_all_stats` so the runtime half of G8 can read every role's `pg_stat_statements` rows. PgBouncer pools
point at the runtime roles only.

## Running the gate suite

```sh
cd db/tests && go test -count=1 ./...   # or: make test-go   (needs Docker; ~1 minute)
KEEP=1 go test -run TestCrossTenantMatrix -v ./...   # leave the stack up for inspection
docker compose -p scf-wse down -v                     # remove it afterwards
```

The suite starts its own stack (`tests/compose.yaml`, project `scf-wse`): PostgreSQL 18.6 (the `server` target of
`Dockerfile`, as uid 70) on `127.0.0.1:56100` and
PgBouncer 1.26.1 in transaction mode on `127.0.0.1:56101`, builds the `db-migrate` image, migrates from zero with it,
seeds tenants A, B and canary C with a row in every table, then runs:

| Test file | Checks |
|---|---|
| `gates_test.go` | G1–G11 + the G8 runtime half clean; **one or more deliberate breakages per gate** (incl. the three S-03 blind spots: unlisted definer function, owner-semantics view in `public`, driver `set_config(…, false)`); G2 companion against `rls-allowlist.txt` |
| `matrix_test.go` | cross-tenant matrix over every relation enumerated **from the catalog** × every runtime role × contexts (tenant A, unset, never set, operator, op_key, system, every named job with tenant A, `erasure`/`tenant_purge` without tenant, every cross-tenant job without tenant — F1), through PgBouncer **and** direct; reads of B/C, UPDATE/DELETE of B, moving A's row to B, INSERT of a B row (C-114); `scf_migrator` in four contexts (direct); plus proof the matrix fails on an F1 regression, a read hole, an INSERT hole and a migrator inheriting a definer role; the SECURITY DEFINER half: every `scf_definer` function (from the catalog) called with another tenant's id under tenant A and with A's id under operator/op_key/pub_key/anonymous contexts → 42501 (audit #5, #8b) |
| `ops_test.go` | every `op_*`: exactly one audit row, C-95 thresholds on breakdowns only, canary only when named, key scopes and tenant restriction, step-up, operator_admin, no other way in |
| `followups_test.go` | C-119: `slug`/`service_name` in `op_web_metrics`/`op_web_breakdown`/`op_trust`/`op_api_metrics` rows (appended columns), `verified_events_today` per site in `op_tenant_detail`, `op_key_url_exposed` (proof of possession, audit, callers), `job_queue('erasure')` sweeps and stale-run re-claims |
| `jobs_followups_test.go` | `0057`: `trust_scoring` reads `web_hourly_totals` (parent and every partition; the migration's partition loop repairs a stale partition, G7), `write_removal_tombstones` (owner self-removal, idempotent, lifted stays lifted, context and status checks, `tenant_purge`, EXECUTE only `scf_app`/`scf_jobs`), audit actions `verification.contract_unverified` / `tenant.purge_failed` for `scf_jobs` only |
| `audit_test.go` | chain append and full recomputation, concurrent appends, no runtime role writes `audit_chain_heads`, append-only even for the superuser |
| `context_test.go` | `scf.set_tenant_ctx()` transaction-local on a shared pooled connection (also after rollback), validation, fresh sign-in triggers (C-87) |
| `hist_test.go` | `hist_exp3_map` = S-05 CTE (2,000 histograms), exp3 ≤ 4.33 %, explicit15 within bucket width, merges exact 1m → 1h → 1d through the writer upsert, mixed kinds, int4 guard (C-112(1)), bucket-1 rule |
| `partitions_test.go` | `ensure_partitions` / `drop_expired_partitions` as job `partitions`; new partitions secured (G1/G3/G7) |
| `livewindow_test.go` | `scf.web_live_window_days()` on seeded data (C-109, C-112(6)) |
| `retention_test.go` | `scf.retention_apply()` per tenant / per job; erasure selector redaction (C-88, C-112) |
| `umami_test.go` | `umami-views` twice, roles and settings, `scf_ro` columns, view owner (no superuser/BYPASSRLS) and G12 in `umami`, `revenue` pruning by `scf_umami_maint`, no other access, the drop/migrate/recreate procedure |
| `c1_followups_test.go` | Migrations `0070` and `0071`: `verification.evidence_lapsed` by `scf_app`, `read_only_mode` shape, integer settings and the privacy floor ranges, the per-day `op_web_breakdown` floor (one visitor over 30 days never passes), job `erasure` on `web_dev_events`, `writer_tenant_gone()` (own tenant, writer only, `scf_writer` only) |
| `c1_hardening_test.go` | Migrations `0067`–`0069`: Umami website ids unique across both columns and all tenants, INSERT column guards (`sites`, `site_domains`, `declared_contracts`) and the general "column-guarded UPDATE without table INSERT" check, trust signals written only by the verifying job / operator path, owner delete+insert needs a fresh sign-in, public definers hide inactive tenants, per-command job policies on global tables, the last active `operator_admin` (incl. a real two-connection race), host-claim invariants and dispute resolution, the privilege/policy snapshot against `testdata/privileges.golden` (`-update-privileges` after a reviewed change) |
| `hardening_test.go` | the C-114 regressions: migrator without INHERIT reads nothing, no clear-text password in `pg_stat_statements`, `tenants` lifecycle columns, `op_*` authorise first, audit action allow-lists (checked against both OpenAPI documents and the control plane's source), canonical v2 injective, retention keeps linked registry projects, migrator seeds global tables, invitations only into active/pending tenants, `release_domain_claim`, node-name pattern, quoted migration paths, the suite failing without Docker |
| `differentiation_test.go` | C-136 (`0063`–`0066`): dev-origin grammar and column grants, the dev-event buffer (insert, trim, 24-hour retention), the Stellar property rollup's closed lists, `op_cohorts` (suppression below `cohort_min_tenants`, exact sums, scopes, audit), snapshot v2 columns and the append-only guard, `public_snapshot_list` / `public_seal_proof`, seal-day immutability and job scoping, the Registered Footprint checks and `op_footprint`; C-137: the cohort small-count floor and on-chain gating, snapshot series numbers, `signed_at`, guard and delete protection, seal head path, segments, chain continuity, unique leaf index and provisional leaves, footprint retention, the machine-key view and conflict resolution (`op_footprint_reject`) |
| `migrate_test.go` | re-run no-op, two concurrent runners, drift detection, failing migration rolls back; every migration file equals its `-- migration:` block of `data-model.md` |
| `lint_test.go` | C-103 source lint: no `set_config(` / `SET app.` / `SET LOCAL app.` / `RESET app.` outside `db/` (comment-only lines excepted) |

Without Docker the suite **fails** (C-114); `SCF_SKIP_DOCKER_TESTS=1` skips it explicitly (it then prints SKIP). Always
run with `-count=1` (the Makefile does), so a cached result is never reported as a run.

## Adding a table (the checklist the gates enforce)

1. **New migration file** `migrations/NNNN_name.sql` (next free number; never edit an applied one — before the first
   deployment, C-114 allows correcting migrations in place). Add the block to
   `docs/data-model.md` in the same change.
2. **Tenant-owned?** Then `tenant_id uuid NOT NULL` is the **first primary-key column** (G9) and every foreign key to
   another tenant-owned table is composite with `tenant_id` (G10).
3. **Secure it in the same migration:** `CALL scf_admin.apply_tenant_rls('scf.<table>', …)` — it enables + forces RLS
   (G1), creates `tenant_backstop` **and** `tenant_backstop_delete` (G2, F1) and issues exactly the grants and
   per-role policies you list. Never `GRANT` by hand on a tenant table, never `TRUNCATE`/`REFERENCES`/`TRIGGER` (G3),
   nothing for `scf_metrics_ro` (C-17).
4. **Global table** (no `tenant_id`)? ENABLE + FORCE RLS, explicit policies per role, and add its name to
   `rls-allowlist.txt` with a review (G2 companion).
5. **Partitioned?** Add a row to `scf_admin.partition_specs()`; partitions are created only by
   `scf.ensure_partitions()` (secured, no grants, every parent policy — G1, G3, G7). After changing a parent policy,
   re-apply it to existing partitions in the same migration (G7, CR-31).
6. **Views** are `WITH (security_invoker = true)` (G4) — in every schema a runtime role can use.
7. **`SECURITY DEFINER`** only when unavoidable: `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL … FROM PUBLIC`,
   the right owner (`scf_op_definer` for `op_*`, `scf_definer`, …) and a line in `definer-allowlist.txt` (G5) plus a
   row in `data-model.md` §12. Grant `EXECUTE` **before** `ALTER FUNCTION … OWNER TO`: the migrator holds the definer
   roles without INHERIT (C-114) and cannot grant on a function it no longer owns.
8. **Retention:** add the period to `data-model.md` §14 and, if a job deletes it, a row in `scf.retention_rules()`.
9. **Context:** application code sets context only with `scf.set_tenant_ctx()` (lint, G8).
10. Run `go test -count=1 ./...` in `db/tests`: the matrix picks the table up from the catalog automatically; seed a row for
    tenants A, B, C in `tests/seed_test.go` (the matrix refuses a tenant table that B has no row in).
11. **Privileges changed?** `TestPrivilegeSnapshot` compares every grant, column grant, function `EXECUTE` and policy of
    the platform roles with `tests/testdata/privileges.golden`; after a reviewed change regenerate it with
    `go test -count=1 -run TestPrivilegeSnapshot -update-privileges ./...` and commit the diff with the migration.
12. **New audit action?** Insert it into `scf.audit_actions` with its `writers` (the roles allowed to append it, C-114).
