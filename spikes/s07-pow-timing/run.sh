#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-07 — PoW solve-time distributions under emulated slow CPUs.  Re-run: ./run.sh   (~45 min, Docker needed)
# 1. build + size the solver;  2. Chromium with DevTools Emulation.setCPUThrottlingRate 1/4/6x (what the plan asked;
#    shown here NOT to reach Web Workers or WebCrypto);  3. Chromium and WebKit under a cgroup CPU quota of 1, 1/4 and
#    1/6 of one core (throttles every thread).  All browsers run in the pinned Playwright image, project scf-s07,
#    no published ports.  N (samples per cell) defaults to 25.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
eval "$(cd "$REPO" && mise env -s bash)"
cd "$HERE"
N="${N:-25}"
pnpm install --frozen-lockfile >/dev/null
node build.mjs
export UID_GID="$(id -u):$(id -g)" HOST_CPU="$(lscpu | sed -n 's/^Model name: *//p') x$(nproc)"
dc() { docker compose -p scf-s07 run --rm bench "$@"; }
trap 'docker compose -p scf-s07 down -v >/dev/null 2>&1 || true' EXIT

# DevTools throttling, container not CPU-limited
CPUS="$(nproc)" OUT=devtools-chromium dc node bench.mjs chromium "$N" 1,4,6 worker,main

# cgroup quota: 1 core = "1x", 0.25 core = "4x", 0.1667 core = "6x"
export SETTINGS="128x1024x1,256x512x1,256x1024x1,512x512x1,512x1024x1,1024x512x1,1024x1024x1,2048x256x1,256x1024x4,512x1024x4,1024x1024x4,512x2048x4,512x4096x4,512x8192x4"
for b in chromium webkit; do
  for q in "1x:1.0" "4x:0.25" "6x:0.1667"; do
    CPUS="${q#*:}" OUT="quota${q%%:*}-$b" dc node bench.mjs "$b" "$N" 1 worker,main
  done
done
python3 -I summarise.py results | tee results/summary.md
