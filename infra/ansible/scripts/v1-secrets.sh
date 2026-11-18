#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Secrets of the v1 small host (docs/guides/deploy-v1.md §4), created ONCE on the operator's workstation in
# $DEPLOY_DIR/secrets (0700; files 0600), never in the repository:
#   dump-age-identity.txt   age identity of the weekly logical dumps (keep a copy offline: without it no dump decrypts)
#   stack-secrets.yml       infra/ansible/scripts/gen-stack-secrets.sh output (refuses to overwrite)
#   extra.yml               backup SAS (writer: racwdl — no version delete, no permanent delete; drill: rl), signed
#                           with the storage account key, which is read for the signing and never stored; the DNS
#                           provider token for ACME DNS-01
#   deploy-secrets.yml      what the playbook reads: stack-secrets.yml with extra.yml merged into scf_stack_secrets
#                           (and alert-email-worker-token as alert_email_worker_token when it exists: the alert
#                           mailer's bearer secret, written by ops/scripts/cloudflare-email-setup.sh)
#
#   DEPLOY_DIR=<deploy dir> ACCOUNT=<backup storage account> RG=<resource group> \
#   CF_TOKEN_FILE=<deploy dir>/cloudflare-dns-token SAS_EXPIRY=2027-11-18T00:00Z infra/ansible/scripts/v1-secrets.sh
#   … --merge-only      rebuild deploy-secrets.yml from the existing files (e.g. after renewing the SAS in extra.yml)
#   … --renew-sas       new SAS pair (before SAS_EXPIRY; the old one keeps working until it expires)
# Needs: the cloud CLI logged in with rights on the account, age-keygen (filippo.io/age v1.3.2), openssl, python3.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEPLOY_DIR=${DEPLOY_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/usagemap}
S=$DEPLOY_DIR/secrets
mode=${1:-}
mkdir -p "$S"; chmod 700 "$DEPLOY_DIR" "$S"; umask 077

merge() {
  python3 -I - "$S" <<'PY'
import os, sys
d = sys.argv[1]
s = open(os.path.join(d, "stack-secrets.yml")).read()
e = open(os.path.join(d, "extra.yml")).read()
assert s.startswith("scf_stack_secrets:\n") or "\nscf_stack_secrets:\n" in s, "stack-secrets.yml has no scf_stack_secrets map"
# The alert mailer's bearer secret (ops/scripts/cloudflare-email-setup.sh writes it; runbook alert-email), if present.
t = os.path.join(d, "alert-email-worker-token")
if os.path.exists(t):
    tok = open(t).read().strip()
    assert len(tok) >= 32 and tok.isalnum(), "alert-email-worker-token is not a generated secret"
    e += '\nalert_email_worker_token: "%s"\n' % tok
# The GitHub OAuth App's client secret (GitHub sign-in, ADR-0014), if the operator saved it next to the deploy files.
g = os.path.join(os.path.dirname(d), "github-oauth-client-secret")
if os.path.exists(g):
    sec = open(g).read().strip()
    assert sec and all(c.isalnum() for c in sec), "github-oauth-client-secret is not an OAuth client secret"
    e += '\ngithub_client_secret: "%s"\n' % sec
s = s.replace("scf_stack_secrets:\n", "scf_stack_secrets:\n" + "".join("  " + l + "\n" for l in e.splitlines() if l.strip()), 1)
p = os.path.join(d, "deploy-secrets.yml.tmp")
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, s.encode()); os.close(fd); os.replace(p, os.path.join(d, "deploy-secrets.yml"))
PY
  echo "wrote $S/deploy-secrets.yml"
}
[ "$mode" = --merge-only ] && { merge; exit 0; }

: "${ACCOUNT:?backup storage account}" "${RG:?resource group}" "${CF_TOKEN_FILE:?DNS provider token file}"
SAS_EXPIRY=${SAS_EXPIRY:?SAS expiry, e.g. 2027-11-18T00:00Z (renew before it: --renew-sas)}
if [ "$mode" != --renew-sas ]; then
  [ -s "$S/dump-age-identity.txt" ] || age-keygen -o "$S/dump-age-identity.txt" 2>/dev/null
  [ -s "$S/stack-secrets.yml" ] || "$REPO/infra/ansible/scripts/gen-stack-secrets.sh" \
    --age-recipient "$(age-keygen -y "$S/dump-age-identity.txt")" -o "$S/stack-secrets.yml"
fi
key=$(az storage account keys list -g "$RG" -n "$ACCOUNT" --query '[0].value' -o tsv)
sas() { az storage container generate-sas --account-name "$ACCOUNT" --account-key "$key" -n pgbackrest \
  --permissions "$1" --expiry "$SAS_EXPIRY" --https-only -o tsv 2>/dev/null; }
writer=$(sas racwdl) drill=$(sas rl); unset key
[[ $writer == *sp=racwdl* && $drill == *sp=rl* ]] || { echo "SAS generation failed" >&2; exit 1; }
printf 'backup_repo_sas:\n  "2": "%s"\nbackup_repo_sas_drill: "%s"\nacme_env:\n  CF_DNS_API_TOKEN: "%s"\n' \
  "$writer" "$drill" "$(tr -d '\n' <"$CF_TOKEN_FILE")" >"$S/extra.yml"
merge
