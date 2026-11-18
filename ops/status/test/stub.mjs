// SPDX-License-Identifier: Apache-2.0
// Stand-in for the public endpoints in the Gatus integration test (gatus-it.sh): /<mode>/<path>.
//   good  → gateway /healthz 200 {"status":"ok"} at once
//   slow  → the same after 2.5 s (over the 2-second ingest threshold)
//   sick  → gateway /healthz 503 {"status":"unavailable","reason":"spool"}
//   portal-ok   → /portal-healthz 200; /public/v1/health 503 with components.dashboards "ok" (ingest down, dashboards up)
//   portal-down → /portal-healthz 200; /public/v1/health 503 with components.dashboards "down"
import { createServer } from "node:http";

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
createServer((req, res) => {
  const [, mode, ...rest] = req.url.split("/");
  const path = `/${rest.join("/")}`;
  if (path === "/healthz") {
    if (mode === "good") return json(res, 200, { status: "ok" });
    if (mode === "slow") return setTimeout(() => json(res, 200, { status: "ok" }), 2500);
    if (mode === "sick") return json(res, 503, { status: "unavailable", reason: "spool" });
  }
  if (path === "/portal-healthz" && mode.startsWith("portal-")) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (path === "/public/v1/health" && mode.startsWith("portal-"))
    return json(res, 503, {
      schema: "scf-analytics/health/1",
      status: "down",
      components: {
        web_ingest: "down",
        otlp_ingest: "ok",
        dashboards: mode === "portal-ok" ? "ok" : "down",
        processing: "ok",
      },
    });
  json(res, 404, { error: "not_found" });
}).listen(8081);
