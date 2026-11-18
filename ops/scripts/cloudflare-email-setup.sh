#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Sets up alert and security e-mail on the zone (runbook ops/runbooks/alert-email.md),
# idempotently, through the Cloudflare API:
#   1. Email Routing enabled on the zone (MX and SPF records added and locked by Cloudflare);
#   2. the destination address (the operations lead's personal mailbox) registered on the account; Cloudflare then
#      sends it a verification e-mail, and the script stops until the link in it has been opened;
#   3. two forwarding rules: security@<zone> and alerts@<zone> → the destination address;
#   4. the alert mailer Worker (ops/alert-mailer) deployed with its send_email binding restricted to the destination
#      address, its two secrets, and its workers.dev URL enabled.
# A second run with nothing to do changes nothing. The destination address is read from a file outside the
# repository and is never printed, logged or written anywhere else (it goes to Cloudflare only).
#
#   ops/scripts/cloudflare-email-setup.sh              apply
#   ops/scripts/cloudflare-email-setup.sh --check      read only: report what would change (exit 1 if anything)
#   ops/scripts/cloudflare-email-setup.sh --redeploy   upload the Worker even if this version is already deployed
#   ops/scripts/cloudflare-email-setup.sh --test-send  also post one synthetic notification: one real test e-mail
#
# Files (all under CONFIG_DIR, never in the repository):
#   cloudflare-email-token           API token with the permissions listed in the runbook (§ API token)
#   alert-destination                the destination address, one line
#   secrets/alert-email-worker-token the Worker's bearer secret; created here when missing (0600); the deploy reads
#                                    it into scf_stack_secrets.alert_email_worker_token (scripts/v1-secrets.sh)
#   state/alert-mailer.deployed      fingerprint of the deployed Worker version (no secret, no address)
# Environment: ZONE (usagemap.dev), WORKER_NAME (usagemap-alert-mailer), CONFIG_DIR ($XDG_CONFIG_HOME/usagemap),
#   CF_API_TOKEN_FILE, CF_API_BASE (https://api.cloudflare.com/client/v4; the tests point it at a local fake),
#   TEST_SEND_URL (--test-send target; default the Worker's workers.dev URL).
# Exit: 0 done · 1 --check found changes · 2 usage or configuration error · 3 waiting for address verification ·
#   4 Cloudflare API error.
# Needs: bash, curl, jq, openssl, sha256sum.
# shellcheck disable=SC2016 # jq programs are single-quoted on purpose
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
MAILER="$(cd "$HERE/../alert-mailer" && pwd)"
ZONE=${ZONE:-usagemap.dev}
WORKER_NAME=${WORKER_NAME:-usagemap-alert-mailer}
CONFIG_DIR=${CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/usagemap}
CF_API_TOKEN_FILE=${CF_API_TOKEN_FILE:-$CONFIG_DIR/cloudflare-email-token}
CF_API_BASE=${CF_API_BASE:-https://api.cloudflare.com/client/v4}
DEST_FILE=$CONFIG_DIR/alert-destination
WORKER_TOKEN_FILE=$CONFIG_DIR/secrets/alert-email-worker-token
STATE_FILE=$CONFIG_DIR/state/alert-mailer.deployed
MAILBOXES=(security alerts)

mode=apply redeploy=0 test_send=0
for arg in "$@"; do
  case $arg in
    --check) mode=check ;;
    --redeploy) redeploy=1 ;;
    --test-send) test_send=1 ;;
    -h | --help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$1" >&2; exit "${2:-2}"; }
changes=0
plan() { changes=$((changes + 1)); if [ "$mode" = check ]; then say "  would: $*"; else say "  doing: $*"; fi; }

