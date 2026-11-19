#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Registers one deployed contract with UsageMap's Registered Footprint as "claimed" (operation
# registerFootprintContract). Use it at the end of a deploy script or CI job.
#
#   SCF_FOOTPRINT_KEY=scfa_reg_… USAGEMAP_TENANT_ID=<project id> ./register.sh <contract id C…> <testnet|mainnet> [label]
#
# The key is a footprint registration key from the portal (Footprint page): it can add contracts as `claimed` to one
# project and nothing else. It is read from the environment and handed to curl on a file descriptor, never on the
# command line (where `ps` and shell history would show it).
set -euo pipefail

key="${SCF_FOOTPRINT_KEY:?export SCF_FOOTPRINT_KEY=scfa_reg_… (portal: Footprint → registration keys)}"
tenant="${USAGEMAP_TENANT_ID:?export USAGEMAP_TENANT_ID=<your project id> (portal: Footprint)}"
api="${USAGEMAP_API_URL:-https://app.usagemap.dev}"
contract="${1:?usage: register.sh <contract id C…> <testnet|mainnet> [label]}"
network="${2:?usage: register.sh <contract id C…> <testnet|mainnet> [label]}"
label="${3:-}"

[[ "$key" =~ ^scfa_reg_ ]] || { echo "SCF_FOOTPRINT_KEY is not a footprint registration key (scfa_reg_…)" >&2; exit 2; }
[[ "$tenant" =~ ^[0-9a-f-]{36}$ ]] || { echo "USAGEMAP_TENANT_ID must be the project's id (a UUID)" >&2; exit 2; }
[[ "$contract" =~ ^C[A-Z2-7]{55}$ ]] || { echo "not a contract id (C… , 56 characters): only your own contracts, never a user's address" >&2; exit 2; }
[[ "$network" =~ ^(testnet|mainnet)$ ]] || { echo "network must be testnet or mainnet" >&2; exit 2; }
[[ "$label" =~ ^[A-Za-z0-9\ _.-]{0,100}$ ]] || { echo "label: letters, digits, space, _ . - (at most 100)" >&2; exit 2; }
[[ "$api" =~ ^https:// || "$api" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]] || { echo "USAGEMAP_API_URL must use https" >&2; exit 2; }

body="{\"kind\":\"contract\",\"subject\":\"$contract\",\"network\":\"$network\""
[ -n "$label" ] && body="$body,\"label\":\"$label\""
body="$body}"

# 201: added as claimed · 409: already declared (fine) · 401: key revoked or expired · 403: key bound to the other
# network · 404: key of another project · 429: rate limited
curl -sS -i --max-redirs 0 -X POST "$api/v1/tenants/$tenant/footprint/register" \
  -H @<(printf 'Authorization: Bearer %s\n' "$key") \
  -H 'Content-Type: application/json' \
  --data "$body"
