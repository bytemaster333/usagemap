#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Development PKI for the local stack (C-60: per-node mutual TLS from a private CA). Production certificates come
# from the IaC (infra/ansible, role pki); this script only serves `docker compose` on one machine.
#
#   infra/compose/scripts/dev-pki.sh          create what is missing (idempotent)
#   FORCE=1 infra/compose/scripts/dev-pki.sh  re-create everything (new CA)
#
# Output: infra/compose/.secrets/pki/ (git-ignored). Node certificates encode the caller's role in the single
# OrganizationalUnit (edge | reader | provisioner) and the node name in the CommonName — the engine proxy's identity
# rule (services/engine-proxy/README.md). Node names follow the one pattern of C-114: ^[a-z0-9][a-z0-9-]{1,31}$.
#
# Private keys are mode 0600 and owned by the uid of the one container user that reads them (Compose file secrets
# are bind mounts: Compose ignores uid/gid/mode for them, so ownership must be right on the host). The ownership is
# set with a throwaway container (root with CAP_CHOWN only, no network), because an unprivileged host user cannot
# chown. Consumers: 65532 = engine proxy, umami-bootstrap, Go services (gateway, metrics writer), the Collector (it
# uses the edge node's certificate, edge-a1, like the gateway on the same node) and the smoke client;
# 1000 = control plane and jobs (node). The CA key stays with the host user and is never mounted. Certificates are public
# (0644).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/.secrets/pki"
DAYS_CA=825
DAYS_LEAF=397
umask 077
mkdir -p "$OUT"
chmod 700 "$HERE/.secrets" "$OUT"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
[[ "${FORCE:-0}" == 1 ]] && rm -f "$OUT"/*.pem

newkey() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }
NODE_RE='^[a-z0-9][a-z0-9-]{1,31}$'
UID_GO=65532      # engine proxy, umami-bootstrap, gateway, metrics writer, Collector, smoke client (nonroot)
UID_NODE=1000     # control plane, jobs (user node)
# Throwaway chown helper (root + CAP_CHOWN, no network, never shipped): the upstream base digest of db/Dockerfile,
# pulled, so this script works before any image of the stack is built.
CHOWN_IMAGE=postgres:18.7-alpine@sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015
declare -A OWNER=()

if [[ ! -s "$OUT/ca.pem" || ! -s "$OUT/ca-key.pem" ]]; then
  rm -f "$OUT"/*.pem
  newkey "$OUT/ca-key.pem"
  openssl req -x509 -new -key "$OUT/ca-key.pem" -sha256 -days "$DAYS_CA" -subj "/O=UsageMap (dev)/CN=UsageMap dev node CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$OUT/ca.pem"
  echo "dev-pki: created CA"
fi

# issue NAME SUBJECT EXT OWNER_UID — writes NAME.pem and NAME-key.pem unless both exist; NAME is the CN.
issue() {
  local name=$1 subj=$2 ext=$3
  [[ "$name" =~ $NODE_RE ]] || { echo "dev-pki: $name is not a node name ($NODE_RE)" >&2; exit 1; }
  [[ "$subj" == *"/CN=$name" ]] || { echo "dev-pki: CN of $name must be $name" >&2; exit 1; }
  OWNER[$name]=$4
  [[ -s "$OUT/$name.pem" && -s "$OUT/$name-key.pem" ]] && return 0
  local csr extf
  csr="$(mktemp)"; extf="$(mktemp)"
  newkey "$OUT/$name-key.pem"
  openssl req -new -key "$OUT/$name-key.pem" -subj "$subj" -out "$csr"
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n%s\n' "$ext" > "$extf"
  openssl x509 -req -in "$csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca-key.pem" -set_serial "0x$(openssl rand -hex 16)" \
    -days "$DAYS_LEAF" -sha256 -extfile "$extf" -out "$OUT/$name.pem" 2>/dev/null
  rm -f "$csr" "$extf"
  echo "dev-pki: issued $name ($subj)"
}

# Servers: the engine proxy's listener; the control plane's internal edge API listener (reached only by the engine
# proxy, over the dedicated network, with mutual TLS — C-114).
issue engine-proxy "/CN=engine-proxy" \
  "extendedKeyUsage=serverAuth
subjectAltName=DNS:engine-proxy,DNS:localhost,IP:127.0.0.1" $UID_GO
issue control-plane "/CN=control-plane" \
  "extendedKeyUsage=serverAuth
subjectAltName=DNS:control-plane" $UID_NODE
# The gateway's public listener: the two ingest host names compiled into the tracker (manifest config.hosts) and
# localhost (and `gateway`, for clients inside the stack). Browsers do not trust the dev CA; local tests resolve the names to 127.0.0.1 and pass the CA or -k.
issue ingest "/CN=ingest" \
  "extendedKeyUsage=serverAuth
subjectAltName=DNS:ingest-a.example-analytics.org,DNS:ingest-b.example-analytics.net,DNS:gateway,DNS:localhost,IP:127.0.0.1" $UID_GO
# The metrics writer's OTLP listener (C-107): the node name and the shared name every edge Collector dials
# (`writers.<mesh>`; one name, the address records of both writers). Clients: edge-* certificates (OU edge).
issue core-a-writer "/CN=core-a-writer" \
  "extendedKeyUsage=serverAuth
subjectAltName=DNS:core-a-writer,DNS:writers.mesh.local,DNS:localhost" $UID_GO
# The engine proxy as a client of the control plane's internal API (SCF_INTERNAL_ALLOWED_CLIENTS). Its OU is not an
# engine-proxy caller role, so the certificate is useless against the engine proxy itself.
issue core-a-engine-proxy    "/OU=engine-proxy/CN=core-a-engine-proxy"   "extendedKeyUsage=clientAuth" $UID_GO
# Callers of the engine proxy (C-60): edge forwarders, readers (control plane, jobs), provisioning identities (the jobs
# service — tenant_purge and umami_reconcile, F16 — and the umami-bootstrap one-shot; one certificate per owner).
# Edge node certificates are also servers: the gateways exchange their ingest keys node to node (GW_KEYX_*), so
# they carry serverAuth as well; certificates issued before that (clientAuth only) are re-issued.
for n in edge-a1 edge-a2; do
  if [[ -s "$OUT/$n.pem" ]] && ! openssl x509 -in "$OUT/$n.pem" -noout -ext extendedKeyUsage 2>/dev/null | grep -q 'Server Authentication'; then
    rm -f "$OUT/$n.pem" "$OUT/$n-key.pem"
  fi
done
issue edge-a1                "/OU=edge/CN=edge-a1"                       "extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:edge-a1" $UID_GO
issue edge-a2                "/OU=edge/CN=edge-a2"                       "extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:edge-a2" $UID_GO
issue core-a-control-plane   "/OU=reader/CN=core-a-control-plane"        "extendedKeyUsage=clientAuth" $UID_NODE
issue core-a-jobs            "/OU=reader/CN=core-a-jobs"                 "extendedKeyUsage=clientAuth" $UID_GO
issue core-a-umami-bootstrap "/OU=provisioner/CN=core-a-umami-bootstrap" "extendedKeyUsage=clientAuth" $UID_GO
issue core-a-jobs-provisioner "/OU=provisioner/CN=core-a-jobs-provisioner" "extendedKeyUsage=clientAuth" $UID_NODE
# The jobs service's reader identity: umami_reconcile reads with a freshly rotated key before storing it (C-85).
issue core-a-jobs-reader     "/OU=reader/CN=core-a-jobs-reader"          "extendedKeyUsage=clientAuth" $UID_NODE

# Certificates are public; the CA key stays 0600 with the host user and is never mounted.
for f in "$OUT"/*.pem; do
  [[ "$f" == *-key.pem ]] || chmod 644 "$f"
done
chmod 600 "$OUT/ca-key.pem"
# Leaf keys: 0600, owned by their one consumer. chmod first (only possible while the host user owns the file).
args=(); names=()
for name in "${!OWNER[@]}"; do
  f="$OUT/$name-key.pem"
  [[ -O "$f" ]] && chmod 600 "$f"
  args+=(-v "$f:/k/$name")
  names+=("${OWNER[$name]}:${OWNER[$name]} /k/$name")
done
command -v docker >/dev/null || { echo "dev-pki: docker is required to hand the keys to their container users" >&2; exit 1; }
printf '%s\n' "${names[@]}" | docker run --rm -i --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN \
  --security-opt no-new-privileges:true "${args[@]}" --entrypoint sh "$CHOWN_IMAGE" \
  -c 'while read -r owner file; do chown "$owner" "$file"; done' >/dev/null
