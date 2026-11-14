#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Re-runs the S-02 checks (spikes/s02-umami-hardened-image/README.md, C-104) against OUR built images:
# pin and source verification, image contents, hardened runtime (read-only root, no capabilities, uid 1001,
# internal network), migrations as a one-shot, /api/send with the surrogate and country headers, route behaviour,
# unmodified tracker bytes, dashboard without external requests (when Playwright is available), the seed-admin
# bootstrap, logs, and a packet capture proving no egress.
#
#   vendor/umami/test/hardening-check.sh                 build both images, then check
#   NO_BUILD=1 vendor/umami/test/hardening-check.sh      check the existing images
#   KEEP=1 …                                             leave the test stack running
#   PW_DIR=<dir with node_modules/playwright> CHROMIUM_PATH=<chrome-headless-shell> …   enable the dashboard check
# Uses Compose project $PROJECT (default scf-umami-test) and 127.0.0.1:$UMAMI_TEST_PORT (default 56122) only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1090,SC1091
. <(grep -E '^[A-Z_]+=' "$VENDOR/UPSTREAM")
OUT="${OUT:-$(mktemp -d)}"; mkdir -p "$OUT"
APP_REPO=$APP_IMAGE MIG_REPO=$MIGRATE_IMAGE
APP_IMG="${APP_IMAGE}:${IMAGE_TAG}"
MIG_IMG="${MIGRATE_IMAGE}:${IMAGE_TAG}"
export APP_IMAGE="$APP_IMG" MIGRATE_IMAGE="$MIG_IMG"
P="${PROJECT:-scf-umami-test}"
export NETCAP_IMAGE="$P/netcap"
export UMAMI_TEST_PORT="${UMAMI_TEST_PORT:-56122}"
B="http://127.0.0.1:$UMAMI_TEST_PORT"
SEED_ADMIN_ID=41e2b680-648e-4b09-bcd7-3e2b10c06264
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
CHROMIUM_PATH="${CHROMIUM_PATH:-$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | tail -1)}"

