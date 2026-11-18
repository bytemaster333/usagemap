#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Integration test of the generated Gatus configuration (core plan C1 item 5): the pinned Gatus image of
# ops/status/gatus/compose.yaml loads ops/status/gatus/config.yaml unchanged and judges stand-in endpoints
# (test/stub.mjs) as docs/sla.md defines them:
#   run 1: ingest A healthy → pass; ingest B answers after 2.5 s → fail (over 2 s); portal up; API 503 with
#          components.dashboards "ok" (ingest down, dashboards up) → pass
#   run 2: ingest A 503 "spool" → fail; portal up; API with components.dashboards "down" → fail
# Compose project scf-st-it, no host port. Exit 0 only when every expectation holds.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)" # ops/status
P=scf-st-it
NODE_IMAGE=node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $*"; }
# compose.yaml requires the three base URLs; the override sets the real (stub) values.
export SCF_STATUS_INGEST_URL_A=unset SCF_STATUS_INGEST_URL_B=unset SCF_STATUS_PORTAL_URL=unset
OVR=$(mktemp "${TMPDIR:-/tmp}/scf-st-it.XXXXXX.yaml")
cleanup() { docker compose -p "$P" -f "$HERE/gatus/compose.yaml" -f "$OVR" down -v --remove-orphans >/dev/null 2>&1; rm -f "$OVR"; }
trap cleanup EXIT

run() { # run A B PORTAL → JSON of Gatus' endpoint statuses after the first evaluations
  cat >"$OVR" <<EOF
services:
  gatus:
    ports: !reset []
    environment:
      SCF_STATUS_INGEST_URL_A: http://stub:8081/$1
      SCF_STATUS_INGEST_URL_B: http://stub:8081/$2
      SCF_STATUS_PORTAL_URL: http://stub:8081/$3
    depends_on: [stub]
  stub:
    image: $NODE_IMAGE
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    user: "65532:65532"
    command: ["node", "/stub.mjs"]
    volumes: ["$HERE/test/stub.mjs:/stub.mjs:ro"]
  probe:
    image: $NODE_IMAGE
    read_only: true
    user: "65532:65532"
    command: ["sleep", "600"]
EOF
  local dc=(docker compose -p "$P" -f "$HERE/gatus/compose.yaml" -f "$OVR")
  "${dc[@]}" down -v >/dev/null 2>&1
  "${dc[@]}" up -d >/dev/null 2>&1 ||
    { "${dc[@]}" logs --no-color --tail 30 >&2; return 1; }
  local out=""
  for _ in $(seq 40); do
    out=$("${dc[@]}" exec -T probe node -e 'fetch("http://gatus:8080/api/v1/endpoints/statuses").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))' 2>/dev/null)
    # every endpoint has at least one result
    if [ -n "$out" ] && [ "$(jq '[.[] | select((.results // []) | length > 0)] | length' <<<"$out" 2>/dev/null)" = 4 ]; then
      echo "$out"; return 0
    fi
    sleep 1
  done
  "${dc[@]}" logs --no-color --tail 30 gatus >&2
  return 1
}
# result NAME JSON → true|false of the newest result
result() { jq -r --arg n "$1" '.[] | select(.name == $n) | .results[-1].success' <<<"$2"; }
cond() { jq -r --arg n "$1" '.[] | select(.name == $n) | .results[-1].conditionResults[] | select(.success == false) | .condition' <<<"$2" | xargs; }

echo "== run 1"
if j=$(run good slow portal-ok); then
  ok "Gatus v5.38.0 loads the generated config and evaluates all 4 endpoints"
  [ "$(result ingest-a "$j")" = true ] && ok "ingest-a healthy within 2 s → pass" || bad "ingest-a: $(cond ingest-a "$j")"
  [ "$(result ingest-b "$j")" = false ] && ok "ingest-b answering after 2.5 s → fail ($(cond ingest-b "$j"))" || bad "ingest-b slow was judged a pass"
  [ "$(result portal "$j")" = true ] && ok "portal up → pass" || bad "portal: $(cond portal "$j")"
  [ "$(result dashboard-api "$j")" = true ] && ok "health 503 with dashboards ok (ingest down) → dashboard pass" || bad "dashboard-api: $(cond dashboard-api "$j")"
else
  bad "Gatus did not start or did not evaluate the endpoints (run 1)"
fi
echo "== run 2"
if j=$(run sick good portal-down); then
  [ "$(result ingest-a "$j")" = false ] && ok "ingest-a 503 spool → fail ($(cond ingest-a "$j"))" || bad "ingest-a 503 was judged a pass"
  [ "$(result ingest-b "$j")" = true ] && ok "ingest-b healthy → pass" || bad "ingest-b: $(cond ingest-b "$j")"
  [ "$(result dashboard-api "$j")" = false ] && ok "dashboards down → fail ($(cond dashboard-api "$j"))" || bad "dashboards down was judged a pass"
else
  bad "Gatus did not start or did not evaluate the endpoints (run 2)"
fi
echo "GATUS-IT $([ $FAIL = 0 ] && echo PASS || echo FAIL) passed=$PASS failed=$FAIL"
[ $FAIL = 0 ]
