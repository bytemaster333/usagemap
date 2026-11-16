#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Every test command of the integration catalogue (src/integrations/catalogue.ts, test-commands.ts), rendered by the
# catalogue itself (gen-test-commands.ts) and run verbatim against the real local stack. Each one must arrive where
# the card's live check looks, and must never be counted:
#   OTLP (every API card, one per metric family: HTTP server, Stellar SDK client, partner calls, payments, both anchor
#        sources) — gateway → Collector → metrics writer → PostgreSQL: one cumulative_first_point each, no request, no
#        route, no client-metric row, no other drop reason;
#   web (script tag and every web card) — gateway → counter record → control plane: one dev event
#        (rejected/challenge_missing), nothing in Umami or the verdict counters;
#   wallet (Privy, connect failures + WalletConnect) — dev events of kind stellar with the integration's names;
#   browser RPC — 202 (the aggregate's shape is accepted), its page view in the dev panel, no RPC row stored;
#   app (React Native, Flutter) — 202 {"accepted":0,"dropped":1}, one `_dropped/reason/stale` cell each, no event, no
#        session (edge_counter_features lists app and rpc in this stack, as a deployment's operator sets it);
#   badge — 404 while private, 200 Shields document once public and the hourly document exists;
#   pin Action — the real tools/pin-action against this stack's release list: the card's tag is ok.
# Uses the existing usagemap/*:dev images (--no-build; builds usagemap/postgres:dev only if missing); project scf-f1, host ports
# 56580–56582; down -v at the end (KEEP=1 keeps it).
#   services/control-plane/test/live/integration-test-commands.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE=$ROOT/infra/compose
HERE_T="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d)"; mkdir -p "$W/live"
PROJECT=scf-f1
export SCF_CONTROL_PLANE_PORT=56580 SCF_PORTAL_PORT=56581 SCF_INGEST_PORT=56582
dc() { docker compose -p "$PROJECT" -f "$HERE/compose.yaml" -f "$HERE/compose.dev.yaml" "$@"; }
PASS=0; FAIL=0
ok() { echo "PASS  $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
cleanup() { rm -rf "$W"; [[ "${KEEP:-0}" == 1 ]] || dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
NODE_IMAGE=node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
eval "$(cd $ROOT && mise env -s bash)"
"$HERE/scripts/init.sh" >/dev/null
if ! docker image inspect usagemap/postgres:dev >/dev/null 2>&1; then echo "== building usagemap/postgres:dev"; dc build postgres >/dev/null 2>&1 || { bad "build postgres"; exit 1; }; fi
echo "== up"
dc up -d --no-build --wait --wait-timeout 600 >/dev/null 2>&1 || { dc ps -a; bad "up"; exit 1; }
ok "stack up"
PGPW="$(cat "$HERE/.secrets/pg_superuser_password")"
psqlc() { dc exec -T -e PGPASSWORD="$PGPW" postgres psql -X -At -U postgres -d "$1" -c "$2"; }
U=0193b7e2-0000-7000-8000-0000000f1001; T=0193b7e2-0000-7000-8000-0000000f100a
S=0193b7e2-0000-7000-8000-0000000f10a1; KEY=F1IntegrationTest00001
WEB=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9bf1a1; TWIN=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9bf1a2
SVC=0193b7e2-0000-7000-8000-0000000f10b1; SVCNAME=f1-anchor-api
psqlc scf "BEGIN;
INSERT INTO scf.users (user_id, display_name) VALUES ('$U', 'f1');
INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ('$T', 'f1-test', 'F1', 'active', '$U');
INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id, visitor_id, created_by, dev_origins)
  VALUES ('$T', '$S', 'site', '$KEY', '$WEB', '$TWIN', 'on', '$U', '{localhost}');
INSERT INTO scf.site_domains (tenant_id, site_id, host, state, verified_at) VALUES ('$T', '$S', 'site.test', 'verified', now());
INSERT INTO scf.api_services (tenant_id, service_id, service_name, registration, registered_at, created_by) VALUES ('$T', '$SVC', '$SVCNAME', 'portal', now() - interval '1 day', '$U');
UPDATE scf.settings SET value = '[\"props\", \"dev\", \"app\", \"rpc\"]'::jsonb, updated_at = now() WHERE key = 'edge_counter_features';
COMMIT; NOTIFY scf_edge; NOTIFY scf_umami;" >/dev/null && ok "fixture tenant, site (dev origin localhost), service; counter features props, dev, app, rpc" || bad "fixtures"
minted="$(docker run --rm --network none --read-only --cap-drop ALL --user 65532:65532 -v "$HERE/.secrets/pepper_ing:/run/pepper:ro" \
  -v "$HERE/.secrets/pki/ca.pem:/pki/ca.pem:ro" -v "$HERE/scripts/smoke-client.mjs:/smoke-client.mjs:ro" "$NODE_IMAGE" node /smoke-client.mjs mint-ing)"
read -r ING_KEY ING_ID ING_LAST4 ING_HASH <<<"$minted"
psqlc scf "INSERT INTO scf.ingest_tokens (tenant_id, token_id, secret_hash, pepper_version, last4, label, created_by)
  VALUES ('$T', '$ING_ID', decode('$ING_HASH', 'hex'), 1, '$ING_LAST4', 'f1', '$U'); NOTIFY scf_edge;" >/dev/null && ok "ingest token" || bad "token"
HOST=ingest-a.example-analytics.org
ORIGIN="https://$HOST:$SCF_INGEST_PORT"
# a curl on PATH that only adds the CA and the host-name pin; the generated command itself runs verbatim
mkdir -p "$W/bin"; cat > "$W/bin/curl" <<SH
#!/bin/sh
exec /usr/bin/curl --cacert "$HERE/.secrets/pki/ca.pem" --resolve "$HOST:$SCF_INGEST_PORT:127.0.0.1" "\$@"
SH
chmod +x "$W/bin/curl"
ready=0; for _ in $(seq 1 90); do
  c=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --cacert "$HERE/.secrets/pki/ca.pem" --resolve "$HOST:$SCF_INGEST_PORT:127.0.0.1" \
     -H "Authorization: Bearer $ING_KEY" -H 'Content-Type: application/json' --data '{"resourceMetrics":[]}' "$ORIGIN/v1/metrics")
  [[ "$c" == 200 ]] && { ready=1; break; }; sleep 1; done
