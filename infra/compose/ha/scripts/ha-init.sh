#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Development secrets of the HA profile (compose.ha.yaml), next to the single-node ones of scripts/init.sh. In
# production every value here comes from SOPS (ADR-0019, C-79) or the IaC (storage keys never leave Azure: nodes use
# SAS tokens or managed identities, infra/opentofu). Idempotent: existing files are kept.
#
#   infra/compose/ha/scripts/ha-init.sh [IMAGE]    IMAGE = the database-node image (for age-keygen); default below
#
# Output: infra/compose/.secrets/ha/ (git-ignored, directory 0700; files 0644 like the rest of .secrets/ so that the
# container users can read the bind-mounted secrets — development only).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)" # infra/compose
OUT="$HERE/.secrets/ha"
IMAGE=${1:-usagemap/postgres-ha:18.7-pgbr2.60.0-patroni4.1.5}
AZBLOB="$HERE/ha/bin/scf-azblob"
SAS_DAYS=${SCF_HA_SAS_DAYS:-30}
umask 077
"$HERE/scripts/init.sh" >/dev/null # the base secrets and PKI (pg_superuser_password, umami_db_password, …)
mkdir -p "$OUT"
chmod 700 "$HERE/.secrets" "$OUT"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

gen() { [[ -s "$OUT/$1" ]] || { printf '%s' "$(openssl rand -hex "$2")" >"$OUT/$1"; echo "ha-init: created $1"; }; }
gen pg_replication_password 24
gen pg_rewind_password 24
gen patroni_restapi_password 24
gen pgbackrest_repo1_cipher_pass 32 # one cipher pass per repository (S-08 O5)
gen pgbackrest_repo2_cipher_pass 32
gen scf_hatest_password 24 # the failover test's writer role (tests only)
# Azurite account keys (two "storage accounts" in two "regions"): base64 of 64 random bytes, as Azure's.
for a in a b; do
  [[ -s "$OUT/azurite_${a}_key" ]] || { openssl rand -base64 64 | tr -d '\n' >"$OUT/azurite_${a}_key"; echo "ha-init: created azurite_${a}_key"; }
done

