// SPDX-License-Identifier: Apache-2.0
// Hosted MCP server over real HTTP against a mock control plane (test/mock-control-plane.ts): Streamable HTTP rules
// of MCP 2026-07-28 and 2025-11-25, authentication, tenant isolation (the isolation-matrix idea of tests/isolation:
// every caller × every other tenant's object is refused, and nothing of the other tenant appears in the answer),
// limits, cancellation, client-address forwarding and log secrecy. Run: services/mcp/run test

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createMcpHttpServer, type Logger } from "../src/http.ts";
import {
  KEYS,
  type Mock,
  SNAP_OPEN,
  SNAP_SEALED,
  startMock,
  TA,
  TB,
  TENANTS,
} from "./mock-control-plane.ts";

const MODERN = "2026-07-28";
const meta = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
};

let mock: Mock;
const logs: string[] = [];
const log: Logger = (level, msg, fields) => logs.push(JSON.stringify({ level, msg, ...fields }));

interface Srv {
  url: string;
  close(): Promise<void>;
}

async function start(env: Record<string, string> = {}): Promise<Srv> {
  const config = loadConfig({
    MCP_CONTROL_PLANE_URL: mock.url,
    MCP_PORT: "0",
    ...env,
  });
  const server = createMcpHttpServer({ config, version: "1.0.0-test", log });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface Opts {
  key?: string | null;
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  raw?: string;
  signal?: AbortSignal;
}

async function post(srv: Srv, body: unknown, o: Opts = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(o.key === null ? {} : { authorization: `Bearer ${o.key ?? KEYS.opAll}` }),
    ...(o.headers ?? {}),
  };
  const r = await fetch(o.url ?? srv.url, {
    method: o.method ?? "POST",
    headers,
    ...(o.method === "GET" || o.method === "DELETE" ? {} : { body: o.raw ?? JSON.stringify(body) }),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const text = await r.text();
  return {
    status: r.status,
    headers: r.headers,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC answers are inspected loosely in tests
    json: text ? (JSON.parse(text) as Record<string, any>) : undefined,
  };
}

/** A modern (2026-07-28) request with the headers the transport requires. */
function modern(
  srv: Srv,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  o: Opts = {},
) {
  const name = typeof params.name === "string" ? { "mcp-name": params.name } : {};
  return post(
    srv,
    { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } },
    {
      ...o,
      headers: {
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...name,
        ...(o.headers ?? {}),
      },
    },
  );
}

const callTool = (
  srv: Srv,
  key: string,
  name: string,
  args: Record<string, unknown> = {},
  id = 1,
) => modern(srv, id, "tools/call", { name, arguments: args }, { key });

const toolNames = async (srv: Srv, key: string) =>
  (
    ((await modern(srv, 1, "tools/list", {}, { key })).json?.result.tools ?? []) as {
      name: string;
    }[]
  )
    .map((t) => t.name)
    .sort();

before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.seen.length = 0;
});

