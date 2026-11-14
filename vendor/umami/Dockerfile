# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# Frontend pinned by digest; 1.18+ is needed for `ADD --checksum=<commit>` on git sources (1.14 rejects it).
#
# Our own Umami image, built from the pinned upstream commit (ADR-0002, ADR-0003, C-104; adopted from spike S-02).
#
#   docker buildx build --target app     -t usagemap/umami:3.5.0-d3c62a8         vendor/umami
#   docker buildx build --target migrate -t usagemap/umami-migrate:3.5.0-d3c62a8 vendor/umami
#
# Build context = this directory (vendor/umami). The Umami source is NOT in the context: the `source` stage fetches it
# from upstream git BY COMMIT SHA, and BuildKit refuses the build unless the fetched commit equals UMAMI_COMMIT
# (`ADD --checksum=<sha>`; git itself verifies every object hash). Then the patch queue (patches/*.patch, empty
# unless an emergency fix is needed) is applied.
#
# Differences from upstream's Dockerfile at d3c62a8 (details: README.md, spikes/s02-umami-hardened-image/README.md):
#  - base image pinned by digest; pnpm from a checksum-verified npm tarball, never `npm i -g`, and not in the runtime
#  - `pnpm install --frozen-lockfile` with `strictDepBuilds: true` (upstream forces it off); the lockfile's own
#    `allowBuilds` (@prisma/engines, prisma) is the reviewed list of install scripts
#  - no unlocked `pnpm add` in the runner: the migration tool-chain (prisma CLI + dotenv) is copied from the frozen
#    install (build/copy-closure.mjs) into the separate `migrate` image
#  - SKIP_BUILD_GEO=1: no GeoLite2 download, no geo/ directory in the image (C-99: callers always send cf-ipcountry)
#  - no npm, npx, corepack, yarn, pnpm, curl or apk packages in the runtime images
#  - app files owned by root and not writable by the runtime user (uid 1001); CMD is `node server.js`, so neither
#    check-db.js (migrations) nor update-tracker.js (script.js rewrite) ever runs (C-40)
#
# Targets: `migrate` (one-shot `prisma migrate deploy`) and `app` (the engine; the default/last stage).

ARG UMAMI_REPO=https://github.com/umami-software/umami.git
ARG UMAMI_COMMIT=d3c62a805beda8643cb468924dda38617fb4c286
ARG NODE_IMAGE=node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
# Set by BuildKit (amd64 | arm64); selects the pinned pnpm binary below.
ARG TARGETARCH

# ---------------------------------------------------------------- source (pinned commit, verified by BuildKit)
FROM scratch AS source
ARG UMAMI_REPO
ARG UMAMI_COMMIT
ADD --keep-git-dir=false --checksum=${UMAMI_COMMIT} ${UMAMI_REPO}#${UMAMI_COMMIT} /src

# ---------------------------------------------------------------- patched source (patch queue, normally empty)
FROM ${NODE_IMAGE} AS patched
WORKDIR /app
COPY --from=source /src/ ./
COPY patches/ /tmp/patches/
# Each patches/NNNN-*.patch is applied in order with `patch -p1`; a patch that does not apply fails the build.
# pnpm-workspace.yaml gets `strictDepBuilds: true` so that any install script outside the lockfile's allowBuilds
# list fails the install instead of depending on pnpm's default (S-02 open issue).
RUN set -eu; \
    for p in /tmp/patches/*.patch; do \
      [ -e "$p" ] || continue; \
      echo "applying $p"; patch -p1 -N -i "$p"; \
    done; \
    rm -rf /tmp/patches; \
    if grep -q '^strictDepBuilds:' pnpm-workspace.yaml; then \
      sed -i 's/^strictDepBuilds:.*/strictDepBuilds: true/' pnpm-workspace.yaml; \
    else printf '\nstrictDepBuilds: true\n' >> pnpm-workspace.yaml; fi; \
    test ! -e geo

# ---------------------------------------------------------------- pnpm (verified binary, build stages only)
# @pnpm/exe.linux-<arch>-musl@12.3.4 — the native binary the `pnpm` package (upstream's PNPM_VERSION) would fetch for
# the platform being built. One stage per architecture, selected by BuildKit's TARGETARCH; ADD --checksum refuses any
# other bytes (the SHA-256 of the registry tarball whose SHA-512 equals the registry's `dist.integrity`, checked
# 2026-11-14 against https://registry.npmjs.org/@pnpm/exe.linux-{x64,arm64}-musl/12.3.4). Any other TARGETARCH has no
# stage and fails the build.
# x64:   integrity sha512-RPmk7Jb/aYaFvL2iyDN/AtMY+hUEsue732WmXpcuQ9tBpMnGyA5py7Z3+e+qmQaJ0zY/4ni9jJiyPBQHujmv6w==
FROM ${NODE_IMAGE} AS pnpm-amd64
ADD --checksum=sha256:4ac4e7fb80b3ba4ffb0e443adab5539de7581d5da0f29501859b30785731aa0e \
    https://registry.npmjs.org/@pnpm/exe.linux-x64-musl/-/exe.linux-x64-musl-12.3.4.tgz /tmp/pnpm.tgz
