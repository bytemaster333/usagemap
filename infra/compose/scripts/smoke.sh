#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Smoke test of the local stack: brings it up, checks every service, sends a real web event through
# the gateway into Umami and a real OTLP request through the Collector and the metrics writer into PostgreSQL,
# restarts the engine proxy, re-runs the bootstrap, runs the on-chain checks (dev origins, the Stellar event property
# rollup, on-chain correlation, the seal and snapshot-list endpoints), and (unless KEEP=1) tears it down with `down -v`.
# Images are kept.
#
#   infra/compose/scripts/smoke.sh
#   PROJECT=scf-int SCF_CONTROL_PLANE_PORT=56280 SCF_PORTAL_PORT=56281 SCF_INGEST_PORT=56282 infra/compose/scripts/smoke.sh
#   EXTRA_COMPOSE=/path/override.yaml infra/compose/scripts/smoke.sh     (e.g. a stand-in for a missing service)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${PROJECT:-scf-smoke}"
export SCF_CONTROL_PLANE_PORT="${SCF_CONTROL_PLANE_PORT:-8080}"
export SCF_PORTAL_PORT="${SCF_PORTAL_PORT:-5173}"
export SCF_INGEST_PORT="${SCF_INGEST_PORT:-8443}"
NODE_IMAGE=node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
files=(-f "$HERE/compose.yaml" -f "$HERE/compose.dev.yaml") # + the dev fixtures (onchain-fixture)
[[ -n "${EXTRA_COMPOSE:-}" ]] && files+=(-f "$EXTRA_COMPOSE")
dc() { docker compose -p "$PROJECT" "${files[@]}" "$@"; }
PASS=0; FAIL=0
ok()   { echo "PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check(){ local n=$1; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
cleanup() { [[ "${KEEP:-0}" == 1 ]] || dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

# A stack left under this project by an interrupted run would be joined by `up` (old volumes, old dev secrets).
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ]]; then
  echo "== removing a leftover stack of project $PROJECT (interrupted earlier run)"; dc down -v --remove-orphans >/dev/null 2>&1
fi
"$HERE/scripts/init.sh" >/dev/null
echo "== up (project $PROJECT)"
t0=$(date +%s)
build_log="$(mktemp)"
dc build >"$build_log" 2>&1 || { tail -n 60 "$build_log"; rm -f "$build_log"; bad "docker compose build"; exit 1; }
rm -f "$build_log"
dc up -d --wait --wait-timeout 600 >/dev/null 2>&1 || { dc ps -a; dc logs --no-color --tail 30; bad "docker compose up --wait"; exit 1; }
ok "docker compose up --wait ($(( $(date +%s) - t0 )) s)"

echo "== containers"
state() { docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$(dc ps -aq "$1")"; }
APPS="engine-proxy control-plane portal jobs metrics-writer gateway"
for s in postgres pgbouncer umami $APPS; do check "$s running and healthy" test "$(state $s)" = "running 0 healthy"; done
check "collector running in its own container (no shared network namespace, C-130)" test \
  "$(docker inspect -f '{{.State.Status}} {{.HostConfig.NetworkMode}}' "$(dc ps -q collector)")" != "running container:$(dc ps -q --no-trunc gateway)"
for s in db-migrate umami-views-drop umami-migrate umami-views umami-bootstrap; do check "one-shot $s exited 0" test "$(state $s)" = "exited 0 "; done
check "Umami publishes no port" test "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$(dc ps -q umami)")" = "{}"
check "Umami is only on the internal engine network" test "$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(dc ps -q umami)")" = "${PROJECT}_engine "
for n in engine db data core cpi; do check "network $n is internal" test "$(docker network inspect -f '{{.Internal}}' "${PROJECT}_$n")" = true; done
nets() { docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(dc ps -q "$1")"; }
check "network cpi holds only the engine proxy and the control plane" test \
  "$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "${PROJECT}_cpi" | tr ' ' '\n' | sed -E "s/^${PROJECT}-//; s/-[0-9]+\$//" | sort | xargs)" = "control-plane engine-proxy"
check "control plane is only on cpi, data, public (not db, not core; F16)" test "$(nets control-plane)" = "${PROJECT}_cpi ${PROJECT}_data ${PROJECT}_public "
check "portal is only on public" test "$(nets portal)" = "${PROJECT}_public "
check "jobs is only on core, data, db (LISTEN only), public (egress; not cpi)" test "$(nets jobs)" = "${PROJECT}_core ${PROJECT}_data ${PROJECT}_db ${PROJECT}_public "
check "metrics writer is only on core and data" test "$(nets metrics-writer)" = "${PROJECT}_core ${PROJECT}_data "
check "gateway is only on core, otlp and public" test "$(nets gateway)" = "${PROJECT}_core ${PROJECT}_otlp ${PROJECT}_public "
# C-130: the Collector is only on otlp (its receivers) and core (the writer hop); otlp holds only it and the gateway;
# nothing else reaches its receivers — not from core (they bind to the otlp address only), not from public or data.
check "collector is only on otlp and core" test "$(nets collector | tr ' ' '\n' | grep -v "^${PROJECT}_monitoring\$" | xargs)" = "${PROJECT}_core ${PROJECT}_otlp"
check "network otlp is internal and holds only the gateway and the collector" test \
  "$(docker network inspect -f '{{.Internal}} {{range .Containers}}{{.Name}} {{end}}' "${PROJECT}_otlp" | tr ' ' '\n' | sed -E "s/^${PROJECT}-//; s/-[0-9]+\$//" | sort | xargs)" = "collector gateway true"
col_ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"${PROJECT}_$1\").IPAddress}}" "$(dc ps -q collector)"; }
tcp_open() { # tcp_open NETWORK HOST PORT → 0 when a TCP connection succeeds from a throwaway client on NETWORK
  docker run --rm --network "$1" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 65532:65532 "$NODE_IMAGE" \
    node -e 'const s=require("node:net").connect({host:process.argv[1],port:+process.argv[2],timeout:3000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' "$2" "$3"
}
check "collector receivers reachable on otlp (the gateway's path)" tcp_open "${PROJECT}_otlp" otlp-collector 4318
closed_from_core() { local ip; ip=$(col_ip core); [ -n "$ip" ] && ! tcp_open "${PROJECT}_core" "$ip" 4318 && ! tcp_open "${PROJECT}_core" "$ip" 4317; }
closed_from_outside() { local ip; ip=$(col_ip otlp); [ -n "$ip" ] && ! tcp_open "${PROJECT}_public" "$ip" 4318 && ! tcp_open "${PROJECT}_data" "$ip" 4318; }
check "collector receivers unreachable from core (bound to the otlp address only)" closed_from_core
check "collector unreachable from public and data" closed_from_outside
check "only the control plane, portal and gateway publish ports" test \
  "$(for c in $(dc ps -q); do [ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$c")" = 0 ] || docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c"; done | sort | xargs)" = "control-plane gateway portal"