for tool in curl jq openssl sha256sum; do command -v "$tool" >/dev/null || die "$tool is required"; done
[ -s "$CF_API_TOKEN_FILE" ] || die "API token file $CF_API_TOKEN_FILE is missing (runbook alert-email, § API token)"
[ -s "$DEST_FILE" ] || die "destination address file $DEST_FILE is missing"
DEST=$(tr -d ' \t\r\n' <"$DEST_FILE")
[[ $DEST =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || die "$DEST_FILE does not hold one plain e-mail address"
[[ ${DEST,,} == *@"${ZONE,,}" ]] && die "the destination must be a mailbox outside $ZONE (Email Routing forwards to it)"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# The token goes to curl through a 0600 config file, never on a command line.
printf 'header = "Authorization: Bearer %s"\n' "$(tr -d ' \t\r\n' <"$CF_API_TOKEN_FILE")" >"$WORK/auth"

# api METHOD PATH [JSON-BODY-FILE] → response JSON on stdout; exits 4 with Cloudflare's error codes on failure.
api() {
  local method=$1 path=$2 body=${3:-} out=$WORK/resp status
  local args=(-sS -o "$out" -w '%{http_code}' -K "$WORK/auth" -X "$method" -H 'Accept: application/json')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "@$body")
  status=$(curl "${args[@]}" "$CF_API_BASE$path") || die "request failed: $method ${path%%\?*}" 4
  if [[ $status != 2?? ]] || [ "$(jq -r '.success // false' "$out" 2>/dev/null)" != true ]; then
    # Error codes and messages only; Cloudflare's messages name the failing field, not our values.
    printf 'error: %s %s → HTTP %s %s\n' "$method" "${path%%\?*}" "$status" \
      "$(jq -c '[.errors[]? | {code, message}]' "$out" 2>/dev/null || echo '(no JSON body)')" >&2
    [ "$status" = 403 ] && say "  the API token lacks a permission: see runbook alert-email, § API token" >&2
    exit 4
  fi
  cat "$out"
}
json() { local f=$WORK/body-$RANDOM.json; jq -n "$@" >"$f"; printf '%s' "$f"; }

say "== zone $ZONE"
zone=$(api GET "/zones?name=$ZONE")
ZONE_ID=$(jq -r '.result[0].id // empty' <<<"$zone")
ACCOUNT_ID=$(jq -r '.result[0].account.id // empty' <<<"$zone")
[ -n "$ZONE_ID" ] && [ -n "$ACCOUNT_ID" ] || die "zone $ZONE not found for this token" 4

say "== 1. Email Routing"
routing=$(api GET "/zones/$ZONE_ID/email/routing")
if [ "$(jq -r '.result.enabled' <<<"$routing")" = true ]; then
  say "  enabled (status $(jq -r '.result.status // "unknown"' <<<"$routing"))"
else
  plan "enable Email Routing on $ZONE (Cloudflare adds and locks the MX and SPF records)"
  if [ "$mode" = apply ]; then
    api POST "/zones/$ZONE_ID/email/routing/dns" "$(json --arg n "$ZONE" '{name: $n}')" >/dev/null
    routing=$(api GET "/zones/$ZONE_ID/email/routing")
    [ "$(jq -r '.result.enabled' <<<"$routing")" = true ] || die "Email Routing is still not enabled (status $(jq -r '.result.status // "unknown"' <<<"$routing")); see the dashboard's Email Routing page" 4
  fi
fi
st=$(jq -r '.result.status // "unknown"' <<<"$routing")
[ "$mode" = check ] || [ "$st" = ready ] || say "  note: routing status is \"$st\", not \"ready\": check the MX/SPF records (dashboard, Email Routing → Settings)"

say "== 2. destination address (from $DEST_FILE)"
dest_id="" verified="" page=1
while :; do
  r=$(api GET "/accounts/$ACCOUNT_ID/email/routing/addresses?per_page=50&page=$page")
  hit=$(jq -c --arg e "${DEST,,}" '[.result[]? | select((.email | ascii_downcase) == $e)][0] // empty' <<<"$r")
  if [ -n "$hit" ]; then dest_id=$(jq -r '.id // .tag' <<<"$hit"); verified=$(jq -r '.verified // empty' <<<"$hit"); break; fi
  [ "$page" -lt "$(jq -r '.result_info.total_pages // 1' <<<"$r")" ] || break
  page=$((page + 1))
done
if [ -z "$dest_id" ]; then
  plan "register the destination address (Cloudflare e-mails it a verification link)"
  if [ "$mode" = apply ]; then
    r=$(api POST "/accounts/$ACCOUNT_ID/email/routing/addresses" "$(json --arg e "$DEST" '{email: $e}')")
    verified=$(jq -r '.result.verified // empty' <<<"$r")
  fi
fi
if [ -z "$verified" ]; then
  if [ "$mode" = check ]; then
    say "  would: wait for the destination address to be verified (rules and Worker follow then)"
  else
    say "  waiting: open the verification link Cloudflare sent to the destination address, then run this again."
    exit 3
  fi
else
  say "  registered and verified"
fi

say "== 3. forwarding rules"
rules=$(api GET "/zones/$ZONE_ID/email/routing/rules?per_page=50")
for box in "${MAILBOXES[@]}"; do
  addr="$box@$ZONE"
  want=$(jq -n --arg a "$addr" --arg d "$DEST" --arg n "UsageMap: $addr to the operations lead" \
    '{name: $n, enabled: true, priority: 0, matchers: [{type: "literal", field: "to", value: $a}], actions: [{type: "forward", value: [$d]}]}')
  have=$(jq -c --arg a "$addr" '[.result[]? | select(any(.matchers[]?; .type == "literal" and .field == "to" and ((.value // "") | ascii_downcase) == ($a | ascii_downcase)))][0] // empty' <<<"$rules")
  if [ -z "$have" ]; then
    plan "create the rule $addr → destination address"
    [ "$mode" = apply ] && { printf '%s' "$want" >"$WORK/rule.json"; api POST "/zones/$ZONE_ID/email/routing/rules" "$WORK/rule.json" >/dev/null; }
  elif jq -e --argjson w "$want" '.enabled == true and ([.actions[] | {type, value}] == $w.actions)' <<<"$have" >/dev/null; then
    say "  $addr: forwards to the destination address"
  else
    plan "update the rule $addr (enable it, forward to the destination address)"
    if [ "$mode" = apply ]; then
      printf '%s' "$want" >"$WORK/rule.json"
      api PUT "/zones/$ZONE_ID/email/routing/rules/$(jq -r '.id // .tag' <<<"$have")" "$WORK/rule.json" >/dev/null
    fi
  fi
done

say "== 4. alert mailer Worker $WORKER_NAME"
mkdir -p "$(dirname "$WORKER_TOKEN_FILE")" "$(dirname "$STATE_FILE")"
if [ ! -s "$WORKER_TOKEN_FILE" ]; then
  plan "create the Worker's bearer secret in $WORKER_TOKEN_FILE (0600)"
  [ "$mode" = apply ] && openssl rand -hex 32 >"$WORKER_TOKEN_FILE"
fi
WORKER_TOKEN=$( [ -s "$WORKER_TOKEN_FILE" ] && tr -d ' \t\r\n' <"$WORKER_TOKEN_FILE" || echo "")
config=$(grep -v '^[[:space:]]*//' "$MAILER/wrangler.jsonc")
compat=$(jq -r '.compatibility_date' <<<"$config")
from=$(jq -r '.vars.MAIL_FROM' <<<"$config")
[[ $from == *@"$ZONE" ]] || die "wrangler.jsonc MAIL_FROM ($from) is not an address of $ZONE"
# The version fingerprint: modules, compatibility date, sender, and hashes of the secret values (never the values).
fingerprint=$( { cat "$MAILER/src/worker.js" "$MAILER/src/mailer.js"; printf '%s\n%s\n%s\n%s\n' "$compat" "$from" \
  "$(printf '%s' "$DEST" | sha256sum)" "$(printf '%s' "$WORKER_TOKEN" | sha256sum)"; } | sha256sum | cut -c1-32)
exists=1
curl -sS -o /dev/null -w '%{http_code}' -K "$WORK/auth" "$CF_API_BASE/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" >"$WORK/exists" || true
[ "$(cat "$WORK/exists")" = 200 ] || exists=0
if [ "$exists" = 1 ] && [ "$redeploy" = 0 ] && [ -s "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" = "$fingerprint" ]; then
  say "  this version is deployed ($fingerprint)"
else
  plan "upload the Worker (2 modules; send_email restricted to the destination address; secrets MAIL_TO, ALERT_TOKEN)"
  if [ "$mode" = apply ]; then
    jq -n --arg c "$compat" --arg f "$from" --arg d "$DEST" --arg t "$WORKER_TOKEN" '{
      main_module: "worker.js", compatibility_date: $c,
      bindings: [
        {type: "send_email", name: "MAIL", destination_address: $d},
        {type: "plain_text", name: "MAIL_FROM", text: $f},
        {type: "secret_text", name: "MAIL_TO", text: $d},
        {type: "secret_text", name: "ALERT_TOKEN", text: $t}
      ],
      observability: {enabled: true}
    }' >"$WORK/metadata.json"
    status=$(curl -sS -o "$WORK/resp" -w '%{http_code}' -K "$WORK/auth" -X PUT \
      -F "metadata=@$WORK/metadata.json;type=application/json" \
      -F "worker.js=@$MAILER/src/worker.js;type=application/javascript+module" \
      -F "mailer.js=@$MAILER/src/mailer.js;type=application/javascript+module" \
      "$CF_API_BASE/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME") || die "Worker upload request failed" 4
    rm -f "$WORK/metadata.json"
    if [[ $status != 2?? ]] || [ "$(jq -r '.success // false' "$WORK/resp")" != true ]; then
      printf 'error: Worker upload → HTTP %s %s\n' "$status" "$(jq -c '[.errors[]? | {code, message}]' "$WORK/resp" 2>/dev/null)" >&2
      exit 4
    fi
    printf '%s\n' "$fingerprint" >"$STATE_FILE"
  fi
