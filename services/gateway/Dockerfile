# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# Web ingest gateway: gateway, probe and rangelist-updater binaries, the tracker built from source (C-100) and
# the DB-IP Lite country database pinned by SHA-256 (C-106). Build with the REPOSITORY ROOT as context:
#   docker build -f services/gateway/Dockerfile -t usagemap/gateway:dev .
# Runtime: distroless static, uid 65532, read-only root friendly; writable state only in /var/lib/scf-gateway
# (volume: snapshot + spool) and, for the updater, /var/lib/scf-rangelists. Range lists are never in the image (C-38).
ARG NODE_IMAGE=node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
ARG TARGETARCH

# --- pnpm, pinned by SHA-256 (same bytes as the registry's sha512 integrity; see services/control-plane/Dockerfile)
FROM ${NODE_IMAGE} AS pnpm-amd64
ADD --checksum=sha256:62350ea0f33a20a1d60e821ef3bae9a2f0ff4c3dc0f2b38ec36ba60350d3fe1b \
    https://registry.npmjs.org/@pnpm/exe.linux-x64-musl/-/exe.linux-x64-musl-12.19.0.tgz /pnpm.tgz
FROM ${NODE_IMAGE} AS pnpm-arm64
ADD --checksum=sha256:3da41041c7813d65dc19d5098d14f2516203bab8d08be28c7cc81f9285d1ce3e \
    https://registry.npmjs.org/@pnpm/exe.linux-arm64-musl/-/exe.linux-arm64-musl-12.19.0.tgz /pnpm.tgz
FROM pnpm-${TARGETARCH} AS pnpm
RUN tar -xzf /pnpm.tgz -C /tmp package/pnpm && install -m 0755 /tmp/package/pnpm /usr/local/bin/pnpm \
 && rm -rf /tmp/package /pnpm.tgz

# --- tracker, built from source (dist/ is not in git; the gateway serves exactly these bytes)
FROM ${NODE_IMAGE} AS tracker
COPY --from=pnpm /usr/local/bin/pnpm /usr/local/bin/pnpm
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY tracker/package.json tracker/
RUN pnpm install --frozen-lockfile --filter @usagemap/tracker --ignore-scripts
COPY tracker/tsconfig.json tracker/tsconfig.types.json tracker/
COPY tracker/scripts tracker/scripts
COPY tracker/src tracker/src
# released versions (tracker.intentional-upgrade): archived bytes, verified against their manifests and served next to the current one
COPY tracker/releases tracker/releases
# The two ingest origins compiled into the tracker (tracker/scripts/build-config.ts). Empty = the release defaults
# (and the archived releases are served too); a deployment passes its own names, e.g.
#   docker build --build-arg TRACKER_HOSTS=https://e1.example.org,https://e2.example.org …
# — such a build carries only the current version (released bytes name other hosts and are never rebuilt).
ARG TRACKER_HOSTS=""
RUN cd tracker && TRACKER_HOSTS="${TRACKER_HOSTS}" node scripts/build.ts && node scripts/check-output.ts \
 && mkdir -p /out && cp -r dist /out/tracker && rm -rf /out/tracker/npm

# --- geo database: DB-IP IP to Country Lite (CC BY 4.0), pinned by SHA-256 (.gz and .mmdb), refreshed monthly
FROM ${GO_IMAGE} AS geo
ADD --checksum=sha256:75fe430010f6d38a8c4331c202bf0df6ce3221a6e6d823b9e5a6d951e4cf9758 \
    https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz /geo/dbip-country-lite.mmdb.gz
RUN cd /geo && gunzip dbip-country-lite.mmdb.gz \
 && echo "145ce5dfb812d8de28547e6289bb5c5f8b3df2f1dea21d324d5b575e0431311f  dbip-country-lite.mmdb" | sha256sum -c - \
 && chmod 0444 dbip-country-lite.mmdb

# --- Go binaries (stdlib-first; maxminddb-golang/v2 ISC, golang.org/x/sys BSD-3; links packages/pathnorm)
FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOWORK=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY packages/pathnorm/ packages/pathnorm/
COPY services/gateway/go.mod services/gateway/go.sum services/gateway/
RUN cd services/gateway && go mod download && go mod verify
COPY services/gateway/ services/gateway/
RUN cd services/gateway && go vet ./... \
 && go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/gateway ./cmd/gateway \
 && go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/probe ./cmd/probe \
 && go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/rangelist-updater ./cmd/rangelist-updater \
 && mkdir -p /out/state/spool /out/rangelists

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="usagemap/gateway" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/gateway /out/probe /out/rangelist-updater /usr/local/bin/
COPY --from=tracker /out/tracker /usr/share/scf-gateway/tracker
COPY --from=geo /geo/dbip-country-lite.mmdb /usr/share/scf-gateway/geo/dbip-country-lite.mmdb
COPY --from=build --chown=65532:65532 /out/state /var/lib/scf-gateway
COPY --from=build --chown=65532:65532 /out/rangelists /var/lib/scf-rangelists
COPY LICENSE NOTICE /usr/share/doc/scf-gateway/
ENV GW_TRACKER_DIR=/usr/share/scf-gateway/tracker \
    GW_GEO_DB=/usr/share/scf-gateway/geo/dbip-country-lite.mmdb \
    GW_GEO_SHA256=145ce5dfb812d8de28547e6289bb5c5f8b3df2f1dea21d324d5b575e0431311f \
    GW_STATE_DIR=/var/lib/scf-gateway \
    GW_RANGELISTS_DIR=/var/lib/scf-rangelists
USER 65532:65532
VOLUME ["/var/lib/scf-gateway"]
EXPOSE 8443 9443 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["/usr/local/bin/gateway", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/gateway"]
