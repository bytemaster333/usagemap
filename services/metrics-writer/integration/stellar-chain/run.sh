#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The whole Stellar client-metric chain (C-153): a live export of @usagemap/stellar-otel → the built Collector
# (collector/config/collector.yaml) → the metrics-writer binary (mutual TLS) → PostgreSQL → the control plane's
# GET …/stellar-client. Runs services/control-plane/test/integration/stellar-client-chain.test.ts with its own
# PostgreSQL stack (Compose project scf-stellar-chain, ports 56956/56957) and processes on 56950–56955 (its own range
# 56950–56959: clear of the quickstarts stack 56460–56469, `make up` 56450–56452 and the integration chain 56940–56947).
# Needs Docker, the toolchain (mise) and collector/_build/scf-otelcol (collector/scripts/build.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
cd "$repo"
eval "$(mise env -s bash)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
[ -x collector/_build/scf-otelcol ] || { echo "build the Collector first: collector/scripts/build.sh" >&2; exit 1; }

(cd services/metrics-writer && go build -o "$work/metrics-writer" ./cmd/metrics-writer)

# Throwaway private CA, the writer's server certificate (localhost) and the edge client certificate (OU=edge, C-113).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=chain test CA" \
  -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
issue() { # name subject extensions
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "$2" -keyout "$work/$1.key" -out "$work/$1.csr" 2>/dev/null
  printf '%s\n' "$3" > "$work/$1.ext"
  openssl x509 -req -in "$work/$1.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 1 \
    -extfile "$work/$1.ext" -out "$work/$1.crt" 2>/dev/null
}
issue writer "/CN=core-a-writer/OU=writer" $'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature'
issue edge "/CN=edge-a1/OU=edge" $'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature'
chmod 600 "$work"/*.key

node "$here/package-export.mts" "$work/export.json"

cd services/control-plane
SCF_STELLAR_CHAIN_DIR="$work" SCF_STELLAR_CHAIN_PORT_BASE=56950 \
  SCF_WSF_PG_PROJECT=scf-stellar-chain SCF_WSF_PG_PORT=56956 SCF_WSF_PGB_PORT=56957 \
  npx vitest run --project integration test/integration/stellar-client-chain.test.ts
