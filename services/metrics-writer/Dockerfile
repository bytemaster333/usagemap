# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# metrics-writer (build context = services/metrics-writer).
#   docker build -t usagemap/metrics-writer:dev services/metrics-writer
# Dependencies are fetched by the Go toolchain and verified against go.sum (GOFLAGS=-mod=readonly, GONOSUMDB unset:
# the checksum database is consulted for anything not in go.sum). Runtime: distroless static, uid 65532, no shell;
# runs with a read-only root filesystem (it writes nothing to disk).
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329

FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOWORK=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
RUN go vet ./cmd/... ./internal/... \
 && go build -trimpath -ldflags="-s -w -buildid=" -o /out/metrics-writer ./cmd/metrics-writer

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="usagemap/metrics-writer" \
      org.opencontainers.image.description="OTLP metrics from the Collectors (mutual TLS) into PostgreSQL as scf_writer" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/metrics-writer /usr/local/bin/metrics-writer
USER 65532:65532
EXPOSE 4319 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/usr/local/bin/metrics-writer", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/metrics-writer"]
