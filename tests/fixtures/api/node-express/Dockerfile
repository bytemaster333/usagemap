# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (tests/fixtures/api), never shipped or deployed
# API e2e fixture: the S-06a Express app with in-SDK dual export (copied from spikes/s06a…/apps/express).
FROM node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && printf 'minimumReleaseAge: 0\nallowBuilds:\n  protobufjs: false\n' > pnpm-workspace.yaml \
 && pnpm install --frozen-lockfile --prod
COPY app.mjs otel.mjs ./
USER 1000:1000
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "--import", "./otel.mjs", "app.mjs"]
