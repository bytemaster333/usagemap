// SPDX-License-Identifier: Apache-2.0
// A mock of the control plane's read APIs for the hosted MCP tests, modelling two tenants and the access rules the
// real control plane enforces (docs/api/operator-metrics.openapi.yaml; wire-formats §i.1, C-14, CR-21):
//   - an operator key sees only the tenants of its tenant restriction (list filtered, detail 404, named outsiders 403);
//   - a share key opens only its own tenant's metrics document; anything else is the same 404 (no existence oracle);
//   - scopes are enforced per route (403).
// Every request is recorded (path, query, Authorization, X-Forwarded-For) so the tests can prove what reached it.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { keyWithChecksum } from "../../../tools/mcp/src/api.ts";

export const TA = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0a01";
export const TB = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0b02";
export const TENANTS = [
  { id: TA, slug: "alpha", name: "Alpha Wallet", pageviews: 1111 },
  { id: TB, slug: "beta", name: "Beta Anchor", pageviews: 2222 },
];
const ALL = ["registry:read", "web:read", "api:read"];
/** Public traction snapshots (evidence links): SNAP_SEALED has a seal proof, SNAP_OPEN not yet. */
export const SNAP_SEALED = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d5e01";
export const SNAP_OPEN = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d5e02";

// Syntactically valid keys with correct checksums that exist only in these tests (never real credentials).
const sec = (c: string) => c.repeat(27);
export const KEYS = {
  opAll: keyWithChecksum("op", "OpAll0000001", sec("a")),
  opA: keyWithChecksum("op", "OpTenantA001", sec("b")),
  opWeb: keyWithChecksum("op", "OpWebOnly001", sec("c")),
  opRevoked: keyWithChecksum("op", "OpRevoked001", sec("d")),
  /** Same public id as opAll, different secret: must never ride on opAll's cached introspection. */
  opForged: keyWithChecksum("op", "OpAll0000001", sec("z")),
  pubA: keyWithChecksum("pub", "PubAlpha0001", sec("e")),
  pubB: keyWithChecksum("pub", "PubBeta00001", sec("f")),
  ing: keyWithChecksum("ing", "Ingest000001", sec("g")),
};

const OP_KEYS: Record<
  string,
  { key_id: string; scopes: string[]; tenant_restriction: string[] | null }
> = {
  [KEYS.opAll]: { key_id: "OpAll0000001", scopes: ALL, tenant_restriction: null },
  [KEYS.opA]: { key_id: "OpTenantA001", scopes: ALL, tenant_restriction: [TA] },
  [KEYS.opWeb]: { key_id: "OpWebOnly001", scopes: ["web:read"], tenant_restriction: null },
};
const PUB_KEYS: Record<string, string> = { [KEYS.pubA]: TA, [KEYS.pubB]: TB };

const ROUTE_SCOPE: Record<string, string> = {
  "/op/v1/projects": "registry:read",
  "/op/v1/web/summary": "web:read",
  "/op/v1/web/verdicts": "web:read",
  "/op/v1/trust/web": "web:read",
  "/op/v1/api/summary": "api:read",
  "/op/v1/trust/api-assurance": "api:read",
};

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  xff: string | undefined;
}

export interface Mock {
  url: string;
  seen: Seen[];
  /** paths whose answer is held until `release()` (in-flight and cancellation tests) */
  hold: Set<string>;
  release(): void;
  aborted: string[];
  close(): Promise<void>;
}

const page = (data: unknown[]) => ({
  data,
  next_cursor: null,
  privacy: { min_count: 10, round_to: 10 },
});

