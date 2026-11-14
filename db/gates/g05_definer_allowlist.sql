-- SPDX-License-Identifier: Apache-2.0
-- G5: SECURITY DEFINER functions = exactly db/definer-allowlist.txt (38 entries, passed as :'definer_allowlist', a
--     text[] literal), each with EXACTLY `search_path=pg_catalog, pg_temp` and no other setting, no PUBLIC EXECUTE,
--     and the right owner (C-114: every function, not only op_*): op_* scf_op_definer, audit_chain_append
--     scf_audit_definer, the two partition functions scf_migrator (§10), every other one scf_definer. (C-103)
SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner), p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef
   AND (p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
        OR has_function_privilege('public', p.oid, 'EXECUTE')
        OR p.oid::regprocedure::text <> ALL (:'definer_allowlist'::text[])
        OR pg_get_userbyid(p.proowner) <> CASE
             WHEN n.nspname = 'scf' AND p.proname LIKE 'op\_%' THEN 'scf_op_definer'
             WHEN n.nspname = 'scf' AND p.proname = 'audit_chain_append' THEN 'scf_audit_definer'
             WHEN n.nspname = 'scf' AND p.proname IN ('ensure_partitions', 'drop_expired_partitions') THEN 'scf_migrator'
             ELSE 'scf_definer' END);
