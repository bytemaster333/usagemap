# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# SPDX-License-Identifier: Apache-2.0
# ci-context: .
#
# scf-otelcol image: the ocb-built distribution (builder-config.yaml) on an empty base.
# Build from the repository root (the processor links packages/pathnorm):
#   docker build -f collector/Dockerfile -t scf-otelcol:dev .
# Runtime contract: non-root (65532), read-only root filesystem, the persistent queue
# (/var/lib/scf-otelcol/queue) is the only writable path — mount a volume there.

# golang:1.27.4-trixie, pinned by digest (amd64/arm64 index).
ARG GO_IMAGE=golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9

FROM ${GO_IMAGE} AS build
# ocb v0.165.0 for linux/amd64 and linux/arm64: SHA-256 from the release's ocb_<v>_linux_<arch>.sha256 files,
# Sigstore bundles verified (collector/README.md, scripts/build.sh). ADD --checksum refuses any other bytes; the
# binary for the platform being built is selected by TARGETARCH.
ARG OCB_VERSION=0.165.0
ARG TARGETARCH
ADD --checksum=sha256:6fd899cf8794803bb0d9ea0a055fdaabd2e7e8304de3872fd9aaec3f0cd7f18c \
    https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/cmd%2Fbuilder%2Fv${OCB_VERSION}/ocb_${OCB_VERSION}_linux_amd64 \
    /opt/ocb/amd64
ADD --checksum=sha256:60796ab92c4becb5a2f54da5dff36e8127e69ea42daca4798b711d9b5c0f3002 \
    https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/cmd%2Fbuilder%2Fv${OCB_VERSION}/ocb_${OCB_VERSION}_linux_arm64 \
    /opt/ocb/arm64
RUN case "${TARGETARCH}" in amd64|arm64) ;; *) echo "no pinned ocb for ${TARGETARCH}" >&2; exit 1 ;; esac \
 && install -m 0755 "/opt/ocb/${TARGETARCH}" /usr/local/bin/ocb \
 && rm -rf /opt/ocb

WORKDIR /src
COPY packages/pathnorm/ packages/pathnorm/
COPY collector/builder-config.yaml collector/
COPY collector/processor/ collector/processor/
WORKDIR /src/collector
# GOWORK=off: no go.work in the image anyway; -trimpath and -buildvcs=false keep the binary independent of
# the checkout, so two builds of the same commit with the same toolchain produce the same bytes.
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOWORK=off CGO_ENABLED=0 GOFLAGS="-buildvcs=false -trimpath" ocb --config builder-config.yaml \
 && install -D -m 0555 _build/scf-otelcol /out/scf-otelcol \
 && install -d -m 0700 -o 65532 -g 65532 /out/var/lib/scf-otelcol/queue

FROM scratch
COPY --from=build /out/scf-otelcol /scf-otelcol
COPY --from=build --chown=65532:65532 /out/var/lib/scf-otelcol /var/lib/scf-otelcol
COPY collector/config/collector.yaml /etc/scf-otelcol/collector.yaml
USER 65532:65532
VOLUME ["/var/lib/scf-otelcol/queue"]
# OTLP gRPC / HTTP (bind to an internal address via SCF_OTLP_*_ENDPOINT), health, self-metrics.
EXPOSE 4317 4318 13133 8888
ENTRYPOINT ["/scf-otelcol"]
CMD ["--config=/etc/scf-otelcol/collector.yaml"]
