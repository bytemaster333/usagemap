#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-12 — country accuracy with truncated addresses.  Re-run: ./run.sh   (needs network; ~70 MB download)
# DB-IP Lite is monthly (URL pinned by month); sapics user-country is rebuilt daily under a moving "latest" tag, so
# its checksum is verified against the publisher's .sha256 file and recorded, not pinned.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
eval "$(cd "$REPO" && mise env -s bash)"
export GOWORK=off
WORK="${S12_WORK:-/tmp/usagemap-spikes/s12}"
MONTH="${DBIP_MONTH:-2026-11}"
# 2026-11 pins: sha256 of the .gz we used; SHA1 of the .mmdb as published on db-ip.com/db/download/ip-to-country-lite
if [ "$MONTH" = 2026-11 ]; then
  DBIP_SHA256="${DBIP_SHA256:-75fe430010f6d38a8c4331c202bf0df6ce3221a6e6d823b9e5a6d951e4cf9758}"
  DBIP_MMDB_SHA1="${DBIP_MMDB_SHA1:-09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0}"
fi
N="${N:-1000000}"
mkdir -p "$WORK" "$HERE/results"
cd "$WORK"

get() { [ -s "$2" ] || curl -fsSL -o "$2" "$1"; }
get "https://download.db-ip.com/free/dbip-country-lite-$MONTH.mmdb.gz" "dbip-country-lite-$MONTH.mmdb.gz"
gunzip -kf "dbip-country-lite-$MONTH.mmdb.gz"
get https://github.com/sapics/ip-location-db/releases/download/latest/user-country.mmdb user-country.mmdb
get https://github.com/sapics/ip-location-db/releases/download/checksum/user-country.mmdb.sha256 user-country.mmdb.sha256
echo "$(awk '{print $1}' user-country.mmdb.sha256)  user-country.mmdb" | sha256sum -c -
get https://iptoasn.com/data/ip2asn-combined.tsv.gz ip2asn-combined.tsv.gz

{ echo "downloaded/verified $(date -u +%FT%TZ)"
  sha256sum "dbip-country-lite-$MONTH.mmdb.gz" "dbip-country-lite-$MONTH.mmdb" user-country.mmdb ip2asn-combined.tsv.gz
  [ -z "${DBIP_SHA256:-}" ] || echo "$DBIP_SHA256  dbip-country-lite-$MONTH.mmdb.gz" | sha256sum -c -
  [ -z "${DBIP_MMDB_SHA1:-}" ] || echo "$DBIP_MMDB_SHA1  dbip-country-lite-$MONTH.mmdb" | sha1sum -c -
} | tee "$HERE/results/inputs.txt"

cd "$HERE"
go run . -iptoasn "$WORK/ip2asn-combined.tsv.gz" -dbip "$WORK/dbip-country-lite-$MONTH.mmdb" \
  -uc "$WORK/user-country.mmdb" -n "$N" > results/results.json 2> results/run.log
cat results/run.log
python3 -I "$HERE/summarise.py" results/results.json | tee results/summary.md
