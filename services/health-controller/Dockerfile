# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# Health controller (C-92) and the fake DNS provider used by tests and the Compose overlay. Standard library only; links
# the gateway's protocol-level probe client (services/gateway/pkg/probe). Build with the REPOSITORY ROOT as context:
#   docker build -f services/health-controller/Dockerfile -t usagemap/health-controller:dev .
# ci-context: .
# Runtime: distroless static, uid 65532, read-only root; no writable path (state lives in memory and in etcd).
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329

FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOWORK=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY packages/pathnorm/go.mod packages/pathnorm/
COPY services/gateway/go.mod services/gateway/
COPY services/gateway/pkg/probe/ services/gateway/pkg/probe/
COPY services/health-controller/ services/health-controller/
RUN cd services/health-controller && go vet ./cmd/... ./internal/... \
 && go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/health-controller ./cmd/health-controller \
 && go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/fake-dns-provider ./cmd/fake-dns-provider

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="usagemap/health-controller" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/health-controller /out/fake-dns-provider /usr/local/bin/
COPY LICENSE NOTICE /usr/share/doc/scf-health-controller/
USER 65532:65532
EXPOSE 9470 9471
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/usr/local/bin/health-controller", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/health-controller"]
