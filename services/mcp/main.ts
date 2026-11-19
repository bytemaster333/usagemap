// SPDX-License-Identifier: Apache-2.0
// Hosted UsageMap MCP server (Streamable HTTP; src/http.ts). Configuration: src/config.ts. Logs: JSON lines on stdout.

import { readFileSync } from "node:fs";
import { loadConfig } from "./src/config.ts";
import { createMcpHttpServer, jsonLogger } from "./src/http.ts";

const log = jsonLogger();
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (e) {
  log("error", "bad configuration", { error: (e as Error).message });
  process.exit(2);
}
const version = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const server = createMcpHttpServer({ config, version, log });
server.listen(config.port, config.host, () => {
  log("info", "listening", {
    host: config.host,
    port: config.port,
    path: config.path,
    version,
    upstream: new URL(config.controlPlaneUrl).origin,
    oauth: config.oauth ? { resource: config.oauth.resource, issuer: config.oauth.issuer } : false,
  });
});

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("info", "stopping", { signal });
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
