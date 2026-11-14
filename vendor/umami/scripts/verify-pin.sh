#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Checks the Umami pin without Docker: the upstream tag still points at the pinned commit, and the Dockerfile's ARG
# defaults and the Compose image tags agree with UPSTREAM. Exit 1 on any mismatch.
#   vendor/umami/scripts/verify-pin.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1090
. <(grep -E '^[A-Z_]+=' "$HERE/UPSTREAM")
fail=0
say() { echo "$1  $2"; [[ $1 == PASS ]] || fail=1; }
got=$(git ls-remote "$UMAMI_REPO" "refs/tags/$UMAMI_TAG" | cut -f1)
[[ "$got" == "$UMAMI_COMMIT" ]] && say PASS "tag $UMAMI_TAG -> $UMAMI_COMMIT" || say FAIL "tag $UMAMI_TAG -> ${got:-missing}, pinned $UMAMI_COMMIT"
grep -qx "ARG UMAMI_COMMIT=$UMAMI_COMMIT" "$HERE/Dockerfile" && say PASS "Dockerfile ARG UMAMI_COMMIT" || say FAIL "Dockerfile ARG UMAMI_COMMIT differs"
grep -qx "ARG UMAMI_REPO=$UMAMI_REPO" "$HERE/Dockerfile" && say PASS "Dockerfile ARG UMAMI_REPO" || say FAIL "Dockerfile ARG UMAMI_REPO differs"
[[ "$UMAMI_COMMIT" == "${IMAGE_TAG##*-}"* ]] && say PASS "IMAGE_TAG $IMAGE_TAG names the commit" || say FAIL "IMAGE_TAG $IMAGE_TAG does not name $UMAMI_COMMIT"
for img in "$APP_IMAGE:$IMAGE_TAG" "$MIGRATE_IMAGE:$IMAGE_TAG"; do
  grep -q "&[a-z-]*image $img\$" "$ROOT/infra/compose/compose.yaml" && say PASS "compose uses $img" || say FAIL "compose does not use $img"
done
exit $fail