export async function startMock(): Promise<Mock> {
  const seen: Seen[] = [];
  const hold = new Set<string>();
  const aborted: string[] = [];
  let waiters: (() => void)[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const auth = req.headers.authorization;
    seen.push({
      method: req.method ?? "",
      path: u.pathname,
      query: u.searchParams,
      auth,
      xff: req.headers["x-forwarded-for"] as string | undefined,
    });
    const json = (status: number, body: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (hold.has(u.pathname)) {
      req.socket.on("close", () => aborted.push(u.pathname));
      await new Promise<void>((r) => waiters.push(r));
    }
    const key = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const problem = (status: number, code: string) => json(status, { code, title: code });

    // Public snapshot endpoints (no authentication; the tests assert none is sent).
    const sm = /^\/public\/v1\/snapshots\/([0-9a-f-]{36})(\/seal)?$/.exec(u.pathname);
    if (sm) {
      const known = sm[1] === SNAP_SEALED || sm[1] === SNAP_OPEN;
      if (!known) return problem(404, "not_found");
      if (sm[2])
        return sm[1] === SNAP_SEALED
          ? json(200, { proofs: [{ network: "testnet", root: "ab" }] })
          : problem(404, "not_found");
      return json(200, {
        snapshot_id: sm[1],
        project: { slug: "alpha" },
        status: sm[1] === SNAP_OPEN ? "revoked" : "valid",
      });
    }
    const sl = /^\/public\/v1\/projects\/([a-z0-9-]+)\/snapshots$/.exec(u.pathname);
    if (sl) {
      if (sl[1] !== "alpha") return problem(404, "not_found");
      return json(200, {
        schema: "scf-analytics/snapshot-list/1",
        project: { slug: "alpha" },
        generated_at: "2026-11-19T00:00:00Z",
        snapshots: [
          { seq: 1, snapshot_id: SNAP_SEALED },
          { seq: 2, snapshot_id: SNAP_OPEN },
        ],
      });
    }
    const pm = /^\/public\/v1\/projects\/([a-z0-9-]+)\/metrics\.json$/.exec(u.pathname);
    if (pm) {
      const t = TENANTS.find((x) => x.slug === pm[1]);
      if (!t || !key) return problem(404, "not_found");
      const pubTenant = PUB_KEYS[key];
      const op = OP_KEYS[key];
      const ok =
        pubTenant === t.id ||
        (op?.scopes.includes("web:read") &&
          op.scopes.includes("api:read") &&
          (!op.tenant_restriction || op.tenant_restriction.includes(t.id)));
      if (!ok) return problem(404, "not_found");
      return json(200, {
        project: { slug: t.slug, name: t.name },
        web: { pageviews_verified: t.pageviews },
      });
    }

    const op = key ? OP_KEYS[key] : undefined;
    if (!op) return problem(401, "unauthenticated");
    const visible = TENANTS.filter(
      (t) => !op.tenant_restriction || op.tenant_restriction.includes(t.id),
    );
    if (u.pathname === "/op/v1/me")
      return json(200, {
        ...op,
        label: "test",
        expires_at: "2099-01-01T00:00:00Z",
        rate_limit_per_min: 600,
      });
    const detail = /^\/op\/v1\/projects\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (detail) {
      if (!op.scopes.includes("registry:read")) return problem(403, "forbidden");
      const t = visible.find((x) => x.id === detail[1]);
      return t
        ? json(200, { project_id: t.id, slug: t.slug, name: t.name })
        : problem(404, "not_found");
    }
    const scope = ROUTE_SCOPE[u.pathname];
    if (!scope) return problem(404, "not_found");
    if (!op.scopes.includes(scope)) return problem(403, "forbidden");
    const named = u.searchParams.get("project_ids")?.split(",");
    if (named && !named.some((id) => visible.some((t) => t.id === id)))
      return problem(403, "forbidden");
    const rows = visible.filter((t) => !named || named.includes(t.id));
    switch (u.pathname) {
      case "/op/v1/projects":
        return json(200, page(rows.map((t) => ({ project_id: t.id, slug: t.slug, name: t.name }))));
      case "/op/v1/web/summary":
        return json(200, page(rows.map((t) => ({ project_id: t.id, pageviews: t.pageviews }))));
      case "/op/v1/api/summary":
        return json(200, page(rows.map((t) => ({ project_id: t.id, requests: t.pageviews * 2 }))));
      case "/op/v1/web/verdicts":
        return json(
          200,
          page(
            rows.map((t) => ({
              project_id: t.id,
              counter: "verdict",
              label: "verified",
              count: t.pageviews,
            })),
          ),
        );
      default:
        return json(200, page(rows.map((t) => ({ project_id: t.id }))));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  return {
    url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`,
    seen,
    hold,
    aborted,
    release() {
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
