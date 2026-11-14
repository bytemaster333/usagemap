-- SPDX-License-Identifier: Apache-2.0
-- G9: tenant_id is the first primary-key column of every tenant-owned table, in every non-system schema (CR-32,
--     C-114). Allow-list with reasons: host_claims (PK host: global uniqueness of hosts), umami_websites (PK
--     website_id: global uniqueness of Umami website ids, 0067), audit_log (PK chain_id:
--     per-tenant and platform chains), auth_challenges, enrollment_tombstones (tenant_id is a reference, not ownership).
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
 WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
   AND a.attname <> 'tenant_id'
   AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
   AND c.oid::regclass::text NOT IN ('scf.host_claims', 'scf.umami_websites', 'scf.audit_log', 'scf.auth_challenges', 'scf.enrollment_tombstones');
