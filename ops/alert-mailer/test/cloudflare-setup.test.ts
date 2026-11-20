// SPDX-License-Identifier: Apache-2.0
// ops/scripts/cloudflare-email-setup.sh against a local fake of the Cloudflare API (never the real one): the first
// run enables Email Routing and registers the destination, then waits for its verification; the next run creates
// and fixes the two forwarding rules, uploads the Worker with the right bindings and enables its workers.dev URL; a
// third run and --check change nothing. No run prints the destination address or a token, and no request carries
// the address in a URL. Run: pnpm --filter @usagemap/alert-mailer test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

const MAILER = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(MAILER, "..", "scripts", "cloudflare-email-setup.sh");
const CF_TOKEN = "cf-test-token-not-a-real-one";
const DEST = "operations-lead@example.org";

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchers: Array<{ type: string; field?: string; value?: string }>;
  actions: Array<{ type: string; value?: string[] }>;
}
interface Recorded {
  method: string;
  url: string;
  body: string;
}

class FakeCloudflare {
  requests: Recorded[] = [];
  routing = { enabled: false, status: "unconfigured" };
  addresses: Array<{ id: string; email: string; verified: string | null }> = [];
  rules: Rule[] = [
    {
      id: "r-catch",
      name: "catch-all",
      enabled: true,
      priority: 9,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    },
    {
      id: "r-sec",
      name: "old security rule",
      enabled: false,
      priority: 0,
      matchers: [{ type: "literal", field: "to", value: "security@usagemap.dev" }],
      actions: [{ type: "forward", value: ["old-address@example.net"] }],
    },
  ];
  scripts = new Map<
    string,
    { metadata: Record<string, unknown>; modules: Map<string, { type: string; text: string }> }
  >();
  scriptSubdomain = new Map<string, boolean>();
  server!: Server;
  base = "";

  async start() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(([status, body]) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/client/v4`;
  }

  writes() {
    return this.requests.filter((r) => r.method !== "GET");
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const method = req.method ?? "GET";
    this.requests.push({ method, url: req.url ?? "", body: raw.toString("utf8") });
    const ok = (result: unknown, extra: Record<string, unknown> = {}): [number, unknown] => [
      200,
      { success: true, errors: [], messages: [], result, ...extra },
    ];
    const fail = (status: number, code: number, message: string): [number, unknown] => [
      status,
      { success: false, errors: [{ code, message }], result: null },
    ];
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`)
      return fail(403, 10000, "Authentication error");
    const json = () => JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
    const ruleId = /^\/zones\/zone1\/email\/routing\/rules\/([^/]+)$/.exec(path)?.[1];
    const scriptName = /^\/accounts\/acct1\/workers\/scripts\/([^/]+)$/.exec(path)?.[1];
    const subdomainOf = /^\/accounts\/acct1\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path)?.[1];

    if (method === "GET" && path === "/zones") {
      return ok(
        url.searchParams.get("name") === "usagemap.dev"
          ? [{ id: "zone1", name: "usagemap.dev", account: { id: "acct1" } }]
          : [],
      );
    }
    if (path === "/zones/zone1/email/routing" && method === "GET")
      return ok({ ...this.routing, name: "usagemap.dev" });
    if (path === "/zones/zone1/email/routing/dns" && method === "POST") {
      assert.deepEqual(json(), { name: "usagemap.dev" });
      this.routing = { enabled: true, status: "ready" };
      return ok([]);
    }
    if (path === "/accounts/acct1/email/routing/addresses" && method === "GET") {
      return ok(this.addresses, {
        result_info: { page: 1, per_page: 50, total_pages: 1, count: this.addresses.length },
      });
    }
    if (path === "/accounts/acct1/email/routing/addresses" && method === "POST") {
      const a = {
        id: `addr${this.addresses.length + 1}`,
        email: String(json().email),
        verified: null,
      };
      this.addresses.push(a);
      return ok(a);
    }
    if (path === "/zones/zone1/email/routing/rules" && method === "GET") return ok(this.rules);
    if (path === "/zones/zone1/email/routing/rules" && method === "POST") {
      const r = { id: `r${this.rules.length + 1}`, ...(json() as Omit<Rule, "id">) };
      if (
        !this.addresses.some(
          (a) => a.verified && r.actions.every((x) => x.value?.every((v) => v === a.email)),
        )
      ) {
        return fail(400, 2020, "Forward actions require exactly one verified destination address");
      }
      this.rules.push(r);
      return ok(r);
    }
    if (ruleId && method === "PUT") {
      const i = this.rules.findIndex((r) => r.id === ruleId);
      if (i < 0) return fail(404, 2001, "rule not found");
      this.rules[i] = { ...(this.rules[i] as Rule), ...(json() as Partial<Rule>) };
      return ok(this.rules[i]);
    }
    if (scriptName && method === "PUT") {
      const form = await new Request("http://x", {
        method: "PUT",
        headers: { "content-type": String(req.headers["content-type"]) },
        body: raw,
      }).formData();
      const modules = new Map<string, { type: string; text: string }>();
      let metadata: Record<string, unknown> = {};
      for (const [name, value] of form.entries()) {
        assert.ok(typeof value !== "string", `part ${name} is a file part`);
        if (name === "metadata") {
          assert.equal(value.type, "application/json");
          metadata = JSON.parse(await value.text()) as Record<string, unknown>;
        } else modules.set(name, { type: value.type, text: await value.text() });
      }
      this.scripts.set(scriptName, { metadata, modules });
      return ok({ id: scriptName });
    }
    if (subdomainOf) {
      const name = subdomainOf;
      if (!this.scripts.has(name))
        return fail(404, 10007, "This Worker does not exist on your account.");
      if (method === "GET")
        return ok({ enabled: this.scriptSubdomain.get(name) ?? false, previews_enabled: true });
      if (method === "POST") {
        const b = json();
        assert.deepEqual(b, { enabled: true, previews_enabled: false });
        this.scriptSubdomain.set(name, true);
        return ok(b);
      }
    }
    if (path === "/accounts/acct1/workers/subdomain" && method === "GET")
      return ok({ subdomain: "ops-test" });
    return fail(404, 7003, `no route ${method} ${path}`);
  }
}

