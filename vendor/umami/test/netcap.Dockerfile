# ci-scan: skip test-only tcpdump sidecar of vendor/umami/test/hardening-check.sh, never deployed
# SPDX-License-Identifier: Apache-2.0
# Test-only sidecar: tcpdump inside Umami's network namespace to prove there is no outbound traffic (S-02).
ARG NODE_IMAGE=node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
FROM ${NODE_IMAGE}
RUN apk add --no-cache tcpdump
