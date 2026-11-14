-- SPDX-License-Identifier: Apache-2.0
-- G12: code that runs with its OWNER's rights is
--     never owned by a superuser or a BYPASSRLS role, in every non-system schema of the database the gate runs in:
--     - every SECURITY DEFINER function, which must also fix its search_path (a `search_path=…` setting);
--     - every owner-semantics view or materialized view (no security_invoker): reading it runs the body as the owner.
--     Objects that belong to an extension are skipped (the superuser installs them, e.g. pg_stat_statements).
--     Run in `scf` by `migrate.sh gates` and in `umami` by `migrate.sh umami-views` (after the scf_ro views are
--     recreated), so the views we create in Umami's database are covered too.
WITH obj AS (
  SELECT 'function'::text AS kind, p.oid::regprocedure::text AS name, p.proowner AS owner, p.proconfig AS config,
         'pg_proc'::regclass AS cls, p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT CASE c.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END, c.oid::regclass::text, c.relowner, NULL,
         'pg_class'::regclass, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('v', 'm') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
     AND NOT COALESCE('security_invoker=true' = ANY (c.reloptions) OR 'security_invoker=on' = ANY (c.reloptions), false))
SELECT o.kind, o.name, r.rolname,
       CASE WHEN r.rolsuper THEN 'owner is a superuser' WHEN r.rolbypassrls THEN 'owner has BYPASSRLS'
            ELSE 'no fixed search_path' END AS finding
  FROM obj o JOIN pg_roles r ON r.oid = o.owner
 WHERE NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = o.cls AND d.objid = o.oid AND d.deptype = 'e')
   AND (r.rolsuper OR r.rolbypassrls
        OR (o.kind = 'function' AND NOT EXISTS (SELECT 1 FROM unnest(o.config) s WHERE s LIKE 'search\_path=%')))
 ORDER BY 1, 2;
