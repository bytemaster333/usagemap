# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# scf-ops: probe sources, SLO report generator, status page, log scanner. Standard library only; links the
# gateway's protocol-level probe client (services/gateway/pkg/probe). Build with the REPOSITORY ROOT as context:
#   docker build -f ops/Dockerfile -t usagemap/ops:dev .
# ci-context: .
# Runtime: distroless static, uid 65532, read-only root; writable paths are volumes (raw probe store, status output).
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329

FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOWORK=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY packages/pathnorm/go.mod packages/pathnorm/
COPY services/gateway/go.mod services/gateway/
COPY services/gateway/pkg/probe/ services/gateway/pkg/probe/
COPY ops/go.mod ops/
COPY ops/cmd/ ops/cmd/
COPY ops/internal/ ops/internal/
RUN cd ops && go vet ./cmd/... \
 && go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/scf-ops ./cmd/scf-ops \
 && mkdir -p /out/var/probes /out/var/www

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="usagemap/ops" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/scf-ops /usr/local/bin/scf-ops
COPY --from=build --chown=65532:65532 /out/var/probes /var/lib/scf-probes
COPY --from=build --chown=65532:65532 /out/var/www /var/lib/scf-status/www
COPY LICENSE NOTICE /usr/share/doc/scf-ops/
USER 65532:65532
EXPOSE 8080 9480
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["/usr/local/bin/scf-ops", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/scf-ops"]
