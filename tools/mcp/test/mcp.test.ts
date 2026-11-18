// SPDX-License-Identifier: Apache-2.0
// UsageMap MCP server (plan E8): protocol conformance (MCP 2026-07-28 modern per-request metadata, server/discover,
// unsupported-version error, legacy initialize handshake), the tools against a mock operator API, key secrecy and the
// one-origin network rule. The server runs as a child process over real stdio. Run: tools/mcp/run selftest

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ApiClient, loadKey, redact } from "../src/api.ts";
import { handle } from "../src/protocol.ts";
import { createServer as createSpec, sumVerdicts } from "../src/tools.ts";

const SERVER = join(import.meta.dirname, "..", "server.ts");
// A syntactically valid key that exists only in this test (never a real credential).
const OP_KEY = `scfa_op_${"A1b2C3d4E5f6"}_${"x".repeat(27)}${"Zz0Zz0"}`;
const PUB_KEY = `scfa_pub_${"B1b2C3d4E5f6"}_${"y".repeat(27)}${"Yy0Yy0"}`;
const P1 = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12";
const S1 = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e15";
const MODERN = "2026-07-28";
const meta = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface Seen {
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  host: string | undefined;
}

let api: Server;
let apiUrl = "";
const seen: Seen[] = [];
let dir = "";

