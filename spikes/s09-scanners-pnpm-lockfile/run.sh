#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-09 — do dependency scanners read pnpm 12 (two-document) lockfiles?  Re-run: ./run.sh
# Downloads pinned scanner binaries (sha256-pinned; Trivy and Grype also cosign-verified), regenerates the canary
# lockfiles with pnpm 12.19 and runs osv-scanner, Trivy, Grype and `pnpm audit` on each fixture.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
eval "$(cd "$REPO" && mise env -s bash)"
WORK="${S09_WORK:-/tmp/usagemap-spikes/s09}"
BIN="$WORK/bin"; OUT="$HERE/results"; mkdir -p "$BIN" "$OUT" "$WORK/dl"

# ---- pinned tools (sha256 = GitHub release asset digest, cross-checked against each project's checksums file)
COSIGN_V=3.1.4;  COSIGN_SHA=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
TRIVY_V=0.76.2;  TRIVY_SHA=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
GRYPE_V=0.121.3; GRYPE_SHA=e9da18cc1429e786722e32161288103600efffd8e483c90761f90485bd1bec85
OSV_V=2.7.1;     OSV_SHA=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8

fetch() { # url sha256 dest
  [ -f "$3" ] || curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >&2
}
cd "$WORK/dl"
fetch "https://github.com/sigstore/cosign/releases/download/v$COSIGN_V/cosign-linux-amd64" "$COSIGN_SHA" cosign
install -m 0755 cosign "$BIN/cosign"

fetch "https://github.com/aquasecurity/trivy/releases/download/v$TRIVY_V/trivy_${TRIVY_V}_Linux-64bit.tar.gz" "$TRIVY_SHA" trivy.tgz
[ -f trivy.tgz.sigstore.json ] || curl -fsSL -o trivy.tgz.sigstore.json "https://github.com/aquasecurity/trivy/releases/download/v$TRIVY_V/trivy_${TRIVY_V}_Linux-64bit.tar.gz.sigstore.json"
"$BIN/cosign" verify-blob --bundle trivy.tgz.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/aquasecurity/trivy/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com trivy.tgz >&2
python3 -I -c 'import json,sys,datetime;d=json.load(open(sys.argv[1]));print("trivy bundle signed at",[datetime.datetime.fromtimestamp(int(e["integratedTime"]),datetime.UTC).isoformat() for e in d["verificationMaterial"]["tlogEntries"]])' trivy.tgz.sigstore.json >&2
tar -xzf trivy.tgz -C "$BIN" trivy

fetch "https://github.com/anchore/grype/releases/download/v$GRYPE_V/grype_${GRYPE_V}_linux_amd64.tar.gz" "$GRYPE_SHA" grype.tgz
for f in checksums.txt checksums.txt.sigstore.json; do [ -f "grype_$f" ] || curl -fsSL -o "grype_$f" "https://github.com/anchore/grype/releases/download/v$GRYPE_V/grype_${GRYPE_V}_$f"; done
"$BIN/cosign" verify-blob --bundle grype_checksums.txt.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/anchore/grype/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com grype_checksums.txt >&2
grep -q "^$GRYPE_SHA  grype_${GRYPE_V}_linux_amd64.tar.gz$" grype_checksums.txt && echo "grype tarball listed in signed checksums" >&2
tar -xzf grype.tgz -C "$BIN" grype

fetch "https://github.com/google/osv-scanner/releases/download/v$OSV_V/osv-scanner_linux_amd64" "$OSV_SHA" osv-scanner
install -m 0755 osv-scanner "$BIN/osv-scanner"

{ echo "pnpm $(pnpm -v)"; "$BIN/cosign" version 2>&1 | grep -E '^GitVersion'; "$BIN/trivy" --version | head -1
  "$BIN/grype" version | grep -E '^Version'; "$BIN/osv-scanner" --version | head -1; } | tee "$OUT/versions.txt" >&2

# ---- fixtures: same canary deps (lodash 4.17.20 prod, minimist 1.2.5 dev), four root configurations
cd "$HERE/fixtures"
for d in a-plain b-packageManager c-devEngines d-configDependencies; do
  (cd "$d" && rm -f pnpm-lock.yaml && pnpm install --lockfile-only --silent >/dev/null 2>&1 && rm -rf node_modules)
  echo "$d: YAML document separators ('---' lines) = $(grep -c '^---$' "$d/pnpm-lock.yaml" || true)" >&2
done

# negative control: what a tool that reads only the FIRST YAML document sees (the boot document of fixture b)
rm -rf e-boot-doc-only && cp -r b-packageManager e-boot-doc-only
awk '/^---$/{n++} n<2' b-packageManager/pnpm-lock.yaml > e-boot-doc-only/pnpm-lock.yaml
echo "e-boot-doc-only: first document of b only ($(wc -l < e-boot-doc-only/pnpm-lock.yaml) lines)" >&2

# ---- scanners (exit codes ignored: a finding makes them non-zero)
export TRIVY_CACHE_DIR="$WORK/trivy-cache" GRYPE_DB_CACHE_DIR="$WORK/grype-db"
for d in a-plain b-packageManager c-devEngines d-configDependencies e-boot-doc-only; do
  o="$OUT/$d"; mkdir -p "$o"
  "$BIN/osv-scanner" scan source --format json --lockfile "$d/pnpm-lock.yaml" > "$o/osv.json" 2> "$o/osv.err" || true
  "$BIN/trivy" fs --quiet --scanners vuln --include-dev-deps --format json "$d" > "$o/trivy.json" 2> "$o/trivy.err" || true
  "$BIN/trivy" fs --quiet --scanners vuln --format json "$d" > "$o/trivy-nodev.json" 2>> "$o/trivy.err" || true
  "$BIN/grype" "dir:$d" -o json -q > "$o/grype.json" 2> "$o/grype.err" || true
  (cd "$d" && pnpm audit --json > "$o/pnpm-audit.json" 2> "$o/pnpm-audit.err") || true
  rm -rf "$d/node_modules"   # pnpm audit installs configDependencies
  grep -ho 'found [0-9]* packages' "$o/osv.err" > "$o/osv-inventory.txt" || true
done
python3 -I "$HERE/summarise.py" "$OUT" | tee "$OUT/summary.md"
