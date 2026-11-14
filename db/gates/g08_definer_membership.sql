-- SPDX-License-Identifier: Apache-2.0
-- G8: no LOGIN role is a member of scf_op_definer, scf_definer or scf_audit_definer, directly or through another
--     role; scf_migrator holds them only WITH INHERIT FALSE (it may SET ROLE to change owners, never use their
--     policies) and inherits no role but pg_read_all_stats (and pg_database_owner, implicit for the database owner)
--     (C-114).
SELECT m.rolname, g.rolname FROM pg_roles m CROSS JOIN pg_roles g
 WHERE g.rolname IN ('scf_op_definer', 'scf_definer', 'scf_audit_definer') AND m.rolcanlogin AND NOT m.rolsuper
   AND m.rolname <> 'scf_migrator' AND pg_has_role(m.oid, g.oid, 'MEMBER')
UNION ALL
SELECT 'scf_migrator', g.rolname FROM pg_roles g
 WHERE g.rolname NOT IN ('scf_migrator', 'pg_read_all_stats', 'pg_database_owner') AND pg_has_role('scf_migrator', g.oid, 'USAGE');
