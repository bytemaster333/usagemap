#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Development secrets for the local stack. In production these come from SOPS (ADR-0019, C-79); here they are random
# values in infra/compose/.secrets/ (git-ignored), created once and kept (idempotent: existing files are never
# overwritten, so a restart never strands a password — the Umami bootstrap is restartable because of that, C-112(7)).
#
#   infra/compose/scripts/dev-secrets.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/.secrets"
umask 077
mkdir -p "$OUT"
chmod 700 "$OUT"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

# gen NAME BYTES — random hex (URL- and shell-safe), no trailing newline.
gen() {
  [[ -s "$OUT/$1" ]] && return 0
  printf '%s' "$(openssl rand -hex "$2")" > "$OUT/$1"
  echo "dev-secrets: created $1"
}

gen pg_superuser_password      24   # PostgreSQL superuser (bootstrap, umami-views only)
gen umami_db_password          24   # role umami_app (Umami's own schema owner, C-12)
gen umami_app_secret           32   # Umami APP_SECRET: 32 random bytes, identical on every Umami instance (C-112(11))
gen umami_seed_admin_password  24   # B2: the seed admin's interim password (C-112(7))
gen umami_provisioner_password 24   # B3: the provisioning admin's password
gen scf_migrator_password      24
gen scf_app_password           24
gen scf_writer_password        24
gen scf_jobs_password          24
gen scf_metrics_ro_password    24
gen scf_dump_login_password    24
gen scf_monitor_password       24   # PostgreSQL exporter (pg_monitor; monitoring overlay)
gen scf_umami_ro_password      24
gen scf_umami_maint_password   24

# genkey NAME BYTES — a versioned key set `1:<base64 of BYTES random bytes>` (the control plane's key-set format).
genkey() {
  [[ -s "$OUT/$1" ]] && return 0
  printf '1:%s' "$(openssl rand -base64 "$2" | tr -d '\n')" > "$OUT/$1"
  echo "dev-secrets: created $1"
}
genkey umami_creds_keys 32   # K_umami_creds: AES-256-GCM key for the tenants' Umami credentials (C-40, C-85)
genkey pepper_ing       32   # ingest-token pepper, shared with the edge nodes (wire-formats §k, C-81)
genkey pepper_op        32   # SCF-operator API key pepper (core only)
genkey pepper_pub       32   # share-key pepper (core only)

# Connection URLs for services that take a URL (control plane reads SCF_DATABASE_URL_FILE). Runtime roles connect
# through PgBouncer in transaction mode (ADR-0013, C-103); only the migrators and the superuser steps (db-migrate,
# umami-views*) and Umami itself connect to PostgreSQL directly. Derived values: rewritten when they differ.
derive() {
  local name=$1 content=$2
  [[ -s "$OUT/$name" && "$(cat "$OUT/$name")" == "$content" ]] && return 0
  printf '%s' "$content" > "$OUT/$name"
  echo "dev-secrets: wrote $name"
}
url() { derive "$1" "postgresql://$2:$(cat "$OUT/$3")@pgbouncer:6432/$4"; }
url control_plane_database_url scf_app          scf_app_password          scf
url jobs_database_url          scf_jobs         scf_jobs_password         scf
url metrics_ro_database_url    scf_metrics_ro   scf_metrics_ro_password   scf    # control plane: operator metrics API
# The one exception to "runtime roles only through PgBouncer": LISTEN needs a session, so the jobs service's core
# workers (scf_edge, scf_umami, scf_verify, scf_erasure, scf_snapshot; F16) connect directly as scf_jobs on network `db`
# and only ever run LISTEN.
derive jobs_listen_database_url "postgresql://scf_jobs:$(cat "$OUT/scf_jobs_password")@postgres:5432/scf"

# PgBouncer's auth_file: the runtime roles it may log in (SCRAM towards clients and towards PostgreSQL). Roles not
# listed here (superuser, scf_migrator, umami_app, …) cannot connect through PgBouncer at all.
userlist=""
for r in scf_app scf_jobs scf_writer scf_metrics_ro scf_umami_ro scf_umami_maint; do
  userlist+="\"$r\" \"$(cat "$OUT/${r}_password")\""$'\n'
done
derive pgbouncer_userlist "${userlist%$'\n'}"

# Edge-snapshot signing key (Ed25519, wire-formats §e.2), held by the jobs service only (F16).
if [[ ! -s "$OUT/edge_signing_key.pem" ]]; then
  openssl genpkey -algorithm ed25519 -out "$OUT/edge_signing_key.pem" 2>/dev/null
  echo "dev-secrets: created edge_signing_key.pem"
fi
# Its public half for the gateways (GW_SNAPSHOT_KEYS, kid edge-1); derived, rewritten when it differs.
derive edge_snapshot_pub.pem "$(openssl pkey -in "$OUT/edge_signing_key.pem" -pubout 2>/dev/null)"
# The rotation slot (kid edge-2): a copy of the current public key until a rotation puts the next key there; kept as is.
if [[ ! -s "$OUT/edge_snapshot_pub_next.pem" ]]; then
  cp "$OUT/edge_snapshot_pub.pem" "$OUT/edge_snapshot_pub_next.pem"
  echo "dev-secrets: created edge_snapshot_pub_next.pem (copy of the current key)"
fi

# Traction-snapshot signing key (Ed25519, PKCS#8 PEM; C-47, C-81): separate from the edge key, held by the jobs service
# only (F16); its public half is what the control plane publishes in /.well-known/scf-snapshot-keys.json (kid snap-1).
if [[ ! -s "$OUT/snapshot_signing_key.pem" ]]; then
  openssl genpkey -algorithm ed25519 -out "$OUT/snapshot_signing_key.pem" 2>/dev/null
  echo "dev-secrets: created snapshot_signing_key.pem"
fi
derive snapshot_pub.pem "$(openssl pkey -in "$OUT/snapshot_signing_key.pem" -pubout 2>/dev/null)"

# SEP-10 server signing key (C-15): a fresh random Stellar secret seed (StrKey `S…`: version byte 18<<3, 32 random
# bytes, CRC-16/XModem little-endian, base32 without padding). Written straight to the file, never printed. Local
# stack only — production takes it from SOPS.
if [[ ! -s "$OUT/sep10_signing_seed" ]]; then
  command -v node >/dev/null || { echo "node is required (mise install)" >&2; exit 1; }
  node -e '
    const { randomBytes } = require("node:crypto"); const { writeFileSync } = require("node:fs");
    const payload = Buffer.concat([Buffer.from([18 << 3]), randomBytes(32)]);
    let crc = 0;
    for (const b of payload) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
    const all = Buffer.concat([payload, Buffer.from([crc & 0xff, crc >> 8])]);
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, val = 0, out = "";
    for (const b of all) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += A[(val << (5 - bits)) & 31];
    writeFileSync(process.argv[1], out, { mode: 0o600 });
  ' "$OUT/sep10_signing_seed"
  echo "dev-secrets: created sep10_signing_seed"
fi

# Containers read these through Compose file secrets as their own non-root users (uid 70, 1001, 65532 …), so the files
# are world-readable inside a 0700 directory that only the owner can enter on the host.
find "$OUT" -maxdepth 1 -type f -exec chmod 644 {} +
