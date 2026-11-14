-- SPDX-License-Identifier: Apache-2.0
-- G11 (G2 companion, C-72; C-114: run by `migrate.sh gates`, not only by the Go suite): a table without tenant_id, in
--     any non-system schema, is a reviewed global table listed in db/rls-allowlist.txt (passed as :'rls_allowlist', a
--     text[] literal; names in schema scf unqualified, others schema-qualified); every listed table exists.
SELECT c.oid::regclass::text, 'not in rls-allowlist.txt' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
   AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
   AND c.oid::regclass::text <> 'scf_migrations.applied'
   AND CASE WHEN n.nspname = 'scf' THEN c.relname::text ELSE n.nspname || '.' || c.relname END <> ALL (:'rls_allowlist'::text[])
UNION ALL
SELECT x, 'listed but missing' FROM unnest(:'rls_allowlist'::text[]) x
 WHERE to_regclass(CASE WHEN x LIKE '%.%' THEN x ELSE 'scf.' || x END) IS NULL;