function page(data: unknown[]) {
  return { data, next_cursor: null, privacy: { min_count: 10, round_to: 10 } };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  writeFileSync(join(dir, "op.key"), `${OP_KEY}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "pub.key"), `${PUB_KEY}\n`, { mode: 0o600 });
  api = createServer((req: IncomingMessage, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push({
      path: u.pathname,
      query: u.searchParams,
      auth: req.headers.authorization,
      host: req.headers.host,
    });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization;
    if (u.pathname.startsWith("/public/")) {
      if (auth !== `Bearer ${PUB_KEY}`) return json(401, { code: "unauthenticated", title: "no" });
      return json(200, { project: { slug: "demo" }, web: { pageviews: 1234 } });
    }
    if (auth !== `Bearer ${OP_KEY}`)
      return json(401, { code: "unauthenticated", title: "bad key" });
    switch (u.pathname) {
      case "/op/v1/projects":
        return json(
          200,
          page([{ project_id: P1, slug: "demo", name: "Demo", verification_level: "L1" }]),
        );
      case `/op/v1/projects/${P1}`:
        return json(200, { project_id: P1, slug: "demo", name: "Demo" });
      case "/op/v1/web/summary":
        return json(
          200,
          page([
            { project_id: P1, pageviews: u.searchParams.get("variant") === "raw" ? 150 : 120 },
          ]),
        );
      case "/op/v1/web/verdicts":
        return json(
          200,
          page([
            {
              project_id: P1,
              site_id: S1,
              day: "2026-11-01",
              counter: "verdict",
              label: "verified",
              count: 120,
            },
            {
              project_id: P1,
              site_id: S1,
              day: "2026-11-02",
              counter: "verdict",
              label: "verified",
              count: 5,
            },
            {
              project_id: P1,
              site_id: S1,
              day: "2026-11-01",
              counter: "reason",
              label: "ua_bot",
              count: 30,
            },
          ]),
        );
      case "/op/v1/api/summary":
        return json(200, page([{ project_id: P1, route: "/accounts/{account}", requests: 42 }]));
      case "/op/v1/trust/web":
        return json(
          200,
          page([{ project_id: P1, day: "2026-11-01", score: 0.9, reason_codes: [] }]),
        );
      case "/op/v1/trust/api-assurance":
        return json(200, page([{ project_id: P1, level: "self_attested" }]));
      case "/op/v1/redirect":
        res.writeHead(302, { location: "https://elsewhere.example/" });
        return res.end();
      case "/op/v1/leaky":
        return json(500, { code: "internal", detail: `echo ${OP_KEY}` });
      default:
        return json(404, { code: "not_found" });
    }
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const a = api.address();
  apiUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

after(() => {
  api.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  readonly p: ChildProcessWithoutNullStreams;
  stdout = "";
  stderr = "";
  #waiters = new Map<string | number, (m: Record<string, unknown>) => void>();
  #buf = "";
  constructor(env: Record<string, string>) {
    this.p = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.p.stdout.setEncoding("utf8");
    this.p.stderr.setEncoding("utf8");
    this.p.stderr.on("data", (d: string) => {
      this.stderr += d;
    });
    this.p.stdout.on("data", (d: string) => {
      this.stdout += d;
      this.#buf += d;
      for (let i = this.#buf.indexOf("\n"); i >= 0; i = this.#buf.indexOf("\n")) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        const m = JSON.parse(line) as Record<string, unknown>;
        const w = this.#waiters.get(m.id as string | number);
        if (w) {
          this.#waiters.delete(m.id as string | number);
          w(m);
        }
      }
    });
  }
  send(o: unknown): void {
    this.p.stdin.write(`${JSON.stringify(o)}\n`);
  }
  raw(s: string): void {
    this.p.stdin.write(s);
  }
  request(id: string | number, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`no answer to ${method}; stderr: ${this.stderr}`)),
        10_000,
      );
      this.#waiters.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }
  waitFor(id: string | number): Promise<Record<string, unknown>> {
    return new Promise((resolve) => this.#waiters.set(id, resolve));
  }
  async close(): Promise<number | null> {
    this.p.stdin.end();
    return new Promise((r) => this.p.on("close", (code) => r(code)));
  }
}

const call = (c: Client, id: number, name: string, args: unknown = {}) =>
  c.request(id, "tools/call", { name, arguments: args, _meta: meta });

describe("MCP protocol (2026-07-28 modern, 2025-11-25 legacy)", () => {
  test("server/discover lists the supported versions, the tools capability and serverInfo", async () => {
    const c = new Client({ USAGEMAP_API_URL: apiUrl });
    const r = await c.request("d1", "server/discover", { _meta: meta });
    const res = r.result as Record<string, unknown>;
    assert.equal(r.jsonrpc, "2.0");
    assert.equal(res.resultType, "complete");
    assert.deepEqual((res.supportedVersions as string[]).slice(0, 2), ["2026-07-28", "2025-11-25"]);
    assert.deepEqual(res.capabilities, { tools: { listChanged: false } });
    assert.equal(
      (
        (res._meta as Record<string, { name: string }>)["io.modelcontextprotocol/serverInfo"] as {
          name: string;
        }
      ).name,
      "usagemap-mcp",
    );
    assert.equal(await c.close(), 0);
  });

  test("an unsupported version is -32022 with supported/requested; missing metadata is -32602", async () => {
    const c = new Client({ USAGEMAP_API_URL: apiUrl });
    const bad = await c.request(1, "tools/list", {
      _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
    });
    const e = bad.error as { code: number; data: { supported: string[]; requested: string } };
    assert.equal(e.code, -32022);
    assert.equal(e.data.requested, "1900-01-01");
    assert.ok(e.data.supported.includes("2026-07-28"));
    const noCaps = await c.request(2, "tools/list", {
      _meta: { "io.modelcontextprotocol/protocolVersion": MODERN },
    });
    assert.equal((noCaps.error as { code: number }).code, -32602);
    const none = await c.request(3, "tools/list");
    assert.equal((none.error as { code: number }).code, -32602);
    const unknown = await c.request(4, "resources/list", { _meta: meta });
    assert.equal((unknown.error as { code: number }).code, -32601);
    await c.close();
  });

  test("legacy clients: initialize negotiates 2025-11-25 (or the asked legacy version) and then work without _meta", async () => {
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "op.key"),
    });
    const init = await c.request(0, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    const r = init.result as Record<string, unknown>;
    assert.equal(r.protocolVersion, "2025-06-18");
    assert.deepEqual((r.serverInfo as { name: string }).name, "usagemap-mcp");
    assert.equal(r.resultType, undefined, "legacy results carry no resultType");
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await c.request(1, "tools/list");
    const tools = (
      list.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }
    ).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        "list_projects",
        "web_summary",
        "api_routes_summary",
        "trust_flags",
        "evidence_pack",
        "project_metrics_document",
        "evidence_links",
      ],
    );
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
    const pr = await c.request(2, "tools/call", { name: "list_projects", arguments: {} });
    assert.equal((pr.result as { isError: boolean }).isError, false);
    const future = new Client({ USAGEMAP_API_URL: apiUrl });
    const f = await future.request(0, "initialize", {
      protocolVersion: "2099-01-01",
      capabilities: {},
    });
    assert.equal((f.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
    await future.close();
    await c.close();
  });

  test("framing: parse errors, batches and notifications; concurrent requests all answered", async () => {
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "op.key"),
    });
    c.raw("{not json\n");
    c.raw(`${JSON.stringify([{ jsonrpc: "2.0", id: 9, method: "ping" }])}\n`);
    c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    const answers = await Promise.all(
      [10, 11, 12, 13].map((i) => call(c, i, i % 2 ? "web_summary" : "list_projects")),
    );
    assert.ok(answers.every((a) => (a.result as { isError: boolean }).isError === false));
    await c.close();
    const lines = c.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
    assert.equal(lines.find((l) => l.id === null && l.error?.code === -32700)?.error?.code, -32700);
    assert.equal(lines.find((l) => l.id === null && l.error?.code === -32600)?.error?.code, -32600);
    assert.equal(lines.length, 6, "no answer to the notification");
  });
});

describe("tools against the operator API", () => {
  test("web_summary sends the documented query: midnight-UTC range, project_ids comma list, variant", async () => {
    seen.length = 0;
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "op.key"),
    });
    const r = await call(c, 1, "web_summary", {
      start: "2026-11-01",
      end: "2026-11-08",
      project_ids: [P1, S1],
      variant: "raw",
      min_level: "L0",
    });
    const res = r.result as {
      structuredContent: { data: { pageviews: number }[] };
      content: { text: string }[];
    };
    assert.equal(res.structuredContent.data[0]?.pageviews, 150);
    assert.match(res.content[0]?.text ?? "", /2026-11-01T00:00:00Z – 2026-11-08T00:00:00Z/);
    const q = seen.find((s) => s.path === "/op/v1/web/summary")?.query;
    assert.equal(q?.get("start"), "2026-11-01T00:00:00Z");
    assert.equal(q?.get("end"), "2026-11-08T00:00:00Z");
    assert.equal(q?.get("project_ids"), `${P1},${S1}`);
    assert.equal(q?.get("variant"), "raw");
    assert.equal(q?.get("min_level"), "L0");
    await c.close();
  });

  test("evidence_pack combines project, verified and raw web, verdict totals, API, trust", async () => {
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "op.key"),
    });
    const r = await call(c, 1, "evidence_pack", {
      project_id: P1,
      start: "2026-11-01",
      end: "2026-11-03",
    });
    const p = (r.result as { structuredContent: unknown }).structuredContent as {
      web: {
        verified: { pageviews: number };
        raw: { pageviews: number };
        verdicts: { verdict: Record<string, number> };
      };
      api: { top_routes: { route: string }[]; label: string };
      range: { end_exclusive: boolean };
    };
    assert.equal(p.web.verified.pageviews, 120);
    assert.equal(p.web.raw.pageviews, 150);
    assert.equal(p.web.verdicts.verdict.verified, 125);
    assert.equal(p.api.top_routes[0]?.route, "/accounts/{account}");
    assert.equal(p.api.label, "self-attested telemetry");
    assert.equal(p.range.end_exclusive, true);
    await c.close();
  });

  test("input errors and API errors are tool errors (isError), not protocol errors", async () => {
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "op.key"),
    });
    const bad = await call(c, 1, "web_summary", { start: "yesterday" });
    assert.equal((bad.result as { isError: boolean }).isError, true);
    const order = await call(c, 2, "web_summary", { start: "2026-11-08", end: "2026-11-01" });
    assert.match(
      (order.result as { content: { text: string }[] }).content[0]?.text ?? "",
      /end must be after start/,
    );
    const ids = await call(c, 3, "evidence_pack", { project_id: "not-a-uuid" });
    assert.equal((ids.result as { isError: boolean }).isError, true);
    const unknown = await call(c, 4, "drop_tables", {});
    assert.equal((unknown.error as { code: number }).code, -32602);
    await c.close();
  });

  test("without an operator key the operator tools explain how to configure one", async () => {
    const c = new Client({ USAGEMAP_API_URL: apiUrl });
    const r = await call(c, 1, "list_projects");
    const res = r.result as { isError: boolean; content: { text: string }[] };
    assert.equal(res.isError, true);
    assert.match(res.content[0]?.text ?? "", /USAGEMAP_OPERATOR_KEY_FILE/);
    await c.close();
  });

  test("project_metrics_document uses the share key; a wrong key is reported as 401 without echoing it", async () => {
    seen.length = 0;
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_SHARE_KEY_FILE: join(dir, "pub.key"),
    });
    const r = await call(c, 1, "project_metrics_document", { slug: "demo" });
    assert.equal(
      (r.result as { structuredContent: { web: { pageviews: number } } }).structuredContent.web
        .pageviews,
      1234,
    );
    assert.equal(seen[0]?.auth, `Bearer ${PUB_KEY}`);
    await c.close();
    const wrong = `scfa_pub_${"C1b2C3d4E5f6"}_${"q".repeat(27)}Qq0Qq0`;
    const c2 = new Client({ USAGEMAP_API_URL: apiUrl, USAGEMAP_SHARE_KEY: wrong });
    const r2 = await call(c2, 1, "project_metrics_document", { slug: "demo" });
    const t = (r2.result as { content: { text: string }[] }).content[0]?.text ?? "";
    assert.match(t, /401/);
    await c2.close();
    assert.ok(!c2.stdout.includes(wrong) && !c2.stderr.includes(wrong));
  });

  test("keys never reach stdout or stderr; the API sees them only in Authorization", async () => {
    seen.length = 0;
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "op.key"),
    });
    for (const [i, t] of [
      "list_projects",
      "web_summary",
      "api_routes_summary",
      "trust_flags",
    ].entries())
      await call(c, i, t, { project_ids: [P1] });
    await call(c, 9, "evidence_pack", { project_id: P1 });
    await c.close();
    assert.ok(!c.stdout.includes(OP_KEY) && !c.stderr.includes(OP_KEY));
    assert.ok(!c.stdout.includes(OP_KEY.slice(20)));
    assert.ok(
      seen.length > 5 &&
        seen.every((s) => s.auth === `Bearer ${OP_KEY}` && !s.query.toString().includes("scfa_")),
    );
  });

  test("a malformed key file stops the server with exit 2 and no key in the message", async () => {
    writeFileSync(join(dir, "bad.key"), "scfa_op_short\n");
    const c = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "bad.key"),
    });
    assert.equal(await c.close(), 2);
    assert.match(c.stderr, /not a UsageMap key/);
    writeFileSync(join(dir, "ing.key"), `scfa_ing_${"A1b2C3d4E5f6"}_${"x".repeat(27)}Zz0Zz0\n`);
    const c2 = new Client({
      USAGEMAP_API_URL: apiUrl,
      USAGEMAP_OPERATOR_KEY_FILE: join(dir, "ing.key"),
    });
    assert.equal(await c2.close(), 2);
    assert.match(c2.stderr, /expected a scfa_op_ key, got a scfa_ing_ key/);
  });
});

describe("network rule and redaction (unit)", () => {
  test("the client contacts only its base origin and refuses redirects", async () => {
    const cl = new ApiClient({ baseUrl: apiUrl, key: OP_KEY });
    assert.throws(() => cl.url("//evil.example/x"), /bad path/);
    assert.throws(() => cl.url("https://evil.example/x"), /bad path/);
    assert.equal(cl.url("/op/v1/me").origin, apiUrl);
    await assert.rejects(cl.get("/op/v1/redirect"), /redirect refused \(302\)/);
    await assert.rejects(
      cl.get("/op/v1/leaky"),
      (e: Error) => !e.message.includes(OP_KEY) && /redacted/.test(e.message),
    );
    assert.throws(() => new ApiClient({ baseUrl: "http://example.org" }), /must be https/);
    assert.throws(() => new ApiClient({ baseUrl: "https://u:p@example.org" }), /credentials/);
  });

  test("redact removes keys and seeds; loadKey checks the kind", () => {
    const seed = `S${"A".repeat(55)}`;
    assert.equal(redact(`x ${OP_KEY} y ${seed} z`), "x scfa_[redacted] y S[redacted] z");
    assert.equal(loadKey({ value: OP_KEY }, "op"), OP_KEY);
    assert.throws(() => loadKey({ value: OP_KEY }, "pub"), /expected a scfa_pub_ key/);
    assert.throws(() => loadKey({ file: join(dir, "missing") }, "op"), /ENOENT/);
  });

  test("handle() ignores client responses and validates ids", async () => {
    const spec = createSpec({ baseUrl: apiUrl });
    assert.equal(await handle(spec, {}, { jsonrpc: "2.0", id: 1, result: {} }), null);
    const r = (await handle(spec, {}, { jsonrpc: "2.0", id: null, method: "ping" })) as {
      error: { code: number };
    };
    assert.equal(r.error.code, -32600);
    const v = (await handle(spec, {}, { jsonrpc: "1.0", id: 1, method: "ping" })) as {
      error: { code: number };
    };
    assert.equal(v.error.code, -32600);
    const ping = (await handle(
      spec,
      {},
      { jsonrpc: "2.0", id: 2, method: "ping", params: { _meta: meta } },
    )) as {
      result: { resultType: string };
    };
    assert.equal(ping.result.resultType, "complete");
  });

  test("sumVerdicts adds counters across days and sites", () => {
    assert.deepEqual(
      sumVerdicts([
        { counter: "verdict", label: "verified", count: 2 },
        { counter: "verdict", label: "verified", count: 3 },
        { counter: "reason", label: "ua_bot", count: 1 },
      ]),
      { verdict: { verified: 5 }, reason: { ua_bot: 1 } },
    );
  });
});
