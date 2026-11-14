-- SPDX-License-Identifier: Apache-2.0
-- G7: every partition carries every parent policy with the same command, roles and expressions (CR-31).
SELECT c.oid::regclass, pp.polname FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
  JOIN pg_policy pp ON pp.polrelid = h.inhparent
 WHERE NOT EXISTS (SELECT 1 FROM pg_policy q WHERE q.polrelid = c.oid AND q.polname = pp.polname
                     AND q.polcmd = pp.polcmd AND q.polpermissive = pp.polpermissive
                     AND (SELECT array_agg(x ORDER BY x) FROM unnest(q.polroles) x)
                       = (SELECT array_agg(x ORDER BY x) FROM unnest(pp.polroles) x)      -- roles as a set
                     AND pg_get_expr(q.polqual, q.polrelid) IS NOT DISTINCT FROM pg_get_expr(pp.polqual, pp.polrelid)
                     AND pg_get_expr(q.polwithcheck, q.polrelid) IS NOT DISTINCT FROM pg_get_expr(pp.polwithcheck, pp.polrelid));
