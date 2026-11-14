#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build the scf-otelcol distribution with a checksum-verified ocb.
#
#   collector/scripts/build.sh                  -> collector/_build/scf-otelcol
#   collector/scripts/build.sh --generate-only  -> collector/_build/{go.mod,go.sum,*.go}, no binary
#                                                  (for licence and vulnerability scanners)
#
# Hosts: linux/amd64 and linux/arm64. Each ocb is pinned by SHA-256; the pin must equal the release's own
# checksum file (ocb_<v>_linux_<arch>.sha256, downloaded next to the binary) and the binary must match it.
#
# Env: OCB_BIN=<path>    use an already downloaded ocb (still verified against the pin)
#      SCF_OCB_COSIGN=1  also verify the Sigstore bundle with cosign (must be on PATH)
set -euo pipefail

OCB_VERSION=0.165.0
# From the release's ocb_0.165.0_linux_<arch>.sha256 files; Sigstore bundles verified with cosign v3.1.4
# (2026-11-12), identity and issuer below.
OCB_SHA256_amd64=6fd899cf8794803bb0d9ea0a055fdaabd2e7e8304de3872fd9aaec3f0cd7f18c
OCB_SHA256_arm64=60796ab92c4becb5a2f54da5dff36e8127e69ea42daca4798b711d9b5c0f3002
OCB_BASE="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/cmd%2Fbuilder%2Fv${OCB_VERSION}"
COSIGN_IDENTITY="https://github.com/open-telemetry/opentelemetry-collector-releases/.github/workflows/base-binary-release.yaml@refs/tags/v${OCB_VERSION}"
COSIGN_ISSUER="https://token.actions.githubusercontent.com"

generate_only=0
case "${1:-}" in
  "") ;;
  --generate-only) generate_only=1 ;;
  *) echo "usage: build.sh [--generate-only]" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=amd64 ;;
  Linux-aarch64 | Linux-arm64) arch=arm64 ;;
  *) echo "build.sh: ocb is pinned for linux/amd64 and linux/arm64 only; build inside the Dockerfile elsewhere" >&2; exit 1 ;;
esac
pin_var="OCB_SHA256_${arch}"
pin="${!pin_var}"
asset="ocb_${OCB_VERSION}_linux_${arch}"

fetch() { # url dest
  local tmp
  tmp="$(mktemp "$2.XXXXXX")"
  curl -fsSL --retry 3 -o "$tmp" "$1"
  mv "$tmp" "$2"
}

mkdir -p .bin
ocb="${OCB_BIN:-.bin/${asset}}"
[ -f "$ocb" ] || fetch "${OCB_BASE}/${asset}" "$ocb"
sumfile=".bin/${asset}.sha256"
[ -f "$sumfile" ] || fetch "${OCB_BASE}/${asset}.sha256" "$sumfile"
published="$(awk '{print $1; exit}' "$sumfile")"
if [ "$published" != "$pin" ]; then
  echo "build.sh: the release's checksum file for ${asset} (${published}) differs from the pin (${pin})" >&2
  exit 1
fi
echo "${pin}  ${ocb}" | sha256sum -c --quiet - || { echo "build.sh: ocb checksum mismatch" >&2; exit 1; }
if [ "${SCF_OCB_COSIGN:-0}" = 1 ]; then
  bundle="${ocb}.sigstore.json"
  [ -f "$bundle" ] || fetch "${OCB_BASE}/${asset}.sigstore.json" "$bundle"
  cosign verify-blob --bundle "$bundle" --certificate-identity "$COSIGN_IDENTITY" \
    --certificate-oidc-issuer "$COSIGN_ISSUER" "$ocb"
fi
chmod +x "$ocb"

# GOWORK=off: the repository's go.work would otherwise take part in the build (S-04).
# -buildvcs=false and -trimpath: the binary does not depend on the checkout or its path.
if [ "$generate_only" = 1 ]; then
  GOWORK=off "$ocb" --config builder-config.yaml --skip-compilation
  echo "generated: $here/_build/go.mod, go.sum"
else
  GOWORK=off CGO_ENABLED=0 GOFLAGS="-buildvcs=false -trimpath" "$ocb" --config builder-config.yaml
  echo "built: $here/_build/scf-otelcol"
fi
