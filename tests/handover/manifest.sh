# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash
# manifest DB → "<db>\t<schema.table>\t<rows>\t<md5 of the ordered row md5s or ->" per ordinary table of user schemas
# (a partitioned table once, with its partitions). The SAME SQL as `manifest` in infra/compose/ha/bin/scf-backup,
# which writes manifest.tsv into every weekly dump; import.sh recomputes it on the target and forge.sh on a forgery.
# Keep the two in step (tests/handover/run.sh compares a fresh dump's manifest with this function's output).
manifest() {
  local db=$1 max=${SCF_DUMP_CHECKSUM_MAX_BYTES:-268435456}
  psql -X -At -F $'\t' -d "$db" -v ON_ERROR_STOP=1 -c "
    SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname),
           (SELECT coalesce(sum(pg_total_relation_size(p.relid)), 0) FROM pg_partition_tree(c.oid) p) <= $max
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p') AND NOT c.relispartition
       AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
     ORDER BY 1" | while IFS=$'\t' read -r tbl small; do
    if [ "$small" = t ]; then
      psql -X -At -F $'\t' -d "$db" -v ON_ERROR_STOP=1 \
        -c "SELECT '$db', '$tbl', count(*), coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '-') FROM $tbl t"
    else
      psql -X -At -F $'\t' -d "$db" -v ON_ERROR_STOP=1 -c "SELECT '$db', '$tbl', count(*), '-' FROM $tbl"
    fi
  done
}
