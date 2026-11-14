-- SPDX-License-Identifier: Apache-2.0
-- G8 runtime half (nightly on staging and production; needs pg_stat_statements with track_utility on): no runtime role
-- issued a top-level 'SET app.' / 'RESET app.' or a direct set_config( call — context is set only through
-- scf.set_tenant_ctx() (C-103). Run by a role that can read every role's statements (superuser or pg_read_all_stats).
-- Amendment: `s.toplevel` — with pg_stat_statements.track = all the wrapper's own inner set_config calls are
-- recorded as nested statements of the calling role and would otherwise be reported.
SELECT r.rolname, s.query FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
 WHERE r.rolname IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro') AND s.toplevel
   AND (s.query ~* '^\s*(SET|RESET)\s+(LOCAL\s+|SESSION\s+)?app\.' OR s.query ~* '\mset_config\s*\(');