[[ $ready == 1 ]] && ok "token reached the gateway (empty export 200)" || bad "token not at gateway ($c)"
dev=0; for _ in $(seq 1 90); do
  /usr/bin/curl -sS --cacert "$HERE/.secrets/pki/ca.pem" --resolve "$HOST:$SCF_INGEST_PORT:127.0.0.1" -D - -o /dev/null \
    -H 'Origin: http://localhost:5173' -H 'Content-Type: text/plain' --data "{\"v\":1,\"s\":\"$KEY\",\"p\":\"standard\",\"tv\":\"1.1.0\"}" \
    "$ORIGIN/v1/c" 2>/dev/null | grep -qi '^x-scf-debug: v=1; class=dev' && { dev=1; break; }; sleep 1; done
[[ $dev == 1 ]] && ok "gateway knows localhost as a dev origin of the site" || bad "dev origin not at gateway"

CP="http://127.0.0.1:$SCF_CONTROL_PLANE_PORT"
/usr/bin/curl -fsS "$CP/v1/tracker/versions" > "$W/versions.json" && ok "tracker release list from the control plane" || bad "versions"
jq -n --slurpfile v "$W/versions.json" --arg key "$KEY" --arg s "$S" --arg origin "$ORIGIN" --arg cp "$CP" --arg svc "$SVC" --arg svcname "$SVCNAME" '{
  versions: $v[0], hosts: ["https://ingest-a.example-analytics.org", "https://ingest-b.example-analytics.net"],
  site: {site_id: $s, name: "site", site_key: $key, tracker_profile: "standard", dev_origins: ["localhost"],
         domains: [{domain_id: "d", host: "site.test", state: "verified"}]},
  service: {service_id: $svc, service_name: $svcname}, tenant: {slug: "f1-test", public_stats: false},
  ingestOrigin: $origin, otlpEndpoint: $origin, portalOrigin: $cp}' > "$W/ctx.json"
gen() { node "$HERE_T/gen-test-commands.ts" "$W/ctx.json" "$1" > "$W/live/$1.sh" || { bad "$1: no command"; return 1; }; }
run() { (cd "${2:-$W}" && PATH="$W/bin:$PATH" SCF_OTLP_TOKEN="$ING_KEY" sh "$W/live/$1.sh" 2>&1); }
psv() { psqlc scf "$1"; }
waitfor() { # <expected> <sql>
  local got=""; for _ in $(seq 1 150); do got=$(psv "$2"); [[ "$got" == "$1" ]] && { echo "$got"; return 0; }; sleep 1; done; echo "$got"; return 1; }