describe("cloudflare-email-setup.sh (fake Cloudflare API)", () => {
  const cf = new FakeCloudflare();
  let home: string;
  // Asynchronous: the fake API answers from this same process.
  const exec = (args: string[]) =>
    new Promise<{ status: number | null; out: string }>((done) => {
      const child = spawn("bash", [SCRIPT, ...args], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          CONFIG_DIR: join(home, "usagemap"),
          CF_API_BASE: cf.base,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
      });
      child.stderr.on("data", (c: Buffer) => {
        out += c.toString();
      });
      child.on("close", (status) => done({ status, out }));
    });
  const run = async (...args: string[]) => {
    const r = await exec(args);
    const out = r.out;
    // Nothing secret or personal in anything the script prints.
    assert.ok(!out.includes(DEST), `output names the destination address:\n${out}`);
    assert.ok(!out.includes(CF_TOKEN), "output contains the API token");
    const workerToken = (() => {
      try {
        return readFileSync(join(home, "usagemap/secrets/alert-email-worker-token"), "utf8").trim();
      } catch {
        return "";
      }
    })();
    if (workerToken) assert.ok(!out.includes(workerToken), "output contains the Worker secret");
    return { status: r.status, out };
  };

  before(async () => {
    await cf.start();
    home = mkdtempSync(join(tmpdir(), "scf-cf-setup-"));
    mkdirSync(join(home, "usagemap"), { mode: 0o700 });
    writeFileSync(join(home, "usagemap/cloudflare-email-token"), `${CF_TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(home, "usagemap/alert-destination"), `${DEST}\n`, { mode: 0o600 });
  });
  after(() => {
    cf.server.closeAllConnections();
    cf.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("run 1: enables Email Routing, registers the destination, then waits for its verification (exit 3)", async () => {
    const r = await run();
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /open the verification link/);
    assert.deepEqual(
      cf.writes().map((w) => `${w.method} ${w.url}`),
      [
        "POST /client/v4/zones/zone1/email/routing/dns",
        "POST /client/v4/accounts/acct1/email/routing/addresses",
      ],
    );
    assert.deepEqual(
      cf.addresses.map((a) => a.email),
      [DEST],
    );
    assert.equal(cf.scripts.size, 0, "nothing deployed before verification");
  });

  test("run 2 (verified): rules created and fixed, Worker uploaded with its bindings, workers.dev enabled", async () => {
    for (const a of cf.addresses) a.verified = "2026-11-19T22:00:00Z";
    cf.requests.length = 0;
    const r = await run();
    assert.equal(r.status, 0, r.out);
    assert.match(
      r.out,
      /scf_alert_email_worker_url: "https:\/\/usagemap-alert-mailer\.ops-test\.workers\.dev\/v1\/alertmanager"/,
    );

    const forward = (addr: string) =>
      cf.rules.find((x) => x.matchers.some((mm) => mm.value === addr));
    for (const addr of ["security@usagemap.dev", "alerts@usagemap.dev"]) {
      const rule = forward(addr);
      assert.ok(rule, addr);
      assert.equal(rule.enabled, true);
      assert.deepEqual(rule.actions, [{ type: "forward", value: [DEST] }]);
      assert.ok(!rule.name.includes(DEST), "rule names never carry the address");
    }
    assert.equal(
      cf.rules.length,
      3,
      "the existing security rule was updated, not duplicated; catch-all untouched",
    );
    assert.deepEqual(cf.rules[0]?.actions, [{ type: "drop" }]);

    const worker = cf.scripts.get("usagemap-alert-mailer");
    assert.ok(worker);
    const token = readFileSync(
      join(home, "usagemap/secrets/alert-email-worker-token"),
      "utf8",
    ).trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(
      statSync(join(home, "usagemap/secrets/alert-email-worker-token")).mode & 0o777,
      0o600,
    );
    const wrangler = JSON.parse(
      readFileSync(join(MAILER, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ) as {
      compatibility_date: string;
    };
    assert.deepEqual(worker.metadata, {
      main_module: "worker.js",
      compatibility_date: wrangler.compatibility_date,
      bindings: [
        { type: "send_email", name: "MAIL", destination_address: DEST },
        { type: "plain_text", name: "MAIL_FROM", text: "alerts@usagemap.dev" },
        { type: "secret_text", name: "MAIL_TO", text: DEST },
        { type: "secret_text", name: "ALERT_TOKEN", text: token },
      ],
      observability: { enabled: true },
    });
    for (const f of ["worker.js", "mailer.js"]) {
      assert.deepEqual(worker.modules.get(f), {
        type: "application/javascript+module",
        text: readFileSync(join(MAILER, "src", f), "utf8"),
      });
    }
    assert.equal(cf.scriptSubdomain.get("usagemap-alert-mailer"), true);
    for (const req of cf.requests)
      assert.ok(!decodeURIComponent(req.url).includes(DEST), `address in URL ${req.url}`);
  });

  test("run 3 and --check: nothing left to change, no write request", async () => {
    cf.requests.length = 0;
    const r = await run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Done \(0 change\(s\)\)/);
    assert.deepEqual(cf.writes(), []);
    const c = await run("--check");
    assert.equal(c.status, 0, c.out);
    assert.match(c.out, /0 change\(s\) needed/);
    assert.deepEqual(cf.writes(), []);
  });

  test("--check reports drift (a disabled rule) with exit 1 and still writes nothing; apply repairs it", async () => {
    const rule = cf.rules.find((x) => x.matchers.some((mm) => mm.value === "alerts@usagemap.dev"));
    assert.ok(rule);
    rule.enabled = false;
    cf.requests.length = 0;
    const c = await run("--check");
    assert.equal(c.status, 1, c.out);
    assert.match(c.out, /would: update the rule alerts@usagemap\.dev/);
    assert.deepEqual(cf.writes(), []);
    const r = await run();
    assert.equal(r.status, 0, r.out);
    const repaired = cf.rules.find((x) => x.id === rule.id);
    assert.equal(repaired?.enabled, true);
    assert.deepEqual(
      cf.writes().map((w) => w.method),
      ["PUT"],
    );
  });

  test("a token without the permissions fails with exit 4, the HTTP status and the runbook pointer", async () => {
    writeFileSync(join(home, "usagemap/cloudflare-email-token"), "a-dns-only-token\n");
    try {
      const r = await run();
      assert.equal(r.status, 4, r.out);
      assert.match(r.out, /HTTP 403/);
      assert.match(r.out, /runbook alert-email, § API token/);
      assert.ok(!r.out.includes("a-dns-only-token"));
    } finally {
      writeFileSync(join(home, "usagemap/cloudflare-email-token"), `${CF_TOKEN}\n`);
    }
  });

  test("refuses a destination inside the zone and a file that is not one address", async () => {
    for (const bad of [
      "alerts@usagemap.dev",
      "two@example.org, three@example.org",
      "not-an-address",
    ]) {
      writeFileSync(join(home, "usagemap/alert-destination"), `${bad}\n`);
      const r = await exec(["--check"]);
      assert.equal(r.status, 2, bad);
    }
    writeFileSync(join(home, "usagemap/alert-destination"), `${DEST}\n`);
  });
});
