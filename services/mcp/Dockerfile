# SPDX-License-Identifier: Apache-2.0
# Hosted MCP server image (Streamable HTTP, https://app.usagemap.dev/mcp). Build with the REPOSITORY ROOT as context:
#   docker build -f services/mcp/Dockerfile -t usagemap/mcp:dev .
# No dependencies and no build step: Node.js runs the TypeScript sources directly (type stripping; the sources use
# erasable syntax only). The tool registry is shared with the local stdio server (tools/mcp/src).
# Runtime: non-root (uid 1000 `node`), read-only root filesystem (writes nothing, needs no /tmp). Every call runs with
# the caller's own key, or — OAuth — with a short-lived control-plane token exchanged for the caller's access token; the
# only secret is that exchange client's (MCP_OAUTH_EXCHANGE_SECRET_FILE, optional). Port 8080: POST /mcp, GET /healthz,
# GET /.well-known/oauth-protected-resource[/mcp] (with OAuth).
# Same pinned Node.js base as the control plane (services/control-plane/Dockerfile: CVE notes for 24.22.x).
ARG NODE_IMAGE=node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# zlib 1.3.2-r1 of the base carries CVE-2026-4738 (critical); 1.4-r0 is the fixed Alpine 3.23 package (exact pin).
RUN apk add --no-cache --upgrade 'zlib=1.4-r0' && rm -rf /var/cache/apk/*
# Node.js only: remove the package managers the base image ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY tools/mcp/package.json /app/tools/mcp/package.json
COPY tools/mcp/src /app/tools/mcp/src
COPY services/mcp/package.json services/mcp/main.ts /app/services/mcp/
COPY services/mcp/src /app/services/mcp/src
COPY LICENSE NOTICE /app/
USER node
ENV MCP_LISTEN_HOST=0.0.0.0 MCP_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/services/mcp/main.ts"]