describe("Streamable HTTP transport", () => {
  let srv: Srv;
  before(async () => {
    srv = await start({ MCP_ALLOWED_ORIGINS: "https://inspector.example" });
  });
  after(() => srv.close());

  test("health, wrong path, GET/DELETE are 405 with Allow", async () => {
    const h = await fetch(srv.url.replace("/mcp", "/healthz"));
    assert.equal(h.status, 200);
    assert.equal((await post(srv, {}, { url: srv.url.replace("/mcp", "/other") })).status, 404);
    for (const method of ["GET", "DELETE"]) {
      const r = await post(srv, undefined, { method });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get("allow"), "POST, OPTIONS");
    }
  });

  test("modern server/discover answers JSON with resultType, serverInfo and no session id", async () => {
    const r = await modern(srv, 1, "server/discover");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(r.headers.get("mcp-session-id"), null);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.json?.result.resultType, "complete");
    assert.ok(r.json?.result.supportedVersions.includes(MODERN));
    assert.ok(r.json?.result.supportedVersions.includes("2025-11-25"));
    assert.deepEqual(r.json?.result._meta["io.modelcontextprotocol/serverInfo"], {
      name: "usagemap-mcp",
      version: "1.0.0-test",
    });
  });

  test("header rules: missing/mismatched MCP-Protocol-Version, Mcp-Method, Mcp-Name are 400 -32020", async () => {
    const body = (method: string, params: Record<string, unknown> = {}) => ({
      jsonrpc: "2.0",
      id: 7,
      method,
      params: { ...params, _meta: meta },
    });
    const cases: [Record<string, string>, unknown][] = [
      [{ "mcp-method": "tools/list" }, body("tools/list")],
      [{ "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" }, body("tools/list")],
      [{ "mcp-protocol-version": MODERN }, body("tools/list")],
      [{ "mcp-protocol-version": MODERN, "mcp-method": "ping" }, body("tools/list")],
      [
        { "mcp-protocol-version": MODERN, "mcp-method": "tools/call" },
        body("tools/call", { name: "list_projects" }),
      ],
      [
        { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "web_summary" },
        body("tools/call", { name: "list_projects" }),
      ],
    ];
    for (const [headers, b] of cases) {
      const r = await post(srv, b, { headers });
      assert.equal(r.status, 400, JSON.stringify(headers));
      assert.equal(r.json?.error.code, -32020, JSON.stringify(headers));
    }
    assert.equal(
      mock.seen.filter((s) => s.path !== "/op/v1/me").length,
      0,
      "nothing reached the tools",
    );
  });

  test("a base64-encoded Mcp-Name is decoded before comparison", async () => {
    const r = await modern(
      srv,
      3,
      "tools/call",
      { name: "list_projects", arguments: {} },
      { headers: { "mcp-name": `=?base64?${Buffer.from("list_projects").toString("base64")}?=` } },
    );
    assert.equal(r.status, 200);
    assert.equal(r.json?.result.isError, false);
  });

  test("unsupported version 400 -32022 with supported list; unknown method 404 -32601", async () => {
    const r = await post(
      srv,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
      },
      { headers: { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" } },
    );
    assert.equal(r.status, 400);
    assert.equal(r.json?.error.code, -32022);
    assert.ok(r.json?.error.data.supported.includes(MODERN));
    const u = await modern(srv, 2, "resources/list");
    assert.equal(u.status, 404);
    assert.equal(u.json?.error.code, -32601);
  });

  test("notifications are 202 without a body; batches, parse errors, wrong content type are refused", async () => {
    const n = await post(
      srv,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { headers: { "mcp-protocol-version": MODERN, "mcp-method": "notifications/initialized" } },
    );
    assert.equal(n.status, 202);
    assert.equal(n.text, "");
    const b = await post(srv, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    assert.equal(b.status, 400);
    assert.equal(b.json?.error.code, -32600);
    const p = await post(srv, undefined, { raw: "{nope" });
    assert.equal(p.status, 400);
    assert.equal(p.json?.error.code, -32700);
    const c = await post(srv, {}, { headers: { "content-type": "text/plain" } });
    assert.equal(c.status, 415);
    const a = await post(srv, {}, { headers: { accept: "text/html" } });
    assert.equal(a.status, 406);
    const big = await post(srv, undefined, {
      raw: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }),
    });
    assert.equal(big.status, 413);
  });

  test("legacy 2025-11-25: initialize (no session minted), then requests identified by the version header", async () => {
    const i = await post(srv, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    assert.equal(i.status, 200);
    assert.equal(i.json?.result.protocolVersion, "2025-11-25");
    assert.equal(i.headers.get("mcp-session-id"), null);
    assert.ok(i.json?.result.capabilities.tools);
    const l = await post(
      srv,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { headers: { "mcp-protocol-version": "2025-11-25" } },
    );
    assert.equal(l.status, 200);
    assert.equal(l.json?.result.tools.length, 7);
    assert.equal(l.json?.result.resultType, undefined, "legacy results carry no modern fields");
    const noHeader = await post(srv, { jsonrpc: "2.0", id: 3, method: "ping" });
    assert.equal(noHeader.status, 200, "no header: 2025-03-26 assumed");
    const bad = await post(
      srv,
      { jsonrpc: "2.0", id: 4, method: "ping" },
      { headers: { "mcp-protocol-version": "1999-01-01" } },
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.json?.error.code, -32022);
    const resp = await post(
      srv,
      { jsonrpc: "2.0", id: 9, result: {} },
      { headers: { "mcp-protocol-version": "2025-11-25" } },
    );
    assert.equal(resp.status, 202);
    const sess = await post(
      srv,
      { jsonrpc: "2.0", id: 5, method: "ping" },
      {
        headers: { "mcp-protocol-version": "2025-11-25", "mcp-session-id": "whatever" },
      },
    );
    assert.equal(sess.status, 200, "a session id from a client is ignored");
  });

  test("Origin: absent is fine, not allow-listed is 403, allow-listed gets CORS and a preflight", async () => {
    const bad = await modern(srv, 1, "ping", {}, { headers: { origin: "https://evil.example" } });
    assert.equal(bad.status, 403);
    const ok = await modern(
      srv,
      1,
      "ping",
      {},
      { headers: { origin: "https://inspector.example" } },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://inspector.example");
    const pre = await fetch(srv.url, {
      method: "OPTIONS",
      headers: { origin: "https://inspector.example" },
    });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /mcp-protocol-version/);
  });
});

