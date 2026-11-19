// SPDX-License-Identifier: Apache-2.0
// Server, edge and SDK integration examples (examples/<integration>) run as their READMEs say, against a local
// stand-in of UsageMap's OTLP front door (bearer token required, logs refused; ../backends/otlp-receiver.ts) and a
// local stand-in of the third-party service each one calls (Stellar RPC and Horizon, an anchor, a partner API, Kafka).
// For every example:
//
//   - it runs and does its job (exit code, its own output);
//   - UsageMap received `/v1/metrics` only, every request with the right bearer token;
//   - the metric the integration promises arrived, with the closed attribute values its guide lists;
//   - no forbidden attribute key (client address, user agent, query, full URL, headers, end-user ids) and none of the
//     canary strings the test planted (API keys in URLs, query strings, user agent, forwarded address, addresses,
//     amounts, secrets) anywhere in any byte UsageMap received.
//
// Runtimes: Node on the host (mise toolchain); Cloudflare's workerd through the example's own `wrangler dev`; Deno,
// Bun and Python in pinned images; Kafka (apache/kafka) in a pinned image for the Anchor Platform listener. Run:
// tests/quickstarts/integrations/run.sh (QS_INTEGRATIONS=edge-deno,payments-mpp limits it).

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../lib/env.ts";
import {
  attributeKeys,
  FORBIDDEN_KEY,
  metricNames,
  type Receiver,
  type ResourceMetrics,
  requestsByRouteStatus,
  startReceiver,
} from "../backends/otlp-receiver.ts";
import {
  allowSkip,
  dockerRun,
  EXAMPLES,
  exec,
  freePort,
  has,
  json,
  type Proc,
  run,
  runWithInput,
  type StandIn,
  selected,
  standIn,
  start,
  until,
} from "./lib.ts";

const CACHE = process.env.QS_INTEGRATIONS_CACHE ?? join(tmpdir(), "scf-qs-integrations");
const TOKEN = "scfa_ing_qsintegrationtoken";
const IMAGES = {
  python:
    "python:3.13-alpine3.23@sha256:bf88c40985006a79ca25458159a4da1dffc457f9ae234e948b2d6df56ca5ebd2",
  deno: "denoland/deno:alpine-2.9.8@sha256:75749604f68aea01d39bead15fd1c86343639e44eb8c58ab051da8a924799d01",
  bun: "oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a",
  kafka:
    "apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f",
} as const;

/** Values planted in what the examples handle; none may reach UsageMap. */
const CANARY = {
  key: "QSCANARYPROVIDERKEY", // an RPC provider / partner API key in a URL or header
  query: "?email=qs.canary%40example.com&wallet=GQSCANARYWALLETADDRESSNEVERSTORED",
  ua: "QsCanaryAgent/9.9",
  xff: "198.51.100.77",
};
const CANARY_STRINGS = [
  CANARY.key,
  "qs.canary",
  "GQSCANARY",
  "QsCanaryAgent",
  CANARY.xff,
  "email=",
];

const node = process.execPath;
let dockerOk: boolean | undefined;
async function docker(): Promise<boolean> {
  dockerOk ??= await has("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return dockerOk;
}

/** Skips (with a reason) only when QS_INTEGRATIONS_ALLOW_SKIP=1; otherwise a missing toolchain fails. */
async function need(ok: boolean, what: string, ctx: { skip: (note?: string) => void }) {
  if (ok) return;
  if (allowSkip) ctx.skip(`${what} not available`);
  throw new Error(`${what} not available (QS_INTEGRATIONS_ALLOW_SKIP=1 to skip)`);
}

interface Pt {
  attrs: Record<string, string>;
  count: number;
  value: number;
  /** 1 delta, 2 cumulative */
  temporality: number;
  time: bigint;
}

/** Every data point of `name`, attribute values as strings; histogram points carry `count`, sums `value`. */
function points(rms: ResourceMetrics[], name: string): Pt[] {
  return rms.flatMap((rm) =>
    rm.scopeMetrics.flatMap((sm) =>
      sm.metrics
        .filter((m) => m.name === name)
        .flatMap((m) =>
          m.points.map((p) => ({
            attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, String(v)])),
            count: p.count ?? 0,
            value: p.value ?? 0,
            temporality: m.temporality,
            time: p.timeUnixNano,
          })),
        ),
    ),
  );
}

