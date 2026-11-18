#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Install the spike's pinned dependencies without lifecycle scripts, and vendor the Stellar Wallets Kit 2.8.0 tarball
# without its 300+ transitive wallet SDKs (only its `/sdk` core is used: preact, htm, @preact/signals, twind).
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --ignore-scripts --no-audit --no-fund --no-package-lock
mkdir -p vendor-swk && cd vendor-swk
[ -f creit.tech-stellar-wallets-kit-2.8.0.tgz ] || npm pack @creit.tech/stellar-wallets-kit@2.8.0 --silent
rm -rf package && tar xzf creit.tech-stellar-wallets-kit-2.8.0.tgz
