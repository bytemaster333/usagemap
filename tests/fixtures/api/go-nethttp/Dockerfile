# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (tests/fixtures/api), never shipped or deployed
# API e2e fixture: the S-06b Go net/http + otelhttp app (copied from spikes/s06b…/apps/go-nethttp). The module
# files carry a .fixture suffix so the monorepo's Go tooling (go.work, `make lint`) does not treat them as a module.
FROM golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9 AS build
WORKDIR /src
COPY go.mod.fixture go.mod
COPY go.sum.fixture go.sum
COPY main.go ./
RUN GOWORK=off CGO_ENABLED=0 go build -trimpath -o /app .

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
COPY --from=build /app /usr/local/bin/app
USER 1000:1000
ENV LISTEN=0.0.0.0:8080 OTEL_SETUP=code
EXPOSE 8080
CMD ["/usr/local/bin/app"]
