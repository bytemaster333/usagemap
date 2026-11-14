-- SPDX-License-Identifier: Apache-2.0
-- G6: among non-superusers only scf_maintenance (NOLOGIN) has BYPASSRLS, and no role has CREATEROLE, CREATEDB or
--     REPLICATION (C-114) — except the HA replication role `replicator` with REPLICATION and nothing else (C-120).
--     (A managed service's own admin role, e.g. on Azure, is listed here by a reviewed change.)
SELECT rolname, 'BYPASSRLS' FROM pg_roles WHERE rolbypassrls AND NOT rolsuper AND (rolname <> 'scf_maintenance' OR rolcanlogin)
UNION ALL
SELECT rolname, concat_ws(' ', CASE WHEN rolcreaterole THEN 'CREATEROLE' END, CASE WHEN rolcreatedb THEN 'CREATEDB' END,
                          CASE WHEN rolreplication THEN 'REPLICATION' END)
  FROM pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_' AND (rolcreaterole OR rolcreatedb OR rolreplication)
   AND NOT (rolname = 'replicator' AND rolreplication AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls);