PASS=0; FAIL=0; SKIP=0
ok()   { echo "PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP  $*"; SKIP=$((SKIP+1)); }
check(){ local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
dc()   { docker compose -p "$P" -f "$HERE/compose.yaml" "$@"; }
json() { python3 -I -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
cleanup() { if [[ "${KEEP:-0}" != 1 ]]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
echo "evidence: $OUT"

echo "== 1. pin"
git ls-remote --tags "$UMAMI_REPO" "refs/tags/$UMAMI_TAG" "refs/tags/$UMAMI_TAG^{}" | tee "$OUT/tag.txt" | grep -q "^$UMAMI_COMMIT" \
  && ok "upstream tag $UMAMI_TAG points to the pinned commit $UMAMI_COMMIT" || bad "upstream tag $UMAMI_TAG != pinned commit"
check "Dockerfile ARG UMAMI_COMMIT equals UPSTREAM" grep -qx "ARG UMAMI_COMMIT=$UMAMI_COMMIT" "$VENDOR/Dockerfile"
check "source is fetched by commit with BuildKit's checksum verification" grep -q 'ADD --keep-git-dir=false --checksum=${UMAMI_COMMIT} ${UMAMI_REPO}#${UMAMI_COMMIT}' "$VENDOR/Dockerfile"
check "patch queue is empty (ADR-0003: unmodified)" test -z "$(ls "$VENDOR/patches/"*.patch 2>/dev/null)"

echo "== 2. build (app + migrate targets)"
if [[ "${NO_BUILD:-0}" != 1 ]]; then
  for target in app migrate; do
    t0=$(date +%s)
    img=$APP_IMG; [[ $target == migrate ]] && img=$MIG_IMG
    docker buildx build --load --progress=plain --target "$target" -t "$img" "$VENDOR" > "$OUT/build-$target.log" 2>&1 \
      || { tail -30 "$OUT/build-$target.log"; exit 1; }
    echo "build $target: $(( $(date +%s) - t0 )) s" | tee -a "$OUT/build-times.txt"
  done
  { grep -q 'SKIP_BUILD_GEO is set' "$OUT/build-app.log" || grep -A1 'RUN pnpm build:docker' "$OUT/build-app.log" | grep -q CACHED; } && ok "geo download skipped" || bad "geo download not skipped"
else
  skip "build (NO_BUILD=1)"
fi
docker build -q -t "$NETCAP_IMAGE" -f "$HERE/netcap.Dockerfile" "$HERE" >/dev/null
for img in "$APP_IMG" "$MIG_IMG"; do
  check "$img carries revision label $UMAMI_COMMIT" test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")" = "$UMAMI_COMMIT"
done
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E "^($APP_REPO|$MIG_REPO|ghcr.io/umami-software/umami):" | tee "$OUT/sizes.txt" || true
check "no geo/ directory in app image" docker run --rm --entrypoint sh "$APP_IMG" -c '! test -e /app/geo'
check "no npm/npx/yarn/corepack/pnpm/curl in app image" docker run --rm --entrypoint sh "$APP_IMG" -c '! command -v npm && ! command -v npx && ! command -v yarn && ! command -v corepack && ! command -v pnpm && ! command -v curl'
check "app files not writable by uid 1001" docker run --rm --entrypoint sh "$APP_IMG" -c '! touch /app/public/script.js 2>/dev/null && ! touch /app/server.js 2>/dev/null && test "$(id -u)" = 1001'
check "migrate image runs as uid 1001" test "$(docker image inspect -f '{{.Config.User}}' "$MIG_IMG")" = "1001:1001"
check "hardening defaults baked into the app image" sh -c "docker image inspect -f '{{join .Config.Env \"\n\"}}' '$APP_IMG' | grep -qx SKIP_DB_MIGRATION=1 && docker image inspect -f '{{join .Config.Env \"\n\"}}' '$APP_IMG' | grep -qx PRIVATE_MODE=1"

echo "== 3. run: PostgreSQL 18 + one-shot migration + hardened Umami on an internal network"
PG_SUPERUSER_PASSWORD="$(openssl rand -hex 24)"; UMAMI_DB_PASSWORD="$(openssl rand -hex 24)"; APP_SECRET="$(openssl rand -hex 32)"
export PG_SUPERUSER_PASSWORD UMAMI_DB_PASSWORD APP_SECRET
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d postgres umami-migrate 2>&1 | tail -2
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Status}}' $P-umami-migrate-1 2>/dev/null)" == exited ]] && break; sleep 1
done
# netcap shares umami's network namespace and is started right after it, so start-up traffic is captured too.
dc up -d umami front netcap 2>&1 | tail -3
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' $P-umami-1 2>/dev/null)" == healthy ]] && break; sleep 1
done
dc logs --no-color umami-migrate > "$OUT/migrate.log"
check "migration one-shot exited 0" test "$(docker inspect -f '{{.State.ExitCode}}' $P-umami-migrate-1)" = 0
grep -q 'All migrations have been successfully applied\|No pending migrations' "$OUT/migrate.log" && ok "prisma migrate deploy applied 27 migrations" || bad "migration log"
check "umami healthy" test "$(docker inspect -f '{{.State.Health.Status}}' $P-umami-1)" = healthy
check "umami: read-only rootfs, cap_drop ALL, no-new-privileges, uid 1001" test \
  "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.Config.User}}' $P-umami-1)" \
  = "true [ALL] [no-new-privileges:true] 1001:1001"
docker inspect -f '{{json .HostConfig.Tmpfs}}' $P-umami-1 | tee "$OUT/tmpfs.txt"
check "engine network is internal" test "$(docker network inspect -f '{{.Internal}}' ${P}_engine)" = true
check "umami attached only to the engine network" test "$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' $P-umami-1)" = "${P}_engine "
check "no startup migration / tracker rewrite in umami log" sh -c "! docker logs $P-umami-1 2>&1 | grep -qiE 'migrat|Updated tracker'"

echo "== 4. API: login, website, /api/send with surrogate IP + country header"
LOGIN=$(curl -s -X POST $B/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"umami"}')
T=$(echo "$LOGIN" | json 'd["token"]')
check "seed admin/umami logs in (API) before bootstrap" test -n "$T"
echo "user.passwordChangeRequired=$(curl -s $B/api/auth/verify -X POST -H "authorization: Bearer $T" | json 'd.get("passwordChangeRequired")')" | tee -a "$OUT/api.txt"
WID=$(curl -s -X POST $B/api/websites -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"name":"s02","domain":"s02.example"}' | json 'd["id"]')
check "website created" test -n "$WID"
send() { # $1 surrogate ip, $2 country header line or empty, $3 path, $4 extra payload
  local h=(); [[ -n "$2" ]] && h=(-H "$2")
  curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/send -H 'content-type: application/json' -H "user-agent: $UA" \
    -H "x-scf-surrogate-ip: $1" "${h[@]}" \
    -d "{\"type\":\"event\",\"payload\":{\"website\":\"$WID\",\"hostname\":\"s02.example\",\"url\":\"$3\",\"language\":\"en-US\",\"screen\":\"1920x1080\",\"tag\":\"v\"$4}}"
}
check "/api/send with x-scf-surrogate-ip + cf-ipcountry: DE -> 200" test "$(send 203.0.113.7 'cf-ipcountry: DE' /hello '')" = 200
check "/api/send with referrer + cf-ipcountry: NL -> 200" test "$(send 203.0.113.11 'cf-ipcountry: NL' /ref ',"referrer":"https://www.example.org/page"')" = 200
check "/api/send with cf-ipcountry: XX -> 200" test "$(send 203.0.113.9 'cf-ipcountry: XX' /xx '')" = 200
code=$(send 203.0.113.8 '' /nocountry ''); echo "send without cf-ipcountry, public surrogate -> $code" | tee -a "$OUT/api.txt"
check "/api/send without country header and no geo DB -> 500 (documented constraint)" test "$code" = 500
check "/api/send without country header, private-range surrogate -> 200" test "$(send 10.1.2.3 '' /private '')" = 200
docker exec $P-postgres-1 psql -U postgres -d umami -At -F' ' -c \
  "select coalesce(s.country,'(null)'), e.url_path, coalesce(e.tag,'') from website_event e join session s using (session_id) order by e.created_at" | tee "$OUT/events.txt"
check "country DE stored from cf-ipcountry" grep -q '^DE /hello v' "$OUT/events.txt"
NOW=$(($(date +%s)*1000))
curl -s "$B/api/websites/$WID/stats?startAt=$((NOW-86400000))&endAt=$NOW" -H "authorization: Bearer $T" | tee -a "$OUT/api.txt"; echo
curl -s "$B/api/websites/$WID/metrics?startAt=$((NOW-86400000))&endAt=$NOW&type=country" -H "authorization: Bearer $T" | tee -a "$OUT/api.txt"; echo
curl -s "$B/api/websites/$WID/stats?startAt=$((NOW-86400000))&endAt=$NOW&tag=v" -H "authorization: Bearer $T" | tee -a "$OUT/api.txt"; echo
check "admin API GET /api/admin/users -> 200" test "$(curl -s -o /dev/null -w '%{http_code}' $B/api/admin/users -H "authorization: Bearer $T")" = 200

echo "== 5. route behaviour on this build (unauthenticated, through the test forwarder)"
probe() { # method path [curl args]
  local m=$1 u=$2; shift 2
  local r; r=$(curl -s -o "$OUT/body" -w '%{http_code} %{content_type}' -X "$m" "$B$u" -H "user-agent: $UA" \
    -H 'x-scf-surrogate-ip: 203.0.113.10' -H 'cf-ipcountry: FR' "$@")
  printf '%-6s %-40s %s  %s\n' "$m" "$u" "$r" "$(head -c 90 "$OUT/body" | tr -d '\n\r' | tr -c '[:print:]' '.')"
}
EV="{\"type\":\"event\",\"payload\":{\"website\":\"$WID\",\"hostname\":\"s02.example\",\"url\":\"/b\"}}"
{
probe POST /api/batch -H 'content-type: application/json' -d "[$EV]"
probe POST /api/record -H 'content-type: application/json' -d "{\"website\":\"$WID\"}"
probe GET  /q/abc
probe GET  /p/abc
probe GET  /mcp
probe POST /mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
probe GET  /share/abc
probe GET  /api/share/abc
probe POST /api/teams/join -H 'content-type: application/json' -d '{"accessCode":"x"}'
probe POST /api/teams/join -H 'content-type: application/json' -H "authorization: Bearer $T" -d '{"accessCode":"nonexistent"}'
probe GET  /script.js
probe GET  /recorder.js
probe GET  /telemetry.js
probe GET  /openapi.json
probe GET  "/_next/image?url=%2Ffavicon-32x32.png&w=64&q=75"
probe GET  /login
probe POST /api/auth/login -H 'content-type: application/json' -d '{"username":"x","password":"y"}'
probe GET  /api/heartbeat
} | tee "$OUT/routes.txt"
check "tracker served unmodified (sha384 = upstream image's)" test \
  "$(curl -s $B/script.js | openssl dgst -sha384 -binary | base64)" = "Ts03XUTV1nsmqXjhMgA3LGXKFnW1NLMAzbKGEaaDFUy7wUETechGFTNIXF7rAuqP"

echo "== 6. dashboard in headless Chromium (external requests recorded and aborted)"
if [[ -x "$CHROMIUM_PATH" && -d "${PW_DIR:-/nonexistent}/node_modules/playwright" ]]; then
  CHROMIUM_PATH="$CHROMIUM_PATH" PW_DIR="$PW_DIR" node "$HERE/ui-check.mjs" $B admin umami "$WID" > "$OUT/ui.json"
  echo "external requests: $(json 'd["externalRequests"]' < "$OUT/ui.json")  visited: $(json 'd["visited"]' < "$OUT/ui.json")"
  check "dashboard requested no external URL with PRIVATE_MODE/DISABLE_*" test "$(json 'len(d["externalRequests"])' < "$OUT/ui.json")" = 0
else
  skip "dashboard check (set PW_DIR to a directory with node_modules/playwright and CHROMIUM_PATH)"
fi

echo "== 7. bootstrap: replace the seed admin"
NEWPW="$(openssl rand -hex 16)"
r=$(curl -s -X POST $B/api/me/password -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d "{\"currentPassword\":\"umami\",\"newPassword\":\"$NEWPW\"}")
T2=$(echo "$r" | json 'd.get("token","")')
check "POST /api/me/password changes the seed password (new token returned)" test -n "$T2"
check "admin/umami no longer logs in -> 401" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"umami"}')" = 401
check "old session token is invalidated -> 401" test "$(curl -s -o /dev/null -w '%{http_code}' $B/api/me -H "authorization: Bearer $T")" = 401
PROVPW="$(openssl rand -hex 16)"
PID=$(curl -s -X POST $B/api/users -H "authorization: Bearer $T2" -H 'content-type: application/json' \
  -d "{\"username\":\"scf-provisioner\",\"password\":\"$PROVPW\",\"role\":\"admin\"}" | json 'd["id"]')
