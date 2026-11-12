# Test-only sidecar: tcpdump inside Umami's network namespace to prove there is no outbound traffic.
ARG NODE_IMAGE=node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
FROM ${NODE_IMAGE}
RUN apk add --no-cache tcpdump
