#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Dead-man's switch (C-30, monitoring plan §4.9): run by .github/workflows/deadman.yml (every 5 minutes, on
# GitHub-hosted runners — infrastructure we do not operate). Reads the Watchdog heartbeat that Alertmanager on mon-c
# posts to the status host every 5 minutes and fails (non-zero exit → the workflow alarms the maintainers through the
# alert channel and a GitHub notification) when it is older than MAX_AGE seconds (default 900) or unreadable.
# Detection therefore takes 15 minutes plus GitHub's scheduling delay. No secrets and no visitor data are involved.
#
#   STATUS_URL=https://status.example ops/deadman/check.sh
set -euo pipefail
: "${STATUS_URL:?set STATUS_URL to the status host}"
MAX_AGE="${MAX_AGE:-900}"
body="$(curl -fsS --max-time 20 "$STATUS_URL/heartbeat.json")" || { echo "DEAD-MANS-SWITCH: heartbeat unreadable"; exit 1; }
last="$(jq -r '.last_heartbeat // empty' <<<"$body")"
[[ -n "$last" ]] || { echo "DEAD-MANS-SWITCH: no heartbeat recorded"; exit 1; }
age=$(( $(date -u +%s) - $(date -u -d "$last" +%s) ))
if (( age > MAX_AGE )); then echo "DEAD-MANS-SWITCH: last heartbeat $last is ${age}s old (> ${MAX_AGE}s)"; exit 1; fi
echo "heartbeat ok: $last (${age}s old)"