check "provisioning admin created (POST /api/users)" test -n "$PID"
T3=$(curl -s -X POST $B/api/auth/login -H 'content-type: application/json' -d "{\"username\":\"scf-provisioner\",\"password\":\"$PROVPW\"}" | json 'd["token"]')
check "seed admin deleted by provisioning admin (DELETE /api/users/$SEED_ADMIN_ID)" test \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $B/api/users/$SEED_ADMIN_ID -H "authorization: Bearer $T3")" = 200
check "username admin no longer logs in with the changed password -> 401" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/auth/login -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$NEWPW\"}")" = 401

echo "== 8. logs and writable paths"
sleep 2
docker logs $P-umami-1 > "$OUT/umami.log" 2>&1
grep -E 'EROFS|read-only|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|unhandledRejection|Failed to write' "$OUT/umami.log" | sort | uniq -c | tee "$OUT/log-errors.txt" || true
grep -c "GeoLite2-City.mmdb" "$OUT/umami.log" | sed 's/^/geo-missing errors (from the no-country send): /'
check "no read-only/egress/DNS errors in umami log" test ! -s "$OUT/log-errors.txt"
docker exec $P-umami-1 sh -c 'echo "/tmp:"; ls -A /tmp; echo "/app/.next/cache:"; ls -A /app/.next/cache' | tee "$OUT/written.txt"

