# syntax=docker/dockerfile:1
# SPDX-License-Identifier: Apache-2.0
# S-02: our own Umami v3.5.0 image, built from the pinned upstream commit.
#
# Build context  = the Umami source checked out at UMAMI_COMMIT (run.sh verifies the SHA).
# Named context  "scf" = ./build in this spike directory (helper script).
#
# Differences from upstream's Dockerfile at d3c62a8:
#  - base image pinned by digest; pnpm taken from a checksum-verified npm tarball, not `npm i -g`
#  - `pnpm install --frozen-lockfile` with pnpm's default strictDepBuilds (upstream forces it off)
#  - no unlocked `pnpm add` in the runner: the migration tool-chain (prisma CLI + dotenv) is copied
#    from the frozen install (build/copy-closure.mjs) into /opt/umami-migrate
#  - SKIP_BUILD_GEO=1: no GeoLite2 download, no geo/ directory in the image
#  - no npm, npx, corepack, yarn, pnpm, curl or apk packages in the runner
#  - app files owned by root and not writable by the runtime user; CMD is `node server.js` directly,
#    so neither check-db.js (migrations) nor update-tracker.js (script.js rewrite) runs at start

ARG NODE_IMAGE=node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

# ---------------------------------------------------------------- pnpm (verified binary)
FROM ${NODE_IMAGE} AS pnpm
# @pnpm/exe.linux-x64-musl@12.3.4, the native binary the `pnpm` package would fetch at install.
ARG PNPM_TGZ_URL=https://registry.npmjs.org/@pnpm/exe.linux-x64-musl/-/exe.linux-x64-musl-12.3.4.tgz
ARG PNPM_TGZ_SHA512=44f9a4ec96ff698685bcbda2c8337f02d318fa1504b2e7bbdf65a65e972e43db41a4c9c6c80e69cbb677f9efaa990689d3363fe278bd8c98b23c1407ba39afeb
RUN wget -q -O /tmp/pnpm.tgz "$PNPM_TGZ_URL" \
 && echo "$PNPM_TGZ_SHA512  /tmp/pnpm.tgz" | sha512sum -c - \
 && tar -xzf /tmp/pnpm.tgz -C /tmp \
 && install -m 0755 /tmp/package/pnpm /usr/local/bin/pnpm \
 && rm -rf /tmp/pnpm.tgz /tmp/package \
 && pnpm --version

# ---------------------------------------------------------------- deps (frozen lockfile)
FROM pnpm AS deps
WORKDIR /app
ENV CI=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api-client/package.json ./packages/api-client/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/mcp/bin ./packages/mcp/bin/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- builder
FROM pnpm AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/api-client/node_modules ./packages/api-client/node_modules
COPY --from=deps /app/packages/mcp/node_modules ./packages/mcp/node_modules
COPY . .
COPY docker/proxy.ts ./src
ENV NEXT_TELEMETRY_DISABLED=1 \
    DISABLE_TELEMETRY=1 \
    SKIP_BUILD_GEO=1 \
    DATABASE_URL="postgresql://user:pass@localhost:5432/dummy"
RUN pnpm build:docker && test ! -e geo
# Locked migration tool-chain: prisma CLI (+ @prisma/engines with its schema engine) and dotenv
# (prisma.config.ts imports dotenv/config), exactly as resolved by the frozen install.
COPY --from=scf copy-closure.mjs /tmp/copy-closure.mjs
RUN node /tmp/copy-closure.mjs /app /out/migrate prisma dotenv \
 && cp -r prisma prisma.config.ts /out/migrate/ \
 && ls /out/migrate/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/ | grep -q engine

# ---------------------------------------------------------------- runtime base (shared)
FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------- migrate (one-shot deploy step)
# Separate image: the Prisma 7 CLI closure (studio, pglite, typescript, effect ...) is ~280 MB and
# the running engine never needs it. Command: `prisma migrate deploy` (what check-db.js runs upstream).
FROM runtime AS migrate
WORKDIR /opt/umami-migrate
COPY --from=builder /out/migrate ./
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
USER 1001:1001
ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

# ---------------------------------------------------------------- app (default target)
FROM runtime AS app
WORKDIR /app
# Everything root-owned and read-only for uid 1001 (upstream chowns public/ so start-up can rewrite script.js).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
ENV HOSTNAME=0.0.0.0 \
    PORT=3000
USER 1001:1001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/heartbeat').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