echo "== OTLP test commands, one per API card (generated, verbatim)"
BASE="select coalesce(sum(count),0) from scf.api_ingest_counters where tenant_id='$T' and service_id='$SVC' and reason='cumulative_first_point'"
n=0
for card in api_otel_node api_otel_node api_edge api_stellar_sdk api_stellar_sdk_python api_partner_calls api_payments api_anchor_wallet_sdk api_anchor_platform_events; do
  gen "$card" || continue
  n=$((n+1))
  metric=$(grep -o '"name":"[a-z._]*","unit"' "$W/live/$card.sh" | head -1)
  out=$(run "$card")
  grep -q "^HTTP/[0-9.]* 200" <<<"$out" && grep -q 'partialSuccess' <<<"$out" && ok "$card ($metric): 200 partialSuccess" || bad "$card: $out"
  got=$(waitfor "$n" "$BASE") && ok "$card: cumulative_first_point = $n for the service (the live check's signal)" || bad "$card: cumulative_first_point = $got, want $n"
done
sleep 5
psqlc scf "select reason, sum(count) from scf.api_ingest_counters where tenant_id='$T' group by 1"
m=$(psv "select coalesce(sum(request_count),0) from scf.api_metrics_1m where tenant_id='$T'")
h=$(psv "select coalesce(sum(request_count),0) from scf.api_metrics_1d where tenant_id='$T'")
[[ "$m" == 0 && "$h" == 0 ]] && ok "never counted: 0 requests in api_metrics_1m and _1d" || bad "counted: 1m=$m 1d=$h"
r=$(psv "select count(*) from scf.api_routes where tenant_id='$T'")
[[ "$r" == 0 ]] && ok "no route registered for /usagemap-test" || bad "routes: $r"
c=$(psv "select (select count(*) from scf.stellar_client_1m where tenant_id='$T') + (select count(*) from scf.stellar_client_1h where tenant_id='$T') + (select count(*) from scf.integration_metrics_1h where tenant_id='$T') + (select count(*) from scf.integration_metrics_1d where tenant_id='$T')")
[[ "$c" == 0 ]] && ok "never counted: no Stellar client or integration metric row" || bad "client-metric rows: $c"
other=$(psv "select count(*) from scf.api_ingest_counters where tenant_id='$T' and reason <> 'cumulative_first_point'")
[[ "$other" == 0 ]] && ok "no drop reason other than cumulative_first_point (every family passed the Collector's allow-list)" || bad "other reasons: $(psv "select string_agg(reason||'='||count, ',') from scf.api_ingest_counters where tenant_id='$T' and reason <> 'cumulative_first_point'")"

echo "== web test command (generated, verbatim)"
gen web_script_tag; cat "$W/live/web_script_tag.sh"
for card in web_npm web_nextjs web_nuxt web_sveltekit web_astro web_react_spa web_react_router web_static_generators web_cms onchain_scaffold app_telegram_mini_app; do
  gen "$card" && cmp -s "$W/live/web_script_tag.sh" "$W/live/$card.sh" || bad "$card: test command differs from the script tag's"
done
ok "every web card's test command is the script tag's (12 cards)"
out=$(run web_script_tag); echo "$out" | head -1
grep -q "^HTTP/[0-9.]* 202" <<<"$out" && ok "web: 202" || bad "web: $out"
ROW="select would_be_verdict || '/' || coalesce(reason,'-') from scf.web_dev_events where site_id='$S' and path_class='/usagemap-test' and kind='pageview'"
got=$(waitfor "rejected/challenge_missing" "$ROW") && ok "web: dev event in the first-event buffer: $got" || bad "web dev event: '$got'"
sleep 3
u=$(psqlc umami "select count(*) from website_event where url_path = '/usagemap-test'")
[[ "$u" == 0 ]] && ok "web: never counted: nothing in Umami" || bad "umami rows: $u"
c=$(psv "select count(*) from scf.web_edge_counters where site_id='$S' and counter='verdict'")
[[ "$c" == 0 ]] && ok "web: no verdict counter for the site" || bad "verdict counters: $c"

echo "== wallet and browser RPC test commands (generated, verbatim)"
for card in wallet_privy wallet_walletconnect wallet_browser_rpc; do
  gen "$card"; out=$(run "$card")
  grep -q "^HTTP/[0-9.]* 202" <<<"$out" && ok "$card: 202 (closed vocabulary accepted)" || bad "$card: $out"
