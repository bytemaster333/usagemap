// SPDX-License-Identifier: Apache-2.0
// Health and metrics listener: GET /healthz (process up and scheduling), GET /readyz (every database it needs
// answers), GET /metrics (Prometheus text). Nothing else; no request data is logged.

import { createServer, type Server } from "node:http";
import type { Registry } from "./metrics.ts";

export interface HealthSource {
  live(): boolean;
  ready(): Promise<boolean>;
}

export function createHttpServer(
  health: HealthSource,
  registry: Registry,
  extra?: () => Promise<string>,
): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if (path === "/healthz") {
      const ok = health.live();
      res
        .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ status: ok ? "ok" : "stopping" }));
      return;
    }
    if (path === "/readyz") {
      health.ready().then(
        (ok) =>
          res
            .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
            .end(JSON.stringify({ status: ok ? "ready" : "unavailable" })),
        () =>
          res
            .writeHead(503, { "content-type": "application/json" })
            .end(JSON.stringify({ status: "unavailable" })),
      );
      return;
    }
    if (path === "/metrics") {
      const more = extra ? extra().catch(() => "") : Promise.resolve("");
      void more.then((m) =>
        res
          .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
          .end(m ? `${registry.render()}${m}\n` : registry.render()),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end('{"status":"not_found"}');
  });
}