# arm64: integrity sha512-FBOt0/7ye6O6q4AllVV5QMviB6qE6fqkeczV/+MDWQsmo+QJrlfsh6X7CpH/tClVpBZEyIbjpUoT8bNhCYBxEg==
FROM ${NODE_IMAGE} AS pnpm-arm64
ADD --checksum=sha256:085f6389c412105dbe18a4209ac35a2b355e85744cd5b846970bc21faa49a22c \
    https://registry.npmjs.org/@pnpm/exe.linux-arm64-musl/-/exe.linux-arm64-musl-12.3.4.tgz /tmp/pnpm.tgz

FROM pnpm-${TARGETARCH} AS pnpm
RUN tar -xzf /tmp/pnpm.tgz -C /tmp package/pnpm \
 && install -m 0755 /tmp/package/pnpm /usr/local/bin/pnpm \
 && rm -rf /tmp/pnpm.tgz /tmp/package \
 && pnpm --version

# ---------------------------------------------------------------- deps (frozen lockfile)
FROM pnpm AS deps
WORKDIR /app
ENV CI=1
COPY --from=patched /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=patched /app/packages/api-client/package.json ./packages/api-client/
COPY --from=patched /app/packages/mcp/package.json ./packages/mcp/
COPY --from=patched /app/packages/mcp/bin ./packages/mcp/bin/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- builder
FROM pnpm AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/api-client/node_modules ./packages/api-client/node_modules
COPY --from=deps /app/packages/mcp/node_modules ./packages/mcp/node_modules
COPY --from=patched /app/ ./
RUN cp docker/proxy.ts ./src
ENV NEXT_TELEMETRY_DISABLED=1 \
    DISABLE_TELEMETRY=1 \
    SKIP_BUILD_GEO=1 \
    DATABASE_URL="postgresql://user:pass@localhost:5432/dummy"
RUN pnpm build:docker && test ! -e geo
# Locked migration tool-chain: prisma CLI (+ @prisma/engines with its schema engine) and dotenv
# (prisma.config.ts imports dotenv/config), exactly as resolved by the frozen install.
COPY build/copy-closure.mjs /tmp/copy-closure.mjs
RUN node /tmp/copy-closure.mjs /app /out/migrate prisma dotenv \
 && cp -r prisma prisma.config.ts /out/migrate/ \
 && ls /out/migrate/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/ | grep -q engine

# ---------------------------------------------------------------- runtime base (shared)
FROM ${NODE_IMAGE} AS runtime
# zlib 1.3.2-r1 of the base (Alpine 3.24) carries CVE-2026-4738 (critical); 1.4-r0 is the fixed package. OpenSSL
# libcrypto3/libssl3 3.5.9-r0 carry CVE-2026-88823, -95691, -95692 and -107496 (high); 3.5.9-r1 is the fixed Alpine
# 3.24 package (v3.24/main, checked 2026-11-19). Exact pins, APKINDEX signed by the keys shipped in the base; no
# other apk package is added.
RUN apk add --no-cache --upgrade 'zlib=1.4-r0' 'libcrypto3=3.5.9-r1' 'libssl3=3.5.9-r1' && rm -rf /var/cache/apk/*
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------- migrate (one-shot deploy step, C-40)
# Separate image: the Prisma 7 CLI closure (~280 MB) is never needed by the running engine.
FROM runtime AS migrate
ARG UMAMI_COMMIT
LABEL org.opencontainers.image.title="usagemap/umami-migrate" \
      org.opencontainers.image.source="https://github.com/umami-software/umami" \
      org.opencontainers.image.revision="${UMAMI_COMMIT}" \
      org.opencontainers.image.version="3.5.0" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /opt/umami-migrate
COPY --from=builder /out/migrate ./
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
USER 1001:1001
ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

# ---------------------------------------------------------------- app (the engine; default target)
FROM runtime AS app
ARG UMAMI_COMMIT
LABEL org.opencontainers.image.title="usagemap/umami" \
      org.opencontainers.image.source="https://github.com/umami-software/umami" \
      org.opencontainers.image.revision="${UMAMI_COMMIT}" \
      org.opencontainers.image.version="3.5.0" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# Everything root-owned and read-only for uid 1001 (upstream chowns public/ so start-up can rewrite script.js).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Hardening defaults baked in (hardening.md §5.2); compose sets them again explicitly. SKIP_DB_MIGRATION is a guard
# only: our CMD never runs check-db.js.
ENV HOSTNAME=0.0.0.0 \
    PORT=3000 \
    TZ=UTC \
    DISABLE_TELEMETRY=1 \
    DISABLE_UPDATES=1 \
    PRIVATE_MODE=1 \
    SKIP_DB_MIGRATION=1 \
    SALT_ROTATION=day \
    CLIENT_IP_HEADER=x-scf-surrogate-ip
USER 1001:1001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/heartbeat').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
