# SPDX-License-Identifier: Apache-2.0
# Jobs service image. Build with the REPOSITORY ROOT as context:
#   docker build -f services/jobs/Dockerfile -t usagemap/jobs:dev .
# Runtime: non-root (uid 1000 `node`), read-only root filesystem friendly (writes nothing to disk), no package
# managers. Port 8080: GET /healthz, /readyz, /metrics. Configuration and secrets: see services/jobs/README.md.
#
# Supply chain (as services/control-plane/Dockerfile): base image pinned by digest; pnpm's native binary from the npm
# registry as a tarball pinned by SHA-256 (`ADD --checksum`), one per target architecture, version = the root
# package.json `packageManager`; frozen lockfile; install scripts off.
# Job onchain_correlation runs the on-chain fallback reader (services/onchain-reader, C-42, C-128) as a child process:
# it is built here from source in a Go stage (modules verified against go.sum) and copied in as a static binary.
# Node 24.22.2: 24.19.0 carries CVE-2026-111497 (critical) and CVE-2026-105482/105483/106069 (fixed in 24.22.1).
ARG NODE_IMAGE=node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG TARGETARCH

FROM ${GO_IMAGE} AS onchain-reader
WORKDIR /src
ENV CGO_ENABLED=0 GOWORK=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY services/onchain-reader/go.mod services/onchain-reader/go.sum ./
RUN go mod download && go mod verify
COPY services/onchain-reader/cmd ./cmd
COPY services/onchain-reader/internal ./internal
RUN go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/onchain-reader ./cmd/onchain-reader

# @pnpm/exe.linux-x64-musl@12.19.0 (MIT), integrity sha512-2IJD+LBqnrwAInPSlhm5Z4l8qXUEG3L/zPmAy1amx8Mw/d+SYOoeI4X61eML1m4UD9mjrePF76M6Z+DEbLv/mg==
FROM ${NODE_IMAGE} AS pnpm-amd64
ADD --checksum=sha256:62350ea0f33a20a1d60e821ef3bae9a2f0ff4c3dc0f2b38ec36ba60350d3fe1b \
    https://registry.npmjs.org/@pnpm/exe.linux-x64-musl/-/exe.linux-x64-musl-12.19.0.tgz /pnpm.tgz

# @pnpm/exe.linux-arm64-musl@12.19.0 (MIT), integrity sha512-qWBJJrY084dmXordzdjL8C4drTHEU6dhbJ4ZupTChg9DKbWSKhVxJwTZXzUwFNmbo/TTAIQ8pFic8YCr0fIczg==
FROM ${NODE_IMAGE} AS pnpm-arm64
ADD --checksum=sha256:3da41041c7813d65dc19d5098d14f2516203bab8d08be28c7cc81f9285d1ce3e \
    https://registry.npmjs.org/@pnpm/exe.linux-arm64-musl/-/exe.linux-arm64-musl-12.19.0.tgz /pnpm.tgz

FROM pnpm-${TARGETARCH} AS pnpm
RUN tar -xzf /pnpm.tgz -C /tmp package/pnpm && install -m 0755 /tmp/package/pnpm /usr/local/bin/pnpm \
 && rm -rf /tmp/package /pnpm.tgz

FROM ${NODE_IMAGE} AS build
COPY --from=pnpm /usr/local/bin/pnpm /usr/local/bin/pnpm
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/jobs/package.json services/jobs/
COPY packages/umami-adapter/package.json packages/umami-adapter/
COPY packages/api-types/package.json packages/api-types/
# The control plane's former in-process workers (F16) are bundled from its package (`/workers` export).
COPY services/control-plane/package.json services/control-plane/
RUN pnpm install --frozen-lockfile --filter @usagemap/jobs... --ignore-scripts
COPY packages/umami-adapter/src packages/umami-adapter/src
COPY packages/api-types/src packages/api-types/src
COPY services/control-plane/src services/control-plane/src
COPY services/jobs/src services/jobs/src
COPY services/jobs/scripts services/jobs/scripts
RUN node services/jobs/scripts/build.ts

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# zlib 1.3.2-r1 of the base carries CVE-2026-4738 (critical); 1.4-r0 is the fixed Alpine 3.23 package (exact pin).
RUN apk add --no-cache --upgrade 'zlib=1.4-r0' && rm -rf /var/cache/apk/*
# The bundle needs Node.js only: remove the package managers the base image ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build /src/services/jobs/dist/ /app/
COPY --from=onchain-reader /out/onchain-reader /usr/local/bin/onchain-reader
COPY LICENSE NOTICE /app/
# Mount point of the on-chain ledger mirror (SCF_ONCHAIN_LEDGER_DIR, infra/compose volume `ledgers`): owned by node so
# that a new named volume takes this owner and the fetch step can write into it on a read-only root file system.
RUN mkdir -p /srv/ledgers && chown node:node /srv/ledgers
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SCF_JOBS_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/main.mjs"]
