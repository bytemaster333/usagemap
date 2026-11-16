#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Whole-stack smoke test of a DEPLOYED stack, from outside, by its public names (the remote counterpart of smoke.sh,
# which builds and inspects a local Compose project and cannot target a remote host). Read-only except for the canary
# web event and OTLP request it sends (both to a site / token the operator names). Prints PASS/FAIL lines and a count.
#
#   LANDING=usagemap.dev PORTAL=app.usagemap.dev STATUS=status.usagemap.dev INGEST="e1.usagemap.dev e2.usagemap.dev" \
#   SITE_KEY=<public site key> SITE_ORIGIN=https://usagemap.dev [INGEST_TOKEN_FILE=<file with scfa_ing_…>] \
#   [SSH_HOST=usagemap-host] [GATEWAY_IMAGE=<gateway image with the probe binary>] [TRACKER_VERSION=1.2.0] \
#   infra/compose/scripts/smoke-remote.sh
#
# Checks: TLS chain (public trust store), certificate names and remaining validity, TLS 1.0/1.1 refused; HSTS and the
# security headers; port 80 only redirects; portal, API, snapshot keys, status page; ingest health on every ingest
# name; the tracker files served by every ingest name match the SRI the API publishes; a canary web event (the
# gateway's probe client: challenge, proof of work, event → 202); OTLP without a token → 401, with a token → 200;
# only 80/443 reachable on the public addresses (22 too when run from the operator's allow-listed address); with
# SSH_HOST, every container of the stack running and healthy.
set -uo pipefail
LANDING=${LANDING:-} PORTAL=${PORTAL:?PORTAL host name} STATUS=${STATUS:-} INGEST=${INGEST:?INGEST host names}
TRACKER_VERSION=${TRACKER_VERSION:-1.2.0}
PASS=0 FAIL=0
ok() { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { local n=$1; shift; if out=$("$@" 2>&1); then ok "$n${out:+  [$(head -c 200 <<<"$out" | tr '\n' ' ')]}"; else bad "$n${out:+  [$(head -c 300 <<<"$out" | tr '\n' ' ')]}"; fi; }
hdr() { curl -sS -o /dev/null -D - --max-time 15 "$1" | tr -d '\r'; }

echo "== TLS"
tls_ok() { # chain verifies against the system trust store, name matches, ≥ 14 days left, issuer printed
  local h=$1 out
  out=$(openssl s_client -connect "$h:443" -servername "$h" -verify_return_error -verify_hostname "$h" </dev/null 2>/dev/null) || return 1
  grep -q 'Verify return code: 0 (ok)' <<<"$out" || return 1
  openssl x509 -noout -checkend $((14 * 86400)) <<<"$out" >/dev/null || { echo "expires within 14 days"; return 1; }
  openssl x509 -noout -issuer -enddate <<<"$out" | tr '\n' ' '
}
old_tls_refused() { ! openssl s_client -connect "$1:443" -servername "$1" -tls1_1 </dev/null >/dev/null 2>&1; }
for h in $LANDING $PORTAL $STATUS $INGEST; do
  check "TLS $h: chain valid for the name, ≥ 14 days left" tls_ok "$h"
  check "TLS $h: TLS 1.1 refused" old_tls_refused "$h"
done

echo "== headers"
has() { grep -qi "^$2" <<<"$(hdr "$1")" || { echo "missing $2"; return 1; }; }
for h in $LANDING $PORTAL $STATUS; do
  check "https://$h/: HSTS" has "https://$h/" "strict-transport-security: max-age="
  check "https://$h/: X-Content-Type-Options nosniff" has "https://$h/" "x-content-type-options: nosniff"
done
check "portal: CSP default-src 'none'" has "https://$PORTAL/" "content-security-policy: default-src 'none'"
check "portal: frame protection" has "https://$PORTAL/" "x-frame-options: deny"
[ -n "$LANDING" ] && check "landing: frame-ancestors 'none'" has "https://$LANDING/" "content-security-policy: .*frame-ancestors 'none'"
redirects() { local c; c=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://$1/x?y=1"); echo "$c"; [[ "$c" == "308 https://$1/x?y=1" ]]; }
for h in $LANDING $PORTAL; do check "http://$h → 308 to https (port 80 redirect only)" redirects "$h"; done

echo "== portal, API, status"
code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }
check "portal /portal-healthz → 200" test "$(code "https://$PORTAL/portal-healthz")" = 200
health() { local b; b=$(curl -sS --max-time 15 "https://$PORTAL/public/v1/health"); echo "$b" | head -c 200; jq -e '.status' <<<"$b" >/dev/null; }
check "API /public/v1/health answers with a status" health
check "snapshot keys published (kid snap-1)" sh -c "curl -fsS --max-time 15 https://$PORTAL/.well-known/scf-snapshot-keys.json | jq -e '[.keys[]?|select(.kid==\"snap-1\")]|length==1' >/dev/null"
op_401() { local h; h=$(curl -sS -D - -o /dev/null --max-time 15 "https://$PORTAL/op/v1/me" | tr -d '\r'); grep -qi '^content-type: application/problem+json' <<<"$h" && head -1 <<<"$h" | grep -q ' 401'; }
check "operator API without a session → 401 problem+json" op_401
[ -n "$STATUS" ] && check "status page → 200" test "$(code "https://$STATUS/")" = 200
[ -n "$LANDING" ] && check "landing page → 200" test "$(code "https://$LANDING/")" = 200

echo "== ingest"
ing_health() { local b; b=$(curl -sS --max-time 10 "https://$1/healthz"); echo "$b" | head -c 120; jq -e '.status == "ok"' <<<"$b" >/dev/null; }
sri_match() { # the bytes each ingest name serves = the SRI the API publishes for that version and profile
  local h=$1 p=$2 want got
  want=$(curl -fsS --max-time 15 "https://$PORTAL/v1/tracker/versions" | jq -r --arg v "$TRACKER_VERSION" --arg p "$p" '.[]|select(.version==$v)|.files[]|select(.profile==$p)|.integrity')
  got="sha384-$(curl -fsS --max-time 15 "https://$h/lib/$TRACKER_VERSION/$p.js" | openssl dgst -sha384 -binary | base64 -w0)"
  echo "$got"; [[ -n "$want" && "$want" == "$got" ]]
}
for h in $INGEST; do
  check "$h /healthz → ok" ing_health "$h"
  for p in standard strict; do check "$h serves /lib/$TRACKER_VERSION/$p.js with the published SRI" sri_match "$h" "$p"; done
  check "$h OTLP /v1/traces without a token → 401" test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' --data '{}' "https://$h/v1/traces")" = 401
done
if [ -n "${SITE_KEY:-}" ]; then
  hosts=$(for h in $INGEST; do printf 'https://%s,' "$h"; done); hosts=${hosts%,}
  canary() {
    docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint /usr/local/bin/probe \
      "${GATEWAY_IMAGE:?GATEWAY_IMAGE}" -hosts "$hosts" -site "$SITE_KEY" -origin "${SITE_ORIGIN:?SITE_ORIGIN}" \
      -source smoke-remote -path /smoke/remote -tv "$TRACKER_VERSION" -deadline 10s
  }
  check "canary web event through the ingest names → 202 (challenge, proof of work, event)" canary
fi
if [ -n "${INGEST_TOKEN_FILE:-}" ]; then
  otlp() {
    local now; now=$(date +%s%N)
    curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H "Authorization: Bearer $(tr -d '\n' <"$INGEST_TOKEN_FILE")" \
      -H 'Content-Type: application/json' "https://${INGEST%% *}/v1/traces" --data @- <<JSON | grep -qx 200
{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"smoke-remote"}}]},
 "scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"GET /smoke/remote",
 "kind":2,"startTimeUnixNano":"$((now - 25000000))","endTimeUnixNano":"$now",
 "attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/smoke/remote"}},
 {"key":"http.response.status_code","value":{"intValue":"200"}}],"status":{}}]}]}]}
