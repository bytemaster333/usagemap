#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Regenerates umami-isbot-expected.json: Umami's own isbot verdicts for corpus.json, computed by Node inside our
# Umami image (no network, read-only, all capabilities dropped). Run after changing the corpus or the Umami pin.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${UMAMI_IMAGE:-usagemap/umami:3.5.0-d3c62a8}"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$HERE/umami-isbot.mjs:/t/umami-isbot.mjs:ro" -v "$HERE/corpus.json:/t/corpus.json:ro" \
  --entrypoint node "$IMAGE" /t/umami-isbot.mjs /t/corpus.json > "${OUT:-$HERE/umami-isbot-expected.json}"