/**
 * The total of `field` over points (each example is one process): a cumulative stream counts its last point per
 * attribute set, delta points are summed.
 */
function total(ps: Pt[], field: "count" | "value"): number {
  const last = new Map<string, Pt>();
  let delta = 0;
  for (const p of ps) {
    if (p.temporality === 1) {
      delta += p[field];
      continue;
    }
    const k = JSON.stringify(Object.entries(p.attrs).sort());
    const prev = last.get(k);
    if (!prev || p.time >= prev.time) last.set(k, p);
  }
  return delta + [...last.values()].reduce((n, p) => n + p[field], 0);
}

/** Points of `name` whose attributes include `match`. */
const having = (ps: Pt[], match: Record<string, string>) =>
  ps.filter((p) => Object.entries(match).every(([k, v]) => p.attrs[k] === v));

/** The checks every example shares: metrics only, authorized, no forbidden key, no canary byte. */
function expectClean(r: Receiver, extraCanaries: string[] = []) {
  expect(r.received.length, "something arrived").toBeGreaterThan(0);
  for (const x of r.received) {
    expect(x.path).toBe("/v1/metrics");
    expect(x.authorized, "bearer token").toBe(true);
    expect(x.status, x.decodeError ?? "accepted").toBe(200);
  }
  const keys = attributeKeys(r.metrics());
  for (const k of [...keys.resource, ...keys.point, ...keys.exemplar])
    for (const re of FORBIDDEN_KEY) expect(k, `forbidden key ${k}`).not.toMatch(re);
  const bytes = Buffer.concat(r.received.map((x) => x.body)).toString("latin1");
  for (const c of [...CANARY_STRINGS, ...extraCanaries])
    expect(bytes.includes(c), `canary ${c} reached UsageMap`).toBe(false);
}

/** OTLP environment of the guides, pointed at the stand-in. */
const otlpEnv = (r: Receiver, service: string): Record<string, string> => ({
  OTEL_SERVICE_NAME: service,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${r.url}/v1/metrics`,
  OTEL_EXPORTER_OTLP_METRICS_HEADERS: `Authorization=Bearer%20${TOKEN}`,
});
/** The edge middleware's environment (base endpoint, `/v1/metrics` appended). */
const edgeEnv = (r: Receiver, service: string): Record<string, string> => ({
  OTEL_SERVICE_NAME: service,
  OTEL_EXPORTER_OTLP_ENDPOINT: r.url,
  OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${TOKEN}`,
});

const receivers: Receiver[] = [];
const standIns: StandIn[] = [];
const procs: Proc[] = [];
async function receiver(): Promise<Receiver> {
  const r = await startReceiver({ token: TOKEN, refuseLogs: true });
  receivers.push(r);
  return r;
}
async function stand(h: Parameters<typeof standIn>[0]): Promise<StandIn> {
  const s = await standIn(h);
  standIns.push(s);
  return s;
}
function launch(...args: Parameters<typeof start>): Proc {
  const p = start(...args);
  procs.push(p);
  return p;
}

beforeAll(() => {
  mkdirSync(CACHE, { recursive: true });
});
afterAll(async () => {
  await Promise.all(procs.map((p) => p.stop().catch(() => null)));
  await Promise.all([...receivers, ...standIns].map((s) => s.close()));
});

// ---------------------------------------------------------------- Stellar RPC + Horizon stand-in

const RPC_FIXTURE = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/stellar-otel/test/fixtures/testnet-rpc.json"), "utf8"),
) as Record<string, { result?: unknown }>;