check "PostgreSQL is only on engine and db" test "$(nets postgres)" = "${PROJECT}_db ${PROJECT}_engine "
check "Umami, the Collector and every app service: read-only root, no capabilities, no-new-privileges, non-root" sh -c "
  for c in $(for a in umami $APPS collector; do dc ps -q "$a"; done | xargs); do
    [ \"\$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' \$c)\" = 'true [ALL] [no-new-privileges:true]' ] || exit 1
    u=\$(docker inspect -f '{{.Config.User}}' \$c); [ -n \"\$u\" ] && [ \"\${u%%:*}\" != 0 ] || exit 1
  done"
check "PostgreSQL: read-only root, no capabilities, no-new-privileges, user 70" test \
  "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}} {{.Config.User}}' "$(dc ps -q postgres)")" \
  = "true [ALL] [] [no-new-privileges:true] 70:70"
check "PostgreSQL runs our clean image (db/Dockerfile target server, no gosu)" sh -c "
  [ \"\$(docker inspect -f '{{.Config.Image}}' $(dc ps -q postgres))\" = usagemap/postgres:dev ] &&
  ! docker run --rm --network none --entrypoint sh usagemap/postgres:dev -c 'command -v gosu'"
check "PgBouncer: read-only root, no capabilities, non-root" test \
  "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.Config.User}}' "$(dc ps -q pgbouncer)")" \
  = "true [ALL] [no-new-privileges:true] 70:70"
stubs_hardened() {
  dc --profile web --profile api config --format json | jq -e '[.services | to_entries[]
    | select(.key | IN("gateway", "collector", "metrics-writer", "jobs", "portal")) | .value
    | select(.read_only == true and .cap_drop == ["ALL"] and ((.security_opt // []) | index("no-new-privileges:true")))]
    | length == 5'
}
check "gateway, collector, metrics-writer, jobs, portal use the hardened anchor" stubs_hardened
collector_context() {
  dc --profile api config --format json | jq -e --arg root "$(cd "$HERE/../.." && pwd)" \
    '.services.collector.build.context == $root and .services.collector.build.dockerfile == "collector/Dockerfile"'
}
check "collector builds from the repository root with collector/Dockerfile" collector_context
keys_private() {
  for f in "$HERE"/.secrets/pki/*-key.pem; do
    [ "$(stat -c %a "$f")" = 600 ] || { echo "$f"; return 1; }
  done
}
check "dev PKI private keys are mode 0600" keys_private
check "Umami runs with SKIP_DB_MIGRATION=1 and the hardening flags" sh -c "docker inspect -f '{{join .Config.Env \"\n\"}}' $(dc ps -q umami) | grep -qx SKIP_DB_MIGRATION=1 &&
  docker inspect -f '{{join .Config.Env \"\n\"}}' $(dc ps -q umami) | grep -qx PRIVATE_MODE=1 &&
  docker inspect -f '{{join .Config.Env \"\n\"}}' $(dc ps -q umami) | grep -qx CLIENT_IP_HEADER=x-scf-surrogate-ip"
check "Umami log shows no start-up migration" sh -c "! docker logs $(dc ps -q umami) 2>&1 | grep -qiE 'migrat|Updated tracker'"

echo "== database"
PGPW="$(cat "$HERE/.secrets/pg_superuser_password")"
psqlc() { dc exec -T -e PGPASSWORD="$PGPW" postgres psql -X -At -U postgres -d "$1" -c "$2"; }
check "pg_hba has no trust rule" test "$(psqlc postgres "select count(*) from pg_hba_file_rules where auth_method = 'trust'")" = 0
local_needs_password() { ! dc exec -T postgres psql -X -At -h /var/run/postgresql -U postgres -d postgres -w -c 'select 1'; }
check "local socket without a password is refused" local_needs_password
check "databases scf and umami exist" test "$(psqlc postgres "select string_agg(datname, ',' order by datname) from pg_database where datname in ('scf','umami')")" = "scf,umami"
check "scf_ro views exist in umami" test "$(psqlc umami "select count(*) from pg_views where schemaname='scf_ro'")" = 2
timeout_set() { psqlc postgres "select setconfig::text from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where rolname = 'umami_app'" | grep -q 'statement_timeout=30s'; }
check "umami_app statement_timeout = 30s (C-112(6))" timeout_set
checkpointed() { dc exec -T postgres sh -c 'ls /tmp/scf-checkpoint-*'; }
check "CHECKPOINT ran after start (C-108)" checkpointed

echo "== PgBouncer (transaction mode) between the runtime roles and PostgreSQL"
pgb_ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"${PROJECT}_db\").IPAddress}}" "$(dc ps -q pgbouncer)")
transaction_mode() { dc exec -T pgbouncer grep -qx 'pool_mode = transaction' /etc/pgbouncer-scf/pgbouncer.ini; }
check "PgBouncer pool_mode = transaction" transaction_mode
cp_db_ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"${PROJECT}_db\").IPAddress}}" "$(dc ps -q jobs)")
# The one direct runtime connection (C-117): the jobs service's LISTEN sessions (core workers moved out of the control
# plane, F16), as scf_jobs, running only LISTEN.
LISTENERS="select string_agg(application_name || '=' || query, ',' order by application_name) from pg_stat_activity
  where usename = 'scf_jobs' and client_addr = '$cp_db_ip'::inet"
cp_listeners() {
  local l
  for _ in $(seq 1 30); do
    l=$(psqlc postgres "$LISTENERS")
    [[ "$l" == *scf_edge* && "$l" == *scf_umami* && "$l" == *scf_verify* && "$l" == *scf_erasure* && "$l" == *scf_snapshot* ]] && break
    sleep 1
  done
  echo "direct jobs sessions: $l"
  [[ "$l" == "scf-domain-verification=LISTEN scf_verify,scf-edge-snapshot-listen=LISTEN scf_edge,scf-erasure-listen=LISTEN scf_erasure,scf-snapshot-signer=LISTEN scf_snapshot,scf-umami-reconcile-listen=LISTEN scf_umami" ]]
}
check "jobs' direct sessions are exactly its five LISTEN sessions (scf_edge, scf_verify, scf_umami, scf_erasure, scf_snapshot)" cp_listeners
runtime_via_pgbouncer() {
  local n
  for _ in $(seq 1 15); do
    n=$(psqlc postgres "select count(*) || ' ' || count(*) filter (where client_addr <> '$pgb_ip'::inet or client_addr is null) from pg_stat_activity
      where usename in ('scf_app','scf_jobs','scf_writer','scf_metrics_ro','scf_umami_ro','scf_umami_maint')
        and not (usename = 'scf_jobs' and client_addr = '$cp_db_ip'::inet and query like 'LISTEN %')")
    [[ "${n% *}" != 0 ]] && break
    sleep 1
  done
  echo "runtime backends: $n (total, not from PgBouncer)"
  [[ "${n% *}" != 0 && "${n#* }" == 0 ]]
}
check "runtime-role backends exist and all come from PgBouncer ($pgb_ip)" runtime_via_pgbouncer
superuser_not_via_pgbouncer() { ! dc exec -T -e PGPASSWORD="$PGPW" pgbouncer psql -X -At -h 127.0.0.1 -p 6432 -U postgres -d scf -c 'select 1'; }
check "the superuser cannot log in through PgBouncer" superuser_not_via_pgbouncer

echo "== control plane"
check "control plane GET /healthz on 127.0.0.1:$SCF_CONTROL_PLANE_PORT -> 200" curl -fsS "http://127.0.0.1:$SCF_CONTROL_PLANE_PORT/healthz"
CPURL="http://127.0.0.1:$SCF_CONTROL_PLANE_PORT"
snapshot_keys() { curl -fsS "$CPURL/.well-known/scf-snapshot-keys.json" | jq -e '[.keys[]? | select(.kid == "snap-1")] | length == 1'; }
check "control plane GET /.well-known/scf-snapshot-keys.json -> 200 with kid snap-1" snapshot_keys
trust_proxy_off() { docker inspect -f '{{join .Config.Env "\n"}}' "$(dc ps -q control-plane)" | grep -qx SCF_TRUST_PROXY=false; }
check "control plane SCF_TRUST_PROXY=false (reached directly, no reverse proxy)" trust_proxy_off
# Review finding F16: the internet-facing process holds no jobs-only secret.
cp_secrets() {
  local l; l=$(dc exec -T control-plane ls /run/secrets | sort | xargs); echo "control-plane secrets: $l"
  ! grep -qwE 'jobs_database_url|jobs_listen_database_url|umami_maint_database_url|edge_signing_key|snapshot_signing_key|provisioner_cert|provisioner_key|jobs_provisioner_key|umami_provisioner_password|scf_umami_maint_password' <<<"$l"
}
check "control plane mounts no jobs-only secret (scf_jobs, scf_umami_maint, provisioner, signing keys; F16)" cp_secrets
cp_env_clean() { ! docker inspect -f '{{join .Config.Env "\n"}}' "$(dc ps -q control-plane)" | grep -qE '^SCF_(JOBS_|UMAMI_MAINT|EDGE_SIGNING_KEY|SNAPSHOT_SIGNING_KEY|ENGINE_PROXY_PROVISIONER|UMAMI_PROVISIONER_PASSWORD)'; }
check "control plane environment names no jobs-only setting (it would refuse to start)" cp_env_clean
cp_metrics() { dc exec -T control-plane node -e "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>process.exit(/scf_cp_auth_events_total/.test(t)&&/scf_cp_edge_snapshot_age_seconds \d/.test(t)?0:1),()=>process.exit(1))"; }
check "control plane /metrics on the internal listener (9464): scf_cp_* and the served snapshot's age" cp_metrics
check "control plane public listener has no /metrics (404)" test "$(curl -s -o /dev/null -w '%{http_code}' "$CPURL/metrics")" = 404

# The smoke client runs as uid 65532, the owner of the keys it uses (dev-pki.sh); NET selects its network.
client() {
  local pki=() n
  for n in ca edge-a1 core-a-jobs core-a-umami-bootstrap; do pki+=(-v "$HERE/.secrets/pki/$n.pem:/pki/$n.pem:ro"); done
  for n in edge-a1 core-a-jobs core-a-umami-bootstrap; do pki+=(-v "$HERE/.secrets/pki/$n-key.pem:/pki/$n-key.pem:ro"); done
  docker run --rm --network "${PROJECT}_${NET:-core}" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 65532:65532 \
    "${pki[@]}" -v "$HERE/.secrets/umami_provisioner_password:/run/prov_password:ro" \
    -v "$HERE/scripts/smoke-client.mjs:/smoke-client.mjs:ro" "$NODE_IMAGE" node /smoke-client.mjs "$@"
}
tally() { echo "$1"; PASS=$((PASS + $(grep -c '^PASS' <<<"$1" || true))); FAIL=$((FAIL + $(grep -c '^FAIL' <<<"$1" || true))); }
echo "== engine proxy (client on the internal core network)"
tally "$(client all || true)"

echo "== internal edge API: only through the engine proxy (C-114)"
tally "$(NET=core client cp-unreachable core || true)"
tally "$(NET=public client cp-direct public || true)"
tally "$(NET=data client cp-direct data || true)"

echo "== portal (fronts the control plane's API on the same origin)"
PORTAL="http://127.0.0.1:$SCF_PORTAL_PORT"
check "portal GET /portal-healthz -> 200" curl -fsS "$PORTAL/portal-healthz"
portal_csp() { curl -fsS -D - -o /dev/null "$PORTAL/" | grep -qi "^content-security-policy: .*default-src 'none'"; }
check "portal GET / -> 200 with a CSP" portal_csp
check "portal proxies /v1/* to the control plane (GET /v1/tracker/versions -> 200)" curl -fsS "$PORTAL/v1/tracker/versions"
# The SCF-operator metrics API is proxied too: without a key it is a 401 problem document, never the SPA's HTML.
op_api_proxied() {
  local h
  h=$(curl -sS -D - -o /dev/null -w '%{http_code}' "$PORTAL/op/v1/me")
  grep -qi '^content-type: application/problem+json' <<<"$h" && [[ "${h##*$'\n'}" == 401 ]]
}
check "portal proxies /op/v1/* (GET /op/v1/me without a key -> 401 problem+json, not the SPA)" op_api_proxied
tracker_sri() {
  local want got
  want=$(jq -r '.files[] | select(.profile=="standard") | .integrity' "$HERE/../../tracker/dist/$1/manifest.json")
  got=$(curl -fsS "$PORTAL/v1/tracker/versions" | jq -r --arg v "$1" '.[] | select(.version==$v) | .files[] | select(.profile=="standard") | .integrity')
  echo "manifest $want, served $got"; [[ -n "$want" && "$want" == "$got" ]]
}
check "tracker 1.0.0 published with the SRI of tracker/dist (manifest + releases mounted)" tracker_sri 1.0.0
check "tracker 1.1.0 published with the SRI of tracker/dist (manifest + releases mounted)" tracker_sri 1.1.0
check "tracker 1.2.0 published with the SRI of tracker/dist (manifest + releases mounted)" tracker_sri 1.2.0
# 1.0.0 is archived in tracker/releases and must stay byte-identical (tracker.intentional-upgrade): the build copies it after checking it.
release_kept() { cmp -s "$HERE/../../tracker/releases/1.0.0/standard.js" "$HERE/../../tracker/dist/1.0.0/standard.js"; }
check "tracker/dist/1.0.0 is the archived release byte for byte (tracker/releases/1.0.0)" release_kept

echo "== jobs"
jobs_ready() { dc exec -T jobs node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
check "jobs GET /readyz -> 200" jobs_ready
today_partition() {
  local p="api_metrics_1m_$(date -u +%Y%m%d)"
  for _ in $(seq 1 60); do
    [[ "$(psqlc scf "select to_regclass('scf_part.$p') is not null")" == t ]] && return 0
    sleep 1
  done
  return 1
}
check "partitions job ran at start: today's api_metrics_1m partition exists" today_partition
# Jobs: the start-up run of tenant_purge (engine proxy with the jobs' provisioner certificate),
# durability_reconcile, trust_scoring and audit_anchor (file publisher on the jobshome volume) finished with success;
# registry_sync and contract_verification are disabled locally (no egress settings) and say so.
jobs_metrics() { dc exec -T jobs node -e "fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))"; }
jobs_ran() {
  local m j
  for _ in $(seq 1 90); do
    m=$(jobs_metrics 2>/dev/null || true)
    for j in tenant_purge durability_reconcile trust_scoring audit_anchor; do
      grep -qE "^scf_job_runs_total\{job=\"$j\",outcome=\"success\"\} [1-9]" <<<"$m" || continue 2
    done
    ! grep -qE '^scf_job_runs_total\{job="(tenant_purge|durability_reconcile|trust_scoring|audit_anchor)",outcome="(failure|aborted)"\} [1-9]' <<<"$m"
    return
  done
  return 1
}
check "jobs: tenant_purge, durability_reconcile, trust_scoring, audit_anchor ran at start without error" jobs_ran
check "jobs: no job_failed in the log" sh -c "! docker logs $(dc ps -q jobs) 2>&1 | grep -q '\"job_failed\"'"
check "jobs: registry_sync and contract_verification logged as job_disabled (no egress settings locally)" sh -c "
  l=\$(docker logs $(dc ps -q jobs) 2>&1 | grep job_disabled); echo \"\$l\" | grep -q registry_sync && echo \"\$l\" | grep -q contract_verification"
check "jobs: audit anchor file written to the volume" sh -c "dc_ls=\$(docker exec $(dc ps -q jobs) ls /home/node/audit-anchors); [ -n \"\$dc_ls\" ]"

echo "== metrics writer (client on the internal core network)"
tally "$(NET=core client writer || true)"

echo "== gateway: a real event through the gateway reaches Umami (tag s: scripted client, C-124)"
G_USER=0193b7e2-0000-7000-8000-0000000005f1; G_TENANT=0193b7e2-0000-7000-8000-00000000050a
G_SITE=0193b7e2-0000-7000-8000-0000000005a1; G_SITEID=SmokeIntegration000001
G_WEB=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b25a1; G_TWIN=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b25a2
psqlc scf "BEGIN;
INSERT INTO scf.users (user_id, display_name) VALUES ('$G_USER', 'smoke') ON CONFLICT DO NOTHING;
INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ('$G_TENANT', 'smoke-test', 'Smoke', 'active', '$G_USER') ON CONFLICT DO NOTHING;
INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id, visitor_id, created_by)
  VALUES ('$G_TENANT', '$G_SITE', 'site', '$G_SITEID', '$G_WEB', '$G_TWIN', 'on', '$G_USER') ON CONFLICT DO NOTHING;
INSERT INTO scf.site_domains (tenant_id, site_id, host, state, verified_at) VALUES ('$G_TENANT', '$G_SITE', 'site.test', 'verified', now()) ON CONFLICT DO NOTHING;
COMMIT; NOTIFY scf_edge; NOTIFY scf_umami;" >/dev/null && ok "fixture tenant, site and verified domain inserted" || bad "fixture rows"
# The fixture's Umami team, user, view-only key and both websites are provisioned the way every tenant's are: by
# umami_reconcile (jobs service), woken by NOTIFY scf_umami. 2026-11-13 regression: websites created by the provisioning
# admin before the tenant had a team are outside that team, the tenant's key cannot read them (401) and every live read
# silently fell back to the rollups (monitoring journey: 0 page views).
in_team() {
  local n
  for _ in $(seq 1 60); do
    n=$(psqlc umami "select count(*) from website where website_id in ('$G_WEB', '$G_TWIN') and deleted_at is null
      and team_id = '$(psqlc scf "select umami_team_id from scf.umami_credentials where tenant_id = '$G_TENANT'")'")
    [[ "$n" == 2 ]] && return 0
    sleep 2
  done
  echo "websites in the tenant's team: $n"; return 1
}
check "fixture site's main and twin websites created by umami_reconcile inside the tenant's team (live reads possible)" in_team
twin_on() { for _ in $(seq 1 30); do [[ "$(psqlc scf "select twin_provisioned_at is not null from scf.sites where site_id = '$G_SITE'")" == t ]] && return 0; sleep 1; done; return 1; }
check "twin marked provisioned (twin_provisioned_at)" twin_on
INGEST_HOST=ingest-a.example-analytics.org
PIN_HOST="$INGEST_HOST:$SCF_INGEST_PORT:127.0.0.1"  # resolve the ingest host name to the published port
check "gateway ingest port published: TLS on 127.0.0.1:$SCF_INGEST_PORT serves the tracker" \
  curl -fsS --cacert "$HERE/.secrets/pki/ca.pem" --resolve "$PIN_HOST" -o /dev/null "https://$INGEST_HOST:$SCF_INGEST_PORT/lib/1.0.0/standard.js"
# Every released version stays served with the bytes its SRI pins (tracker.intentional-upgrade): the archived 1.0.0 and 1.1.0, the current 1.2.0.
served_sri() {
  local want got
  want=$(jq -r --arg p "$2" '.files[] | select(.profile==$p) | .integrity' "$HERE/../../tracker/dist/$1/manifest.json")
  got="sha384-$(curl -fsS --cacert "$HERE/.secrets/pki/ca.pem" --resolve "$PIN_HOST" "https://$INGEST_HOST:$SCF_INGEST_PORT/lib/$1/$2.js" | openssl dgst -sha384 -binary | base64 -w0)"
  echo "manifest $want, served $got"; [[ -n "$want" && "$want" == "$got" ]]
}
for v in 1.0.0 1.1.0 1.2.0; do for pr in standard strict; do
  check "gateway serves /lib/$v/$pr.js with the bytes of its manifest SRI" served_sri "$v" "$pr"
done; done
# The gateway's own canary client (image binary), from inside the stack on `public`, trusting the dev CA.
probe() {
  docker run --rm --network "${PROJECT}_public" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$HERE/.secrets/pki/ca.pem:/pki/ca.pem:ro" --entrypoint /usr/local/bin/probe usagemap/gateway:dev \
    -hosts https://gateway:8443 -ca /pki/ca.pem -site "$G_SITEID" -origin https://site.test -source smoke -path "$1" -deadline 5s
}
probe_ok() { for _ in $(seq 1 60); do probe /smoke/gateway >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
check "gateway answers 202 to a solved challenge + event (site reached it through the signed snapshot)" probe_ok
# The probe is a Go client that claims a browser User-Agent, so the gateway's transport fingerprint (C-124) marks it
# `suspect/transport_mismatch`: stored with tag s. Real browsers get tag v (tests/e2e/web, the tracker e2e suites).
evcount() { psqlc umami "select count(*) from website_event where website_id = '$G_WEB' and url_path = '/smoke/gateway' and tag = 's'"; }
ev_stored() { for _ in $(seq 1 30); do [[ "$(evcount)" -ge 1 ]] && return 0; sleep 1; done; return 1; }
check "the event is stored in Umami with tag s (gateway -> engine proxy -> Umami; scripted client = suspect)" ev_stored
tm_count() { psqlc scf "select coalesce(sum(count), 0) from scf.web_edge_counters where site_id = '$G_SITE' and counter = 'reason' and label = 'transport_mismatch'"; }
tm_counted() { for _ in $(seq 1 90); do [[ "$(tm_count)" -ge 1 ]] && return 0; sleep 1; done; return 1; }
check "its reason is transport_mismatch (Go TLS stack claiming Chrome; counter record delivered to the control plane)" tm_counted

echo "== API path: gateway OTLP front door -> Collector (private otlp network) -> writer (mTLS) -> PostgreSQL"
otlp_client() {  # on the private otlp network, playing the gateway (C-130)
  docker run --rm --network "${PROJECT}_otlp" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user 65532:65532 -v "$HERE/.secrets/pki/ca.pem:/pki/ca.pem:ro" -v "$HERE/scripts/smoke-client.mjs:/smoke-client.mjs:ro" \
    "$NODE_IMAGE" node /smoke-client.mjs otlp "$@"
}
minted="$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 65532:65532 \
  -v "$HERE/.secrets/pki/ca.pem:/pki/ca.pem:ro" -v "$HERE/.secrets/pepper_ing:/run/pepper:ro" \
  -v "$HERE/scripts/smoke-client.mjs:/smoke-client.mjs:ro" "$NODE_IMAGE" node /smoke-client.mjs mint-ing)"
read -r ING_KEY ING_ID ING_LAST4 ING_HASH <<<"$minted"
psqlc scf "INSERT INTO scf.ingest_tokens (tenant_id, token_id, secret_hash, pepper_version, last4, label, created_by)
  VALUES ('$G_TENANT', '$ING_ID', decode('$ING_HASH', 'hex'), 1, '$ING_LAST4', 'smoke', '$G_USER'); NOTIFY scf_edge;" >/dev/null \
  && ok "ingest token seeded (HMAC with the shared pepper_ing)" || bad "ingest token seeded"
tally "$(docker run --rm --network "${PROJECT}_public" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 65532:65532 \
  -v "$HERE/.secrets/pki/ca.pem:/pki/ca.pem:ro" -v "$HERE/scripts/smoke-client.mjs:/smoke-client.mjs:ro" \
  "$NODE_IMAGE" node /smoke-client.mjs otlp-door "$ING_KEY" || true)"
# Then the Collector directly with the gateway's metadata (level L1: the fixture tenant is L0, whose one-service
# limit the front-door service above already uses; scf.tenant.level must lift it, C-116).
tally "$(otlp_client "$G_TENANT" || true)"
rows() { psqlc scf "select coalesce(sum(m.request_count), 0) from scf.api_metrics_1m m join scf.api_services s using (tenant_id, service_id)
  where m.tenant_id = '$G_TENANT' and s.service_name = '$1' and s.registration = 'auto'"; }
rows_stored() { for _ in $(seq 1 45); do [[ "$(rows "$1")" == 3 ]] && return 0; sleep 1; done; echo "request_count $(rows "$1")"; return 1; }
check "Collector-direct point stored: auto-registered service, 3 requests in api_metrics_1m" rows_stored smoke-svc
check "front-door point stored: token -> gateway -> Collector -> writer -> 3 requests in api_metrics_1m" rows_stored smoke-door
check "no tenant-supplied attribute stored (host.name / client.address canaries)" test \
  "$(dc exec -T -e PGPASSWORD="$PGPW" postgres pg_dump -U postgres -d scf --data-only | grep -cE 'CANARY-HOST|203\.0\.113\.9')" = 0

echo "== engine proxy restart: the gate is re-checked at start; the bootstrap is restartable"
dc restart engine-proxy >/dev/null 2>&1
for _ in $(seq 1 30); do [[ "$(state engine-proxy)" == "running 0 healthy" ]] && break; sleep 1; done
sleep 3
tally "$(client after-restart || true)"
steps=$(dc run --rm --no-deps umami-bootstrap 2>&1 | grep -o '"steps":"[^"]*"' || true)
check "bootstrap re-run is a no-op (P1,B5): $steps" test "$steps" = '"steps":"P1,B5"'

echo "== privacy"
no_secrets_in_proxy_logs() { ! dc logs --no-color engine-proxy 2>&1 | grep -qE '2001:db8|Mozilla|startAt|Bearer|"cache"|([0-9]{1,3}\.){3}[0-9]{1,3}'; }
check "engine proxy logs: no surrogate, IP, UA, query string or token" no_secrets_in_proxy_logs
no_secrets_in_app_logs() { ! dc logs --no-color gateway metrics-writer collector jobs control-plane portal 2>&1 | grep -qE "Mozilla/|2001:db8:|Bearer |CANARY-HOST|203\.0\.113\.9|${ING_KEY:-scfa_ing_none}"; }
# health_endpoint (C-121): derived from the edge nodes' counter reports, so it answers 503 (`down`) until edge-a1 has
# sent its first report (counter period 1 min); by now the gateway has been up for minutes.
health_ok() {
  for _ in $(seq 1 60); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$CPURL/public/v1/health")" == 200 ]] && return 0
    sleep 3
  done
  curl -s "$CPURL/public/v1/health"; return 1
}
check "control plane GET /public/v1/health -> 200 once edge-a1 has reported (health_endpoint)" health_ok
snapshot_expiry() {
  local p
  p=$(psqlc scf "select convert_from(envelope, 'UTF8') from scf.edge_snapshots order by sequence desc limit 1" | jq -r .payload | tr '_-' '/+')
  while (( ${#p} % 4 )); do p+="="; done
  base64 -d <<<"$p" | jq -e '(.expires_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - (.issued_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) == 86400' >/dev/null
}
check "edge snapshot signed by the jobs service carries expires_at = issued_at + 24 h (F12)" snapshot_expiry
jobs_workers_ran() {
  local m w
  for _ in $(seq 1 30); do
    m=$(jobs_metrics 2>/dev/null || true)
    for w in edge_snapshot umami_reconcile domain_verification erasure public_metrics traction_snapshot_sign; do
      grep -qE "^scf_job_runs_total\{job=\"$w\",outcome=\"success\"\} [1-9]" <<<"$m" || continue 2
    done
    return 0
  done
  return 1
}
check "jobs: the core workers moved from the control plane ran with success (F16)" jobs_workers_ran
check "gateway, writer, Collector, jobs, control plane, portal logs: no UA, surrogate, token or canary" no_secrets_in_app_logs
no_surrogate_in_umami() { [ "$(dc exec -T -e PGPASSWORD="$PGPW" postgres pg_dump -U postgres -d umami --data-only | grep -c '2001:db8')" = 0 ]; }
check "Umami's database stores no surrogate address (pg_dump scan)" no_surrogate_in_umami

echo "== range lists (bot.ip-multiplicity, C-38)"
# The gateway reads compose.dev.yaml's test lists (documentation ranges) from GW_RANGELISTS_DIR; the weekly download
# (rangelist-updater, compose.yaml) is off in the local stacks. Gateway metrics through jobs, which shares `core`.
gw_rangelists() { dc exec -T jobs node -e "fetch('http://edge-a1:9464/metrics').then(r=>r.text()).then(t=>process.exit(/scf_gateway_rangelist_entries\{class=\"datacenter\"\} 2\b/.test(t)&&/scf_gateway_rangelist_entries\{class=\"tor\"\} 1\b/.test(t)&&/scf_gateway_rangelist_entries\{class=\"relay\"\} 1\b/.test(t)?0:1),()=>process.exit(1))"; }
check "gateway loaded the test range lists (datacenter 2, tor 1, relay 1 entries)" gw_rangelists
check "no range-list download in the local stack (rangelist-updater not started)" test -z "$(state rangelist-updater)"

echo "== on-chain, dev origins, seal"
for s in dev-settings onchain-fixture; do check "one-shot $s exited 0" test "$(state $s)" = "exited 0 "; done
check "setting edge_counter_features = [\"props\", \"dev\"] (dev-settings, C-137)" test \
  "$(psqlc scf "select value = '[\"props\",\"dev\"]'::jsonb from scf.settings where key = 'edge_counter_features'")" = t
# The capability flag the edge snapshot carries (wire-formats §e.3): what the gateways are told the core accepts.
snapshot_payload() {
  local p
  p=$(psqlc scf "select convert_from(envelope, 'UTF8') from scf.edge_snapshots order by sequence desc limit 1" | jq -r .payload | tr '_-' '/+')
  while (( ${#p} % 4 )); do p+="="; done
  base64 -d <<<"$p"
}
features() { snapshot_payload 2>/dev/null | jq -r '(.settings.counter_features // []) | join(",")' 2>/dev/null; }
FEATURES=""
for _ in $(seq 1 30); do FEATURES=$(features); [[ -n "$FEATURES" ]] && break; sleep 2; done
check "the edge snapshot advertises counter_features dev,props (wire-formats §e.3)" test "$FEATURES" = "dev,props"

echo "-- on-chain correlation over the fixture mirror (plan A1; ledger files primary, C-136)"
SMOKE_C=$(dc logs --no-color onchain-fixture 2>/dev/null | grep -o '"smoke-contract":"C[A-Z2-7]\{55\}"' | tail -n1 | cut -d'"' -f4)
SMOKE_X=$(dc logs --no-color onchain-fixture 2>/dev/null | grep -o '"smoke-conflict":"C[A-Z2-7]\{55\}"' | tail -n1 | cut -d'"' -f4)
check "onchain-fixture printed the strkeys of its contracts" test -n "$SMOKE_C" -a -n "$SMOKE_X"
check "jobs: onchain_correlation enabled (mirror mounted read-only at SCF_ONCHAIN_LEDGER_DIR, not job_disabled)" sh -c "
  ! docker logs $(dc ps -q jobs) 2>&1 | grep job_disabled | grep -q onchain_correlation &&
  [ \"\$(docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/srv/ledgers\"}}{{.RW}}{{end}}{{end}}' $(dc ps -q jobs))\" = false ]"
YDAY=$(date -u -d yesterday +%F)
reader_counts() {
  local l
  l=$(dc exec -T jobs /usr/local/bin/onchain-reader -network testnet -contract "$SMOKE_C" -from-day "$YDAY" -to-day "$YDAY" /srv/ledgers 2>/dev/null)
  echo "reader: $l"
  jq -e --arg d "$YDAY" '.day == $d and .invocations == 3 and .successful_invocations == 2 and .distinct_invokers == 2
    and .complete == true and .ledgers_in_day == 48 and .data_source == "ledger_files"' <<<"$l" >/dev/null
}
check "the reader in the jobs image counts yesterday from the mirror: 3 invocations, 2 successful, 2 invokers, complete" reader_counts
reader_no_identity() { ! dc exec -T jobs /usr/local/bin/onchain-reader -network testnet -contract "$SMOKE_C" /srv/ledgers 2>&1 | grep -qE 'G[A-Z2-7]{55}|M[A-Z2-7]{68}'; }
check "the reader's output and summary carry no account address" reader_no_identity
# Opt the fixture tenant in, with one verified contract and one verified contract in conflict (C-137: verified for two
# tenants, counted for neither), then restart jobs so onchain_correlation runs at start for the last 3 days.
EV=$(psqlc scf "INSERT INTO scf.verification_evidence (tenant_id, kind, subject, status)
  VALUES ('$G_TENANT', 'stellar_account', 'GSMOKE$(printf 'A%.0s' $(seq 1 50))', 'valid') RETURNING evidence_id" | head -n1)
psqlc scf "UPDATE scf.tenants SET onchain_correlation_enabled = true WHERE tenant_id = '$G_TENANT';
  INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by, status, verified_role, verified_by_evidence, verified_at, conflict_since)
  VALUES ('$G_TENANT', '$SMOKE_C', 'testnet', '$G_USER', 'verified', 'deployer', '$EV', now(), NULL),
         ('$G_TENANT', '$SMOKE_X', 'testnet', '$G_USER', 'verified', 'deployer', '$EV', now(), now())" >/dev/null \
  && ok "fixture tenant opted in with a verified contract and a verified contract in conflict" || bad "on-chain fixture rows"
dc restart jobs >/dev/null 2>&1
for _ in $(seq 1 60); do [[ "$(state jobs)" == "running 0 healthy" ]] && break; sleep 2; done
ONCHAIN_ROWS="select count(*) filter (where o.invocations = 3 and o.successful_invocations = 2 and o.distinct_invokers = 2
    and o.data_source = 'ledger_files' and o.day between current_date - 3 and current_date - 1)
  from scf.onchain_daily o join scf.declared_contracts c using (tenant_id, contract_ref) where c.contract_id = '$SMOKE_C'"
onchain_stored() { for _ in $(seq 1 60); do [[ "$(psqlc scf "$ONCHAIN_ROWS")" == 3 ]] && return 0; sleep 2; done; psqlc scf "$ONCHAIN_ROWS"; return 1; }
check "onchain_correlation stored the last 3 complete days for the verified contract (3/2/2 each, ledger_files)" onchain_stored
check "a contract in conflict is counted for nobody (C-137)" test \
  "$(psqlc scf "select count(*) from scf.onchain_daily o join scf.declared_contracts c using (tenant_id, contract_ref) where c.contract_id = '$SMOKE_X'")" = 0

echo "-- dev origins and the Stellar event property rollup (counter-record parts: snapshot counter_features = [${FEATURES}])"
psqlc scf "UPDATE scf.sites SET dev_origins = '{localhost}' WHERE site_id = '$G_SITE'; NOTIFY scf_edge;" >/dev/null
# A 202 says nothing (every well-formed batch gets one, C-39): wait until the gateway has applied the snapshot that
# carries the dev origin, i.e. until /v1/c from http://localhost:5173 answers with `X-Scf-Debug: … class=dev` (§a.5).
dev_recognised() {
  for _ in $(seq 1 90); do
    curl -sS --cacert "$HERE/.secrets/pki/ca.pem" --resolve "$PIN_HOST" -D - -o /dev/null \
      -H 'Origin: http://localhost:5173' -H 'Content-Type: text/plain' \
      --data "{\"v\":1,\"s\":\"$G_SITEID\",\"p\":\"standard\",\"tv\":\"1.2.0\"}" \
      "https://$INGEST_HOST:$SCF_INGEST_PORT/v1/c" 2>/dev/null | grep -qi '^x-scf-debug: v=1; class=dev; reasons=dev_origin' && return 0
    sleep 1
  done
  return 1
}
check "gateway classifies http://localhost:5173 as a dev origin of the site (X-Scf-Debug class=dev on /v1/c)" dev_recognised
dev_probe() {
    docker run --rm --network "${PROJECT}_public" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      -v "$HERE/.secrets/pki/ca.pem:/pki/ca.pem:ro" --entrypoint /usr/local/bin/probe usagemap/gateway:dev \
    -hosts https://gateway:8443 -ca /pki/ca.pem -site "$G_SITEID" -origin http://localhost:5173 -source smoke -path /smoke/dev -deadline 5s
}
check "gateway answers 202 to an event from a dev origin (localhost)" dev_probe
DEV_ROW="select count(*) from scf.web_dev_events where site_id = '$G_SITE' and kind = 'pageview' and path_class = '/smoke/dev'"
dev_buffered() { for _ in $(seq 1 90); do [[ "$(psqlc scf "$DEV_ROW")" -ge 1 ]] && return 0; sleep 1; done; return 1; }
check "the dev event is in the first-event buffer (web_dev_events, pageview /smoke/dev)" dev_buffered
check "a dev-origin event is not counted: nothing in Umami for /smoke/dev" test \
  "$(psqlc umami "select count(*) from website_event where url_path = '/smoke/dev'")" = 0
tally "$(NET=public client stellar-event "$G_SITEID" || true)"
PROPS="select coalesce(sum(count), 0) from scf.web_event_property_daily where site_id = '$G_SITE' and event_name = 'wallet_connect'
  and network = 'testnet' and prop_key = '_total' and prop_value = 'all'"
props_stored() { for _ in $(seq 1 90); do [[ "$(psqlc scf "$PROPS")" -ge 1 ]] && return 0; sleep 1; done; return 1; }
check "the wallet event lands in the property rollup (web_event_property_daily, wallet_connect/_total)" props_stored

echo "-- public seal and snapshot list endpoints (wire-formats §i.3, §m.2)"
SEAL_URL="$CPURL/public/v1/seals?start=$(date -u -d '7 days ago' +%F)T00:00:00Z&end=$(date -u +%F)T00:00:00Z"
seals_ok() {
  local body
  body=$(curl -fsS "$SEAL_URL") || return 1
  jq -e '.network.name and (.days | type == "array") and (.statement | test("not show that the numbers are genuine"))' <<<"$body" >/dev/null
}
check "GET /public/v1/seals -> 200 with network, days and the tamper-evidence statement" seals_ok
LIST_URL="$CPURL/public/v1/projects/smoke-test/snapshots"
# No listed snapshot yet: 404, the same answer as for an unknown slug (no slug-existence oracle; §i.3.3, C-138).
check "GET /public/v1/projects/smoke-test/snapshots -> 404 while the project has no signed snapshot" test \
  "$(curl -s -o /dev/null -w '%{http_code}' "$LIST_URL")" = 404
check "GET /public/v1/projects/no-such-project/snapshots -> 404 (same answer)" test \
  "$(curl -s -o /dev/null -w '%{http_code}' "$CPURL/public/v1/projects/no-such-project/snapshots")" = 404
# Request a v2 snapshot of the last 7 whole days as createTractionSnapshot records it; job public_metrics (the only
# signer, F16) computes, signs and numbers it (series seq 1).
psqlc scf "INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end, include_api, schema_version, preset)
  VALUES ('$G_TENANT', uuidv7(), '$G_USER', date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '7 days',
          date_trunc('day', now() at time zone 'utc') at time zone 'utc', true, 2, 'custom');
  NOTIFY scf_snapshot;" >/dev/null && ok "v2 traction snapshot requested for the fixture tenant" || bad "traction snapshot request"
snapshot_listed() {
  local body
  for _ in $(seq 1 90); do
    body=$(curl -fsS "$LIST_URL" 2>/dev/null) && jq -e '.schema == "scf-analytics/snapshot-list/1" and .project.slug == "smoke-test"
      and (.snapshots | length) == 1 and .snapshots[0].seq == 1 and .snapshots[0].previous_sha256 == null
      and .snapshots[0].schema_version == 2 and .snapshots[0].status == "valid"' <<<"$body" >/dev/null && return 0
    sleep 1
  done
  echo "list: ${body:-none}"; return 1
}
check "GET /public/v1/projects/smoke-test/snapshots -> 200 once signed: snapshot-list/1 with seq 1, previous_sha256 null, v2" snapshot_listed

echo
echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