done
DEV="select string_agg(event_name || ':' || would_be_verdict || '/' || coalesce(reason,'-'), ',' order by event_name) from scf.web_dev_events where site_id='$S' and path_class='/usagemap-test' and kind='stellar'"
want="wallet_connect:rejected/challenge_missing,wallet_connect_failed:rejected/challenge_missing,wallet_connect_failed:rejected/challenge_missing,walletconnect_session:rejected/challenge_missing"
got=$(waitfor "$want" "$DEV") && ok "wallet: dev events of kind stellar (wallet cards' test signal): $got" || bad "wallet dev events: '$got'"
got=$(waitfor 2 "select count(*) from scf.web_dev_events where site_id='$S' and path_class='/usagemap-test' and kind='pageview'") \
  && ok "browser RPC: its page view arrived in the first-event buffer" || bad "browser RPC page view: $got"
sleep 3
c=$(psv "select count(*) from scf.web_rpc_client_daily where site_id='$S'")
[[ "$c" == 0 ]] && ok "browser RPC: never counted: the dev aggregate stored nothing (rpc feature on)" || bad "rpc rows: $c"
c=$(psv "select count(*) from scf.web_edge_counters where site_id='$S' and counter='verdict'")
[[ "$c" == 0 ]] && ok "wallet/RPC: no verdict counter for the site" || bad "verdict counters: $c"

echo "== app-event test commands (generated, verbatim)"
STALE="select coalesce(sum(count),0) from scf.app_event_daily where site_id='$S' and event_name='_dropped' and prop_key='reason' and prop_value='stale'"
k=0
for card in app_react_native app_flutter; do
  gen "$card"; [[ $card == app_react_native ]] && cat "$W/live/$card.sh"
  k=$((k+1)); out=$(run "$card"); echo "$out" | head -1
  grep -q "^HTTP/[0-9.]* 202" <<<"$out" && grep -q '{"accepted":0,"dropped":1}' <<<"$out" && ok "$card: 202 {\"accepted\":0,\"dropped\":1}" || bad "$card: $out"
  got=$(waitfor "$k" "$STALE") && ok "$card: stale drops = $k for the site (the live check's signal)" || bad "$card: stale drops = $got, want $k"
done
c=$(psv "select count(*) from scf.app_event_daily where site_id='$S' and event_name <> '_dropped'")
[[ "$c" == 0 ]] && ok "app: never counted: no event and no session row" || bad "app rows: $c"

echo "== badge test command (generated, verbatim)"
gen tool_badges; cat "$W/live/tool_badges.sh"
out=$(run tool_badges); grep -q "^HTTP/[0-9.]* 404" <<<"$out" && ok "badge: 404 while the statistics are private" || bad "badge private: $(head -1 <<<"$out")"
psv "UPDATE scf.tenants SET public_stats_enabled = true WHERE tenant_id = '$T';
INSERT INTO scf.public_metrics_documents (tenant_id, document) VALUES ('$T', '{\"schema\":\"scf-analytics/metrics-endpoint/1\",\"project\":{\"slug\":\"f1-test\",\"name\":\"F1\",\"verification_level\":\"L0\"},\"generated_at\":\"2026-11-19T01:00:00Z\",\"window\":{\"start\":\"2026-10-20T00:00:00Z\",\"end\":\"2026-11-19T00:00:00Z\",\"days\":30},\"web\":{\"verified\":{\"pageviews\":0,\"visitors_sum\":0},\"raw\":{},\"visit_metrics\":{},\"daily\":[]},\"api\":{\"label\":\"self-attested telemetry\",\"requests\":0,\"assurance_level\":null},\"links\":{\"definitions\":\"x\"}}');" >/dev/null \
  && ok "public stats on; the hourly public document (as job public_metrics writes it)" || bad "public stats"
out=$(run tool_badges); tail -1 <<<"$out"
grep -q "^HTTP/[0-9.]* 200" <<<"$out" && grep -q '"schemaVersion":1' <<<"$out" && ok "badge: 200 Shields endpoint document" || bad "badge public: $out"

echo "== pin Action test command (generated, verbatim)"
gen tool_pin_action; cat "$W/live/tool_pin_action.sh"
# a copy, not a symlink: main.mjs runs only when argv[1] is its real path
mkdir -p "$W/pin/tools" && cp -r "$ROOT/tools/pin-action" "$W/pin/tools/"
out=$(run tool_pin_action "$W/pin"); rc=$?; echo "$out"
[[ $rc == 0 ]] && grep -q "^ok  index.html:1 standard " <<<"$out" && grep -q "1 tag(s), 0 error(s), 0 warning(s)" <<<"$out" \
  && ok "pin Action: the card's tag is ok against this stack's release list" || bad "pin Action (rc $rc)"
echo "== $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
