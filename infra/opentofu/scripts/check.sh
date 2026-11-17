#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Offline-safe checks of the OpenTofu code (no cloud credentials, nothing applied — C-96):
#   fmt -check · init -backend=false · validate (module and root) · tofu test (plan against a mock provider) · tflint
# Tools are pinned by version and sha256 and cached in ${XDG_CACHE_HOME:-~/.cache}/scf-tools (OpenTofu MPL-2.0,
# TFLint MPL-2.0, tflint-ruleset-azurerm MPL-2.0 — never Terraform ≥ 1.6, BUSL).
#
#   infra/opentofu/scripts/check.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/scf-tools"
TOFU_VERSION=1.13.9 TFLINT_VERSION=0.66.0 AZRS_VERSION=0.33.0 # AZRS = tflint-ruleset-azurerm (.tflint.hcl pins the same)
case "$(uname -m)" in
  x86_64) ARCH=amd64 TOFU_SHA=bc44eb6b06446ba83bd4072114891987f590f66cca712737a7f1147c50c539ce TFLINT_SHA=22be11cadc25cd02401e94c0ccc91aa63467debb8485c2a755d98f4c0a9d1e2e
    AZRS_SHA=cd372389bd9ef17096ed7a9fbd856c0122521df141301685e974b269322819a8 ;;
  aarch64 | arm64) ARCH=arm64 TOFU_SHA=04f7c93828b859d420269ed30f923ffebf09157b5d7fb95bf8d88a4d208b7fa3 TFLINT_SHA=1105a0a5ddee7cdac7957a3475571a946b839192ea1bc0c722c6c4686001067e
    AZRS_SHA=defe24ecc0b7d86629e1e9cb949e95b8cafc775bacd8d916f6d67a1b8c5b0928 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 2 ;;
esac
[ "$(uname -s)" = Linux ] || { echo "check.sh pins Linux binaries only" >&2; exit 2; }

fetch() { # fetch URL SHA256 DEST_ZIP
  [ -s "$3" ] && echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null && return 0
  curl -fsSL -o "$3.tmp" "$1"
  echo "$2  $3.tmp" | sha256sum -c --quiet - || { rm -f "$3.tmp"; echo "checksum mismatch: $1" >&2; exit 2; }
  mv "$3.tmp" "$3"
}
mkdir -p "$CACHE/tofu-$TOFU_VERSION" "$CACHE/tflint-$TFLINT_VERSION" "$CACHE/tflint-plugins"
fetch "https://github.com/opentofu/opentofu/releases/download/v$TOFU_VERSION/tofu_${TOFU_VERSION}_linux_$ARCH.zip" "$TOFU_SHA" "$CACHE/tofu-$TOFU_VERSION/tofu.zip"
fetch "https://github.com/terraform-linters/tflint/releases/download/v$TFLINT_VERSION/tflint_linux_$ARCH.zip" "$TFLINT_SHA" "$CACHE/tflint-$TFLINT_VERSION/tflint.zip"
[ -x "$CACHE/tofu-$TOFU_VERSION/tofu" ] || unzip -q -o "$CACHE/tofu-$TOFU_VERSION/tofu.zip" tofu -d "$CACHE/tofu-$TOFU_VERSION"
[ -x "$CACHE/tflint-$TFLINT_VERSION/tflint" ] || unzip -q -o "$CACHE/tflint-$TFLINT_VERSION/tflint.zip" -d "$CACHE/tflint-$TFLINT_VERSION"
# The Azure ruleset is installed here by URL + SHA-256 like the tools, not by `tflint --init`: --init asks the GitHub
# API, which rate-limits unauthenticated requests from shared runners (seen as 403).
AZRS_DIR="$CACHE/tflint-plugins/github.com/terraform-linters/tflint-ruleset-azurerm/$AZRS_VERSION"
mkdir -p "$AZRS_DIR" "$CACHE/tflint-azurerm-$AZRS_VERSION"
fetch "https://github.com/terraform-linters/tflint-ruleset-azurerm/releases/download/v$AZRS_VERSION/tflint-ruleset-azurerm_linux_$ARCH.zip" "$AZRS_SHA" "$CACHE/tflint-azurerm-$AZRS_VERSION/ruleset.zip"
[ -x "$AZRS_DIR/tflint-ruleset-azurerm" ] || unzip -q -o "$CACHE/tflint-azurerm-$AZRS_VERSION/ruleset.zip" tflint-ruleset-azurerm -d "$AZRS_DIR"
TOFU="$CACHE/tofu-$TOFU_VERSION/tofu" TFLINT="$CACHE/tflint-$TFLINT_VERSION/tflint"
export TFLINT_PLUGIN_DIR="$CACHE/tflint-plugins" TF_IN_AUTOMATION=1
# The root module enforces state/plan encryption from a passphrase; validation needs some value, never a real one.
export TF_VAR_state_passphrase=validation-only-not-a-secret

# Lean profile (C-123, production) and the scale-out profile (documented, not deployed).
DIRS="modules/azure-lean envs/azure-lean modules/azure-platform envs/azure-eu modules/single-vm envs/v1-small"
fail=0
step() { echo "== $*"; }
step "tofu fmt -check"; "$TOFU" fmt -check -recursive "$ROOT" || fail=1
for d in $DIRS; do
  step "tofu init/validate $d"
  (cd "$ROOT/$d" && "$TOFU" init -backend=false -input=false -no-color >/dev/null && "$TOFU" validate -no-color) || fail=1
done
for m in modules/azure-lean modules/azure-platform modules/single-vm; do
  step "tofu test $m (mock provider plan)"
  (cd "$ROOT/$m" && "$TOFU" test -no-color) || fail=1
done
step "tflint"
for d in $DIRS; do
  (cd "$ROOT/$d" && "$TFLINT" --config="$ROOT/.tflint.hcl" --format compact) || fail=1
done
[ $fail = 0 ] && echo "Result: PASS — fmt, validate, test, tflint" || echo "Result: FAIL"
exit $fail
