# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# Engine proxy and umami-bootstrap (stdlib-only Go; build context = services/engine-proxy).
#   docker build -t usagemap/engine-proxy:dev services/engine-proxy
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329

FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOWORK=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN go vet ./... \
 && go build -trimpath -ldflags="-s -w -buildid=" -o /out/engine-proxy ./cmd/engine-proxy \
 && go build -trimpath -ldflags="-s -w -buildid=" -o /out/umami-bootstrap ./cmd/umami-bootstrap

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="usagemap/engine-proxy" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/engine-proxy /out/umami-bootstrap /usr/local/bin/
USER 65532:65532
EXPOSE 8443 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/usr/local/bin/engine-proxy", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/engine-proxy"]