/** A Stellar RPC (JSON-RPC, recorded testnet answers) under `/rpc-<key>` and a Horizon under `/hz-<key>`. */
const stellarStandIn = () =>
  stand((hit, res) => {
    if (hit.method === "POST" && hit.path.startsWith(`/rpc-${CANARY.key}`)) {
      const req = hit.json as { id: number; method: string };
      const rec = RPC_FIXTURE[req.method];
      if (!rec) return json(res, 200, { jsonrpc: "2.0", id: req.id, error: { code: -32601 } });
      return json(res, 200, { ...rec, id: req.id });
    }
    if (hit.path.startsWith(`/hz-${CANARY.key}/fee_stats`))
      return json(res, 200, {
        last_ledger: "5812068",
        last_ledger_base_fee: "100",
        ledger_capacity_usage: "0.5",
        fee_charged: { max: "200", min: "100", mode: "100", p50: "100", p99: "200" },
        max_fee: { max: "200", min: "100", mode: "100", p50: "100", p99: "200" },
      });
    return false;
  });

function expectStellarSdkMetrics(r: Receiver) {
  const rms = r.metrics();
  const calls = points(rms, "rpc.client.call.duration");
  for (const method of ["getHealth", "getNetwork"])
    expect(
      total(
        having(calls, {
          "rpc.method": method,
          "rpc.system.name": "jsonrpc",
          "stellar.network": "testnet",
        }),
        "count",
      ),
      method,
    ).toBe(1);
  const hz = having(points(rms, "http.client.request.duration"), {
    "url.template": "/fee_stats",
    "http.request.method": "GET",
    "stellar.network": "testnet",
  });
  expect(total(hz, "count")).toBe(1);
  expect(String(hz[0]?.attrs["http.response.status_code"])).toBe("200");
  expectClean(r);
}

describe.skipIf(!selected("stellar-rpc-node"))("examples/stellar-rpc-node", () => {
  it("measures RPC methods and Horizon routes; no URL (provider key) reaches UsageMap", async () => {
    const r = await receiver();
    const s = await stellarStandIn();
    const { stdout } = await run(node, ["index.mjs"], {
      cwd: join(EXAMPLES, "stellar-rpc-node"),
      env: {
        ...otlpEnv(r, "my-backend"),
        STELLAR_RPC_URL: `${s.url}/rpc-${CANARY.key}`,
        HORIZON_URL: `${s.url}/hz-${CANARY.key}`,
      },
    });
    expect(stdout).toContain("rpc healthy, protocol 30, fee p50 100");
    expect(s.hits.map((h) => h.path.split("/")[2] ?? "")).toContain("fee_stats");
    expectStellarSdkMetrics(r);
  });
});

