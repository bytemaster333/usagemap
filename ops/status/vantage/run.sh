#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# A second probe vantage point OUTSIDE the host (the operator's workstation, another network and provider): the same
# `scf-ops probe` as the host's probe-mon-c — ingest health of every ingest name, a canary web event with proof of
# work through them, the signed-in dashboard journey (C-93) — recording into a local probe store that
# `scf-ops slo-report` reads (ops/README.md). Runs as a container restarted with Docker (survives reboots).
#
#   STORE=~/.local/share/usagemap/probe-ws CONFIG_DIR=<config dir>/probe-ws OPS_IMAGE=<scf ops image> \
#   SOURCE=ws-1 INGEST="e1.usagemap.dev e2.usagemap.dev" PORTAL=app.usagemap.dev SITE_KEY=<canary site key> \
#   TENANT_ID=<id> SITE_ID=<canary site id> SEED_FILE=<journey member seed> TRACKER_VERSION=1.1.0 \
#   ops/status/vantage/run.sh            # (re)start;   OUT=<dir> ops/status/vantage/run.sh report [YYYY-MM]   # SLO report
set -euo pipefail
NAME=${NAME:-usagemap-probe-ws}
STORE=${STORE:?} CONFIG_DIR=${CONFIG_DIR:?} OPS_IMAGE=${OPS_IMAGE:?}
if [ "${1:-}" = report ]; then
  OUT=${OUT:-$PWD/slo-report}; mkdir -p "$OUT"
  exec docker run --rm --user "$(id -u):$(id -g)" -v "$STORE:/var/lib/scf-probes:ro" -v "$OUT:/out" "$OPS_IMAGE" \
    slo-report -store /var/lib/scf-probes -out /out ${2:+-month "$2"}
fi
: "${SOURCE:?}" "${INGEST:?}" "${PORTAL:?}" "${SITE_KEY:?}" "${TENANT_ID:?}" "${SITE_ID:?}" "${SEED_FILE:?}"
mkdir -p "$STORE" "$CONFIG_DIR"; chmod 700 "$CONFIG_DIR"
install -m 0600 "$SEED_FILE" "$CONFIG_DIR/journey_seed"
hosts=$(i=0; for h in $INGEST; do i=$((i + 1)); printf '%s"host-%d": "https://%s"' "$([ $i -gt 1 ] && echo ', ')" "$i" "$h"; done)
cat >"$CONFIG_DIR/probe.json" <<JSON
{
  "source": "$SOURCE",
  "hosts": { $hosts },
  "nodes": {},
  "site_key": "$SITE_KEY",
  "origin": "https://$PORTAL",
  "tracker_version": "${TRACKER_VERSION:-1.1.0}",
  "interval": "30s",
  "deadline": "2s",
  "store_dir": "/var/lib/scf-probes",
  "metrics_addr": "127.0.0.1:9480",
  "journey": {
    "every": "60s",
    "api": "https://$PORTAL",
    "portal_origin": "https://$PORTAL",
    "seed_file": "/etc/scf-ops/journey_seed",
    "tenant_id": "$TENANT_ID",
    "site_id": "$SITE_ID",
    "require_data": true
  }
}
JSON
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user "$(id -u):$(id -g)" --memory 128m \
  -v "$CONFIG_DIR:/etc/scf-ops:ro" -v "$STORE:/var/lib/scf-probes" \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  "$OPS_IMAGE" probe -config /etc/scf-ops/probe.json
