#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Usage: tools/traffic.sh http://127.0.0.1:18640
# Fixed request mix (44 requests). Query string, User-Agent and X-Forwarded-For carry canary values so the
# analysis can see which of them an SDK copies into telemetry (Host is a canary for header-derived server.address). 203.0.113.7 is a documentation address (RFC 5737).
set -euo pipefail
B=$1
H=(-H 'User-Agent: s06b-canary-UA/1.0' -H 'X-Forwarded-For: 203.0.113.7' -H 'Host: canary-host.example:8443')
c() { curl -s -o /dev/null -w '%{http_code} ' "${H[@]}" "$@"; }
for i in $(seq 1 5); do c "$B/health"; done
for i in $(seq 1 10); do c "$B/accounts/GACCOUNT${i}CANARY?cursor=42&email=canary%40example.com"; done
for i in $(seq 1 2); do c "$B/accounts/GNOTFOUND"; done
for i in $(seq 1 6); do c "$B/assets/USDC/GISSUER${i}CANARY"; done
for i in $(seq 1 5); do c -X POST -H 'Content-Type: application/json' -d '{"amount":"-1"}' "$B/payments"; done
for i in $(seq 1 3); do c "$B/boom"; done
for i in $(seq 1 3); do c "$B/does-not-exist/${i}CANARY"; done
for i in $(seq 1 10); do c "$B/health"; done
echo
