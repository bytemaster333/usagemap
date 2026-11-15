#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Gateway upgrade and rollback against the REAL previous image (tracker.intentional-upgrade, ADR-0020).
#
# The previous gateway image is built from git (`git archive <ref>`, read-only on the repository) with the same
# Dockerfile the release pipeline uses; the current image is built from the working tree. Both run, one after the
# other, on the same state volume of the integration stack (real control plane, engine proxy, Umami, PostgreSQL):
#   1. previous image: accept events while the engine proxy is down (they stay in the spool) → swap to the current
#      image on the same volume → the current image delivers every one of them to Umami exactly once;
#   2. rollback: the current image spools events (records now carry event_key) → swap back to the previous image →
#      it delivers them exactly once;
#   3. the tracker files every image serves: 1.0.0 is byte-identical in both, the current one adds its own version.
# PREV_REF picks the previous release (default: HEAD when services/gateway has uncommitted changes, else the commit
# before the latest one that changed the gateway, the tracker or pathnorm); PREV_IMAGE uses an existing image instead
# (e.g. a published release). Project scf-wsu, host ports 56210–56213. `KEEP=1` keeps the stack.
#   services/gateway/integration/upgrade.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
COMPOSE="$ROOT/infra/compose"
PROJECT="${PROJECT:-scf-wsu}"
export WSB_INGEST_PORT="${WSB_INGEST_PORT:-56210}" WSB_METRICS_PORT="${WSB_METRICS_PORT:-56211}"
export SCF_CONTROL_PLANE_PORT="${SCF_CONTROL_PLANE_PORT:-56212}" SCF_PORTAL_PORT="${SCF_PORTAL_PORT:-56213}"
export WSB_WORK="$(mktemp -d "${TMPDIR:-/tmp}/scf-wsu.XXXXXX")"
CUR_IMAGE="usagemap/gateway:upgrade-current"
NODE_IMAGE=node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
dc() { docker compose -p "$PROJECT" -f "$COMPOSE/compose.yaml" -f "$COMPOSE/compose.dev.yaml" -f "$HERE/compose.override.yaml" -f "$HERE/upgrade.override.yaml" "$@"; }
PASS=0; FAIL=0
ok()  { echo "PASS  $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check() { local n=$1; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
BUILT_PREV=""
cleanup() {
  if [[ "${KEEP:-0}" != 1 ]]; then
    WSB_GW_IMAGE="$CUR_IMAGE" dc down -v --remove-orphans >/dev/null 2>&1 || true
    [[ -n "$BUILT_PREV" ]] && docker image rm "$BUILT_PREV" >/dev/null 2>&1 || true
    docker image rm "$CUR_IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$WSB_WORK"
}
trap cleanup EXIT

# ---- the two images
if [[ -z "${PREV_IMAGE:-}" ]]; then
  if [[ -z "${PREV_REF:-}" ]]; then
    if [[ -n "$(git -C "$ROOT" status --porcelain -- services/gateway tracker packages/pathnorm)" ]]; then
      PREV_REF=HEAD
    else
      PREV_REF="$(git -C "$ROOT" log -n1 --format=%H -- services/gateway tracker packages/pathnorm)^"
    fi
  fi
  PREV_SHA="$(git -C "$ROOT" rev-parse --short=12 "$PREV_REF")"
  PREV_IMAGE="usagemap/gateway:prev-$PREV_SHA"
  echo "== build the previous gateway image from git $PREV_REF ($PREV_SHA)"
  mkdir -p "$WSB_WORK/prev-src"
  git -C "$ROOT" archive "$PREV_SHA" | tar -x -C "$WSB_WORK/prev-src"
  docker build -q -t "$PREV_IMAGE" -f "$WSB_WORK/prev-src/services/gateway/Dockerfile" "$WSB_WORK/prev-src" >/dev/null
  BUILT_PREV="$PREV_IMAGE"
  rm -rf "$WSB_WORK/prev-src"
fi
echo "== build the current gateway image from the working tree"
docker build -q -t "$CUR_IMAGE" -f "$ROOT/services/gateway/Dockerfile" "$ROOT" >/dev/null
check "previous and current images differ" test "$(docker image inspect -f '{{.Id}}' "$PREV_IMAGE")" != "$(docker image inspect -f '{{.Id}}' "$CUR_IMAGE")"

"$COMPOSE/scripts/init.sh" >/dev/null
mkdir -p "$WSB_WORK/tls" "$WSB_WORK/snapshot"
openssl pkey -in "$COMPOSE/.secrets/edge_signing_key.pem" -pubout -out "$WSB_WORK/snapshot/edge-1.pub.pem" 2>/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=ingest-a.example-analytics.org" \
  -addext "subjectAltName=DNS:ingest-a.example-analytics.org,DNS:ingest-b.example-analytics.net,IP:127.0.0.1" \
  -keyout "$WSB_WORK/tls/key.pem" -out "$WSB_WORK/tls/cert.pem" 2>/dev/null
chmod 0755 "$WSB_WORK" "$WSB_WORK/tls" "$WSB_WORK/snapshot"; chmod 0644 "$WSB_WORK"/tls/* "$WSB_WORK"/snapshot/*  # test-only key

WSB_GW_IMAGE="$PREV_IMAGE" dc down -v --remove-orphans >/dev/null 2>&1 || true
echo "== up with the previous image ($PREV_IMAGE)"
WSB_GW_IMAGE="$PREV_IMAGE" dc up -d --wait --wait-timeout 900 >/dev/null 2>&1 || {
  WSB_GW_IMAGE="$PREV_IMAGE" dc ps -a; WSB_GW_IMAGE="$PREV_IMAGE" dc logs --no-color --tail 40 gateway; bad "compose up --wait"; exit 1; }
ok "stack up, gateway = previous image"

PGPW="$(cat "$COMPOSE/.secrets/pg_superuser_password")"
psqlc() { WSB_GW_IMAGE="$PREV_IMAGE" dc exec -T -e PGPASSWORD="$PGPW" postgres psql -X -At -v ON_ERROR_STOP=1 -U postgres -d "$1" -c "$2"; }
USER_ID=0193b7e2-0000-7000-8000-0000000000f1
TENANT=0193b7e2-0000-7000-8000-00000000000a
SITE=0193b7e2-0000-7000-8000-0000000000a1
SITE_KEY=WsbIntegration00000001
WEBSITE=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41
TWIN=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a42
psqlc scf "BEGIN;
INSERT INTO scf.users (user_id, display_name) VALUES ('$USER_ID', 'wsu') ON CONFLICT DO NOTHING;
INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ('$TENANT', 'wsu-test', 'WSU test', 'active', '$USER_ID') ON CONFLICT DO NOTHING;
INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id, twin_provisioned_at, visitor_id, created_by)
  VALUES ('$TENANT', '$SITE', 'site', '$SITE_KEY', '$WEBSITE', '$TWIN', now(), 'on', '$USER_ID') ON CONFLICT DO NOTHING;
INSERT INTO scf.site_domains (tenant_id, site_id, host, state, verified_at) VALUES ('$TENANT', '$SITE', 'site.test', 'verified', now()) ON CONFLICT DO NOTHING;
COMMIT; NOTIFY scf_edge;" >/dev/null && ok "fixture rows inserted" || bad "fixture rows"
client() {
  local pki=() n
  for n in ca edge-a1 core-a-umami-bootstrap; do pki+=(-v "$COMPOSE/.secrets/pki/$n.pem:/pki/$n.pem:ro"); done
  for n in edge-a1 core-a-umami-bootstrap; do pki+=(-v "$COMPOSE/.secrets/pki/$n-key.pem:/pki/$n-key.pem:ro"); done
  docker run --rm --network "${PROJECT}_core" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 65532:65532 \
    "${pki[@]}" -v "$COMPOSE/.secrets/umami_provisioner_password:/run/prov_password:ro" -v "$HERE/client.mjs:/client.mjs:ro" \
    -v "$WSB_WORK:/work:ro" "$NODE_IMAGE" node /client.mjs "$@"
}
for _ in $(seq 1 15); do out="$(client provision "$WEBSITE" "$TWIN" site.test 2>&1)" && break; sleep 2; done
if [[ "$out" == provisioned ]]; then ok "Umami websites created (P1, P7)"; else bad "Umami websites created: $out"; fi

CURL=(curl -sk --resolve "ingest-a.example-analytics.org:$WSB_INGEST_PORT:127.0.0.1")
GW=https://ingest-a.example-analytics.org:$WSB_INGEST_PORT
metric() { curl -fsS "http://127.0.0.1:$WSB_METRICS_PORT/metrics" | awk -v n="$1" '$1==n {print $2}'; }
chal() { "${CURL[@]}" -o /dev/null -w '%{http_code}' -H 'Origin: https://site.test' -H 'Content-Type: text/plain' \
  --data "{\"v\":1,\"s\":\"$SITE_KEY\",\"p\":\"standard\",\"tv\":\"1.0.0\"}" "$GW/v1/c"; }
ready() { for _ in $(seq 1 90); do [[ "$(chal)" == 200 ]] && return 0; sleep 1; done; return 1; }
check "previous image: the site arrived through the signed snapshot" ready
PROBE="$WSB_WORK/probe"; (cd "$ROOT/services/gateway" && eval "$(cd "$ROOT" && mise env -s bash)" && go build -o "$PROBE" ./cmd/probe)
send() { # path prefix, count → number of 202 answers
  local n=0 i
  for i in $(seq 1 "$2"); do
    "$PROBE" -hosts "https://127.0.0.1:$WSB_INGEST_PORT" -insecure -site "$SITE_KEY" -origin https://site.test -source wsu -path "$1/$i" -deadline 5s >/dev/null 2>&1 && n=$((n+1))
  done
  echo "$n"
}
evsql() { psqlc umami "SELECT count(*) FROM website_event WHERE website_id = '$WEBSITE' AND $1"; }
swap() { # image → recreate the gateway on the same volume
  WSB_GW_IMAGE="$1" dc stop gateway >/dev/null 2>&1
  WSB_GW_IMAGE="$1" dc up -d --no-deps --wait --wait-timeout 300 gateway >/dev/null 2>&1
}
drained() { for _ in $(seq 1 120); do [[ "$(metric scf_gateway_spool_queued)" == 0 ]] && return 0; sleep 2; done; return 1; }
lib() { "${CURL[@]}" "$GW/lib/$1" | sha256sum | cut -d' ' -f1; }

PREV_STD="$(lib 1.0.0/standard.js)"; PREV_STRICT="$(lib 1.0.0/strict.js)"

echo "== 1. upgrade: previous image spools, current image delivers"
WSB_GW_IMAGE="$PREV_IMAGE" dc stop engine-proxy >/dev/null 2>&1
check "previous image: 6 of 6 events answered 202 while the engine proxy is down" test "$(send /up 6)" = 6
sleep 2
check "previous image: the spool holds them (queued ≥ 6)" sh -c "[ \"$(metric scf_gateway_spool_queued)\" -ge 6 ]"
swap "$CUR_IMAGE"
check "gateway now runs the current image" test "$(docker inspect -f '{{.Config.Image}}' "$(WSB_GW_IMAGE="$CUR_IMAGE" dc ps -q gateway)")" = "$CUR_IMAGE"
check "current image: recovered the previous image's spool (queued ≥ 6, no corrupt frames)" sh -c \
  "[ \"$(metric scf_gateway_spool_queued)\" -ge 6 ] && [ \"$(metric scf_gateway_spool_corrupt_frames)\" = 0 ]"
WSB_GW_IMAGE="$CUR_IMAGE" dc start engine-proxy >/dev/null 2>&1
check "current image: spool drained" drained
check "every event the previous image accepted is in Umami exactly once" test "$(evsql "url_path LIKE '/up/%'")" = 6
check "current image: new events still accepted" test "$(send /after-up 2)" = 2

echo "== 2. rollback: current image spools (with event keys), previous image delivers"
WSB_GW_IMAGE="$CUR_IMAGE" dc stop engine-proxy >/dev/null 2>&1
check "current image: 6 of 6 events answered 202 while the engine proxy is down" test "$(send /down 6)" = 6
sleep 2
swap "$PREV_IMAGE"
check "gateway now runs the previous image again" test "$(docker inspect -f '{{.Config.Image}}' "$(WSB_GW_IMAGE="$PREV_IMAGE" dc ps -q gateway)")" = "$PREV_IMAGE"
check "previous image: read the current image's spool (no corrupt frames)" test "$(metric scf_gateway_spool_corrupt_frames)" = 0
WSB_GW_IMAGE="$PREV_IMAGE" dc start engine-proxy >/dev/null 2>&1
check "previous image: spool drained" drained
check "every event the current image accepted is in Umami exactly once" test "$(evsql "url_path LIKE '/down/%'")" = 6

echo "== 3. tracker files across the upgrade"
swap "$CUR_IMAGE"
ready >/dev/null || true
check "1.0.0 standard.js byte-identical in both images" test "$(lib 1.0.0/standard.js)" = "$PREV_STD"
check "1.0.0 strict.js byte-identical in both images" test "$(lib 1.0.0/strict.js)" = "$PREV_STRICT"
cur_v="$(jq -r .version "$ROOT/tracker/package.json")"
check "current image also serves tracker $cur_v (manifest SRI matches the bytes)" sh -c \
  "[ \"\$(${CURL[*]} $GW/lib/manifest.json | jq -r --arg v $cur_v '.versions[] | select(.version==\$v) | .files[] | select(.path==\"standard.js\") | .integrity')\" = \"sha384-\$(${CURL[*]} $GW/lib/$cur_v/standard.js | openssl dgst -sha384 -binary | base64 -w0)\" ]"
check "after the round trip every event is in Umami exactly once (14)" test "$(evsql "url_path LIKE '/up/%' OR url_path LIKE '/down/%' OR url_path LIKE '/after-up/%'")" = 14

echo "== result ($PREV_IMAGE → $CUR_IMAGE → $PREV_IMAGE → $CUR_IMAGE): $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