# TLS for Azurite (pgBackRest's Azure driver is HTTPS-only, S-08 O2): a throw-away CA with keyUsage (Python's strict
# X.509 check rejects a CA without it) and one server certificate for both hosts.
if [[ ! -s "$OUT/azurite_ca.pem" || ! -s "$OUT/azurite.pem" ]]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$OUT/azurite_ca-key.pem" 2>/dev/null
  openssl req -x509 -new -key "$OUT/azurite_ca-key.pem" -sha256 -days 825 -subj "/CN=SCF dev Azurite CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$OUT/azurite_ca.pem"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$OUT/azurite-key.pem" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:azurite-a,DNS:azurite-b\n' >"$OUT/azurite.ext"
  openssl req -new -key "$OUT/azurite-key.pem" -subj "/CN=azurite" -out "$OUT/azurite.csr"
  openssl x509 -req -in "$OUT/azurite.csr" -CA "$OUT/azurite_ca.pem" -CAkey "$OUT/azurite_ca-key.pem" \
    -set_serial "0x$(openssl rand -hex 16)" -days 397 -sha256 -extfile "$OUT/azurite.ext" -out "$OUT/azurite.pem" 2>/dev/null
  rm -f "$OUT/azurite.csr" "$OUT/azurite.ext"
  rm -f "$OUT"/*_sas # tokens are re-issued below
  echo "ha-init: created Azurite CA and certificate"
fi

# SAS tokens (C-108): database nodes `racwdl` on their container — create, write, delete current blobs, list; never
# x (delete version) or y (permanent delete). The restore-drill host `rl` on repository 2 only. Account SAS `c` for
# the one-shot that creates the containers.
sas() { [[ -s "$OUT/$1" ]] || { "$AZBLOB" "$2" "${@:3}" >"$OUT/$1"; echo "ha-init: issued $1"; }; }
sas pgbackrest_repo1_key sas-container scfbackupa "$OUT/azurite_a_key" pgbackrest racwdl "$SAS_DAYS"
sas pgbackrest_repo2_key sas-container scfbackupb "$OUT/azurite_b_key" pgbackrest racwdl "$SAS_DAYS"
sas pgbackrest_repo2_drill_sas sas-container scfbackupb "$OUT/azurite_b_key" pgbackrest rl "$SAS_DAYS"
sas azurite_a_init_sas sas-account scfbackupa "$OUT/azurite_a_key" rc "$SAS_DAYS"
sas azurite_b_init_sas sas-account scfbackupb "$OUT/azurite_b_key" rc "$SAS_DAYS"

# age key pair for the weekly logical dump: the recipient (public) goes to the database nodes, the identity (private)
# only to the host that restores a dump (migration / handover, handover.data-migration).
if [[ ! -s "$OUT/dump_age_identity" ]]; then
  # On a fresh machine the image does not exist yet: build it from the same context as compose.ha.yaml.
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "ha-init: building $IMAGE (needed for age-keygen)"
    docker buildx build --load -q -t "$IMAGE" -f "$HERE/ha/postgres/Dockerfile" "$HERE/ha" >/dev/null
  fi
  docker run --rm --network none --entrypoint age-keygen "$IMAGE" 2>/dev/null >"$OUT/dump_age_identity"
  echo "ha-init: created dump_age_identity"
fi
sed -n 's/^# public key: //p' "$OUT/dump_age_identity" >"$OUT/dump_age_recipient"

# PgBouncer auth file for the test overlay: the base file plus the failover writer (tests only).
{ cat "$HERE/.secrets/pgbouncer_userlist"; printf '\n"scf_hatest" "%s"\n' "$(cat "$OUT/scf_hatest_password")"; } >"$OUT/pgbouncer_userlist_test"

find "$OUT" -maxdepth 1 -type f ! -name '*-key.pem' -exec chmod 644 {} +
chmod 644 "$OUT/azurite-key.pem" # Azurite (root in its container, no capabilities dropped) reads it; dev only
chmod 600 "$OUT/azurite_ca-key.pem" # never mounted

# DCS PKI (F15): etcd client and peer TLS with client-certificate authentication, Patroni's REST API over TLS. A CA
# of its own (dcs/ca.pem); per etcd member one certificate for client and peer traffic (serverAuth + clientAuth, SAN =
# member name); Patroni's client certificate towards etcd; per database node a REST API server certificate (SAN node
# name and localhost). In production the Ansible `pki` role issues the same set from the IaC CA.
DCS="$OUT/dcs"
mkdir -p "$DCS"
if [[ ! -s "$DCS/ca.pem" ]]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$DCS/ca-key.pem" 2>/dev/null
  openssl req -x509 -new -key "$DCS/ca-key.pem" -sha256 -days 825 -subj "/CN=SCF dev DCS CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$DCS/ca.pem"
  rm -f "$DCS"/etcd-*.pem "$DCS"/patroni-*.pem "$DCS"/pg-*.pem
  echo "ha-init: created DCS CA"
fi
issue_dcs() { # issue_dcs NAME CN EKU SAN…
  local n=$1 cn=$2 eku=$3; shift 3
  [[ -s "$DCS/$n.pem" && -s "$DCS/$n-key.pem" ]] && return 0
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$DCS/$n-key.pem" 2>/dev/null
  openssl req -new -key "$DCS/$n-key.pem" -subj "/CN=$cn" -out "$DCS/$n.csr"
  { printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=%s\n' "$eku"
    [ $# -gt 0 ] && printf 'subjectAltName=%s\n' "$(printf 'DNS:%s,' "$@" | sed 's/,$//')"; } >"$DCS/$n.ext"
  openssl x509 -req -in "$DCS/$n.csr" -CA "$DCS/ca.pem" -CAkey "$DCS/ca-key.pem" -set_serial "0x$(openssl rand -hex 16)" \
    -days 397 -sha256 -extfile "$DCS/$n.ext" -out "$DCS/$n.pem" 2>/dev/null
  rm -f "$DCS/$n.csr" "$DCS/$n.ext"
  echo "ha-init: issued dcs/$n"
}
for m in etcd-a etcd-b etcd-c; do issue_dcs "$m" "$m" serverAuth,clientAuth "$m" localhost; done
issue_dcs patroni-etcd-client patroni clientAuth
for n in pg-a pg-b; do issue_dcs "$n-rest" "$n" serverAuth "$n" localhost; done
# Development convention of this directory: readable by the container users (etcd runs as root, Patroni as 999,
# HAProxy as haproxy); the CA key is never mounted.
find "$DCS" -maxdepth 1 -type f -name '*.pem' ! -name 'ca-key.pem' -exec chmod 644 {} +
chmod 600 "$DCS/ca-key.pem"
# Multi-node profile (core-b, edge-a2): certificates for the second engine proxy from the base development CA
# (scripts/dev-pki.sh). Server: SAN engine-proxy-b; client towards the control plane's internal API: core-b-engine-proxy.
PKI="$HERE/.secrets/pki"
issue_b() { # issue_b NAME SUBJECT EXT OWNER_UID
  [[ -s "$OUT/$1.pem" && -s "$OUT/$1-key.pem" ]] && return 0
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$OUT/$1-key.pem" 2>/dev/null
  openssl req -new -key "$OUT/$1-key.pem" -subj "$2" -out "$OUT/$1.csr"
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n%s\n' "$3" >"$OUT/$1.ext"
  openssl x509 -req -in "$OUT/$1.csr" -CA "$PKI/ca.pem" -CAkey "$PKI/ca-key.pem" -set_serial "0x$(openssl rand -hex 16)" \
    -days 397 -sha256 -extfile "$OUT/$1.ext" -out "$OUT/$1.pem" 2>/dev/null
  rm -f "$OUT/$1.csr" "$OUT/$1.ext"
  echo "ha-init: issued $1"
}
issue_b engine-proxy-b "/CN=engine-proxy-b" $'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:engine-proxy-b'
issue_b core-b-engine-proxy "/OU=engine-proxy/CN=core-b-engine-proxy" "extendedKeyUsage=clientAuth"
chmod 644 "$OUT"/engine-proxy-b.pem "$OUT"/core-b-engine-proxy.pem
# The engine proxy runs as uid 65532 and reads its keys as bind-mounted secrets (see dev-pki.sh).
for k in engine-proxy-b-key.pem core-b-engine-proxy-key.pem; do
  [[ -O "$OUT/$k" ]] || continue
  chmod 600 "$OUT/$k"
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
    -v "$OUT/$k:/k" --entrypoint chown postgres:18.7-alpine@sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015 65532:65532 /k
done