JSON
  }
  check "OTLP/HTTP JSON trace with the ingest token through ${INGEST%% *} → 200" otlp
fi

echo "== exposure"
open_ports() { # TCP ports that accept a connection on the address of $1, from this machine
  local ip p o=""; ip=$(getent ahostsv4 "$1" | awk 'NR==1{print $1}')
  for p in 21 22 25 80 443 2375 2379 3000 4317 4318 5432 6432 8080 8081 8090 8443 9090 9093 9100 9187 9428 9443 9464 5140; do
    timeout 3 bash -c "</dev/tcp/$ip/$p" 2>/dev/null && o="$o $p"
  done
  echo "$ip:${o:- none}"; [[ "${o# }" =~ ^(22\ )?(80\ )?443$ ]]
}
for h in $PORTAL ${INGEST%% *}; do check "$h: only 443 (+80 redirect) open (22 only from the admin address)" open_ports "$h"; done

if [ -n "${SSH_HOST:-}" ]; then
  echo "== containers on $SSH_HOST"
  ps_ok() {
    local ps
    ps=$(ssh "$SSH_HOST" "sudo docker ps -a --filter label=com.docker.compose.project=${PROJECT:-scf} --format '{{.Label \"com.docker.compose.service\"}} {{.State}} {{.Status}}'")
    echo "$(wc -l <<<"$ps") containers"
    ! grep -Ev ' running Up .*\(healthy\)$| running Up [0-9a-zA-Z ]+$| exited Exited \(0\)' <<<"$ps" | grep .
  }
  check "every container running (healthy where it has a check) or a one-shot exited 0" ps_ok
fi

echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
