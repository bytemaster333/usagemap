#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Spike S-01 — reproduces every observation in README.md with one command:  ./run.sh
# Needs: docker compose v2+, curl, jq, node (for the forged-token step), openssl.
# Evidence goes to ./out/run.log (tokens and API keys are redacted). Containers are removed at the end
# (images kept); set KEEP=1 to leave the stack running for inspection.
set -euo pipefail
cd "$(dirname "$0")"

P=scf-s01
U=http://127.0.0.1:18100          # umami (geo DB present, as shipped)
UNG=http://127.0.0.1:18101        # umami-nogeo (GEOLITE_DB_PATH -> missing file)
OUT=out; mkdir -p "$OUT"; LOG=$OUT/run.log; : >"$LOG"
export S01_APP_SECRET; S01_APP_SECRET=$(openssl rand -hex 32)   # random per run, never written to disk

dc() { docker compose -p "$P" "$@"; }
log() { printf '%s\n' "$*" | tee -a "$LOG"; }
hdr() { log ""; log "=================== $* ==================="; }
sql() { log "SQL> $1"; dc exec -T db psql -U umami -d umami -P pager=off -c "$1" 2>&1 | tee -a "$LOG"; }
sqlv() { dc exec -T db psql -U umami -d umami -At -c "$1"; }
redact() { sed -E 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/<jwt>/g; s/umami_[A-Za-z0-9]{20,}/umami_<redacted>/g; s/"token":"[^"]+"/"token":"<redacted>"/g; s/team_[A-Za-z0-9]{16}/team_<redacted>/g'; }
jwtpayload() { local p; p=$(cut -d. -f2 <<<"$1" | tr '_-' '/+'); while (( ${#p} % 4 )); do p+="="; done; base64 -d <<<"$p" 2>/dev/null; }

D=$(date -u -d yesterday +%F)        # all synthetic events are stamped on "yesterday" (UTC) ...
D1=$(date -u +%F)                    # ... except the day-boundary checks, which use today
t()  { date -u -d "$D $1" +%s; }     # t 10:55 -> unix seconds on day D
t1() { date -u -d "$D1 $1" +%s; }
RANGE="startAt=$(( $(t 00:00) * 1000 ))&endAt=$(( $(t 23:59:59) * 1000 + 999 ))&timezone=UTC"

UA_CW='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
UA_SI='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
UA_UNK='Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/0.0'

# send BASE WEBSITE SURROGATE COUNTRY UA TS TAG URL [NAME] [CACHE] [EXTRA_PAYLOAD_JSON]
#   "-" means "omit". Sets LAST_CODE, LAST_BODY, LAST_CACHE, LAST_SID, LAST_VID.
send() {
  local base=$1 site=$2 surr=$3 cc=$4 ua=$5 ts=$6 tag=$7 url=$8 name=${9:--} cache=${10:--} extra=${11:-'{}'}
  local payload h=(-H 'content-type: application/json' -A "$ua")
  payload=$(jq -cn --arg w "$site" --arg u "$url" --arg tag "$tag" --arg ts "$ts" --arg n "$name" --argjson x "$extra" '
    {website:$w, hostname:"app.example.org", url:$u, screen:"1536x864", language:"en"}
    + (if $tag=="-" then {} else {tag:$tag} end)
    + (if $ts=="-" then {} else {timestamp:($ts|tonumber)} end)
    + (if $n=="-" then {} else {name:$n} end) + $x | {type:"event", payload:.}')
  [[ $surr != - ]] && h+=(-H "x-scf-surrogate-ip: $surr")
  [[ $cc != - ]] && h+=(-H "cf-ipcountry: $cc")
  [[ $cache != - ]] && h+=(-H "x-umami-cache: $cache")
  LAST_BODY=$(curl -s -o /dev/stdout -w '\n%{http_code}' -X POST "$base/api/send" "${h[@]}" -d "$payload")
  LAST_CODE=$(tail -n1 <<<"$LAST_BODY"); LAST_BODY=$(sed '$d' <<<"$LAST_BODY")
  LAST_CACHE=$(jq -r '.cache // empty' <<<"$LAST_BODY" 2>/dev/null || true)
  LAST_SID=$(jq -r '.sessionId // empty' <<<"$LAST_BODY" 2>/dev/null || true)
  LAST_VID=$(jq -r '.visitId // empty' <<<"$LAST_BODY" 2>/dev/null || true)
  log "send surr=$surr cc=$cc ts=$ts tag=$tag url=$url name=$name cache=$([[ $cache != - ]] && echo yes || echo no) extra=$extra ua=${ua:0:40}…"
  log "  -> HTTP $LAST_CODE $(redact <<<"$LAST_BODY")"
}
# api METHOD PATH AUTH [BODY] -> prints "HTTP code" + body (redacted) to the log; body in API_BODY
api() {
  local m=$1 path=$2 auth=$3 body=${4:-}
  local a=(); [[ $auth != - ]] && a=(-H "authorization: Bearer $auth")
  if [[ -n $body ]]; then
    API_BODY=$(curl -s -w '\n%{http_code}' -X "$m" "$U$path" "${a[@]}" -H 'content-type: application/json' -d "$body")
  else
    API_BODY=$(curl -s -w '\n%{http_code}' -X "$m" "$U$path" "${a[@]}")
  fi
  API_CODE=$(tail -n1 <<<"$API_BODY"); API_BODY=$(sed '$d' <<<"$API_BODY")
  log "$m $path $( [[ -n $body ]] && redact <<<"$body" | sed -E 's/"(password|newPassword|currentPassword)":"[^"]*"/"\1":"<redacted>"/g')"
  log "  -> HTTP $API_CODE $(redact <<<"$API_BODY" | cut -c1-600)"
}

# ---------------------------------------------------------------------------------------------- up
hdr "0. start stack"
dc down -v >/dev/null 2>&1 || true
dc up -d db umami 2>&1 | tail -n2
for _ in $(seq 1 90); do curl -sf "$U/api/heartbeat" >/dev/null && break; sleep 2; done
dc --profile nogeo up -d umami-nogeo 2>&1 | tail -n1
for _ in $(seq 1 90); do curl -sf "$UNG/api/heartbeat" >/dev/null && break; sleep 2; done
log "umami image: $(docker image inspect ghcr.io/umami-software/umami:3.5.0 --format '{{index .RepoDigests 0}}')"
log "postgres: $(sqlv 'select version()' | cut -c1-40)"
log "day D=$D (events), D1=$D1"

# -------------------------------------------------------------------------------- 6 provisioning
hdr "6. provisioning (admin identity)"
api POST /api/auth/login - '{"username":"admin","password":"umami"}'
ADMIN0=$(jq -r .token <<<"$API_BODY")
log "  default admin works over the API; passwordChangeRequired=$(jq -r .user.passwordChangeRequired <<<"$API_BODY")"
api GET /api/me "$ADMIN0"
ADMIN_PW=$(openssl rand -hex 16)
api POST /api/me/password "$ADMIN0" "{\"currentPassword\":\"umami\",\"newPassword\":\"$ADMIN_PW\"}"
ADMIN=$(jq -r .token <<<"$API_BODY")
log "  old admin token after password change:"; api GET /api/me "$ADMIN0"
api POST /api/auth/login - '{"username":"admin","password":"umami"}'
api POST /api/auth/login - "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}"
ADMIN=$(jq -r .token <<<"$API_BODY"); log "  passwordChangeRequired=$(jq -r .user.passwordChangeRequired <<<"$API_BODY")"

TENANT_PW=$(openssl rand -hex 32)
api POST /api/users "$ADMIN" "{\"username\":\"scf-t-aaaa\",\"password\":\"$TENANT_PW\",\"role\":\"view-only\"}"
USER_A=$(jq -r .id <<<"$API_BODY")
USERU_PW=$(openssl rand -hex 32)   # comparison: global role "user" as written in wire-formats §j.2 P2
api POST /api/users "$ADMIN" "{\"username\":\"scf-t-cccc\",\"password\":\"$USERU_PW\",\"role\":\"user\"}"
USER_C=$(jq -r .id <<<"$API_BODY")
api POST /api/teams "$ADMIN" '{"name":"scf-t-aaaa"}'; TEAM_A=$(jq -r ".[0].id" <<<"$API_BODY")
api POST /api/teams "$ADMIN" '{"name":"scf-t-bbbb"}'; TEAM_B=$(jq -r ".[0].id" <<<"$API_BODY")
api POST "/api/teams/$TEAM_A/users" "$ADMIN" "{\"userId\":\"$USER_A\",\"role\":\"team-view-only\"}"
api POST "/api/teams/$TEAM_A/users" "$ADMIN" "{\"userId\":\"$USER_C\",\"role\":\"team-view-only\"}"
api GET "/api/teams/$TEAM_A/users" "$ADMIN"

SITE_M=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41   # main website (metrics dataset)
SITE_T=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a42   # its twin (C-73)
SITE_L=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a43   # lab website for items 1, 3, 5, 7
SITE_B=6f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41   # another tenant's website
api POST /api/websites "$ADMIN" "{\"id\":\"$SITE_M\",\"name\":\"site-m\",\"domain\":\"app.example.org\",\"teamId\":\"$TEAM_A\"}"
api POST /api/websites "$ADMIN" "{\"id\":\"$SITE_T\",\"name\":\"site-m/twin\",\"domain\":\"app.example.org\",\"teamId\":\"$TEAM_A\"}"
api POST /api/websites "$ADMIN" "{\"id\":\"$SITE_L\",\"name\":\"lab\",\"domain\":\"app.example.org\",\"teamId\":\"$TEAM_A\"}"
api POST /api/websites "$ADMIN" "{\"id\":\"$SITE_B\",\"name\":\"site-b\",\"domain\":\"b.example.org\",\"teamId\":\"$TEAM_B\"}"
api POST /api/websites "$ADMIN" "{\"id\":\"$SITE_B\",\"name\":\"dup\",\"domain\":\"b.example.org\",\"teamId\":\"$TEAM_B\"}"
api POST "/api/websites/$SITE_M" "$ADMIN" '{"name":"site-m","domain":"app.example.org"}'
api GET "/api/admin/websites?page=1&pageSize=10" "$ADMIN"
log "  admin/websites count=$(jq -r .count <<<"$API_BODY") ids=$(jq -c '[.data[].id]' <<<"$API_BODY")"

api POST /api/auth/login - "{\"username\":\"scf-t-aaaa\",\"password\":\"$TENANT_PW\"}"
TSESS=$(jq -r .token <<<"$API_BODY")
api POST /api/me/api-keys "$TSESS" '{"name":"scf-control-plane"}'
KEY=$(jq -r .key <<<"$API_BODY"); KEY_ID=$(jq -r .id <<<"$API_BODY")
log "  api key response fields: $(jq -c 'keys' <<<"$API_BODY"); key prefix: ${KEY:0:6}"
api GET /api/me/api-keys "$TSESS"
log "  -- read with the API key (own team): stats on M, L"
api GET "/api/websites/$SITE_M/stats?$RANGE" "$KEY"
log "  -- isolation: API key on another team's website, on admin/user/key-management paths, website creation"
api GET "/api/websites/$SITE_B/stats?$RANGE" "$KEY"
api GET "/api/websites/$SITE_B" "$KEY"
api GET /api/websites "$KEY"; log "  websites visible to tenant key: $(jq -c '[.data[]?.id]' <<<"$API_BODY")"
api GET "/api/teams/$TEAM_B/websites" "$KEY"
api POST /api/websites "$KEY" '{"name":"x","domain":"x.example.org"}'
api POST /api/websites "$KEY" "{\"name\":\"x\",\"domain\":\"x.example.org\",\"teamId\":\"$TEAM_A\"}"
api POST /api/websites "$TSESS" '{"name":"x","domain":"x.example.org"}'
api POST "/api/websites/$SITE_M" "$KEY" '{"name":"hacked"}'
api DELETE "/api/websites/$SITE_M" "$KEY"
api POST /api/me/api-keys "$KEY" '{"name":"via-key"}'
api GET /api/admin/websites "$KEY"
log "  -- comparison: global role 'user' + team-view-only (as in wire-formats §j.2 P2)"
api POST /api/auth/login - "{\"username\":\"scf-t-cccc\",\"password\":\"$USERU_PW\"}"; CSESS=$(jq -r .token <<<"$API_BODY")
api POST /api/websites "$CSESS" '{"name":"personal","domain":"p.example.org"}'
api POST /api/teams "$CSESS" '{"name":"own-team"}'
api POST /api/websites "$CSESS" "{\"name\":\"x\",\"domain\":\"x.example.org\",\"teamId\":\"$TEAM_A\"}"

# ------------------------------------------------------------------- 1 surrogate + country
hdr "1. surrogate + country"
S1=2001:db8:5c1f:9a2e:77d0:13ab:e4c2:b9f; S2=2001:db8:aaaa:bbbb:cccc:dddd:eeee:1; S3=2001:db8:1234:5678:9abc:def0:1111:2222
send $U $SITE_L $S1 DE "$UA_CW" "$(t 09:00)" v /a;            A_SID=$LAST_SID; A_VID=$LAST_VID
send $U $SITE_L $S1 DE "$UA_CW" "$(t 09:10)" v /b;            log "  same surrogate+UA, same hour, no token: same session=$([[ $LAST_SID == "$A_SID" ]] && echo yes || echo NO) same visit=$([[ $LAST_VID == "$A_VID" ]] && echo yes || echo NO)"
send $U $SITE_L $S1 DE "$UA_CW" "$(t 17:00)" v /c;            log "  same surrogate+UA, later hour same day: same session=$([[ $LAST_SID == "$A_SID" ]] && echo yes || echo NO) same visit=$([[ $LAST_VID == "$A_VID" ]] && echo yes || echo no)"
send $U $SITE_L $S2 FR "$UA_CW" "$(t 09:05)" v /a;            log "  other surrogate: new session=$([[ $LAST_SID != "$A_SID" ]] && echo yes || echo NO)"
send $U $SITE_L $S3 US "$UA_SI" "$(t 09:06)" s /a
send $U $SITE_L $S1 DE "$UA_SI" "$(t 09:07)" v /a;            log "  same surrogate, other UA: new session=$([[ $LAST_SID != "$A_SID" ]] && echo yes || echo NO)"
send $U $SITE_L $S1 DE "$UA_CW" "$(t1 00:10)" v /a;           log "  same surrogate+UA, next UTC day (SALT_ROTATION=day): new session=$([[ $LAST_SID != "$A_SID" ]] && echo yes || echo NO)"
send $U $SITE_L 2001:db8:0:0:0:0:0:99 XX "$UA_CW" "$(t 09:20)" v /xx-sentinel
send $U $SITE_L $S1 FR "$UA_CW" "$(t 09:21)" v /country-change;  log "  same session, later event with another country: country is a session attribute set by the first event (see table)"
log "  -- local / private / invalid surrogates with cf-ipcountry: DE"
i=0; for s in 10.1.2.3 127.0.0.1 ::1 fd00::1 fd12:3456::abcd 100.64.1.1 not-an-ip; do
  i=$((i+1)); log "  local case $i = $s"; send $U $SITE_L "$s" DE "$UA_CW" "$(t 09:30)" v "/local/$i"
done
log "  -- no country header, valid surrogate (bundled GeoLite DB present -> lookup of 2001:db8::/32)"
send $U $SITE_L 2001:db8:0:0:0:0:0:77 - "$UA_CW" "$(t 09:40)" v /nocountry
log "  -- umami-nogeo (GEOLITE_DB_PATH points at a missing file)"
send $UNG $SITE_L 2001:db8:0:0:0:0:0:78 DE "$UA_CW" "$(t 09:41)" v /nogeo-with-country
send $UNG $SITE_L 2001:db8:0:0:0:0:0:79 - "$UA_CW" "$(t 09:42)" v /nogeo-without-country
send $UNG $SITE_L 10.9.9.9 - "$UA_CW" "$(t 09:43)" v /nogeo-local-without-country
dc logs umami-nogeo 2>&1 | grep -iE 'error|enoent|mmdb' | head -n5 | tee -a "$LOG" || true
log "  -- payload.ip (we never send it): it overrides the header and disables cf-ipcountry"
send $U $SITE_L $S1 DE "$UA_CW" "$(t 09:50)" v /payload-ip-doc - - '{"ip":"2001:db8::9"}'
send $U $SITE_L $S1 DE "$UA_CW" "$(t 09:51)" v /payload-ip-public - - '{"ip":"8.8.8.8"}'
log "  -- no surrogate header at all (two different 'visitors', same UA)"
send $U $SITE_L - DE "$UA_CW" "$(t 09:55)" v /noheader-1; NH=$LAST_SID
send $U $SITE_L - FR "$UA_CW" "$(t 09:56)" v /noheader-2; log "  no header: same session for both=$([[ $LAST_SID == "$NH" ]] && echo yes || echo no)"
sql "select e.url_path, e.tag, s.country, s.region, s.city, s.browser, s.os, s.device, left(e.session_id::text,8) sid, left(e.visit_id::text,8) vid, e.created_at
     from website_event e join session s using (session_id) where e.website_id='$SITE_L' order by e.created_at, e.url_path"

# ------------------------------------------------------------------------------- 5 bot drop
hdr "5. bot drop"
before=$(sqlv "select count(*) from website_event")
send $U $SITE_L 2001:db8::b07 DE 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' "$(t 10:00)" v /bot
send $U $SITE_L 2001:db8::b07 DE 'curl/8.5.0' "$(t 10:00)" v /bot
send $U $SITE_L 2001:db8::b07 DE 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0.0.0 Safari/537.36' "$(t 10:00)" v /bot
send $U $SITE_L 2001:db8::b07 DE "$UA_CW" "$(t 10:00)" v /notbot - - '{"userAgent":"Googlebot/2.1"}'
log "  website_event rows before=$before after=$(sqlv "select count(*) from website_event")"
log "  synthetic UA templates (C-36 / wire-formats §c.3) as parsed by Umami:"
send $U $SITE_L 2001:db8::c01 DE "$UA_CW"  "$(t 10:01)" v /ua-chrome-win
send $U $SITE_L 2001:db8::c02 DE "$UA_SI"  "$(t 10:01)" v /ua-safari-ios - - '{"screen":"390x844"}'
send $U $SITE_L 2001:db8::c03 DE "$UA_UNK" "$(t 10:01)" v /ua-unknown
log "  further candidate templates (bare/unknown strings are bots for isbot):"
i=0; for ua in 'Mozilla/5.0' 'Mozilla/5.0 (Unknown)' \
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' \
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0' \
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' \
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'; do
  i=$((i+1)); send $U $SITE_L "2001:db8::c1$i" DE "$ua" "$(t 10:02)" v "/ua-probe-$i"; log "  probe $i = $ua"
done
sql "select e.url_path, s.browser, s.os, s.device, s.screen from website_event e join session s using (session_id) where e.url_path like '/ua-%' order by 1"

# ---------------------------------------------------------------------------- 3 visit continuity
hdr "3. visit continuity / cache token"
C1=2001:db8:c0:0:0:0:0:1; C2=2001:db8:c0:0:0:0:0:2; C3=2001:db8:c0:0:0:0:0:3; C4=2001:db8:c0:0:0:0:0:4
log "  A: no token, 10:55 and 11:05"
send $U $SITE_L $C1 DE "$UA_CW" "$(t 10:55)" v /3a-1; V1=$LAST_VID
send $U $SITE_L $C1 DE "$UA_CW" "$(t 11:05)" v /3a-2; log "  A: same visit=$([[ $LAST_VID == "$V1" ]] && echo yes || echo no)"
log "  B: token replayed, 10:55 -> 11:05 -> 13:30 (2h25 gap) -> 23:59"
send $U $SITE_L $C2 DE "$UA_CW" "$(t 10:55)" v /3b-1; V2=$LAST_VID; TOK2=$LAST_CACHE; S2ID=$LAST_SID
log "  token payload: $(jwtpayload "$TOK2")"
send $U $SITE_L $C2 DE "$UA_CW" "$(t 11:05)" v /3b-2 - "$TOK2"; log "  B: same visit across the hour=$([[ $LAST_VID == "$V2" ]] && echo yes || echo no); token payload now: $(jwtpayload "$LAST_CACHE")"
send $U $SITE_L $C2 DE "$UA_CW" "$(t 13:30)" v /3b-3 - "$LAST_CACHE"; log "  B: same visit after a 2h25 gap=$([[ $LAST_VID == "$V2" ]] && echo yes || echo no)"
send $U $SITE_L $C2 DE "$UA_CW" "$(t 23:59)" v /3b-4 - "$TOK2"; log "  B: first token replayed again 13h later, same visit=$([[ $LAST_VID == "$V2" ]] && echo yes || echo no)"
log "  B': out of order (spool backlog): 11:20 first, then 11:10 with its token"
send $U $SITE_L $C4 DE "$UA_CW" "$(t 11:20)" v /3b2-1; V4=$LAST_VID
send $U $SITE_L $C4 DE "$UA_CW" "$(t 10:50)" v /3b2-0 - "$LAST_CACHE"; log "  B': earlier-stamped event with token joins visit=$([[ $LAST_VID == "$V4" ]] && echo yes || echo no)"
log "  C: token of C2 replayed for another surrogate C3 on the same website"
send $U $SITE_L $C3 DE "$UA_CW" "$(t 11:06)" v /3c - "$TOK2"
log "  C: visit=$([[ $LAST_VID == "$V2" ]] && echo 'C2 visit (WRONG)' || echo 'new visit') session=$([[ $LAST_SID == "$S2ID" ]] && echo 'C2 session (WRONG)' || echo 'own session'); session row exists: $(sqlv "select count(*) from session where session_id='$LAST_SID'")"
log "  D: token of website L replayed on website B"
send $U $SITE_B $C2 DE "$UA_CW" "$(t 11:07)" v /3d - "$TOK2"
log "  D: visit reused=$([[ $LAST_VID == "$V2" ]] && echo 'yes (WRONG)' || echo no)"
log "  E: tampered token (signature broken)"
send $U $SITE_L $C2 DE "$UA_CW" "$(t 11:08)" v /3e - "${TOK2%?}x"
log "  E: visit=$([[ $LAST_VID == "$V2" ]] && echo 'kept' || echo 'hour-bucket visit (token ignored)')"
log "  F: token across the UTC day boundary (salt rotates): 23:55 D -> 00:05 D+1"
send $U $SITE_L $C1 DE "$UA_CW" "$(t 23:55)" v /3f-1; VF=$LAST_VID; SF=$LAST_SID
send $U $SITE_L $C1 DE "$UA_CW" "$(t1 00:05)" v /3f-2 - "$LAST_CACHE"
log "  F: same session=$([[ $LAST_SID == "$SF" ]] && echo yes || echo no) same visit=$([[ $LAST_VID == "$VF" ]] && echo yes || echo no)"
log "  G: is the 30-min rule applied, and from when? Tokens forged with the spike's APP_SECRET carrying a random visitId R"
forge() {  # forge TOKEN IAT_SHIFT_SECONDS -> same claims, visitId := fixed marker, iat += shift
  node -e '
    const c=require("crypto"); const [tok,sec,shift]=process.argv.slice(1);
    const key=c.createHash("sha512").update(sec).digest("hex");
    const p=JSON.parse(Buffer.from(tok.split(".")[1],"base64url"));
    p.visitId="00000000-0000-4000-8000-0000000000aa"; p.iat=Math.floor(Date.now()/1000)+Number(shift);
    const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const h=b({alg:"HS256",typ:"JWT"}), q=b(p);
    console.log(h+"."+q+"."+c.createHmac("sha256",key).update(h+"."+q).digest("base64url"));' "$1" "$S01_APP_SECRET" "$2"; }
G=2001:db8:c0::5; R=00000000-0000-4000-8000-0000000000aa
send $U $SITE_L $G DE "$UA_CW" - v /3g-0; TOKG=$LAST_CACHE; VG=$LAST_VID
send $U $SITE_L $G DE "$UA_CW" - v /3g-1 - "$(forge "$TOKG" -60)";   log "  G1 no timestamp, iat 1 min old:  visit=$([[ $LAST_VID == "$R" ]] && echo 'R (token visit kept)' || echo "other ($LAST_VID)")"
send $U $SITE_L $G DE "$UA_CW" - v /3g-2 - "$(forge "$TOKG" -1860)"; log "  G2 no timestamp, iat 31 min old: visit=$([[ $LAST_VID == "$R" ]] && echo 'R (kept)' || echo "NEW hour-bucket visit (== first event's: $([[ $LAST_VID == "$VG" ]] && echo yes || echo no))")"
log "  G2 returned token iat reset to now: $(jwtpayload "$LAST_CACHE")"
send $U $SITE_L $G DE "$UA_CW" "$(date +%s)" v /3g-3 - "$(forge "$TOKG" -86400)"; log "  G3 WITH timestamp, iat 24 h old: visit=$([[ $LAST_VID == "$R" ]] && echo 'R (kept: no expiry on the timestamped path)' || echo 'new')"
log "  H: token of a deleted website (website existence check is skipped when a valid token is present)"
SITE_Z=5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a49
api POST /api/websites "$ADMIN" "{\"id\":\"$SITE_Z\",\"name\":\"z\",\"domain\":\"z.example.org\",\"teamId\":\"$TEAM_A\"}"
send $U $SITE_Z 2001:db8:c0::9 DE "$UA_CW" "$(t 11:00)" v /3h-1; TOKZ=$LAST_CACHE
api DELETE "/api/websites/$SITE_Z" "$ADMIN"
send $U $SITE_Z 2001:db8:c0::9 DE "$UA_CW" "$(t 11:01)" v /3h-2
send $U $SITE_Z 2001:db8:c0::9 DE "$UA_CW" "$(t 11:02)" v /3h-3 - "$TOKZ"
log "  H: rows stored for the deleted website: $(sqlv "select count(*) from website_event where website_id='$SITE_Z'")"
sql "select e.url_path, left(e.session_id::text,8) sid, left(e.visit_id::text,8) vid, e.created_at from website_event e where e.url_path like '/3%' order by e.url_path"
sql "select website_id, left(session_id::text,8) sid from website_event where url_path='/3d'"
sql "select left(session_id::text,8) sid, count(*) from session where website_id='$SITE_L' and session_id in (select session_id from website_event where url_path like '/3c%') group by 1"

# --------------------------------------------------------------------- 4 metrics dataset on M
hdr "4. metrics dataset on website M (and twin T)"
M1=2001:db8:a1::1; M2=2001:db8:a2::1; M3=2001:db8:a3::1; M4=2001:db8:a4::1; M5=2001:db8:a5::1; M6=2001:db8:a6::1
send $U $SITE_M $M1 DE "$UA_CW"  "$(t 12:00)" v /                                    # V1 single pageview -> bounce
send $U $SITE_M $M2 FR "$UA_SI"  "$(t 12:00)" v /             - - '{"referrer":"https://news.ycombinator.com/","screen":"390x844"}'
send $U $SITE_M $M2 FR "$UA_SI"  "$(t 12:02)" v /pricing - "$LAST_CACHE" '{"screen":"390x844"}'
send $U $SITE_M $M2 FR "$UA_SI"  "$(t 12:05)" v /docs    - "$LAST_CACHE" '{"screen":"390x844"}'   # V2: 3 pv, 300 s
send $U $SITE_M $M3 US "$UA_CW"  "$(t 12:10)" v /
send $U $SITE_M $M3 US "$UA_CW"  "$(t 12:11)" v / wallet_selected "$LAST_CACHE" '{"data":{"wallet_id":"freighter"}}'  # V3: pv + custom event -> not a bounce
send $U $SITE_M $M4 DE "$UA_UNK" "$(t 12:20)" s /                                    # V4: suspect single pageview
send $U $SITE_M $M5 DE "$UA_CW"  "$(t 12:30)" v /
send $U $SITE_M $M5 DE "$UA_CW"  "$(t 12:31)" s /pricing - "$LAST_CACHE"            # V5: mixed v/s visit, 60 s
send $U $SITE_M $M6 DE "$UA_CW"  "$(t 12:40)" v / modal_opened                       # V6: custom event only, no pageview
for i in 1 2 3; do                                                                  # twin: unidentified, random surrogate per event
  send $U $SITE_T "2001:db8:$(openssl rand -hex 2):$(openssl rand -hex 2)::$i" DE "$UA_CW" "$(t 12:5$i)" "$([[ $i == 3 ]] && echo s || echo v)" /
done
sql "select left(session_id::text,8) sid, left(visit_id::text,8) vid, event_type, coalesce(event_name,'') ev, url_path, tag, created_at from website_event where website_id='$SITE_M' and url_path not like '/3%' order by created_at"

hdr "2+4. stats API with and without the tag filter (read with the tenant API key)"
for f in "" "&tag=v" "&tag=s" "&tag=eq.v" "&tag=v,s" "&tag=eq.v,s" "&tag=neq.s" "&tag=c.v" "&tag=x"; do
  api GET "/api/websites/$SITE_M/stats?$RANGE$f" "$KEY"
  log "  M stats [${f:-unfiltered}] => $(jq -c 'del(.comparison)' <<<"$API_BODY")"
done
for f in "" "&tag=v"; do
  api GET "/api/websites/$SITE_T/stats?$RANGE$f" "$KEY"; log "  T stats [${f:-unfiltered}] => $(jq -c 'del(.comparison)' <<<"$API_BODY")"
done
for f in "" "&tag=v"; do
  api GET "/api/websites/$SITE_M/pageviews?$RANGE&unit=hour$f" "$KEY"
  log "  M pageviews [${f:-unfiltered}] => $(jq -c '{pageviews:[.pageviews[]|select(.y>0)], sessions:[.sessions[]|select(.y>0)]}' <<<"$API_BODY")"
done
for ty in referrer country device browser os path event; do
  for f in "" "&tag=v"; do
    api GET "/api/websites/$SITE_M/metrics?$RANGE&type=$ty&limit=500$f" "$KEY"
    log "  M metrics type=$ty [${f:-unfiltered}] => $(jq -c . <<<"$API_BODY")"
  done
done
for ty in country path; do
  for f in "" "&tag=v"; do
    api GET "/api/websites/$SITE_M/metrics/expanded?$RANGE&type=$ty&limit=500$f" "$KEY"
    log "  M metrics/expanded type=$ty [${f:-unfiltered}] => $(jq -c . <<<"$API_BODY")"
  done
done
log "  endAt boundary: an event exactly at endAt is included (between ... and ...)"
api GET "/api/websites/$SITE_M/stats?startAt=$(( $(t 12:00) * 1000 ))&endAt=$(( $(t 12:00) * 1000 ))&timezone=UTC" "$KEY"
log "  M stats [12:00:00.000 .. 12:00:00.000] => $(jq -c 'del(.comparison)' <<<"$API_BODY")"

hdr "C-82 fallback SQL (tag predicate; 30-minute-gap sessionisation) over website_event"
sql "select tag, count(*) filter (where event_type=1) pageviews, count(distinct session_id) filter (where event_type=1) visitors
     from website_event where website_id='$SITE_M' and created_at >= '$D' and created_at < date '$D' + 1 and url_path not like '/3%' group by rollup(tag) order by tag"
log "  30-minute-gap sessionisation vs Umami's visit_id, per session, for the item-3 visitors (A: no token; B: token)"
sql "with e as (select session_id, visit_id, created_at, event_type,
              case when lag(created_at) over w is null or created_at - lag(created_at) over w > interval '30 minutes' then 1 else 0 end as new_visit
            from website_event where website_id='$SITE_L' and event_type in (1,2) and (url_path like '/3a%' or url_path like '/3b-%' or url_path like '/3b2%')
            window w as (partition by session_id order by created_at)),
     v as (select *, sum(new_visit) over (partition by session_id order by created_at) vno from e),
     g as (select session_id, vno, count(*) filter (where event_type=1) pv, bool_or(event_type=2) has_custom,
                  extract(epoch from max(created_at) filter (where event_type=1) - min(created_at) filter (where event_type=1))::int dur
           from v group by 1,2 having count(*) filter (where event_type=1) > 0)
     select left(g.session_id::text,8) sid,
            (select count(distinct visit_id) from e where e.session_id=g.session_id) umami_visits,
            count(*) gap30_visits, count(*) filter (where pv=1 and not has_custom) gap30_bounces, sum(dur) gap30_totaltime
     from g group by g.session_id order by 1"
log "  same sessionisation over the whole metrics dataset of M (compare with the unfiltered /stats above)"
sql "with e as (select session_id, created_at, event_type,
              case when lag(created_at) over w is null or created_at - lag(created_at) over w > interval '30 minutes' then 1 else 0 end as new_visit
            from website_event where website_id='$SITE_M' and event_type in (1,2) and created_at >= '$D' and created_at < date '$D' + 1
            window w as (partition by session_id order by created_at)),
     v as (select *, sum(new_visit) over (partition by session_id order by created_at) vno from e),
     g as (select session_id, vno, count(*) filter (where event_type=1) pv, bool_or(event_type=2) has_custom,
                  extract(epoch from max(created_at) filter (where event_type=1) - min(created_at) filter (where event_type=1)) dur
           from v group by 1,2 having count(*) filter (where event_type=1) > 0)
     select count(distinct session_id) visitors, count(*) visits, count(*) filter (where pv=1 and not has_custom) bounces, sum(dur)::bigint totaltime from g"

# ------------------------------------------------------------------------------ 7 timestamps
hdr "7. timestamp bounds"
NOW=$(date +%s)
for ts in 0 -1 1.5 '"1794460800"' $((NOW + 86400 * 365)) 2147483647 2147483648; do
  send $U $SITE_L 2001:db8:7::1 DE "$UA_CW" - v "/ts/$ts" - - "{\"timestamp\":$ts}"
done
sql "select url_path, created_at from website_event where url_path like '/ts/%' order by 1"

# --------------------------------------------------------------------------- 1 (cont.) no IP
hdr "1 (cont.). no IP address stored anywhere"
PAT='2001:db8|10\.1\.2\.3|10\.9\.9\.9|127\.0\.0\.1|fd00:|fd12:|100\.64\.|8\.8\.8\.8|::1'
sql "do \$\$ declare r record; n bigint; total bigint := 0; begin
  for r in select table_schema, table_name, column_name from information_schema.columns
           where table_schema='public' and data_type in ('text','character varying','json','jsonb','character') loop
    execute format('select count(*) from %I.%I where %I::text ~ %L', r.table_schema, r.table_name, r.column_name, '$PAT') into n;
    if n > 0 then raise notice 'HIT %.%: %', r.table_name, r.column_name, n; end if; total := total + n;
  end loop; raise notice 'text/json columns scanned, total hits: %', total; end \$\$;"
n=$(dc exec -T db pg_dump -U umami -d umami | grep -cE "$PAT" || true); log "  pg_dump (schema+data) lines matching an IP pattern: $n"
n=$(dc logs umami umami-nogeo 2>&1 | grep -cE "$PAT" || true); log "  container log lines matching an IP pattern: $n"

# ------------------------------------------------------------------- 6 (cont.) key rotation
hdr "6 (cont.). key rotation P5 -> P6 -> verify -> P10"
api POST /api/auth/login - "{\"username\":\"scf-t-aaaa\",\"password\":\"$TENANT_PW\"}"; TSESS=$(jq -r .token <<<"$API_BODY")
api POST /api/me/api-keys "$TSESS" '{"name":"scf-control-plane"}'; KEY2=$(jq -r .key <<<"$API_BODY")
api GET "/api/websites/$SITE_M/stats?$RANGE" "$KEY2"
api DELETE "/api/me/api-keys/$KEY_ID" "$TSESS"
api GET "/api/websites/$SITE_M/stats?$RANGE" "$KEY"
log "  old key after delete: HTTP $API_CODE"
api GET "/api/users/$USER_A/api-keys" "$ADMIN"

hdr "done"
if [[ ${KEEP:-0} != 1 ]]; then dc --profile nogeo down -v 2>&1 | tail -n1; fi
log "evidence: $LOG"
