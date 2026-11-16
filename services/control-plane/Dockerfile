# SPDX-License-Identifier: Apache-2.0
# Control plane image. Build with the REPOSITORY ROOT as context:
#   docker build -f services/control-plane/Dockerfile -t usagemap/control-plane:dev .
# Runtime: non-root (uid 1000 `node`), works with a read-only root filesystem (writes nothing; /tmp may be tmpfs).
# Ports: 8080 public API (GET /healthz, /readyz), 8081 internal edge API (only for the engine proxies, C-60; mutual TLS
# unless bound to loopback, C-114).
#
# Supply chain: pnpm is not fetched by corepack. The build stage takes pnpm's native binary
# from the npm registry as a tarball pinned by SHA-256 (`ADD --checksum`; the same bytes as the registry's sha512
# integrity), one per target architecture; the version equals the root package.json `packageManager`. The runtime
# image carries neither npm, npx, corepack nor yarn.
# Node 24.22.2: 24.19.0 carries CVE-2026-111497 (critical) and CVE-2026-105482/105483/106069 (fixed in 24.22.1).
ARG NODE_IMAGE=node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc
# Set by BuildKit (amd64 | arm64); selects the pinned pnpm binary below.
ARG TARGETARCH

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
COPY packages/api-types/package.json packages/api-types/
COPY packages/umami-adapter/package.json packages/umami-adapter/
COPY services/control-plane/package.json services/control-plane/
RUN pnpm install --frozen-lockfile --filter @usagemap/control-plane... --ignore-scripts
COPY packages/api-types/src packages/api-types/src
COPY packages/umami-adapter/src packages/umami-adapter/src
COPY services/control-plane/src services/control-plane/src
COPY services/control-plane/scripts services/control-plane/scripts
RUN node services/control-plane/scripts/build.ts

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# zlib 1.3.2-r1 of the base carries CVE-2026-4738 (critical); 1.4-r0 is the fixed Alpine 3.23 package (exact pin).
RUN apk add --no-cache --upgrade 'zlib=1.4-r0' && rm -rf /var/cache/apk/*
# The bundle needs Node.js only: remove the package managers the base image ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build /src/services/control-plane/dist/ /app/
COPY LICENSE NOTICE /app/
USER node
EXPOSE 8080 8081
ENTRYPOINT ["node", "/app/main.mjs"]