describe("authentication", () => {
  let srv: Srv;
  before(async () => {
    srv = await start();
  });
  after(() => srv.close());

  test("missing, malformed, bad-checksum and ingest keys are 401 offline (the control plane is not asked)", async () => {
    const none = await modern(srv, 1, "ping", {}, { key: null });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="usagemap"');
    const badCrc = `${KEYS.opAll.slice(0, -1)}${KEYS.opAll.endsWith("0") ? "1" : "0"}`;
    for (const key of ["nonsense", badCrc, KEYS.ing]) {
      const r = await modern(srv, 1, "ping", {}, { key });
      assert.equal(r.status, 401, key.slice(0, 12));
      assert.match(r.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    }
    assert.equal(mock.seen.length, 0);
  });

  test("a revoked operator key is refused after introspection; a key in the URL is refused before anything", async () => {
    const r = await modern(srv, 1, "ping", {}, { key: KEYS.opRevoked });
    assert.equal(r.status, 401);
    assert.deepEqual(
      mock.seen.map((s) => s.path),
      ["/op/v1/me"],
    );
    mock.seen.length = 0;
    const u = await modern(srv, 1, "ping", {}, { url: `${srv.url}?key=${KEYS.opAll}` });
    assert.equal(u.status, 400);
    assert.match(u.json?.error.message, /compromised/);
    assert.ok(!u.text.includes(KEYS.opAll));
    assert.equal(mock.seen.length, 0);
  });

  test("the introspection cache is keyed by the whole key: a forged secret with a real key id is refused", async () => {
    assert.equal((await modern(srv, 1, "ping", {}, { key: KEYS.opAll })).status, 200);
    const forged = await modern(srv, 1, "ping", {}, { key: KEYS.opForged });
    assert.equal(forged.status, 401);
    const me = mock.seen.filter((s) => s.path === "/op/v1/me").map((s) => s.auth);
    assert.ok(
      me.includes(`Bearer ${KEYS.opForged}`),
      "the forged key was checked at the control plane",
    );
  });
});

describe("tenant isolation and scopes", () => {
  let srv: Srv;
  before(async () => {
    srv = await start();
  });
  after(() => srv.close());

  test("each key lists only the tools it can use", async () => {
    assert.equal((await toolNames(srv, KEYS.opAll)).length, 7);
    assert.deepEqual(await toolNames(srv, KEYS.opWeb), [
      "evidence_links",
      "trust_flags",
      "web_summary",
    ]);
    assert.deepEqual(await toolNames(srv, KEYS.pubA), [
      "evidence_links",
      "project_metrics_document",
    ]);
  });

  test("a tenant share key reads its own document and nothing of another tenant", async () => {
    const own = await callTool(srv, KEYS.pubA, "project_metrics_document", { slug: "alpha" });
    assert.equal(own.json?.result.isError, false);
    assert.equal(own.json?.result.structuredContent.web.pageviews_verified, 1111);
    const other = await callTool(srv, KEYS.pubA, "project_metrics_document", { slug: "beta" });
    assert.equal(other.status, 200);
    assert.equal(other.json?.result.isError, true);
    assert.match(other.json?.result.content[0].text, /404/);
    for (const leak of ["2222", "Beta Anchor", TB]) assert.ok(!other.text.includes(leak), leak);
    // Operator tools are not even callable with a share key, and nothing was sent to /op/v1 with it.
    for (const tool of [
      "list_projects",
      "web_summary",
      "evidence_pack",
      "trust_flags",
      "api_routes_summary",
    ]) {
      const r = await callTool(
        srv,
        KEYS.pubA,
        tool,
        tool === "evidence_pack" ? { project_id: TB } : {},
      );
      assert.equal(r.json?.error?.code, -32602, tool);
    }
    assert.ok(mock.seen.every((s) => !s.path.startsWith("/op/v1/")));
    assert.ok(mock.seen.every((s) => s.auth === `Bearer ${KEYS.pubA}`));
  });

  test("matrix: every caller × every other tenant's object is refused and leaks nothing", async () => {
    const callers = [
      { key: KEYS.pubA, own: TENANTS[0], tools: ["project_metrics_document"] },
      { key: KEYS.pubB, own: TENANTS[1], tools: ["project_metrics_document"] },
      {
        key: KEYS.opA,
        own: TENANTS[0],
        tools: ["project_metrics_document", "evidence_pack", "web_summary"],
      },
    ];
    for (const c of callers) {
      for (const other of TENANTS.filter((t) => t.id !== c.own?.id)) {
        for (const tool of c.tools) {
          const args =
            tool === "project_metrics_document"
              ? { slug: other.slug }
              : tool === "evidence_pack"
                ? { project_id: other.id }
                : { project_ids: [other.id] };
          const r = await callTool(srv, c.key, tool, args);
          assert.equal(r.json?.result?.isError, true, `${tool} ${other.slug}`);
          for (const leak of [String(other.pageviews), other.name])
            assert.ok(!r.text.includes(leak), `${tool} leaked ${leak}`);
        }
      }
    }
  });

  test("a tenant-restricted operator key sees only its tenants in list and summary", async () => {
    const list = await callTool(srv, KEYS.opA, "list_projects");
    assert.deepEqual(
      list.json?.result.structuredContent.data.map((p: { project_id: string }) => p.project_id),
      [TA],
    );
    const sum = await callTool(srv, KEYS.opA, "web_summary", {
      start: "2026-11-01",
      end: "2026-11-08",
    });
    assert.ok(!sum.text.includes("2222"));
    const all = await callTool(srv, KEYS.opAll, "web_summary", {
      start: "2026-11-01",
      end: "2026-11-08",
    });
    assert.ok(all.text.includes("2222") && all.text.includes("1111"));
  });

  test("evidence_links: by id, by link (only the id is taken) and by slug; public endpoints, no key sent", async () => {
    const byId = await callTool(srv, KEYS.pubA, "evidence_links", { snapshot_id: SNAP_SEALED });
    assert.equal(byId.json?.result.isError, false);
    const sc = byId.json?.result.structuredContent;
    assert.equal(sc.snapshot.status, "valid");
    assert.equal(sc.seal.proofs[0].network, "testnet");
    assert.equal(sc.verify_url, `${mock.url}/verify/${SNAP_SEALED}`);
    const byLink = await callTool(srv, KEYS.opWeb, "evidence_links", {
      link: `https://elsewhere.example/verify/${SNAP_OPEN.toUpperCase()}?x=1`,
    });
    assert.equal(byLink.json?.result.structuredContent.snapshot.status, "revoked");
    assert.equal(byLink.json?.result.structuredContent.seal, null);
    const list = await callTool(srv, KEYS.pubB, "evidence_links", { slug: "alpha" });
    assert.equal(list.json?.result.structuredContent.snapshots.length, 2);
    const none = await callTool(srv, KEYS.pubA, "evidence_links", { slug: "nobody" });
    assert.equal(none.json?.result.isError, true);
    const bad = await callTool(srv, KEYS.pubA, "evidence_links", {
      slug: "alpha",
      snapshot_id: SNAP_OPEN,
    });
    assert.match(bad.json?.result.content[0].text, /exactly one/);
    const pub = mock.seen.filter((s) => s.path.includes("/snapshots"));
    assert.ok(pub.length >= 5);
    assert.ok(
      pub.every((s) => s.auth === undefined),
      "no key on public endpoints",
    );
    assert.ok(mock.seen.every((s) => !s.path.includes("elsewhere")));
  });

  test("concurrent callers never get each other's key or data", async () => {
    const jobs = Array.from({ length: 24 }, (_, i) => {
      const k = [KEYS.pubA, KEYS.pubB, KEYS.opA][i % 3] as string;
      const slug = k === KEYS.pubB ? "beta" : "alpha";
      return callTool(srv, k, "project_metrics_document", { slug }, i + 1).then((r) => ({ k, r }));
    });
    for (const { k, r } of await Promise.all(jobs)) {
      assert.equal(r.json?.result.isError, false);
      const want = k === KEYS.pubB ? 2222 : 1111;
      assert.equal(r.json?.result.structuredContent.web.pageviews_verified, want);
    }
    const auths = new Set(mock.seen.map((s) => s.auth));
    assert.deepEqual(
      [...auths].sort(),
      [KEYS.opA, KEYS.pubA, KEYS.pubB].map((k) => `Bearer ${k}`).sort(),
    );
  });
});

describe("limits, cancellation, forwarding, logs", () => {
  test("per-key rate limit and failed-authentication limit per subnet answer 429 with Retry-After", async () => {
    const srv = await start({ MCP_KEY_RATE_PER_MIN: "3", MCP_AUTH_FAIL_PER_MIN: "2" });
    try {
      for (let i = 0; i < 3; i++)
        assert.equal((await modern(srv, i, "ping", {}, { key: KEYS.pubA })).status, 200);
      const r = await modern(srv, 4, "ping", {}, { key: KEYS.pubA });
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get("retry-after")) >= 1);
      assert.equal(
        (await modern(srv, 5, "ping", {}, { key: KEYS.pubB })).status,
        200,
        "other keys unaffected",
      );
      assert.equal((await modern(srv, 6, "ping", {}, { key: "bad" })).status, 401);
      assert.equal((await modern(srv, 7, "ping", {}, { key: "bad" })).status, 401);
      const blocked = await modern(srv, 8, "ping", {}, { key: KEYS.opAll });
      assert.equal(blocked.status, 429, "subnet blocked after failures, even with a valid key");
    } finally {
      await srv.close();
    }
  });

  test("in-flight cap answers 503; a client that goes away cancels its upstream call", async () => {
    const srv = await start({ MCP_MAX_INFLIGHT: "1" });
    const path = "/public/v1/projects/alpha/metrics.json";
    mock.hold.add(path);
    try {
      const ac = new AbortController();
      const first = callTool(srv, KEYS.pubA, "project_metrics_document", { slug: "alpha" }).catch(
        (e) => e,
      );
      while (!mock.seen.some((s) => s.path === path)) await new Promise((r) => setTimeout(r, 5));
      const second = await modern(srv, 2, "ping", {}, { key: KEYS.pubB });
      assert.equal(second.status, 503);
      mock.release();
      await first;
      mock.seen.length = 0;
      const third = post(
        srv,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "project_metrics_document", arguments: { slug: "alpha" }, _meta: meta },
        },
        {
          key: KEYS.pubA,
          signal: ac.signal,
          headers: {
            "mcp-protocol-version": MODERN,
            "mcp-method": "tools/call",
            "mcp-name": "project_metrics_document",
          },
        },
      ).catch((e) => e);
      while (!mock.seen.some((s) => s.path === path)) await new Promise((r) => setTimeout(r, 5));
      ac.abort();
      await third;
      const t0 = Date.now();
      while (!mock.aborted.includes(path) && Date.now() - t0 < 2000)
        await new Promise((r) => setTimeout(r, 10));
      assert.ok(mock.aborted.includes(path), "the upstream request was aborted");
    } finally {
      mock.hold.delete(path);
      mock.release();
      await srv.close();
    }
  });

  test("the client address is forwarded only when configured, and taken from X-Forwarded-For only from a trusted proxy", async () => {
    const plain = await start();
    const fwd = await start({ MCP_FORWARD_CLIENT_ADDRESS: "true", MCP_TRUST_PROXY: "127.0.0.1" });
    const fwdUntrusted = await start({ MCP_FORWARD_CLIENT_ADDRESS: "true" });
    try {
      const xff = { "x-forwarded-for": "198.51.100.7, 203.0.113.9" };
      await callTool(plain, KEYS.pubA, "project_metrics_document", { slug: "alpha" });
      assert.equal(mock.seen.at(-1)?.xff, undefined);
      await modern(
        fwd,
        1,
        "tools/call",
        { name: "project_metrics_document", arguments: { slug: "alpha" } },
        { key: KEYS.pubA, headers: xff },
      );
      assert.equal(mock.seen.at(-1)?.xff, "203.0.113.9");
      await modern(
        fwdUntrusted,
        1,
        "tools/call",
        { name: "project_metrics_document", arguments: { slug: "alpha" } },
        { key: KEYS.pubA, headers: xff },
      );
      assert.equal(mock.seen.at(-1)?.xff, "127.0.0.1");
    } finally {
      await Promise.all([plain.close(), fwd.close(), fwdUntrusted.close()]);
    }
  });

  test("logs carry method, tool, key kind and id — never a key, address, argument or result", async () => {
    logs.length = 0;
    const srv = await start();
    try {
      await callTool(srv, KEYS.opAll, "evidence_pack", {
        project_id: TA,
        start: "2026-11-01",
        end: "2026-11-08",
      });
      await callTool(srv, KEYS.pubA, "project_metrics_document", { slug: "alpha" });
      await modern(srv, 1, "ping", {}, { key: KEYS.opRevoked });
      await modern(srv, 1, "ping", {}, { url: `${srv.url}?k=${KEYS.pubB}` });
    } finally {
      await srv.close();
    }
    const all = logs.join("\n");
    for (const k of Object.values(KEYS))
      assert.ok(!all.includes(k.slice(-33)), "no key secret in logs");
    for (const s of ["127.0.0.1", TA, "alpha", "1111", "2026-11-01", "Bearer"])
      assert.ok(!all.includes(s), s);
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.tool === "evidence_pack");
    assert.equal(line.key_kind, "op");
    assert.equal(line.key_id, "OpAll0000001");
    assert.equal(line.status, 200);
  });
});
