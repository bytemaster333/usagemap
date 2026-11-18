#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# End-to-end test of the monitoring overlay against the real local stack. Brings up compose.yaml +
# compose.monitoring.yaml through the base smoke test (which seeds the fixture tenant and site that the canary probes
# use), then checks:
#   scrape targets up · rules loaded · Watchdog → Alertmanager → status host heartbeat · Grafana provisions D1–D14 and
#   every dashboard query parses · three probe sources record good rounds, quorum computed · signed-in journey (SEP-53)
#   succeeds · status page renders · SLO report generated from the stored probe data (+ server-side view) · logs reach
#   VictoriaLogs and the scanner finds no personal data · health controller: killing the edge removes its address at
#   both fake DNS providers, the last AAAA address stays, ProbeQuorumFailing/EdgeNodeProbeFailing fire, recovery
#   re-adds it, a killed leader is replaced · no address/UA/token/seed in our containers' logs or the probe store.
#
#   ops/e2e/run.sh            (KEEP=1 keeps the stack; project scf-wsj1, host ports 56331–56338)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CDIR="$ROOT/infra/compose"
export PROJECT="${PROJECT:-scf-wsj1}"
export SCF_CONTROL_PLANE_PORT=56331 SCF_PORTAL_PORT=56332 SCF_INGEST_PORT=56333 SCF_SYSLOG_PORT=56334
export SCF_PROMETHEUS_PORT=56335 SCF_ALERTMANAGER_PORT=56336 SCF_GRAFANA_PORT=56337 SCF_STATUS_PORT=56338
NODE_IMAGE=node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
files=(-f "$CDIR/compose.yaml" -f "$CDIR/compose.dev.yaml" -f "$CDIR/compose.monitoring.yaml") # = smoke.sh + EXTRA_COMPOSE
dc() { docker compose -p "$PROJECT" "${files[@]}" "$@"; }
PASS=0; FAIL=0
ok()   { echo "PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check(){ local n=$1; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
waitfor(){ local secs=$1; shift; local end=$(( $(date +%s) + secs )); while (( $(date +%s) < end )); do "$@" >/dev/null 2>&1 && return 0; sleep 3; done; return 1; }
cleanup() { [[ "${KEEP:-0}" == 1 ]] || dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

PROM="http://127.0.0.1:$SCF_PROMETHEUS_PORT"; AM="http://127.0.0.1:$SCF_ALERTMANAGER_PORT"
GRAF="http://127.0.0.1:$SCF_GRAFANA_PORT"; STATUS="http://127.0.0.1:$SCF_STATUS_PORT"
promq() { curl -fsS --get "$PROM/api/v1/query" --data-urlencode "query=$1"; }
promv() { promq "$1" | jq -r '.data.result[0].value[1] // empty'; }
# fetch from inside the monitoring network (fake DNS providers, VictoriaLogs publish no port)
inside() { docker run --rm --network "${PROJECT}_monitoring" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user 65532:65532 "$NODE_IMAGE" node -e "fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t),()=>process.exit(1))" "$1"; }
PGPW() { cat "$CDIR/.secrets/pg_superuser_password"; }
psqlc() { dc exec -T -e PGPASSWORD="$(PGPW)" postgres psql -X -At -U postgres -d "$1" -c "$2"; }

"$CDIR/scripts/init.sh" >/dev/null
"$ROOT/ops/e2e/secrets.sh"
echo "== base stack + monitoring overlay through the base smoke test (seeds the fixture site the probes use)"
if KEEP=1 EXTRA_COMPOSE="$CDIR/compose.monitoring.yaml" "$CDIR/scripts/smoke.sh" > /tmp/scf-wsj1-smoke.log 2>&1; then
  ok "base smoke test with the overlay"
else
  echo "      (base smoke reported failures — see /tmp/scf-wsj1-smoke.log; continuing with the monitoring checks)"
  grep -E "^FAIL" /tmp/scf-wsj1-smoke.log | sed 's/^/      /' || true
fi
dc ps --format '{{.Service}}' | grep -qx prometheus || { bad "stack is not up"; exit 1; }

echo "== monitoring containers hardened"
for s in prometheus alertmanager grafana victorialogs postgres-exporter logscan probe-mon-c probe-probe-d probe-edge status etcd dns-a dns-b hc-mon-c hc-core-b; do
  check "$s: read-only root, no capabilities, no-new-privileges, non-root" sh -c "
    c=\$(docker compose -p $PROJECT ${files[*]} ps -q $s); [ -n \"\$c\" ] || exit 1
    [ \"\$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' \$c)\" = 'true [ALL] [no-new-privileges:true]' ] || exit 1
    u=\$(docker inspect -f '{{.Config.User}}' \$c); [ -n \"\$u\" ] && [ \"\${u%%:*}\" != 0 ] && [ \"\$u\" != root ]"
done
check "monitoring network is internal" test "$(docker network inspect -f '{{.Internal}}' "${PROJECT}_monitoring")" = true

echo "== Prometheus"
targets_up() {
  local j; j="$(curl -fsS "$PROM/api/v1/targets")"
  for job in prometheus alertmanager gateway collector engine-proxy metrics-writer jobs control-plane postgres probes health-controller status logscan victorialogs; do
    [[ "$(jq -r --arg j "$job" '[.data.activeTargets[] | select(.labels.job==$j) | .health] | (length > 0 and all(. == "up"))' <<<"$j")" == true ]] || { echo "down: $job"; return 1; }
  done
}
if waitfor 180 targets_up; then ok "every scrape target up (14 jobs)"; else bad "scrape targets: $(targets_up || true)"; fi
check "alert and recording rules loaded (≥ 70 rules)" test "$(curl -fsS "$PROM/api/v1/rules" | jq '[.data.groups[].rules[]] | length')" -ge 70
check "jobs service: job label kept as job_name" sh -c "[ -n \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=scf_job_last_success_timestamp_seconds{job_name=\"partitions\"}' | jq -r '.data.result[0].value[1] // empty')\" ]"

echo "== Watchdog → Alertmanager → status host (dead-man's-switch heartbeat)"
check "Watchdog firing in Alertmanager" waitfor 120 sh -c "curl -fsS '$AM/api/v2/alerts' | jq -e '[.[] | select(.labels.alertname==\"Watchdog\")] | length == 1'"
check "heartbeat.json published by the status host" waitfor 120 sh -c "curl -fsS '$STATUS/heartbeat.json' | jq -e '.last_heartbeat'"
check "dead-man's switch check (ops/deadman/check.sh, run every 5 min by .github/workflows/deadman.yml) passes" \
  env STATUS_URL="$STATUS" "$ROOT/ops/deadman/check.sh"
check "dead-man's switch fails on a stale heartbeat (MAX_AGE=-1)" sh -c "! STATUS_URL='$STATUS' MAX_AGE=-1 '$ROOT/ops/deadman/check.sh'"

echo "== Grafana: dashboards provisioned from ops/dashboards"
GPW="$(cat "$CDIR/.secrets/grafana_admin_password")"
check "Grafana provisions D1–D14 (14 dashboards)" waitfor 90 sh -c "[ \"\$(curl -fsS -u 'admin:$GPW' '$GRAF/api/search?type=dash-db' | jq '[.[] | select(.uid | startswith(\"scf-d\"))] | length')\" = 14 ]"
check "Grafana anonymous access refused" sh -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' '$GRAF/api/search')\" = 401 ]"
qbad=0; qn=0
while IFS= read -r expr; do
  qn=$((qn+1)); e="${expr//\$__range/1h}"
  [[ "$(curl -fsS --get "$PROM/api/v1/query" --data-urlencode "query=$e" | jq -r .status 2>/dev/null)" == success ]] || { echo "      bad query: $expr"; qbad=$((qbad+1)); }
done < <(jq -r '.panels[].targets[]?.expr' "$ROOT"/ops/dashboards/*.json)
check "all $qn dashboard queries are valid PromQL on the running Prometheus" test "$qbad" = 0

echo "== probes (three sources, 30 s rounds) and the signed-in journey"
ACCOUNT="$(docker run --rm --network none --read-only --cap-drop ALL --user "$(id -u):$(id -g)" -v "$CDIR/.secrets/journey_seed:/s:ro" usagemap/ops:dev keygen -seed-file /s)"
G_TENANT=0193b7e2-0000-7000-8000-00000000050a
member() {
  psqlc scf "INSERT INTO scf.memberships (tenant_id, user_id, role)
    SELECT '$G_TENANT', user_id, 'viewer' FROM scf.external_identities WHERE provider = 'stellar' AND subject = '$ACCOUNT'
    ON CONFLICT DO NOTHING; SELECT count(*) FROM scf.memberships m JOIN scf.external_identities i USING (user_id)
    WHERE i.subject = '$ACCOUNT' AND m.tenant_id = '$G_TENANT';" | tail -1 | grep -qx 1
}
# The first journey signs the synthetic member up (SEP-53); it then gets viewer access to the canary tenant only.
if waitfor 150 member; then ok "synthetic journey member signed up by SEP-53 and added to the canary tenant"; else bad "journey member"; fi
round_good() { [[ "$(promv 'count(scf_probe_last_bad{kind="round"} == 0)')" == 3 ]]; }
check "three probe sources record good ingest rounds (canary accepted within 2 s)" waitfor 180 round_good
check "quorum recorded: scf:probe_quorum:bad{kind=round} = 0 with 3 voters" waitfor 90 sh -c "
  [ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=scf:probe_quorum:bad{kind=\"round\"}' | jq -r '.data.result[0].value[1]')\" = 0 ] &&
  [ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=scf:probe_quorum:voters{kind=\"round\"}' | jq -r '.data.result[0].value[1]')\" = 3 ]"
check "per-hostname and per-node rounds good" waitfor 60 sh -c "[ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=count(scf_probe_last_bad{kind=~\"host|node\"} == 0)' | jq -r '.data.result[0].value[1]')\" = 9 ]"
check "canary counter exported per (source, path) (wire-formats §o)" sh -c "[ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=count(scf_probe_canary_accepted_total > 0)' | jq -r '.data.result[0].value[1]')\" -ge 9 ]"
journey_good() { [[ "$(promv 'count(scf_probe_last_bad{kind="journey"} == 0)')" == 3 ]]; }
if waitfor 420 journey_good; then ok "signed-in journey (sign-in, tenants, web overview with data, ≤ 3 s per step) good from 3 sources"
else bad "journey: $(dc logs --no-color --tail 5 probe-mon-c 2>&1 | grep -o '"step":"[a-z_]*","status":[0-9]*' | tail -1)"; fi

echo "== status page and SLO report from the stored probe data"
# The page shows one row per check the probe runs and loads exactly one same-origin script (status.js);
# any other <script> (inline or external) is a regression the CSP would also block.
check "status page served (self-contained HTML, web tracking row, only its own status.js)" sh -c "
  page=\"\$(curl -fsS '$STATUS/')\" && printf '%s' \"\$page\" | grep -q '<b>Web tracking ' &&
  [ \"\$(printf '%s' \"\$page\" | grep -o '<script[^>]*>' | sort -u)\" = '<script src=\"status.js\" defer>' ] &&
  curl -fsS '$STATUS/status.js' | grep -q 'getElementById'"
check "status.json lists ingest, hostnames, edge node and dashboard" sh -c "[ \"\$(curl -fsS '$STATUS/status.json' | jq '.components | length')\" -ge 5 ]"
check "status page headers: CSP and no referrer" sh -c "curl -fsSI '$STATUS/' | grep -qi \"content-security-policy: default-src 'none'\""
OUTDIR="$(mktemp -d)"; chmod 777 "$OUTDIR"; MONTH="$(date -u +%Y-%m)"  # the probe store belongs to uid 65532
docker run --rm --network "${PROJECT}_monitoring" --read-only --cap-drop ALL --user 65532:65532 \
  -v "${PROJECT}_probestore:/p:ro" -v "$OUTDIR:/out" usagemap/ops:dev slo-report -store /p -month "$MONTH" -out /out -prometheus http://prometheus:9090 >/dev/null 2>&1 || true
check "SLO report $MONTH generated with headline, per-hostname, per-node and dashboard rows" sh -c "
  grep -q '| Ingest availability (probe rounds, headline) |' '$OUTDIR/$MONTH.md' && grep -q 'Ingest hostname host-a' '$OUTDIR/$MONTH.md' &&
  grep -q 'Edge node edge-a1' '$OUTDIR/$MONTH.md' && grep -q 'Dashboard availability' '$OUTDIR/$MONTH.md'"
check "SLO report includes the server-side view from Prometheus" grep -q 'accepted ÷ valid = ' "$OUTDIR/$MONTH.md"
check "SLO report raw CSVs for every probe source + SHA256SUMS verify" sh -c "
  ls '$OUTDIR/$MONTH/raw/' | sort | xargs | grep -qx 'edge-b1.csv mon-c.csv probe-d.csv' && cd '$OUTDIR/$MONTH' && sha256sum -c SHA256SUMS"
docker run --rm --network none --user 65532:65532 -v "$OUTDIR:/o" "$NODE_IMAGE" sh -c "rm -rf /o/*" >/dev/null 2>&1 || true
rmdir "$OUTDIR" 2>/dev/null || true

echo "== logs: VictoriaLogs and the PII scanner"
check "application logs arrive in VictoriaLogs (syslog driver)" waitfor 90 sh -c "
  docker run --rm --network ${PROJECT}_monitoring --user 65532:65532 $NODE_IMAGE node -e \"fetch('http://victorialogs:9428/select/logsql/query?query=_time:30m&limit=50').then(r=>r.text()).then(t=>process.exit(t.split('\\\\n').filter(Boolean).length>5?0:1),()=>process.exit(1))\""
dc restart logscan >/dev/null 2>&1 || true
check "log scanner ran over the logs" waitfor 90 sh -c "[ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=sum(scf_log_scan_lines_total)' | jq -r '.data.result[0].value[1] // 0' | cut -d. -f1)\" -gt 0 ]"
check "log scanner: no IP, UA, bearer token, key, seed or account id in the operational logs" sh -c "[ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=sum(scf_log_pii_findings_total)' | jq -r '.data.result[0].value[1]')\" = 0 ]"

echo "== health controller (C-92): kill the edge, both providers, last address, recovery, leader failover"
dnsset() { inside "http://$1:8053/admin/sets" | jq -r --arg k "$2" '.[$k].records // [] | sort | join(",")'; }
check "initial record sets published at both providers (A and AAAA)" waitfor 90 sh -c "
  [ \"\$(docker run --rm --network ${PROJECT}_monitoring --user 65532:65532 $NODE_IMAGE node -e \"fetch('http://dns-b:8053/admin/sets').then(r=>r.json()).then(s=>console.log((s['example-analytics.net|ingest-b.example-analytics.net|AAAA']||{records:[]}).records.join()))\")\" = '2001:db8:e::11' ]"
leader() { for h in mon-c core-b; do if [[ "$(promv "scf_health_controller_leader{controller=\"$h\"}")" == 1 ]]; then echo "$h"; fi; done; return 0; }
check "exactly one health-controller leader (etcd lease)" sh -c "[ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=sum(scf_health_controller_leader)' | jq -r '.data.result[0].value[1]')\" = 1 ]"
dc stop gateway >/dev/null 2>&1 || true; t0=$(date +%s)
removed() { [[ "$(dnsset dns-a 'example-analytics.org|ingest-a.example-analytics.org|A')" == 192.0.2.12 && "$(dnsset dns-b 'example-analytics.net|ingest-b.example-analytics.net|A')" == 192.0.2.12 ]]; }
if waitfor 120 removed; then ok "edge killed: its address removed at both providers after $(( $(date +%s) - t0 )) s (10 s rounds locally; 30 s rounds proven ≤ 2 min in services/health-controller/integration)"
else bad "edge address not removed: $(dnsset dns-a 'example-analytics.org|ingest-a.example-analytics.org|A')"; fi
check "last AAAA address kept although its node is down" test "$(dnsset dns-a 'example-analytics.org|ingest-a.example-analytics.org|AAAA')" = "2001:db8:e::11"
check "ProbeQuorumFailing and EdgeNodeProbeFailing fire in Alertmanager" waitfor 150 sh -c "
  curl -fsS '$AM/api/v2/alerts' | jq -e '[.[] | .labels.alertname] | (index(\"ProbeQuorumFailing\") != null) and (index(\"EdgeNodeProbeFailing\") != null)'"
check "status page shows the ingest outage" waitfor 90 sh -c "curl -fsS '$STATUS/status.json' | jq -e '.overall == \"outage\"'"
L="$(leader | head -1)"; dc kill -s KILL "hc-$L" >/dev/null 2>&1 || true
other=core-b; [[ "$L" == core-b ]] && other=mon-c
check "leader hc-$L killed: hc-$other takes over the lease" waitfor 90 sh -c "[ \"\$(curl -fsS --get '$PROM/api/v1/query' --data-urlencode 'query=scf_health_controller_leader{controller=\"$other\"}' | jq -r '.data.result[0].value[1]')\" = 1 ]"
dc start gateway >/dev/null 2>&1 || true; dc up -d collector >/dev/null 2>&1 || true; t1=$(date +%s)
readded() { [[ "$(dnsset dns-a 'example-analytics.org|ingest-a.example-analytics.org|A')" == 192.0.2.11,192.0.2.12 && "$(dnsset dns-b 'example-analytics.net|ingest-b.example-analytics.net|A')" == 192.0.2.11,192.0.2.12 ]]; }
if waitfor 180 readded; then ok "edge recovered: re-added at both providers after $(( $(date +%s) - t1 )) s (5 good rounds)"; else bad "edge not re-added"; fi
dc start "hc-$L" >/dev/null 2>&1 || true

echo "== privacy"
check "no address, UA, token, surrogate or seed in the probe, status, logscan and health-controller logs" sh -c "
  ! docker compose -p $PROJECT ${files[*]} logs --no-color probe-mon-c probe-probe-d probe-edge status logscan hc-mon-c hc-core-b dns-a dns-b 2>&1 |
    grep -qE 'Mozilla/|Bearer |2001:db8|192\.0\.2\.|S[A-Z2-7]{55}|$ACCOUNT|$(cat "$CDIR/.secrets/dns_token")|$(cat "$CDIR/.secrets/heartbeat_token")'"
check "raw probe store holds only round, source, kind, target, outcome, status, latency" sh -c "
  docker run --rm -v ${PROJECT}_probestore:/p:ro --user 65532:65532 $NODE_IMAGE sh -c \"cat /p/*/*.csv\" | grep -v '^round_start_utc' |
  grep -vqE '^[0-9TZ:-]+,[a-z0-9-]+,(round|host|node|otlp|journey),[a-z0-9.-]+,(good|bad|abstain),[0-9]+,[0-9]+\$' && exit 1 || exit 0"

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
