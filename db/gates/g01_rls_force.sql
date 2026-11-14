-- SPDX-License-Identifier: Apache-2.0
-- G1: RLS + FORCE on every table and partition in EVERY non-system schema (C-114; was scf and scf_part only); no
--     materialized views or foreign tables anywhere. Exempt: scf_migrations.applied, the runner's ledger (owned by the
--     migrator, no grants — G3 proves no other role reaches it). (data-model.md §15)
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'm', 'f')
   AND (c.relkind IN ('m', 'f') OR NOT (c.relrowsecurity AND c.relforcerowsecurity))
   AND c.oid::regclass::text <> 'scf_migrations.applied';
