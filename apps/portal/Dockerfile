# SPDX-License-Identifier: Apache-2.0
# Portal image (ADR-0024): the static SPA served by Caddy, which also reverse-proxies the control-plane API on the same
# origin. Build with the REPOSITORY ROOT as context:
#   docker build -f apps/portal/Dockerfile -t usagemap/portal:dev .
# Runtime: non-root (uid/gid 65532), no capabilities needed (port 8080), works with a read-only root filesystem
# (Caddy writes nothing: admin API, autosave and automatic HTTPS are off; XDG dirs point at /tmp, which may be tmpfs).
# Environment: SCF_PORTAL_PORT (8080), SCF_PORTAL_SCHEME (https | http — http only for a local stack on localhost),
# SCF_CONTROL_PLANE_UPSTREAM (control-plane:8080). See server/Caddyfile.
#
# Supply chain: both base images pinned by digest; pnpm's native binary is fetched as a registry tarball pinned by
# SHA-256 (same pin as services/control-plane/Dockerfile); `pnpm install --frozen-lockfile --ignore-scripts`.
ARG NODE_IMAGE=node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc
# Caddy 2.11.9 (Apache-2.0): the official image supplies the runtime layout (Alpine, wget for the health check); its
# binary is replaced by apps/portal/caddy built from source with the pinned Go (the upstream binary was built with Go
# 1.27.3, golang.org/x/net v0.60.0 and klauspost/compress v1.20.1, which carry reachable HIGH advisories).
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG TARGETARCH

# @pnpm/exe.linux-x64-musl@12.19.0 (MIT)
FROM ${NODE_IMAGE} AS pnpm-amd64
ADD --checksum=sha256:62350ea0f33a20a1d60e821ef3bae9a2f0ff4c3dc0f2b38ec36ba60350d3fe1b \
    https://registry.npmjs.org/@pnpm/exe.linux-x64-musl/-/exe.linux-x64-musl-12.19.0.tgz /pnpm.tgz

# @pnpm/exe.linux-arm64-musl@12.19.0 (MIT)
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
COPY apps/portal/package.json apps/portal/
RUN pnpm install --frozen-lockfile --filter @usagemap/portal... --ignore-scripts
COPY packages/api-types/src packages/api-types/src
COPY apps/portal/index.html apps/portal/vite.config.ts apps/portal/tsconfig.json apps/portal/
COPY apps/portal/src apps/portal/src
COPY apps/portal/server apps/portal/server
COPY apps/portal/scripts apps/portal/scripts
# The published measurement methodology, rendered at build time to /docs/methodology/<semver> (plan C1 #6).
COPY docs/methodology docs/methodology
# The Caddy header files must match server/headers.ts (fails the build when they are stale).
RUN cd apps/portal && node scripts/gen-caddy.ts --check && node_modules/.bin/vite build

# Caddy from source: go.mod pins upstream v2.11.9 and the fixed dependency releases; go.sum and the Go checksum
# database verify every module (GOFLAGS=-mod=readonly, GOSUMDB on by default).
FROM ${GO_IMAGE} AS caddy
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY apps/portal/caddy/go.mod apps/portal/caddy/go.sum apps/portal/caddy/go.work apps/portal/caddy/go.work.sum ./
RUN go mod download
COPY apps/portal/caddy/main.go ./
RUN go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/caddy . && /out/caddy version

FROM ${CADDY_IMAGE}
# zlib 1.3.2-r1 of the base carries CVE-2026-4738 (critical); 1.4-r0 is the fixed Alpine 3.24 package. OpenSSL
# libcrypto3/libssl3 3.5.9-r0 carry CVE-2026-88823, -95691, -95692 and -107496 (high); 3.5.9-r1 is the fixed Alpine
# 3.24 package (v3.24/main, checked 2026-11-19). APKINDEX signed by the keys shipped in the base; an exact pin fails
# the build instead of drifting.
RUN apk add --no-cache --upgrade 'zlib=1.4-r0' 'libcrypto3=3.5.9-r1' 'libssl3=3.5.9-r1' && rm -rf /var/cache/apk/*
COPY --from=caddy /out/caddy /usr/bin/caddy
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data \
    SCF_PORTAL_PORT=8080 SCF_PORTAL_SCHEME=https SCF_CONTROL_PLANE_UPSTREAM=control-plane:8080
COPY apps/portal/server/Caddyfile apps/portal/server/headers-http.caddy apps/portal/server/headers-https.caddy /etc/caddy/
COPY --from=build /src/apps/portal/dist/ /srv/portal/
COPY LICENSE NOTICE /srv/
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/portal-healthz"]
ENTRYPOINT ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