describe.skipIf(!selected("stellar-rpc-python"))("examples/stellar-rpc-python", () => {
  it("measures RPC methods and Horizon routes from py-stellar-base (python:3.13 image)", async (ctx) => {
    await need(await docker(), "docker", ctx);
    const ex = join(EXAMPLES, "stellar-rpc-python");
    const deps = join(CACHE, "python-stellar");
    mkdirSync(deps, { recursive: true });
    await run(
      "docker",
      dockerRun(`qsi-py-deps-${process.pid}`, {}, [
        "-v",
        `${ex}:/src:ro`,
        "-v",
        `${deps}:/deps`,
        IMAGES.python,
        "sh",
        "-c",
        "h=$(sha256sum /src/requirements.txt | cut -c1-16); test -f /deps/.done-$h || " +
          "(rm -rf /deps/site && pip install -q --no-cache-dir --disable-pip-version-check --no-deps " +
          "--only-binary=:all: --target /deps/site -r /src/requirements.txt && touch /deps/.done-$h)",
      ]),
    );
    const r = await receiver();
    const s = await stellarStandIn();
    const { stdout } = await run(
      "docker",
      dockerRun(
        `qsi-py-${process.pid}`,
        {
          ...otlpEnv(r, "my-python-backend"),
          STELLAR_RPC_URL: `${s.url}/rpc-${CANARY.key}`,
          HORIZON_URL: `${s.url}/hz-${CANARY.key}`,
          PYTHONPATH: "/deps/site:/pkg/src",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        [
          "-v",
          `${ex}:/app:ro`,
          "-v",
          `${deps}:/deps:ro`,
          "-v",
          `${join(REPO_ROOT, "packages/stellar-otel-py/src")}:/pkg/src:ro`,
          "-w",
          "/app",
          IMAGES.python,
          "python",
          "main.py",
        ],
      ),
    );
    expect(stdout).toContain("rpc healthy, protocol 30, fee p50 100");
    expectStellarSdkMetrics(r);
  });
});

// ---------------------------------------------------------------- payments (MPP)

describe.skipIf(!selected("payments-mpp"))("examples/payments-mpp", () => {
  it("counts payment required / paid / failed; payer, payee, amount and credential stay in the server", async () => {
    const r = await receiver();
    const port = await freePort();
    const cwd = join(EXAMPLES, "payments-mpp");
    const payee = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    const secret = "qs-mpp-secret-0123456789abcdef-0123456789";
    const server = launch(node, ["server.mjs"], {
      cwd,
      env: { ...otlpEnv(r, "paid-api"), PORT: String(port), MPP_SECRET_KEY: secret },
    });
    await server.waitFor(/listening on/);
    const api = { API_URL: `http://127.0.0.1:${port}` };
    const ok = await run(node, ["pay.mjs"], { cwd, env: api });
    expect(ok.stdout).toContain("GET /report → 402");
    expect(ok.stdout).toContain("GET /report with payment → 200");
    const bad = await run(node, ["pay.mjs", "bad"], { cwd, env: api });
    expect(bad.stdout).toContain("GET /report with payment → 402");
    expect(await server.stop()).toBe(0); // SIGTERM: otel.mjs flushes the last counts

    const ev = points(r.metrics(), "payment.server.events");
    const base = {
      "payment.protocol": "mpp",
      "payment.method": "stellar",
      "payment.intent": "charge",
      "payment.network": "stellar:testnet",
      "payment.asset": "USDC",
    };
    const sum = (m: Record<string, string>) => total(having(ev, m), "value");
    expect(sum({ ...base, "payment.stage": "required" })).toBeGreaterThanOrEqual(2);
    expect(sum({ ...base, "payment.stage": "paid" })).toBe(1);
    expect(
      sum({ ...base, "payment.stage": "failed", "payment.reason_class": "verification_failed" }),
    ).toBe(1);
    expectClean(r, [payee, secret, "demo-paid", "not-a-real-payment"]);
  });
});

// ---------------------------------------------------------------- anchor wallet side (Wallet SDK)

interface StellarSdk {
  Keypair: { random(): { publicKey(): string } };
  Networks: { TESTNET: string };
  WebAuth: {
    buildChallengeTx(
      server: unknown,
      account: string,
      homeDomain: string,
      timeout: number,
      passphrase: string,
      webAuthDomain: string,
    ): string;
  };
}

describe.skipIf(!selected("anchor-wallet-sdk"))("examples/anchor-wallet-sdk", () => {
  it("measures SEP-1/10/24 steps and the funnel; no account, token, amount or URL", async () => {
    const sdk = createRequire(join(EXAMPLES, "anchor-wallet-sdk/package.json"))(
      "@stellar/stellar-sdk",
    ) as StellarSdk;
    const signer = sdk.Keypair.random();
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ iss: "x", sub: "GQSCANARYWALLETADDRESSNEVERSTORED", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
    let base = "";
    let home = "";
    const anchor = await stand((hit, res) => {
      const path = hit.path.split("?")[0];
      switch (`${hit.method} ${path}`) {
        case "GET /.well-known/stellar.toml":
          res
            .writeHead(200, { "content-type": "text/plain" })
            .end(
              [
                `NETWORK_PASSPHRASE="${sdk.Networks.TESTNET}"`,
                `SIGNING_KEY="${signer.publicKey()}"`,
                `WEB_AUTH_ENDPOINT="${base}/auth"`,
                `TRANSFER_SERVER_SEP0024="${base}/sep24"`,
                "[DOCUMENTATION]",
                'ORG_NAME="QS Test Anchor"',
                "",
              ].join("\n"),
            );
          return;
        case "GET /auth": {
          const account = new URL(hit.path, base).searchParams.get("account") ?? "";
          const tx = sdk.WebAuth.buildChallengeTx(
            signer,
            account,
            home,
            300,
            sdk.Networks.TESTNET,
            "127.0.0.1",
          );
          return json(res, 200, { transaction: tx, network_passphrase: sdk.Networks.TESTNET });
        }
        case "POST /auth":
          return json(res, 200, { token: jwt });
        case "GET /sep24/info":
          return json(res, 200, {
            deposit: { SRT: { enabled: true } },
            withdraw: { SRT: { enabled: true } },
            fee: { enabled: false },
          });
        case "POST /sep24/transactions/deposit/interactive":
          return json(res, 200, {
            type: "interactive_customer_info_needed",
            url: `${base}/kyc?token=${CANARY.key}&amount=4242.17`,
            id: "tx-qs-canary-0001",
          });
        default:
          return false;
      }
    });
    home = `127.0.0.1:${anchor.port}`;
    base = `http://${home}`;
    const r = await receiver();
    const { stdout } = await run(node, ["index.mjs"], {
      cwd: join(EXAMPLES, "anchor-wallet-sdk"),
      env: { ...otlpEnv(r, "my-wallet-backend"), ANCHOR_HOME_DOMAIN: home, ALLOW_HTTP: "1" },
    });
    expect(stdout).toContain("SEP-24 deposit of SRT enabled: true");
    expect(stdout).toContain("interactive deposit started (interactive_customer_info_needed)");

    const rms = r.metrics();
    const steps = points(rms, "stellar.anchor.request.duration");
    // a local anchor (an IP address) is reported as `_OTHER`, never by address: the guide's home-domain rule
    for (const p of steps) expect(p.attrs["stellar.anchor.home_domain"]).toBe("_OTHER");
    const seen = (sep: string, step: string) =>
      total(
        having(steps, {
          "stellar.sep": sep,
          "stellar.anchor.step": step,
          "stellar.anchor.outcome": "ok",
          "stellar.network": "testnet",
        }),
        "count",
      );
    expect(seen("1", "toml")).toBeGreaterThanOrEqual(1);
    expect(seen("10", "challenge")).toBe(1);
    expect(seen("10", "token")).toBe(1);
    expect(seen("24", "info")).toBeGreaterThanOrEqual(1); // deposit() reads info again
    expect(seen("24", "deposit_interactive")).toBe(1);
    const events = new Set(
      points(rms, "stellar.anchor.events").map((p) => p.attrs["stellar.anchor.event"]),
    );
    for (const e of ["authenticated", "deposit_interactive_started"])
      expect(events, e).toContain(e);
    expectClean(r, [jwt, "tx-qs-canary-0001", "4242.17", "/kyc", String(anchor.port)]);
  });
});

// ---------------------------------------------------------------- partner API calls

describe.skipIf(!selected("partner-calls"))("examples/partner-calls", () => {
  it("measures calls per partner route template and outcome; no key, query or body", async () => {
    const partner = await stand((hit, res) => {
      if (hit.method === "POST" && hit.path.startsWith("/quote"))
        return json(res, 200, { amountOut: "4242170", trade: "qs-canary-trade" });
      if (hit.method === "GET" && hit.path.startsWith("/price"))
        return json(res, 429, { error: "rate limited" });
      return false;
    });
    const r = await receiver();
    const { stdout } = await run(node, ["index.mjs"], {
      cwd: join(EXAMPLES, "partner-calls"),
      env: {
        ...otlpEnv(r, "my-backend"),
        SOROSWAP_API_URL: partner.url,
        SOROSWAP_API_KEY: CANARY.key,
      },
    });
    expect(stdout).toContain("POST /quote → 200");
    expect(stdout).toContain("GET /price → 429");
    expect(partner.hits.map((h) => h.headers.authorization)).toEqual([
      `Bearer ${CANARY.key}`,
      `Bearer ${CANARY.key}`,
    ]);
    const ps = points(r.metrics(), "stellar.partner.call.duration");
    const one = (op: string, outcome: string) =>
      total(
        having(ps, {
          "stellar.partner": "soroswap",
          "stellar.partner.operation": op,
          "stellar.partner.outcome": outcome,
          "stellar.network": "testnet",
        }),
        "count",
      );
    expect(one("/quote", "success")).toBe(1);
    expect(one("/price", "rate_limited")).toBe(1);
    for (const p of ps) expect(Object.keys(p.attrs).sort()).toHaveLength(4);
    expectClean(r, [
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "4242170",
      "qs-canary-trade",
      "EXACT_IN",
    ]);
  });
});

// ---------------------------------------------------------------- edge middleware

/** The request mix every edge example answers; canary query, user agent and forwarded address on each request. */
async function hitEdge(base: string, accounts: string, n200 = 5, n404 = 3) {
  const get = async (path: string, want: number) => {
    const res = await fetch(`${base}${path}${CANARY.query}`, {
      headers: { "user-agent": CANARY.ua, "x-forwarded-for": CANARY.xff, cookie: "sid=qs.canary" },
    });
    await res.arrayBuffer();
    expect(res.status, path).toBe(want);
  };
  for (let i = 0; i < n200; i++) await get(`${accounts}/GABC`, 200);
  for (let i = 0; i < n404; i++) await get(`${accounts}/GMISSING`, 404);
}

async function ready(url: string, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.status < 500) return;
    } catch {
      /* not yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function expectEdgeRoutes(r: Receiver, route: string, extra: { route: string; min: number }[]) {
  const rs = requestsByRouteStatus(r.metrics());
  const count = (rt: string, status: number) =>
    rs.find((x) => x.route === rt && x.status === status)?.count ?? 0;
  expect(count(route, 200), `${route} 200`).toBeGreaterThanOrEqual(5);
  expect(count(route, 404), `${route} 404`).toBe(3);
  for (const e of extra) expect(count(e.route, 200), e.route).toBeGreaterThanOrEqual(e.min);
  expect(metricNames(r.metrics())).toEqual(new Set(["http.server.request.duration"]));
  for (const p of points(r.metrics(), "http.server.request.duration"))
    expect(Object.keys(p.attrs).sort()).toEqual([
      "http.request.method",
      "http.response.status_code",
      "http.route",
    ]);
  expectClean(r, ["sid="]);
}

/** Delta windows are exported by the next request after a window closes (per-request runtimes). */
async function nextWindow(r: Receiver, trigger: string) {
  await new Promise((res) => setTimeout(res, 10_500));
  await (await fetch(trigger)).arrayBuffer();
  await until(() => r.metrics().length > 0, 20_000, "an export");
}

describe.skipIf(!selected("edge-cloudflare-workers"))("examples/edge-cloudflare-workers", () => {
  it("the Worker in workerd (wrangler dev): route templates, export via waitUntil", async () => {
    const r = await receiver();
    const port = await freePort();
    const cwd = join(EXAMPLES, "edge-cloudflare-workers");
    const wrangler = launch(
      join(cwd, "node_modules/.bin/wrangler"),
      [
        "dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--persist-to",
        join(CACHE, `wrangler-state-${process.pid}`),
        "--var",
        `OTEL_EXPORTER_OTLP_ENDPOINT:${r.url}`,
        "--var",
        `OTEL_EXPORTER_OTLP_HEADERS:Authorization=Bearer%20${TOKEN}`,
      ],
      {
        cwd,
        env: {
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: join(CACHE, "wrangler-logs"),
          CI: "1",
        },
      },
    );
    await wrangler.waitFor(/Ready on/, 120_000);
    const base = `http://127.0.0.1:${port}`;
    await ready(`${base}/health`);
    await hitEdge(base, "/accounts");
    await nextWindow(r, `${base}/health`);
    expectEdgeRoutes(r, "/accounts/{id}", [{ route: "/health", min: 1 }]);
    expect(
      r.metrics().every((rm) => rm.resource["service.name"] === "my-worker"),
      "service.name from wrangler.toml",
    ).toBe(true);
    await wrangler.stop();
  });
});

describe.skipIf(!selected("edge-vercel"))("examples/edge-vercel", () => {
  it("the edge function on Node (dev.mjs): route template from the file name, export via waitUntil", async () => {
    const r = await receiver();
    const port = await freePort();
    const p = launch(node, ["dev.mjs"], {
      cwd: join(EXAMPLES, "edge-vercel"),
      env: { ...edgeEnv(r, "my-edge-api"), PORT: String(port) },
    });
    await p.waitFor(/listening on/);
    const base = `http://127.0.0.1:${port}`;
    await hitEdge(base, "/api/accounts");
    await nextWindow(r, `${base}/api/accounts/GABC`);
    expectEdgeRoutes(r, "/api/accounts/{id}", []);
    await p.stop();
  });
});

for (const id of ["edge-deno", "edge-bun"] as const) {
  describe.skipIf(!selected(id))(`examples/${id}`, () => {
    it(`the server in the pinned ${id === "edge-deno" ? "Deno" : "Bun"} image: flush timer, last window on SIGTERM`, async (ctx) => {
      await need(await docker(), "docker", ctx);
      const r = await receiver();
      const port = await freePort();
      const name = `qsi-${id}-${process.pid}`;
      const mounts = [
        "-v",
        `${join(EXAMPLES, id)}:/repo/examples/${id}:ro`,
        "-v",
        `${join(REPO_ROOT, "packages/edge-otel")}:/repo/packages/edge-otel:ro`,
        "-w",
        `/repo/examples/${id}`,
      ];
      const cmd =
        id === "edge-deno"
          ? [IMAGES.deno, "deno", "run", "--allow-net", "--allow-env", "main.ts"]
          : [IMAGES.bun, "bun", "run", "index.ts"];
      const p = launch(
        "docker",
        dockerRun(
          name,
          { ...edgeEnv(r, `my-${id}-api`), PORT: String(port), DENO_DIR: "/tmp/deno" },
          [...mounts, ...cmd],
        ),
        { container: name },
      );
      await p.waitFor(/[Ll]istening on/, 120_000);
      const base = `http://127.0.0.1:${port}`;
      await ready(`${base}/health`);
      await hitEdge(base, "/accounts");
      expect(await p.stop()).toBe(0); // docker stop: SIGTERM → usagemap.shutdown()
      expect(p.log()).not.toContain("analytics off");
      expectEdgeRoutes(r, "/accounts/{id}", [{ route: "/health", min: 1 }]);
    });
  });
}

// ---------------------------------------------------------------- Anchor Platform event listener

describe.skipIf(!selected("anchor-platform-listener"))("examples/anchor-platform-listener", () => {
  const ex = join(EXAMPLES, "anchor-platform-listener");
  const bin = join(CACHE, "ap-listener");

  it("builds tools/ap-listener; run.sh -check-config accepts the example's listener.env", async (ctx) => {
    await need(await has("go", ["version"]), "go", ctx);
    await run("go", ["build", "-trimpath", "-o", bin, "."], {
      cwd: join(REPO_ROOT, "tools/ap-listener"),
      env: { CGO_ENABLED: "0" }, // the repository's go.work, as run.sh builds it
    });
    const { stdout } = await run(join(ex, "run.sh"), ["-check-config"], {
      env: { AP_LISTENER_BIN: bin },
    });
    expect(stdout).toContain("configuration ok");
    // the shell wins over the file: a bad override is reported, not silently replaced
    await expect(
      run(join(ex, "run.sh"), ["-check-config"], {
        env: { AP_LISTENER_BIN: bin, AP_KAFKA_START: "yesterday" },
      }),
    ).rejects.toThrow(/AP_KAFKA_START/);
  });

  it("reads Anchor Platform events from a real Kafka and exports the funnel metrics only", async (ctx) => {
    await need(await docker(), "docker", ctx);
    await need(await has("go", ["version"]), "go", ctx);
    const [kport, cport] = [await freePort(), await freePort()];
    const kname = `qsi-kafka-${process.pid}`;
    const kafka = launch(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        kname,
        "--network",
        "host",
        "-e",
        "KAFKA_NODE_ID=1",
        "-e",
        "KAFKA_PROCESS_ROLES=broker,controller",
        "-e",
        `KAFKA_LISTENERS=PLAINTEXT://127.0.0.1:${kport},CONTROLLER://127.0.0.1:${cport}`,
        "-e",
        `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${kport}`,
        "-e",
        "KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER",
        "-e",
        "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
        "-e",
        `KAFKA_CONTROLLER_QUORUM_VOTERS=1@127.0.0.1:${cport}`,
        "-e",
        "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1",
        "-e",
        "KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1",
        "-e",
        "KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1",
        "-e",
        "KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0",
        IMAGES.kafka,
      ],
      { container: kname },
    );
    const kbin = "/opt/kafka/bin";
    const t0 = Date.now();
    for (;;) {
      try {
        await exec("docker", [
          "exec",
          kname,
          `${kbin}/kafka-topics.sh`,
          "--bootstrap-server",
          `127.0.0.1:${kport}`,
          "--create",
          "--if-not-exists",
          "--topic",
          "TRANSACTION",
        ]);
        break;
      } catch (e) {
        if (Date.now() - t0 > 120_000) throw new Error(`kafka not ready: ${e}\n${kafka.log()}`);
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    // the recorded Anchor Platform 5.0.0 events of the listener's own tests (amounts, accounts, names, IBANs in
    // them), then the example's sample event
    const recorded = readFileSync(
      join(REPO_ROOT, "tools/ap-listener/testdata/events.jsonl"),
      "utf8",
    );
    const sample = readFileSync(join(ex, "sample-event.json"), "utf8");
    const prod = await runWithInput(
      "docker",
      [
        "exec",
        "-i",
        kname,
        `${kbin}/kafka-console-producer.sh`,
        "--bootstrap-server",
        `127.0.0.1:${kport}`,
        "--topic",
        "TRANSACTION",
      ],
      `${recorded.trim()}\n${sample.trim()}\n`,
    );
    expect(prod.code, prod.stderr).toBe(0);

    const r = await receiver();
    const listener = launch(join(ex, "run.sh"), [], {
      env: {
        AP_LISTENER_BIN: bin,
        AP_KAFKA_BROKERS: `127.0.0.1:${kport}`,
        AP_KAFKA_START: "earliest",
        AP_KAFKA_GROUP: `qsi-${process.pid}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: r.url,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${TOKEN}`,
        OTEL_METRIC_EXPORT_INTERVAL: "1000",
      },
    });
    await until(
      () =>
        having(points(r.metrics(), "stellar.anchor.transfer.created"), {
          "stellar.anchor.client": "wallet.example.org",
        }).length > 0,
      90_000,
      `the sample event's metrics\n${listener.log()}`,
    );
    expect(await listener.stop()).toBe(0);
    await kafka.stop();

    const rms = r.metrics();
    const names = metricNames(rms);
    for (const m of ["stellar.anchor.transfer.created", "stellar.anchor.transfer.transitions"])
      expect(names, m).toContain(m);
    for (const m of names) expect(m).toMatch(/^stellar\.anchor\./);
    const created = having(points(rms, "stellar.anchor.transfer.created"), {
      "stellar.sep": "24",
      "stellar.anchor.kind": "deposit",
      "stellar.anchor.client": "wallet.example.org",
      "stellar.network": "testnet",
    });
    expect(total(created, "value")).toBe(1);
    expect(
      rms.every((rm) => rm.resource["service.name"] === "my-anchor-events"),
      "service.name from listener.env",
    ).toBe(true);
    expectClean(r, [
      "100.25",
      "Jane Doe",
      "DE89370400440532013000",
      "GBXQ5QPEDCQFEWXRO3SPPV3ZGXAKKSNK3AUSP3XQNQSUD7FOXD4UFMXJ",
      "tx-24a",
      "tx-sample-1",
      "evt-sample-1",
    ]);
  });
});
