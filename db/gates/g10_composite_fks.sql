-- SPDX-License-Identifier: Apache-2.0
-- G10: every tenant-owned table's foreign keys to other tenant-owned tables include tenant_id (C-87), in every
--     non-system schema (C-114).
SELECT con.conrelid::regclass, con.conname FROM pg_constraint con
  JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace n ON n.oid = con.connamespace
 WHERE con.contype = 'f' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
   AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = con.conrelid AND t.attname = 'tenant_id')
   AND EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = con.confrelid AND t.attname = 'tenant_id')
   AND rc.oid::regclass::text <> 'scf.tenants'
   AND NOT EXISTS (SELECT 1 FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
                    WHERE a.attname = 'tenant_id');
