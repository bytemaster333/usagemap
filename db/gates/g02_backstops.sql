-- SPDX-License-Identifier: Apache-2.0
-- G2: every table with tenant_id, in every non-system schema, has BOTH restrictive policies — tenant_backstop
--     (FOR ALL) and tenant_backstop_delete (FOR DELETE, F1, C-103) — for exactly the four runtime roles and with the
--     canonical expressions of scf_admin.apply_tenant_rls() (C-114: compared, not just present). tenants, memberships
--     and audit_log carry their own documented USING clauses (§8.3, §5). Whitespace of pg_get_expr is normalised.
--     Global tables (no tenant_id, own policies, C-72) are gate G11 (db/rls-allowlist.txt).
WITH x(std_using, std_check) AS (VALUES (
  '(((tenant_id = ( SELECT scf.current_tenant() AS current_tenant)) AND ( SELECT scf.tenant_ctx_ok() AS tenant_ctx_ok)) OR ( SELECT scf.cross_tenant_read_ok() AS cross_tenant_read_ok))',
  '((tenant_id = ( SELECT scf.current_tenant() AS current_tenant)) AND ( SELECT scf.tenant_ctx_ok() AS tenant_ctx_ok))')),
want AS (
  SELECT c.oid, b.polname, b.cmd,
         CASE WHEN b.cmd = 'd' THEN x.std_check
              WHEN c.oid::regclass::text = 'scf.tenants' THEN '(((tenant_id = ( SELECT scf.current_tenant() AS current_tenant)) AND ( SELECT scf.tenant_ctx_ok() AS tenant_ctx_ok)) OR ( SELECT scf.cross_tenant_read_ok() AS cross_tenant_read_ok) OR (( SELECT scf.tenant_ctx_ok() AS tenant_ctx_ok) AND (EXISTS ( SELECT 1 FROM scf.memberships m WHERE ((m.tenant_id = tenants.tenant_id) AND (m.user_id = ( SELECT scf.current_actor_user() AS current_actor_user)))))))'
              WHEN c.oid::regclass::text = 'scf.memberships' THEN '(((tenant_id = ( SELECT scf.current_tenant() AS current_tenant)) AND ( SELECT scf.tenant_ctx_ok() AS tenant_ctx_ok)) OR ( SELECT scf.cross_tenant_read_ok() AS cross_tenant_read_ok) OR (( SELECT scf.tenant_ctx_ok() AS tenant_ctx_ok) AND (user_id = ( SELECT scf.current_actor_user() AS current_actor_user))))'
              WHEN c.oid::regclass::text = 'scf.audit_log' THEN '((tenant_id = ( SELECT scf.current_tenant() AS current_tenant)) OR (tx_id = pg_current_xact_id()) OR (( SELECT scf.current_job() AS current_job) = ANY (ARRAY[''audit_verify''::text, ''audit_anchor''::text])))'
              ELSE x.std_using END AS qual,
         CASE WHEN b.cmd = 'd' THEN NULL
              WHEN c.oid::regclass::text = 'scf.audit_log' THEN '((tenant_id IS NULL) OR (tenant_id = ( SELECT scf.current_tenant() AS current_tenant)))'
              ELSE x.std_check END AS chk
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN x
   CROSS JOIN (VALUES ('tenant_backstop', '*'::"char"), ('tenant_backstop_delete', 'd'::"char")) b(polname, cmd)
   WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND c.oid::regclass::text NOT IN ('scf.auth_challenges', 'scf.enrollment_tombstones')   -- tenant_id is a reference there
     AND NOT (c.oid::regclass::text = 'scf.audit_log' AND b.cmd = 'd'))   -- append-only: no DELETE grant, trigger refuses (§5)
SELECT w.oid::regclass, w.polname FROM want w
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_policy p
    WHERE p.polrelid = w.oid AND p.polname = w.polname AND NOT p.polpermissive AND p.polcmd = w.cmd
      AND (SELECT array_agg(r.rolname::text ORDER BY r.rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles))
          = ARRAY['scf_app', 'scf_jobs', 'scf_metrics_ro', 'scf_writer']
      AND regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g') = w.qual
      AND regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\s+', ' ', 'g') IS NOT DISTINCT FROM w.chk);