fi
sub=$(api GET "/accounts/$ACCOUNT_ID/workers/subdomain" | jq -r '.result.subdomain // empty')
[ -n "$sub" ] || die "the account has no workers.dev subdomain yet: choose one once in the dashboard (Workers & Pages)" 4
if [ "$exists" = 1 ] && [ "$(api GET "/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" | jq -r '.result.enabled')" = true ]; then
  say "  workers.dev URL enabled"
else
  plan "enable the Worker's workers.dev URL (no preview URLs)"
  [ "$mode" = apply ] && api POST "/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" \
    "$(json '{enabled: true, previews_enabled: false}')" >/dev/null
fi
URL="https://$WORKER_NAME.$sub.workers.dev/v1/alertmanager"

if [ "$test_send" = 1 ] && [ "$mode" = apply ]; then
  say "== test e-mail"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg now "$now" '{version: "4", status: "firing", receiver: "maintainers-critical",
    groupLabels: {alertname: "AlertMailerTest"}, commonLabels: {alertname: "AlertMailerTest", severity: "warning"},
    commonAnnotations: {}, alerts: [{status: "firing", labels: {alertname: "AlertMailerTest", severity: "warning"},
    annotations: {summary: "Test e-mail from ops/scripts/cloudflare-email-setup.sh --test-send",
    runbook_url: "ops/runbooks/alert-email.md"}, startsAt: $now}]}' >"$WORK/test.json"
  printf 'header = "Authorization: Bearer %s"\n' "$WORKER_TOKEN" >"$WORK/worker-auth"
  status=$(curl -sS -o "$WORK/resp" -w '%{http_code}' -K "$WORK/worker-auth" -H 'Content-Type: application/json' \
    --data-binary "@$WORK/test.json" "${TEST_SEND_URL:-$URL}") || die "test request failed" 4
  [ "$status" = 200 ] || die "the Worker answered HTTP $status $(jq -c . "$WORK/resp" 2>/dev/null) (runbook alert-email, § Failures)" 4
  say "  sent: one test e-mail to the destination address (subject \"[UsageMap FIRING:1] warning AlertMailerTest …\")"
fi

say ""
if [ "$mode" = check ]; then
  say "$changes change(s) needed."
  [ "$changes" = 0 ] || exit 1
  exit 0
fi
say "Done ($changes change(s)). Alertmanager settings for the deploy (runbook alert-email, § Deploy):"
say "  scf_alert_email_worker_url: \"$URL\""
say "  scf_stack_secrets.alert_email_worker_token: the content of $WORKER_TOKEN_FILE"
say "    (infra/ansible/scripts/v1-secrets.sh --merge-only adds it to deploy-secrets.yml)"
