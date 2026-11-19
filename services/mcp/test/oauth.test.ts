// SPDX-License-Identifier: Apache-2.0
// OAuth at the hosted MCP server (src/oauth.ts, src/tenant-tools.ts) against a mock authorization server / control
// plane: protected resource metadata (RFC 9728), the 401 challenge Claude needs, token exchange (RFC 8693) instead of
// token passthrough, tenant isolation of a tenant grant (it can only ever read its own tenant), operator tools only for
// an operator grant, API keys unchanged, and no token in any log line or answer. The real authorization server is
// exercised end to end in services/control-plane/test/integration/oauth.test.ts (real PostgreSQL).
// Run: services/mcp/run test

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createMcpHttpServer, type Logger } from "../src/http.ts";
import { challenge, metadataPath } from "../src/oauth.ts";
import { KEYS, type Mock, startMock, TA, TB } from "./mock-control-plane.ts";

const SECRET = "mcp-exchange-secret-for-tests-0123456789";
const RESOURCE = "https://app.usagemap.test/mcp";
const tok = (p: string, c: string) => `scfa_${p}_${c.repeat(43)}`;
const AT = {
  tenantA: tok("oat", "a"),
  operator: tok("oat", "o"),
  revoked: tok("oat", "r"),
  misconfigured: tok("oat", "m"),
};
const DT = { tenantA: tok("odt", "A"), operator: tok("odt", "O") };
const SITE_A = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d1a01";
const SITE_B = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d1b02";
const MODERN = "2026-07-28";
const meta = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
}

/** Authorization server + tenant API + /op/v1 for delegated tokens; anything else goes to the key mock. */
async function startOAuthMock(
  keys: Mock,
): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url ?? "/", "http://x");
    const auth = req.headers.authorization;
    seen.push({ method: req.method ?? "", path: u.pathname, auth, body });
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (u.pathname === "/v1/oauth/token") {
      const expected = `Basic ${Buffer.from(`usagemap-mcp:${encodeURIComponent(SECRET)}`).toString("base64")}`;
      const f = new URLSearchParams(body);
      if (f.get("subject_token") === AT.misconfigured || auth !== expected)
        return json(401, { error: "invalid_client" });
      if (f.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange")
        return json(400, { error: "unsupported_grant_type" });
      const subject = f.get("subject_token");
      const grant =
        subject === AT.tenantA
          ? {
              t: DT.tenantA,
              u: { grant_id: "g-tenant", kind: "tenant", tenant_id: TA, client_name: "Claude" },
            }
          : subject === AT.operator
            ? {
                t: DT.operator,
                u: { grant_id: "g-op", kind: "operator", tenant_id: null, client_name: "Claude" },
              }
            : null;
      if (!grant) return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: grant.t,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 300,
        scope: "usagemap:read",
        usagemap: grant.u,
      });
    }
    const bearerTok = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (bearerTok === DT.tenantA) {
      // the control plane's rule for a tenant grant: its own tenant only, GET only, the same 404 for anything else
      const m = /^\/v1\/tenants\/([0-9a-f-]{36})(\/.*)?$/.exec(u.pathname);
      if (req.method !== "GET" || !m || m[1] !== TA) return json(404, { code: "not_found" });
      const rest = m[2] ?? "";
      if (rest === "") return json(200, { tenant_id: TA, slug: "alpha", name: "Alpha Wallet" });
      if (rest === "/sites") return json(200, [{ site_id: SITE_A, name: "alpha.test" }]);
      if (rest === "/services") return json(200, []);
      if (rest === "/verification") return json(200, { level: "L1" });
      if (rest === `/sites/${SITE_A}/web/stats`) return json(200, { pageviews: 1111 });
      return json(404, { code: "not_found" });
    }
    if (bearerTok === DT.operator) {
      if (u.pathname === "/op/v1/projects")
        return json(200, {
          data: [
            { project_id: TA, slug: "alpha" },
            { project_id: TB, slug: "beta" },
          ],
          next_cursor: null,
        });
      return json(404, { code: "not_found" });
    }
    if (/^scfa_o(at|rt|dt|ac)_/.test(bearerTok)) return json(401, { code: "unauthenticated" });
    // API keys: the existing mock
    const r = await fetch(`${keys.url}${req.url}`, {
      method: req.method ?? "GET",
      headers: auth ? { authorization: auth } : {},
    });
    res.writeHead(r.status, {
      "content-type": r.headers.get("content-type") ?? "application/json",
    });
    res.end(await r.text());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let keys: Mock;
let cp: Awaited<ReturnType<typeof startOAuthMock>>;
let srv: { url: string; base: string; close(): Promise<void> };
const logs: string[] = [];
const log: Logger = (level, msg, fields) => logs.push(JSON.stringify({ level, msg, ...fields }));