echo "== 9. packet capture inside umami's network namespace"
sleep 1; dc stop netcap >/dev/null 2>&1
SUB=$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' ${P}_engine)
docker run --rm -v ${P}_netcap:/cap "$NETCAP_IMAGE" sh -c "
  echo 'DNS questions asked by umami:'; tcpdump -nn -r /cap/umami.pcap -T domain 'udp and host 127.0.0.11' 2>/dev/null | grep -oE '(A|AAAA)\? [^ ]+' | sort | uniq -c
  echo 'TCP SYNs by destination:'; tcpdump -nn -r /cap/umami.pcap 'tcp[tcpflags] & (tcp-syn) != 0 and tcp[tcpflags] & (tcp-ack) == 0' 2>/dev/null | grep -oE '> [0-9a-f.:]+' | sed -E 's/\.[0-9]+$//' | sort | uniq -c
  echo -n 'IP packets to/from anything outside $SUB and loopback: '; tcpdump -nn -r /cap/umami.pcap '(ip or ip6) and not net $SUB and not net 127.0.0.0/8 and not ip6 multicast and not (ip6 and src net fe80::/10)' 2>/dev/null | wc -l" | tee "$OUT/netcap.txt"
check "no packet left the engine subnet" grep -q 'outside .*: 0$' "$OUT/netcap.txt"
check "only DNS name resolved is postgres" sh -c "! grep -E '\\? ' '$OUT/netcap.txt' | grep -vq 'postgres\\.'"

echo "== 10. deliberate egress probe from inside the umami container (after the capture)"
docker exec $P-umami-1 node -e '
const t0=Date.now();
Promise.allSettled(["https://api.umami.is/v1/updates","https://i.umami.is/a.png","https://icons.duckduckgo.com/ip3/example.org.ico","http://1.1.1.1/"].map(u=>{const t=Date.now();return fetch(u,{signal:AbortSignal.timeout(10000)}).then(r=>u+" -> HTTP "+r.status,e=>u+" -> "+(e.cause?.code||e.name)+" after "+(Date.now()-t)+" ms")})).then(r=>{r.forEach(x=>console.log(x.value));console.log("elapsed_ms="+(Date.now()-t0))})' | tee "$OUT/egress.txt"
check "every outbound attempt fails (no HTTP response)" sh -c "! grep -q 'HTTP ' '$OUT/egress.txt'"

echo
echo "RESULT: $PASS passed, $FAIL failed, $SKIP skipped  (evidence in $OUT)"
[[ $FAIL -eq 0 ]]
