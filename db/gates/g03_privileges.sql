-- SPDX-License-Identifier: Apache-2.0
-- G3 (C-114: table AND column privileges; every role; every non-system schema). Every role except superusers,
--     predefined pg_* roles, the owner scf_migrator and the backup pair scf_maintenance/scf_dump_login (BYPASSRLS
--     by design, ADR-0013) is checked. Findings:
--     - any privilege of a role that is not one of the seven platform roles (a new or foreign role reaching scf);
--     - any privilege on a partition, or on a relation outside schema scf (scf_part always; other schemas when the
--       role has USAGE there — e.g. pg_stat_statements' PUBLIC grant in public is inert without USAGE);
--     - TRUNCATE/REFERENCES/TRIGGER for anyone;
--     - scf_metrics_ro on any table with a tenant_id column (C-17) except audit_log (own-transaction rows);
--     - INSERT/UPDATE of the lifecycle columns of scf.tenants by a runtime role (C-114, §8.3) — except UPDATE of
--       purged_at by scf_jobs (job tenant_purge, guarded by tenants_guard).
WITH roles AS (
  SELECT r.oid, r.rolname::text AS rolname FROM pg_roles r
   WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.rolname NOT IN ('scf_migrator', 'scf_maintenance', 'scf_dump_login')),
rels AS (
  SELECT c.oid, c.relname, c.relispartition, n.nspname, n.oid AS nsp,
         EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')),
privs(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
held AS (
  SELECT r.rolname, c.*, p.priv FROM rels c CROSS JOIN roles r CROSS JOIN privs p
   WHERE (has_table_privilege(r.oid, c.oid, p.priv)
          OR (p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(r.oid, c.oid, p.priv)))
     AND (c.nspname IN ('scf', 'scf_part') OR has_schema_privilege(r.oid, c.nsp, 'USAGE')))
SELECT h.rolname, h.oid::regclass, h.priv FROM held h
 WHERE h.rolname NOT IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro', 'scf_definer', 'scf_op_definer', 'scf_audit_definer')
    OR h.relispartition OR h.nspname <> 'scf' OR h.priv IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')
    OR (h.rolname = 'scf_metrics_ro' AND h.relname <> 'audit_log' AND h.has_tenant)
UNION ALL
SELECT r.rolname, 'scf.tenants'::regclass, p.priv || ' (' || col || ')'
  FROM roles r CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) p(priv)
 CROSS JOIN unnest(ARRAY['tenant_id', 'slug', 'created_by', 'created_at', 'status_changed_at', 'status_changed_by',
                         'removed_at', 'purge_after', 'purged_at', 'is_canary']) col
 WHERE r.rolname IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro')
   AND has_column_privilege(r.oid, 'scf.tenants'::regclass, col, p.priv)
   AND NOT (p.priv = 'INSERT' AND r.rolname = 'scf_app' AND col IN ('tenant_id', 'slug', 'created_by'))
   AND NOT (p.priv = 'UPDATE' AND r.rolname = 'scf_jobs' AND col = 'purged_at');
