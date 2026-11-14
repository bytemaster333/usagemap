-- SPDX-License-Identifier: Apache-2.0
-- G4: every view in EVERY non-system schema that a role other than superusers, pg_* roles, the owner and the backup
--     pair can use is security_invoker (C-103; C-114: role list from the catalog, not hard-coded).
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind = 'v'
   AND EXISTS (SELECT 1 FROM pg_roles r
                WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.rolname NOT IN ('scf_migrator', 'scf_maintenance', 'scf_dump_login')
                  AND has_schema_privilege(r.oid, n.oid, 'USAGE'))
   AND NOT COALESCE('security_invoker=true' = ANY (c.reloptions), false);
