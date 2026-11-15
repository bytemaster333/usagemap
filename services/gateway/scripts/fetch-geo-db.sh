#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Downloads the DB-IP IP to Country Lite database (CC BY 4.0) that the gateway image bakes in, verified against the
# SAME pins as services/gateway/Dockerfile (URL and SHA-256 of the .gz from its `ADD --checksum`, SHA-256 of the
# .mmdb from its `sha256sum -c` line), so the pin lives in one place. Prints the two variables the geo test reads
# (internal/geo TestDBIPLite), one per line, ready for `export`:
#   services/gateway/scripts/fetch-geo-db.sh <dest-dir>   →   SCF_GEO_DB=<dest-dir>/dbip-country-lite.mmdb
#                                                              SCF_GEO_SHA256=<sha-256 of the .mmdb>
set -euo pipefail
DF="$(cd "$(dirname "$0")/.." && pwd)/Dockerfile"
DEST="${1:?usage: fetch-geo-db.sh <dest-dir>}"
# The `ADD --checksum=sha256:<gz sha> \` line directly above the DB-IP URL (the Dockerfile has other ADD pins).
read -r GZ_SHA URL < <(awk '/^ADD --checksum=sha256:[0-9a-f]{64} \\$/ { sha = substr($2, 19, 64); next }
  sha != "" && match($0, /https:\/\/download\.db-ip\.com\/free\/dbip-country-lite-[0-9-]+\.mmdb\.gz/) {
    print sha, substr($0, RSTART, RLENGTH); exit } { sha = "" }' "$DF")
MMDB_SHA=$(sed -n 's/^.*echo "\([0-9a-f]\{64\}\)  dbip-country-lite\.mmdb".*$/\1/p' "$DF")
[ -n "$GZ_SHA" ] && [ -n "$URL" ] && [ -n "$MMDB_SHA" ] || { echo "fetch-geo-db: pins not found in $DF" >&2; exit 2; }
mkdir -p "$DEST"
out="$DEST/dbip-country-lite.mmdb"
if [ -s "$out" ] && echo "$MMDB_SHA  $out" | sha256sum -c --quiet - 2>/dev/null; then
  printf 'SCF_GEO_DB=%s\nSCF_GEO_SHA256=%s\n' "$out" "$MMDB_SHA"; exit 0
fi
curl -fsSL --retry 3 -o "$out.gz.tmp" "$URL"
echo "$GZ_SHA  $out.gz.tmp" | sha256sum -c --quiet - || { rm -f "$out.gz.tmp"; echo "checksum mismatch: $URL" >&2; exit 2; }
gunzip -c "$out.gz.tmp" >"$out.tmp" && rm -f "$out.gz.tmp"
echo "$MMDB_SHA  $out.tmp" | sha256sum -c --quiet - || { rm -f "$out.tmp"; echo "checksum mismatch: unpacked .mmdb" >&2; exit 2; }
chmod 0444 "$out.tmp" && mv -f "$out.tmp" "$out"
printf 'SCF_GEO_DB=%s\nSCF_GEO_SHA256=%s\n' "$out" "$MMDB_SHA"
