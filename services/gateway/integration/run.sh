#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Gateway integration test against the real stack (infra/compose + this override): real control plane (snapshot,
# counter upload), real engine proxy (mTLS, visit rule), real Umami, real PostgreSQL, the gateway image built from
# source (tracker included), a real Chromium. Project scf-wsb, host ports 56200–56202 only. `KEEP=1` keeps the stack.
#   services/gateway/integration/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
COMPOSE="$ROOT/infra/compose"
PROJECT="${PROJECT:-scf-wsb}"
# Host ports (defaults 56200–56203; WSB_INGEST_PORT / WSB_METRICS_PORT / SCF_CONTROL_PLANE_PORT / SCF_PORTAL_PORT move them)
export WSB_INGEST_PORT="${WSB_INGEST_PORT:-56200}" WSB_METRICS_PORT="${WSB_METRICS_PORT:-56201}"
export SCF_CONTROL_PLANE_PORT="${SCF_CONTROL_PLANE_PORT:-56202}" SCF_PORTAL_PORT="${SCF_PORTAL_PORT:-56203}"
export WSB_WORK="$(mktemp -d "${TMPDIR:-/tmp}/scf-wsb.XXXXXX")"
NODE_IMAGE=node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
dc() { docker compose -p "$PROJECT" -f "$COMPOSE/compose.yaml" -f "$COMPOSE/compose.dev.yaml" -f "$HERE/compose.override.yaml" "$@"; }
PASS=0; FAIL=0
ok()  { echo "PASS  $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check() { local n=$1; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
cleanup() {
  if [[ "${KEEP:-0}" != 1 ]]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$WSB_WORK"
}
trap cleanup EXIT

"$COMPOSE/scripts/init.sh" >/dev/null
mkdir -p "$WSB_WORK/tls" "$WSB_WORK/snapshot"
openssl pkey -in "$COMPOSE/.secrets/edge_signing_key.pem" -pubout -out "$WSB_WORK/snapshot/edge-1.pub.pem" 2>/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=ingest-a.example-analytics.org" \
  -addext "subjectAltName=DNS:ingest-a.example-analytics.org,DNS:ingest-b.example-analytics.net,IP:127.0.0.1" \
  -keyout "$WSB_WORK/tls/key.pem" -out "$WSB_WORK/tls/cert.pem" 2>/dev/null
chmod 0755 "$WSB_WORK" "$WSB_WORK/tls" "$WSB_WORK/snapshot"; chmod 0644 "$WSB_WORK"/tls/* "$WSB_WORK"/snapshot/*  # test-only key

dc down -v --remove-orphans >/dev/null 2>&1 || true  # start from empty volumes (no rows from an earlier KEEP=1 run)
echo "== up (project $PROJECT)"
t0=$(date +%s)
dc up -d --build --wait --wait-timeout 900 >/dev/null 2>&1 || { dc ps -a; dc logs --no-color --tail 40 gateway control-plane engine-proxy; bad "compose up --wait"; exit 1; }
ok "compose up --wait with the gateway healthy ($(( $(date +%s) - t0 )) s)"
GWC="$(dc ps -q gateway)"
check "gateway: read-only root, no capabilities, no-new-privileges, uid 65532" test \
  "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.Config.User}}' "$GWC")" \
  = "true [ALL] [no-new-privileges:true] 65532:65532"
metric() { curl -fsS "http://127.0.0.1:$WSB_METRICS_PORT/metrics" | awk -v n="$1" '$1==n {print $2}'; }
check "core dumps disabled (RLIMIT_CORE 0 and non-dumpable)" test "$(metric scf_gateway_core_dumps_disabled)" = 1
check "key memory locked (mlock)" test "$(metric scf_gateway_keys_mlocked)" = 1
check "no key material on disk (state volume holds only snapshot.json and spool/)" sh -c \
  "docker run --rm -v ${PROJECT}_gwstate:/s:ro --entrypoint sh $NODE_IMAGE -c 'cd /s && find . -type f | grep -v -E \"^./(snapshot.json|spool/edge-a1/[0-9]{16}\\.seg(\\.ack)?)\$\" | grep -q . && exit 1 || exit 0'"

echo "== fixture: tenant, site, domains (SQL as superuser), Umami websites (P7 through the engine proxy)"
PGPW="$(cat "$COMPOSE/.secrets/pg_superuser_password")"
psqlc() { dc exec -T -e PGPASSWORD="$PGPW" postgres psql -X -At -v ON_ERROR_STOP=1 -U postgres -d "$1" -c "$2"; }
USER_ID=0193b7e2-0000-7000-8000-0000000000f1
TENANT=0193b7e2-0000-7000-8000-00000000000a
SITE=0193b7e2-0000-7000-8000-0000000000a1
SITE_KEY=WsbIntegration00000001
WEBSITE=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41
TWIN=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a42
psqlc scf "BEGIN;
INSERT INTO scf.users (user_id, display_name) VALUES ('$USER_ID', 'wsb') ON CONFLICT DO NOTHING;
INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ('$TENANT', 'wsb-test', 'WSB test', 'active', '$USER_ID') ON CONFLICT DO NOTHING;
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
for _ in $(seq 1 15); do out="$(client provision "$WEBSITE" "$TWIN" site.test 2>&1)" && break; sleep 2; done  # the proxy's gate may still be closing/opening
if [[ "$out" == provisioned ]]; then ok "Umami websites created (P1, P7)"; else bad "Umami websites created (P1, P7): $out"; fi
CURL=(curl -sk --resolve "ingest-a.example-analytics.org:$WSB_INGEST_PORT:127.0.0.1")
GW=https://ingest-a.example-analytics.org:$WSB_INGEST_PORT
chal() { "${CURL[@]}" -o /dev/null -w '%{http_code}' -H 'Origin: https://site.test' -H 'Content-Type: text/plain' \
  --data "{\"v\":1,\"s\":\"$SITE_KEY\",\"p\":\"standard\",\"tv\":\"1.0.0\"}" "$GW/v1/c"; }
for _ in $(seq 1 60); do [[ "$(chal)" == 200 ]] && break; sleep 1; done
check "the site reached the gateway through the signed snapshot (challenge 200)" test "$(chal)" = 200
check "snapshot sequence > 0 and fresh" sh -c "[ \"\$(curl -fsS http://127.0.0.1:$WSB_METRICS_PORT/metrics | awk '\$1==\"scf_gateway_snapshot_stale\"{print \$2}')\" = 0 ]"

echo "== tracker files"
check "GET /lib/1.0.0/standard.js → 200 immutable" sh -c "${CURL[*]} -D - -o /dev/null $GW/lib/1.0.0/standard.js | grep -qi 'cache-control: public, max-age=31536000, immutable'"
check "unknown tracker version → 404" test "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$GW/lib/9.9.9/standard.js")" = 404
built_sri="$("${CURL[@]}" "$GW/lib/manifest.json" | jq -r '.versions[0].files[] | select(.path=="standard.js") | .integrity')"
served_sri="sha384-$("${CURL[@]}" "$GW/lib/1.0.0/standard.js" | openssl dgst -sha384 -binary | base64 -w0)"
check "served bytes match the SRI of the manifest built in the image" test "$built_sri" = "$served_sri"

echo "== synthetic UA templates parsed by Umami 3.5.0 (contract test, §c.3)"
docker run --rm --entrypoint /usr/local/bin/gateway usagemap/gateway:dev templates > "$WSB_WORK/templates.json"
chmod 0644 "$WSB_WORK/templates.json"
check "every template accepted by Umami (no bot answer)" client templates /work/templates.json "$TWIN"
sleep 2
tplsql="SELECT e.url_path || ' ' || s.browser || ' ' || s.os || ' ' || s.device FROM website_event e JOIN session s ON s.session_id = e.session_id WHERE e.website_id = '$TWIN' AND e.url_path LIKE '/tpl/%' ORDER BY 1"
psqlc umami "$tplsql" > "$WSB_WORK/tpl-parsed.txt"
check "Chrome/Windows → chrome / Windows 10 / laptop" grep -qx "/tpl/$(jq -r 'map(.Family+"/"+.OS+"/"+.Device) | index("chrome/windows/desktop")+1' "$WSB_WORK/templates.json") chrome Windows 10 laptop" "$WSB_WORK/tpl-parsed.txt"
check "Safari/iPhone → ios / iOS / mobile" grep -qx "/tpl/$(jq -r 'map(.Family+"/"+.OS+"/"+.Device) | index("safari/ios/mobile")+1' "$WSB_WORK/templates.json") ios iOS mobile" "$WSB_WORK/tpl-parsed.txt"
check "unknown template → firefox / Linux / laptop" grep -qx "/tpl/$(jq 'length' "$WSB_WORK/templates.json") firefox Linux laptop" "$WSB_WORK/tpl-parsed.txt"
echo "   rows: $(wc -l < "$WSB_WORK/tpl-parsed.txt"), templates: $(jq length "$WSB_WORK/templates.json")"
check "one parsed row per template" test "$(wc -l < "$WSB_WORK/tpl-parsed.txt")" = "$(jq length "$WSB_WORK/templates.json")"
echo "   parsed templates:"; sed 's/^/     /' "$WSB_WORK/tpl-parsed.txt"

echo "== real browser → gateway → engine proxy → Umami"
PW_MODULE="$ROOT/tracker/node_modules/@playwright/test/index.mjs"
if out="$(PW_MODULE="$PW_MODULE" GW="https://127.0.0.1:$WSB_INGEST_PORT" NODE_TLS_REJECT_UNAUTHORIZED=0 node "$HERE/browser.mjs" "$SITE_KEY" 2>&1)"; then
  ok "Chromium: challenge, proof, two page views answered 202 ($out)"
else
  bad "Chromium run: $out"
fi
evsql() { psqlc umami "SELECT count(*) FROM website_event WHERE website_id = '$WEBSITE' AND $1"; }
for _ in $(seq 1 30); do [[ "$(evsql "url_path = '/spa/second' AND tag = 'v'")" -ge 1 ]] && break; sleep 1; done
check "landing page view stored in Umami with tag v, path without query" test "$(evsql "url_path = '/landing' AND tag = 'v' AND (url_query IS NULL OR url_query = '')")" = 1
check "SPA navigation stored with tag v" test "$(evsql "url_path = '/spa/second' AND tag = 'v'")" = 1
check "no page title stored" test "$(evsql "page_title IS NOT NULL AND page_title <> ''")" = 0
check "hostname from the validated Origin" test "$(evsql "hostname = 'site.test'")" -ge 2
check "one session for the browser's two page views (surrogate + visit token)" test \
  "$(psqlc umami "SELECT count(DISTINCT session_id) FROM website_event WHERE website_id = '$WEBSITE' AND url_path IN ('/landing','/spa/second')")" = 1

echo "== scripted POST without a valid challenge"
scripted() { "${CURL[@]}" -o /dev/null -w '%{http_code}' -H 'Origin: https://site.test' -H 'Content-Type: text/plain' \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  --data "{\"v\":1,\"s\":\"$SITE_KEY\",\"p\":\"standard\",\"tv\":\"1.0.0\",\"t\":\"$1\",\"e\":[{\"id\":\"ScriptedEvent000000001\",\"k\":\"pv\",\"u\":\"/scripted\"}]}" "$GW/v1/e"; }
check "answered 202 (no oracle)" test "$(scripted bogus)" = 202
check "client-supplied ip/userAgent/timestamp/hostname refused (400)" test "$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H 'Content-Type: text/plain' \
  --data "{\"v\":1,\"s\":\"$SITE_KEY\",\"p\":\"standard\",\"tv\":\"1.0.0\",\"e\":[{\"id\":\"ScriptedEvent000000002\",\"k\":\"pv\",\"u\":\"/x\",\"ip\":\"1.2.3.4\"}]}" "$GW/v1/e")" = 400
check "unknown site key → 404" test "$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H 'Content-Type: text/plain' \
  --data '{"v":1,"s":"AAAAAAAAAAAAAAAAAAAAAA","p":"standard","tv":"1.0.0","e":[{"id":"ScriptedEvent000000003","k":"pv","u":"/x"}]}' "$GW/v1/e")" = 404
sleep 8
check "rejected event never reached Umami" test "$(evsql "url_path = '/scripted'")" = 0
csql() { psqlc scf "SELECT COALESCE(sum(count),0) FROM scf.web_edge_counters WHERE site_id = '$SITE' AND counter = '$1' AND label = '$2'"; }
for _ in $(seq 1 30); do [[ "$(csql reason challenge_missing)" -ge 1 ]] && break; sleep 1; done
check "counter upload: verdict/rejected and reason/challenge_missing in scf.web_edge_counters" sh -c "[ $(csql verdict rejected) -ge 1 ] && [ $(csql reason challenge_missing) -ge 1 ]"
check "counter upload: verdict/verified ≥ 2 (the browser's page views)" test "$(csql verdict verified)" -ge 2

echo "== Umami and PostgreSQL down → still 202; the spool drains afterwards"
dc stop umami postgres >/dev/null 2>&1
PROBE="$WSB_WORK/probe"; (cd "$ROOT/services/gateway" && eval "$(mise env -s bash)" && go build -o "$PROBE" ./cmd/probe)
down_ok=0
for i in 1 2 3 4 5; do
  "$PROBE" -hosts https://127.0.0.1:$WSB_INGEST_PORT -insecure -site "$SITE_KEY" -origin https://site.test -source wsb -path "/down/$i" -deadline 5s >/dev/null 2>&1 && down_ok=$((down_ok+1))
done
check "5 of 5 canaries answered 202 while Umami and PostgreSQL are down" test "$down_ok" = 5
sleep 3
check "spool holds them (queued ≥ 5)" sh -c "[ \"\$(curl -fsS http://127.0.0.1:$WSB_METRICS_PORT/metrics | awk '\$1==\"scf_gateway_spool_queued\"{print \$2}')\" -ge 5 ]"
HOSTIP="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "${PROJECT}_public")"
scan_spool() { docker run --rm -v "${PROJECT}_gwstate:/s:ro" --entrypoint sh "$NODE_IMAGE" -c 'cat /s/spool/*/*.seg 2>/dev/null'; }
scan_spool > "$WSB_WORK/spool.bin" || true
check "privacy: spool holds records (scan is meaningful)" grep -q '"url":"/down/' "$WSB_WORK/spool.bin"
check "privacy: no client address ($HOSTIP) in the spool" sh -c "! grep -aqF '$HOSTIP' '$WSB_WORK/spool.bin'"
check "privacy: no raw User-Agent, Go client or query string in the spool" sh -c "! grep -aqE 'Go-http-client|HeadlessChrome|utm_secret' '$WSB_WORK/spool.bin'"
dc start postgres umami >/dev/null 2>&1
for _ in $(seq 1 120); do [[ "$(curl -fsS http://127.0.0.1:$WSB_METRICS_PORT/metrics | awk '$1=="scf_gateway_spool_queued"{print $2}')" == 0 ]] && break; sleep 2; done
check "spool drained after the engine came back (queued 0)" test "$(metric scf_gateway_spool_queued)" = 0
check "all 5 canaries stored in Umami exactly once" test "$(evsql "url_path LIKE '/down/%'")" = 5

# Counter records written while the control plane's database was down are retried with back-off and may arrive after
# later ones (seen on a loaded host: fsynced 2 | acked 7 after 30 s), so wait up to 3 minutes for the books to balance.
ACCT_SQL="SELECT sum(fsynced), sum(acked_stored + acked_engine_bot + acked_engine_rejected + expired_72h), (array_agg(queued_end ORDER BY last_period_end DESC))[1] FROM scf.edge_spool_accounting WHERE node_id = 'edge-a1'"
for _ in $(seq 1 90); do
  acct="$(psqlc scf "$ACCT_SQL")"
  echo "$acct" | awk -F'|' '{ exit !($1 >= 7 && $1 == $2 + $3) }' && break
  sleep 2
done
check "spool accounting in scf.edge_spool_accounting: fsynced = acknowledged + expired + queued ($acct)" \
  sh -c "echo '$acct' | awk -F'|' '{ exit !(\$1 >= 7 && \$1 == \$2 + \$3) }'"

echo "== privacy scan of the gateway's logs"
docker logs "$GWC" > "$WSB_WORK/gw.log" 2>&1
check "logs: no client address ($HOSTIP)" sh -c "! grep -qF '$HOSTIP' '$WSB_WORK/gw.log'"
check "logs: no User-Agent, surrogate, query string or token" sh -c "! grep -qE 'Mozilla/|2001:db8:|utm_secret|ScriptedEvent|Bearer' '$WSB_WORK/gw.log'"

echo "== result: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
