# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# onchain-reader (build context = services/onchain-reader): the ledger-file reader and fetcher of the on-chain
# correlation (primary source, C-136; wire-formats §p, §p.1).
#   docker build -t usagemap/onchain-reader:dev services/onchain-reader
#   docker build --target lakegen -t usagemap/onchain-lakegen:dev services/onchain-reader   # local stack's fixture mirror
# Dependencies are fetched by the Go toolchain and verified against go.sum (GOFLAGS=-mod=readonly). Runtime: distroless
# static, uid 65532, no shell; a batch command (no port) that reads ledger files from a mount and writes JSON lines to
# stdout (`fetch` writes the mirror only), so it runs with a read-only root filesystem.
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
 && go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/onchain-reader ./cmd/onchain-reader

# Local stack only (infra/compose service onchain-fixture): the synthetic demo mirror, never a production image. Not
# built by a default build (BuildKit builds only the stages the target needs).
FROM build AS lakegen-build
RUN go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/lakegen ./internal/fixture/lakegen \
 && mkdir -p /out/ledgers

FROM ${RUNTIME_IMAGE} AS lakegen
LABEL org.opencontainers.image.title="usagemap/onchain-lakegen" \
      org.opencontainers.image.description="Synthetic ledger-file mirror for the local stack (test fixture)" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=lakegen-build /out/lakegen /usr/local/bin/lakegen
# The mount point of the compose volume: a new named volume takes this directory's owner.
COPY --from=lakegen-build --chown=65532:65532 /out/ledgers /ledgers
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/lakegen"]

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="usagemap/onchain-reader" \
      org.opencontainers.image.description="Daily per-contract Soroban invocation counts from public Stellar ledger data files" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/onchain-reader /usr/local/bin/onchain-reader
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/onchain-reader"]
