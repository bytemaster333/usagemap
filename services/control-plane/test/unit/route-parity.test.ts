// SPDX-License-Identifier: Apache-2.0
// Route ↔ OpenAPI parity: every route the control plane serves is an operation of
// docs/api/control-plane.openapi.yaml or docs/api/operator-metrics.openapi.yaml, and every operation is served, on the
// right listener. The only undocumented routes are the liveness and readiness probes (`/healthz`, `/readyz`): no
// authentication, no data. Routes are captured with an onRoute hook on every Fastify instance the app creates, so a
// route added by hand (outside the generated loop) is caught too.

import { controlPlaneOpenApi, operatorMetricsOpenApi } from "@usagemap/api-types";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

const captured: Array<{ app: FastifyInstance; routes: Set<string> }> = [];

vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const original = mod.default as unknown as (opts: unknown) => FastifyInstance;
  const wrapped = (opts: unknown) => {
    const app = original(opts);
    const routes = new Set<string>();
    app.addHook("onRoute", (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) if (m !== "HEAD") routes.add(`${m} ${r.url}`);
    });
    captured.push({ app, routes });
    return app;
  };
  return { ...mod, default: wrapped, fastify: wrapped };
});

const { buildApps } = await import("../../src/app.ts");
const { loadConfig } = await import("../../src/config.ts");

const HEALTH = ["GET /healthz", "GET /readyz"];
const METHODS = ["get", "put", "post", "delete", "patch"];

/** `METHOD /path/:param` for every operation of an OpenAPI document, split by `x-internal`. */
function documented(doc: unknown): { pub: string[]; internal: string[] } {
  const d = doc as { paths: Record<string, Record<string, { "x-internal"?: boolean }>> };
  const pub: string[] = [];
  const internal: string[] = [];
  for (const [path, item] of Object.entries(d.paths)) {
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const route = `${m.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`;
      (op["x-internal"] === true ? internal : pub).push(route);
    }
  }
  return { pub, internal };
}

describe("route ↔ OpenAPI parity", () => {
  it("serves exactly the documented operations, per listener, plus the health probes", async () => {
    captured.length = 0;
    const config = loadConfig({
      SCF_PORTAL_ORIGIN: "https://portal.test",
      SCF_DATABASE_URL: "postgres://x@127.0.0.1/scf",
      SCF_INTERNAL_LISTEN_HOST: "127.0.0.1",
      SCF_RATE_LIMIT_STORE: "memory",
    });
    const apps = await buildApps({
      config,
      db: {} as never,
      tracker: {} as never,
      horizon: {} as never,
    });
    await apps.publicApp.ready();
    await apps.internalApp.ready();
    const pub = captured.find((c) => c.app === apps.publicApp)?.routes;
    const internal = captured.find((c) => c.app === apps.internalApp)?.routes;
    if (!pub || !internal) throw new Error("listeners not captured");

    const cp = documented(controlPlaneOpenApi());
    const om = documented(operatorMetricsOpenApi());
    expect(om.internal).toEqual([]);

    const expectedPublic = [...cp.pub, ...om.pub, ...HEALTH].sort();
    const expectedInternal = [...cp.internal, ...HEALTH].sort();
    expect(cp.pub.length).toBeGreaterThan(100);
    expect(cp.internal.length).toBeGreaterThan(0);
    expect([...pub].sort()).toEqual(expectedPublic);
    expect([...internal].sort()).toEqual(expectedInternal);
    await apps.publicApp.close();
    await apps.internalApp.close();
  });
});