async function startMcp(env: Record<string, string>) {
  const config = loadConfig({ MCP_CONTROL_PLANE_URL: cp.url, MCP_PORT: "0", ...env });
  const server = createMcpHttpServer({ config, version: "1.0.0-test", log });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/mcp`,
    base,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function rpc(method: string, params: Record<string, unknown>, token: string | null, id = 1) {
  const name = typeof params.name === "string" ? { "mcp-name": params.name } : {};
  const r = await fetch(srv.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...name,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }),
  });
  const text = await r.text();
  return {
    status: r.status,
    headers: r.headers,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC answers are inspected loosely in tests
    json: text ? (JSON.parse(text) as any) : undefined,
  };
}

const tools = async (token: string) =>
  (((await rpc("tools/list", {}, token)).json?.result.tools ?? []) as { name: string }[])
    .map((t) => t.name)
    .sort();
const call = (token: string, name: string, args: Record<string, unknown> = {}) =>
  rpc("tools/call", { name, arguments: args }, token);

before(async () => {
  keys = await startMock();
  cp = await startOAuthMock(keys);
  srv = await startMcp({
    MCP_OAUTH_EXCHANGE_SECRET: SECRET,
    MCP_RESOURCE_URL: RESOURCE,
    MCP_AUTHORIZATION_SERVER: "https://app.usagemap.test",
    MCP_INTROSPECT_CACHE_MS: "30000",
  });
});
after(async () => {
  await srv.close();
  await cp.close();
  await keys.close();
});
beforeEach(() => {
  cp.seen.length = 0;
});

describe("discovery", () => {
  test("protected resource metadata at the path-specific and the root well-known URI", async () => {
    assert.equal(metadataPath(RESOURCE), "/.well-known/oauth-protected-resource/mcp");
    for (const p of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const r = await fetch(`${srv.base}${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(await r.json(), {
        resource: RESOURCE,
        authorization_servers: ["https://app.usagemap.test"],
        scopes_supported: ["usagemap:read"],
        bearer_methods_supported: ["header"],
        resource_name: "UsageMap",
        resource_documentation: "https://docs.usagemap.dev/",
      });
    }
  });

  test("an unauthenticated request is 401 with resource_metadata and scope (what starts Claude's sign-in)", async () => {
    const r = await rpc("tools/list", {}, null);
    assert.equal(r.status, 401);
    assert.equal(
      r.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://app.usagemap.test/.well-known/oauth-protected-resource/mcp", scope="usagemap:read"',
    );
    const bad = await rpc("tools/list", {}, AT.revoked);
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    assert.match(bad.headers.get("www-authenticate") ?? "", /resource_metadata="/);
  });

  test("without OAuth configured: no metadata, the old challenge", async () => {
    const plain = await startMcp({});
    try {
      assert.equal(
        (await fetch(`${plain.base}/.well-known/oauth-protected-resource/mcp`)).status,
        404,
      );
      const r = await fetch(plain.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${AT.tenantA}` },
        body: "{}",
      });
      assert.equal(r.status, 401);
      assert.equal(cp.seen.filter((s) => s.path === "/v1/oauth/token").length, 0);
    } finally {
      await plain.close();
    }
  });

  test("challenge() escapes nothing it should not carry", () => {
    const c = challenge(
      { secret: "x", resource: RESOURCE, issuer: "https://i.test" },
      true,
      'a "quoted" \\ text',
    );
    assert.match(c, /error_description="a quoted {2}text"/);
  });
});

describe("tenant grant", () => {
  test("lists the tenant tools only — no operator tool, no share-key tool", async () => {
    const names = await tools(AT.tenantA);
    assert.deepEqual(names, [
      "api_stellar_surfaces",
      "api_summary",
      "project_overview",
      "traction_snapshots",
      "trust_scores",
      "wallet_funnel",
      "web_breakdown",
      "web_stats",
      "web_timeseries",
    ]);
  });

  test("no token passthrough: upstream sees only the delegated token; the access token goes to the exchange only", async () => {
    const r = await call(AT.tenantA, "project_overview");
    assert.equal(r.status, 200);
    assert.notEqual(r.json.result.isError, true);
    assert.equal(r.json.result.structuredContent.tenant.slug, "alpha");
    const api = cp.seen.filter((s) => s.path !== "/v1/oauth/token");
    assert.ok(api.length >= 4);
    for (const s of api) {
      assert.equal(s.auth, `Bearer ${DT.tenantA}`);
      assert.ok(s.path.startsWith(`/v1/tenants/${TA}`), s.path);
    }
    for (const s of cp.seen) assert.ok(!(s.auth ?? "").includes(AT.tenantA));
  });

  test("isolation: another tenant's site is not found and nothing of it appears; the tenant is never an input", async () => {
    const own = await call(AT.tenantA, "web_stats", { site_id: SITE_A });
    assert.equal(own.json.result.structuredContent.pageviews, 1111);
    const foreign = await call(AT.tenantA, "web_stats", { site_id: SITE_B });
    assert.equal(foreign.json.result.isError, true);
    assert.match(foreign.json.result.content[0].text, /not found/);
    assert.ok(!foreign.text.includes("beta") && !foreign.text.includes("2222"));
    // a tenant id in the arguments changes nothing: every path is built from the grant
    cp.seen.length = 0;
    await call(AT.tenantA, "web_stats", { site_id: SITE_A, tenant_id: TB });
    for (const s of cp.seen.filter((x) => x.path !== "/v1/oauth/token"))
      assert.ok(s.path.startsWith(`/v1/tenants/${TA}/`), s.path);
    const notUuid = await call(AT.tenantA, "web_stats", { site_id: "../../op/v1/projects" });
    assert.equal(notUuid.json.result.isError, true);
    assert.match(notUuid.json.result.content[0].text, /invalid input/);
  });

  test("operator tools are not callable with a tenant grant", async () => {
    for (const name of [
      "list_projects",
      "web_summary",
      "evidence_pack",
      "project_metrics_document",
    ]) {
      const r = await call(AT.tenantA, name, {});
      assert.equal(r.json.result?.isError ?? true, true, name);
    }
    assert.equal(cp.seen.filter((s) => s.path.startsWith("/op/v1")).length, 0);
  });

  test("the exchange is cached: one exchange for several requests", async () => {
    const fresh = tok("oat", "a");
    assert.equal(fresh, AT.tenantA);
    await tools(AT.tenantA);
    await tools(AT.tenantA);
    assert.equal(
      cp.seen.filter((s) => s.path === "/v1/oauth/token").length,
      0,
      "cached since the earlier tests",
    );
  });
});

describe("operator grant", () => {
  test("lists the operator tools (all three read scopes) except the share-key document", async () => {
    const names = await tools(AT.operator);
    assert.ok(names.includes("list_projects"));
    assert.ok(names.includes("evidence_pack"));
    assert.ok(!names.includes("project_metrics_document"));
    assert.ok(!names.includes("project_overview"));
    const r = await call(AT.operator, "list_projects");
    assert.notEqual(r.json.result.isError, true, r.text);
    const op = cp.seen.filter((s) => s.path === "/op/v1/projects");
    assert.equal(op.length, 1);
    assert.equal(op[0]?.auth, `Bearer ${DT.operator}`);
  });
});

describe("other credentials", () => {
  test("refresh, delegated and code values are refused without an exchange", async () => {
    for (const t of [tok("ort", "a"), DT.tenantA, tok("oac", "a")]) {
      const r = await rpc("tools/list", {}, t);
      assert.equal(r.status, 401, t.slice(0, 9));
    }
    assert.equal(cp.seen.filter((s) => s.path === "/v1/oauth/token").length, 0);
  });

  test("API keys keep working next to OAuth", async () => {
    const r = await call(KEYS.opAll, "list_projects");
    assert.equal(r.status, 200);
    assert.notEqual(r.json.result.isError, true, r.text);
    const share = await call(KEYS.pubA, "project_metrics_document", { slug: "alpha" });
    assert.equal(share.status, 200);
  });

  test("a refused exchange client is a server problem (503), logged without the token", async () => {
    const r = await rpc("tools/list", {}, AT.misconfigured);
    assert.equal(r.status, 503);
    assert.ok(logs.some((l) => l.includes("refused the OAuth exchange client")));
  });

  test("an OAuth token in the URL is refused", async () => {
    const r = await fetch(`${srv.url}?access_token=${AT.tenantA}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 400);
  });

  test("no token of any kind in any log line", () => {
    const all = logs.join("\n");
    assert.ok(all.length > 0);
    assert.doesNotMatch(all, /scfa_o(at|rt|dt|ac)_[A-Za-z0-9_-]{10,}/);
    assert.ok(!all.includes(SECRET));
  });
});

describe("configuration", () => {
  const base = { MCP_CONTROL_PLANE_URL: "http://127.0.0.1:1" };
  test("OAuth is off without the secret, needs a resource with it, and checks both", () => {
    assert.equal(loadConfig(base).oauth, null);
    assert.throws(
      () => loadConfig({ ...base, MCP_OAUTH_EXCHANGE_SECRET: SECRET }),
      /MCP_RESOURCE_URL/,
    );
    assert.throws(
      () => loadConfig({ ...base, MCP_OAUTH_EXCHANGE_SECRET: "short", MCP_RESOURCE_URL: RESOURCE }),
      /32/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...base,
          MCP_OAUTH_EXCHANGE_SECRET: SECRET,
          MCP_RESOURCE_URL: "https://x.test/mcp#f",
        }),
      /MCP_RESOURCE_URL/,
    );
    assert.deepEqual(
      loadConfig({
        ...base,
        MCP_OAUTH_EXCHANGE_SECRET: SECRET,
        MCP_RESOURCE_URL: "HTTPS://App.UsageMap.dev/mcp/",
      }).oauth,
      {
        secret: SECRET,
        resource: "https://app.usagemap.dev/mcp",
        issuer: "https://app.usagemap.dev",
      },
    );
  });
});
