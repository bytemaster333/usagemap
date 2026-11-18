#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Data fingerprint of a PostgreSQL cluster for the handover migration drill (handover.independent-operator, handover.data-migration, handover.ready; handover plan
# §4.3 "row counts" and "content checksums"). Runs wherever psql 18 reaches the server (PGHOST/PGUSER/PGPASSWORD from
# the environment; superuser, so row-level security does not hide rows) and prints sorted TSV lines:
#
#   <db>  table     <schema.table>   <rows> <md5 of the sorted per-row md5s>     every ordinary table and partition
#   <db>  sequence  <schema.seq>     <last_value> <is_called>
#   <db>  schema    <part>           <md5>        columns, constraints, indexes, policies, RLS flags, grants,
#                                                 functions (body, owner, SECURITY DEFINER, settings), triggers, views
#   <db>  database  owner|acl|settings  <value>   database owner, ACL and ALTER DATABASE … SET settings
#   -     role      <role>           <md5>        role attributes, memberships and settings (never passwords)
#
#   fingerprint.sh scf umami        (databases to fingerprint; roles are cluster-wide and printed once)
#   FP_RAW=1 fingerprint.sh …       the schema and role lines carry the hashed text itself (newlines as ¶), to find
#                                   what differs; schema text only, still no row content
#
# Nothing in the output is personal data: counts and hashes only. Two clusters hold the same data and schema exactly
# when their outputs are equal; `diff` names the table or object that differs.
set -euo pipefail
if [ "${FP_RAW:-0}" = 1 ]; then H="replace(%s, E'\\n', ' ¶ ')"; else H="md5(%s)"; fi
h() { printf "$H" "$1"; } # h SQL-EXPR → the expression hashed, or raw with FP_RAW=1
q() { psql -X -At -F $'\t' -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

for db in "$@"; do
  [ "$(q postgres "SELECT count(*) FROM pg_database WHERE datname = '$db'")" = 1 ] || { printf '%s\tdatabase\tmissing\t-\n' "$db"; continue; }
  q "$db" "SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'
            ORDER BY 1" | while IFS= read -r t; do
    # ONLY: a partitioned parent's rows are counted at its partitions (relkind 'p' is not listed, partitions are 'r').
    q "$db" "SELECT '$db', 'table', '$t', count(*) || ' ' || coalesce(md5(string_agg(h, '' ORDER BY h)), '-')
               FROM (SELECT md5(x::text) AS h FROM ONLY $t x) s"
  done
  q "$db" "SELECT '$db', 'sequence', schemaname || '.' || sequencename, coalesce(last_value::text, 'null')
             FROM pg_sequences ORDER BY 3"
  # Each part is the sorted set of its lines (order-independent). ACLs are compared as effective privileges: a NULL
  # ACL is the owner's default (acldefault), which pg_restore produces where the source held the same default
  # explicitly. NOT NULL constraints are compared by table and column: PostgreSQL 18 names them, and a restore may
  # name a partitioned table's ones differently (api_metrics_1m_hist_not_null → …_not_null1, drill 2026-11-18).
  # CHECK expressions are compared without parentheses: the restore re-parses them and flattens nested ANDs, so
  # ((a AND b) AND c) comes back as (a AND b AND c) (hist_exp3_map, seal_leaves, web_dev_events in the drill). The
  # row content of every table is compared exactly; this only loosens the schema text of CHECK constraints.
  q "$db" "
    WITH lines(part, l) AS (
      SELECT 'columns', format('%I.%I.%I %s %s %s', n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                               a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), ''))
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
      UNION ALL
      SELECT 'constraints', format('%I.%I %s %s', n.nspname, c.relname, CASE WHEN k.contype = 'n' THEN '(not null)' ELSE quote_ident(k.conname) END,
                                   CASE WHEN k.contype = 'c' THEN translate(pg_get_constraintdef(k.oid), '()', '') ELSE pg_get_constraintdef(k.oid) END)
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL
      SELECT 'indexes', schemaname || ' ' || indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema')
      UNION ALL
      SELECT 'policies', format('%s.%s %s %s %s %s %s %s', schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check) FROM pg_policies
      UNION ALL
      SELECT 'rls_and_grants', format('%I.%I %s %s %s %s owner=%s', n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
                                      (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::\"char\", c.relowner))) x),
                                      pg_get_userbyid(c.relowner))
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','S','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
      UNION ALL
      SELECT 'schemas', format('%I owner=%s acl=%s', nspname, pg_get_userbyid(nspowner),
                               (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(nspacl, acldefault('n', nspowner))) x))
        FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_(toast|temp)'
      UNION ALL
      SELECT 'functions', format('%I.%I(%s) owner=%s definer=%s config=%s acl=%s md5=%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                                 pg_get_userbyid(p.proowner), p.prosecdef, coalesce(p.proconfig::text, ''),
                                 (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(p.proacl, acldefault('f', p.proowner))) x), md5(p.prosrc))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL
      SELECT 'triggers', format('%s %s', tgrelid::regclass, pg_get_triggerdef(oid)) FROM pg_trigger WHERE NOT tgisinternal
      UNION ALL
      SELECT 'views', format('%I.%I %s', schemaname, viewname, md5(definition)) FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema')
      UNION ALL
      SELECT 'extensions', extname || ' ' || extversion FROM pg_extension
    ), parts(part) AS (VALUES ('columns'), ('constraints'), ('indexes'), ('policies'), ('rls_and_grants'), ('schemas'), ('functions'), ('triggers'), ('views'), ('extensions'))
    SELECT '$db', 'schema', p.part, $(h "coalesce((SELECT string_agg(l, E'\\n' ORDER BY l) FROM lines WHERE lines.part = p.part), '')")
      FROM parts p ORDER BY p.part"
  q postgres "SELECT '$db', 'database', 'owner', pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$db'
              UNION ALL
              SELECT '$db', 'database', 'acl', (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(datacl, acldefault('d', datdba))) x)
                FROM pg_database WHERE datname = '$db'
              UNION ALL
              SELECT '$db', 'database', 'settings', coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM pg_db_role_setting s, unnest(s.setconfig) x
                                                              WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = '$db') AND s.setrole = 0), 'none')"
done
# Roles: attributes, memberships and per-role settings; the bootstrap superuser and pg_* roles are the installation's.
q postgres "SELECT '-', 'role', r.rolname,
                   $(h "format('%s %s %s %s %s %s %s %s', r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolbypassrls, r.rolconnlimit,
                              coalesce((SELECT string_agg(pg_get_userbyid(m.roleid) || ':' || m.admin_option || m.inherit_option || m.set_option, ',' ORDER BY pg_get_userbyid(m.roleid))
                                          FROM pg_auth_members m WHERE m.member = r.oid), '')
                              || ' ' || coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM pg_db_role_setting s, unnest(s.setconfig) x WHERE s.setrole = r.oid), ''))")
              FROM pg_roles r WHERE r.rolname !~ '^pg_' AND r.oid <> 10 ORDER BY 3"
