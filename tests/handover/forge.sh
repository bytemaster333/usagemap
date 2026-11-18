#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Builds the forged dumps of the handover drill's tamper cases (runs in the usagemap/postgres-ha image, scratch server in
# $PGDATA). An attacker who can write the dump store holds the public age recipient (it is on every database host),
# so it can encrypt an archive of its own; it cannot read the original without the identity — the drill grants it
# that to forge the most convincing case: the real data with one Umami website renamed.
#
#   forge.sh IN_DIR RECIPIENT_FILE IDENTITY_FILE OUT_DIR
#     OUT_DIR/consistent/  forged data, manifest.tsv recomputed, fresh SHA256SUMS (a careful forger)
#     OUT_DIR/stale/       forged data, original manifest.tsv, fresh SHA256SUMS (a careless forger)
set -euo pipefail
IN=$1 RECIPIENT=$2 IDENTITY=$3 OUT=$4
. "$(dirname "$0")/manifest.sh"
: "${PGDATA:?}"
W=$(mktemp -d); trap 'rm -rf "$W"; pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true' EXIT
mkdir "$W/d"
age -d -i "$IDENTITY" "$IN/dump.tar.age" | tar -C "$W/d" --no-same-owner -xf -
initdb -D "$PGDATA" -U postgres --auth-local=trust -E UTF8 --locale=C.UTF-8 >/dev/null
pg_ctl -D "$PGDATA" -l "$W/pg.log" -w -o "-c listen_addresses='' -c unix_socket_directories=/var/run/postgresql" start >/dev/null
export PGHOST=/var/run/postgresql PGUSER=postgres
psql -X -q -d postgres -f "$W/d/globals.sql" >/dev/null 2>&1 || true
pg_restore --create --exit-on-error -d postgres "$W/d/umami.dump"
n=$(psql -X -q -At -d umami -c "UPDATE website SET name = name || ' (forged)' WHERE website_id = (SELECT website_id FROM website ORDER BY website_id LIMIT 1) RETURNING website_id" | grep -c . || true)
[ "$n" = 1 ] || { echo "forge: no Umami website to alter" >&2; exit 1; }
pg_dump -Fc -Z zstd -d umami -f "$W/umami.forged"
pack() { # pack NAME MANIFEST
  mkdir -p "$OUT/$1" "$W/$1"
  cp "$W/d/globals.sql" "$W/d/databases.txt" "$W/d/scf.dump" "$W/$1/"
  cp "$W/umami.forged" "$W/$1/umami.dump"
  cp "$2" "$W/$1/manifest.tsv"
  tar -C "$W/$1" -cf - . | age -r "$(tr -d '\n' <"$RECIPIENT")" -o "$OUT/$1/dump.tar.age"
  (cd "$OUT/$1" && sha256sum dump.tar.age >SHA256SUMS)
}
{ grep -v '^umami	' "$W/d/manifest.tsv"; manifest umami; } | sort >"$W/manifest.consistent"
sort "$W/d/manifest.tsv" >"$W/manifest.orig.sorted"
cmp -s "$W/manifest.consistent" "$W/manifest.orig.sorted" && { echo "forge: the manifest did not change" >&2; exit 1; }
# keep the generator's order (by db, then table) for the consistent forgery
{ grep -v '^umami	' "$W/d/manifest.tsv"; manifest umami; } >"$W/manifest.consistent"
pack consistent "$W/manifest.consistent"
pack stale "$W/d/manifest.tsv"
echo "forge: ok"
