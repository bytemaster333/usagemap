// SPDX-License-Identifier: Apache-2.0
// Gate G3 — e2e API suite (api.*, capacity.1m-requests-day baseline). The S-06a/S-06b sample services (Node/Express,
// Python/FastAPI, Go/net/http, Rust/axum; copied to tests/fixtures/api) run as containers and dual-export with their
// unmodified SDK recipes: to a stand-in "tenant APM" (a counting sink) and to the UsageMap endpoint — the gateway's OTLP
// front door (§f) → Collector (scfsanitize, signal_to_metrics) → metrics writer → PostgreSQL → control-plane API.
// A scripted driver sends a fixed request mix to each service:
//
//   GET /health ×20 (200) · GET /accounts/GABC ×10 (200) · GET /accounts/GMISSING ×5 (404) · GET /boom ×3 (500)
//
// preceded by a readiness probe (the first /health the app answers) and one warm-up request per route. Every request
// the app served is counted by the driver, and the control-plane API must report exactly that: 43 requests, 33/6/4 by
// status class and code (C-122: the first point of a fresh process's stream is counted in full), and p50 ≤ p95 ≤ p99.
// Logs are refused (404), a canary trace leaves only derived metrics (its attributes are recorded for the
// data-inventory scan), and the tenant's APM sink received both metrics and traces (dual export works).
// Requires the OTLP front door (SCF_OTLP_URL): until it is wired every test is NOT RUN with that reason, and with
// SCF_REQUIRE_FULL_STACK=1 it fails.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordCanaries, tag } from "../../lib/canaries.ts";
import { Compose, NODE_IMAGE } from "../../lib/compose.ts";
import { ControlPlane } from "../../lib/cp-client.ts";
import { loadEnv, TESTS_DIR } from "../../lib/env.ts";
import { eventually, openEnrollment } from "../../lib/fixture.ts";
import { requires } from "../../lib/gate.ts";
import { request } from "../../lib/http.ts";
import { Recorder } from "../../lib/recorder.ts";
import { randomStrKey } from "../../lib/stellar.ts";

const run = promisify(execFile);
const env = loadEnv();
const compose = new Compose(env);
const rec = new Recorder(
  env,
  "e2e-api",
  "api",
  "E2E API suite: SDK dual export → OTLP front door → Collector → writer → PostgreSQL → API",
  "Four sample services (Node, Python, Go, Rust) built from the S-06 recipes dual-export to a tenant APM sink and to the UsageMap OTLP endpoint; a fixed request mix is compared with the control-plane API's volume, status codes and percentiles; logs are refused; a canary trace leaves only derived metrics.",
);

const CAPS = ["otlp", "control-plane", "compose", "collector", "metrics-writer", "docker"] as const;
const LANGS = ["node-express", "python-fastapi", "go-nethttp", "rust-axum"] as const;
const MIX = [
  { path: "/health", n: 20, status: 200 },
  { path: "/accounts/GABC", n: 10, status: 200 },
  { path: "/accounts/GMISSING", n: 5, status: 404 },
  { path: "/boom", n: 3, status: 500 },
];
/** Requests the app serves before the measured mix: the readiness probe that answered plus one warm-up per route. */
const PRE = 1 + MIX.length;
const TOTAL = MIX.reduce((a, m) => a + m.n, 0) + PRE;
/** Status code → requests the app served (readiness, warm-up and the measured mix). */
const EXPECTED: Record<string, number> = { 200: 33, 404: 6, 500: 4 };

/** One tenant per service: an L0 tenant may register one service (l0_max_services), a user may own 3 tenants. */
interface Svc {
  cp: ControlPlane;
  tenantId: string;
  serviceId: string;
  token: string;
}
const svc: Record<string, Svc> = {};
const S = (k: string): Svc => {
  const x = svc[k];
  if (!x) throw new Error(`no service ${k}`);
  return x;
};
const net = `${env.project}_public`;
const containers: string[] = [];

async function docker(args: string[], timeout = 900_000) {
  return run("docker", args, { timeout, maxBuffer: 64 * 1024 * 1024 });
}

beforeAll(async () => {
  if (!env.otlpUrl) return; // every test reports NOT RUN through `requires`
  await openEnrollment(compose);
  const id = Date.now().toString(36);
  let cp = new ControlPlane(env);
  let owned = 0;
  for (const l of [...LANGS, "wsl-canary"]) {
    if (owned === 0) await cp.signIn();
    const tenantId = (await cp.createTenant(`wsl-api-${l.slice(0, 10)}-${id}`)).tenant_id;
    const s = await cp.json<{ service_id: string }>("POST", `/v1/tenants/${tenantId}/services`, {
      service_name: l === "wsl-canary" ? l : `wsl-${l}`,
    });
    const t = await cp.json<{ token: string }>("POST", `/v1/tenants/${tenantId}/ingest-tokens`, {
      label: "ws-l e2e",
    });
    svc[l] = { cp, tenantId, serviceId: s.service_id, token: t.token };
    owned++;
    if (owned === 3) {
      cp = new ControlPlane(env);
      owned = 0;
    }
  }
}, 300_000);

afterAll(async () => {
  for (const c of containers) await docker(["rm", "-f", c]).catch(() => undefined);
  const out = rec.write();
  if (out) console.log(`evidence: ${out.md}`);
});

describe("e2e API (G3)", () => {
  it("logs are refused at the front door (404)", async (ctx) => {
    rec.start(ctx, ["api.drop-logs"]);
    await requires(env, ctx, [...CAPS]);
    const r = await request(`${env.otlpUrl}/v1/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${S("node-express").token}`,
      },
      body: JSON.stringify({ resourceLogs: [] }),
      servername: env.ingestHosts[0] as string,
      caFile: env.gatewayCaFile,
    });
    expect(r.status).toBe(404);
  });

  it("a wrong or foreign credential is answered 401", async (ctx) => {
    rec.start(ctx, ["api.dual-export"]);
    await requires(env, ctx, [...CAPS]);
    const r = await request(`${env.otlpUrl}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": "vendor-key-canary" },
      body: JSON.stringify({ resourceMetrics: [] }),
      servername: env.ingestHosts[0] as string,
      caFile: env.gatewayCaFile,
    });
    expect(r.status).toBe(401);
  });

  for (const lang of LANGS) {
    it(`${lang}: dual export lands; volume, status codes and percentiles equal the request mix`, async (ctx) => {
      const d = rec.start(ctx, [
        "api.dual-export",
        "api.drop-traces",
        "api.attribute-allowlist",
        "api.postgres-metrics",
      ]);
      await requires(env, ctx, [...CAPS]);
      const image = `scf-wsl/fixture-${lang}:test`;
      await docker(["build", "-q", "-t", image, `${TESTS_DIR}/fixtures/api/${lang}`]);
      const gw = (
        await docker([
          "inspect",
          "-f",
          `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`,
          await compose.containerId("gateway"),
        ])
      ).stdout.trim();
      const sink = `wsl-apm-${lang}-${tag()}`;
      const app = `wsl-app-${lang}-${tag()}`;
      containers.push(sink, app);
      // the tenant's own APM: counts OTLP requests per path
      await docker([
        "run",
        "-d",
        "--name",
        sink,
        "--network",
        net,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--user",
        "1000:1000",
        NODE_IMAGE,
        "node",
        "-e",
        "const n={};require('node:http').createServer((q,s)=>{q.resume();q.on('end',()=>{if(q.url==='/count'){s.end(JSON.stringify(n));return}n[q.url]=(n[q.url]||0)+1;s.end('{}')})}).listen(4318)",
      ]);
      const scf = `https://${env.ingestHosts[0]}:8443`;
      const apm = `http://${sink}:4318`;
      await docker([
        "run",
        "-d",
        "--name",
        app,
        "--network",
        net,
        "--add-host",
        `${env.ingestHosts[0]}:${gw}`,
        "-v",
        `${env.gatewayCaFile}:/ca.pem:ro`,
        "-e",
        `OTEL_SERVICE_NAME=wsl-${lang}`,
        "-e",
        "OTEL_RESOURCE_ATTRIBUTES=service.instance.id=wsl-1",
        "-e",
        "OTEL_METRIC_EXPORT_INTERVAL=5000",
        // Node / Python recipes
        "-e",
        `SCF_OTLP_URL=${scf}`,
        "-e",
        `APM_OTLP_URL=${apm}`,
        "-e",
        `SCF_OTLP_TOKEN=${S(lang).token}`,
        "-e",
        "APM_API_KEY=apm-key",
        "-e",
        "NODE_EXTRA_CA_CERTS=/ca.pem",
        "-e",
        "REQUESTS_CA_BUNDLE=/ca.pem",
        // Go / Rust recipes
        "-e",
        `SCF_OTLP_ENDPOINT=${scf}`,
        "-e",
        `APM_ENDPOINT=${apm}`,
        "-e",
        `OTEL_EXPORTER_OTLP_ENDPOINT=${apm}`,
        "-e",
        "SSL_CERT_FILE=/ca.pem",
        "-e",
        "RUST_OTEL_MODE=tower",
        image,
      ]);
      // the driver: a fixed request mix from a container on the same network
      // Readiness probe, then a warm-up of one request per route/status pair and two export intervals, so that every
      // stream's first point is exported before the measured mix. Since C-122 the writer counts a stream's first
      // point in full when its source is already known (a new route of a running process) or the process is fresh
      // (start time ≤ 10 min before the point) — so the readiness and warm-up requests ARE expected in the API. The
      // driver counts every response the app served (connection errors before the app listens are not requests),
      // separately for the pre-mix requests and for the measured mix, and the API must equal their sum.
      // the S-06a apps answer 404 for GMISSING, the S-06b apps for GNOTFOUND (as copied from the spikes)
      const missing = lang === "go-nethttp" || lang === "rust-axum" ? "GNOTFOUND" : "GMISSING";
      const mix = MIX.map((m) => ({ ...m, path: m.path.replace("GMISSING", missing) }));
      const script = `const mix=${JSON.stringify(mix)};const pre={},out={};const hit=async(p,o)=>{const r=await fetch('http://${app}:8080'+p);await r.arrayBuffer();o[r.status]=(o[r.status]||0)+1};
for(let i=0;i<90;i++){try{await hit('/health',pre);break}catch{await new Promise(r=>setTimeout(r,1000))}}
for(const m of mix)await hit(m.path,pre);
await new Promise(r=>setTimeout(r,13000));
for(const m of mix)for(let i=0;i<m.n;i++)await hit(m.path,out);console.log(JSON.stringify({pre,out}))`;
      const drv = await docker([
        "run",
        "--rm",
        "--network",
        net,
        "--cap-drop",
        "ALL",
        "--user",
        "1000:1000",
        NODE_IMAGE,
        "node",
        "--input-type=module",
        "-e",
        script,
      ]);
      const { pre, out: seen } = JSON.parse(drv.stdout.trim().split("\n").pop() ?? "{}") as {
        pre: Record<string, number>;
        out: Record<string, number>;
      };
      expect(seen).toEqual({ 200: 30, 404: 5, 500: 3 });
      expect(pre).toEqual({ 200: 3, 404: 1, 500: 1 });
      const served: Record<string, number> = {};
      for (const o of [pre, seen])
        for (const [k, n] of Object.entries(o)) served[k] = (served[k] ?? 0) + n;
      expect(served).toEqual(EXPECTED);
      const { cp, tenantId, serviceId: sid } = S(lang);
      const sum = await eventually(
        "api summary",
        () =>
          cp.json<{
            requests: number;
            status: Record<string, number>;
            latency: Record<string, number | null>;
          }>("GET", `/v1/tenants/${tenantId}/services/${sid}/api/summary?range=24h`),
        (x) => x.requests >= TOTAL,
        180_000,
        5000,
      );
      const codes = await cp.json<{ codes: { status_code: number; requests: number }[] }>(
        "GET",
        `/v1/tenants/${tenantId}/services/${sid}/api/status-codes?range=24h`,
      );
      const apmCount = JSON.parse(
        (
          await docker([
            "exec",
            sink,
            "node",
            "-e",
            "fetch('http://127.0.0.1:4318/count').then(r=>r.text()).then(console.log)",
          ])
        ).stdout,
      ) as Record<string, number>;
      // no late surplus: one more export interval later the figures have not moved (nothing counted twice)
      await new Promise((r) => setTimeout(r, 12_000));
      const settled = await cp.json<{ requests: number }>(
        "GET",
        `/v1/tenants/${tenantId}/services/${sid}/api/summary?range=24h`,
      );
      rec.data[lang] = { summary: sum, codes, apm: apmCount, served: { pre, measured: seen } };
      d.detail(
        `served ${JSON.stringify(served)} (pre-mix ${JSON.stringify(pre)}), requests ${sum.requests}, status ${JSON.stringify(sum.status)}, latency ${JSON.stringify(sum.latency)}, APM sink ${JSON.stringify(apmCount)}`,
      );
      expect(sum.requests).toBe(TOTAL);
      expect(settled.requests).toBe(TOTAL);
      expect(sum.status).toMatchObject({ s2xx: 33, s4xx: 6, s5xx: 4 });
      expect(
        Object.fromEntries(codes.codes.map((c) => [String(c.status_code), c.requests])),
      ).toEqual(EXPECTED);
      const { p50_ms, p95_ms, p99_ms } = sum.latency as {
        p50_ms: number;
        p95_ms: number;
        p99_ms: number;
      };
      expect(p50_ms).not.toBeNull();
      expect(p50_ms).toBeLessThanOrEqual(p95_ms);
      expect(p95_ms).toBeLessThanOrEqual(p99_ms);
      expect(apmCount["/v1/metrics"] ?? 0).toBeGreaterThan(0); // the tenant's own APM got its copy
    }, 1_200_000);
  }

  it("a canary trace leaves only derived metrics; its attributes are never stored", async (ctx) => {
    const d = rec.start(ctx, ["api.drop-traces", "api.attribute-allowlist"]);
    await requires(env, ctx, [...CAPS]);
    const c = {
      ua: `CanaryAgent${tag()}`,
      query: `cq${tag()}`,
      seed: randomStrKey("S"),
      user: randomStrKey("G"),
      custom: `custom${tag()}${tag()}`,
    };
    recordCanaries(env.workDir, "e2e/api canary trace", [
      { label: "otlp user_agent.original", value: c.ua },
      { label: "otlp url.query", value: c.query },
      { label: "otlp seed in url.path", value: c.seed },
      { label: "otlp enduser.id", value: c.user },
      { label: "otlp custom attribute", value: c.custom },
    ]);
    const now = BigInt(Date.now()) * 1_000_000n;
    const hex = (n: number) =>
      Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const attr = (k: string, v: string) => ({ key: k, value: { stringValue: v } });
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [attr("service.name", "wsl-canary"), attr("host.ip", "203.0.113.77")],
          },
          scopeSpans: [
            {
              scope: { name: "canary" },
              spans: [
                {
                  traceId: hex(32),
                  spanId: hex(16),
                  name: "GET /canary/{id}",
                  kind: 2,
                  startTimeUnixNano: String(now - 25_000_000n),
                  endTimeUnixNano: String(now),
                  attributes: [
                    attr("http.request.method", "GET"),
                    attr("http.route", "/canary/{id}"),
                    { key: "http.response.status_code", value: { intValue: "200" } },
                    attr("url.path", `/canary/${c.seed}`),
                    attr("url.query", `token=${c.query}`),
                    attr("url.full", `https://api.example.org/canary/${c.seed}?token=${c.query}`),
                    attr("user_agent.original", `Mozilla/5.0 ${c.ua}`),
                    attr("client.address", "203.0.113.77"),
                    attr("enduser.id", c.user),
                    attr("app.custom", c.custom),
                  ],
                  status: {},
                },
              ],
            },
          ],
        },
      ],
    };
    const r = await request(`${env.otlpUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${S("wsl-canary").token}`,
      },
      body: JSON.stringify(body),
      servername: env.ingestHosts[0] as string,
      caFile: env.gatewayCaFile,
    });
    expect(r.status).toBe(200);
    const { cp, tenantId, serviceId: sid } = S("wsl-canary");
    const sum = await eventually(
      "derived metric",
      () =>
        cp.json<{ requests: number }>(
          "GET",
          `/v1/tenants/${tenantId}/services/${sid}/api/summary?range=24h`,
        ),
      (x) => x.requests >= 1,
      120_000,
      5000,
    );
    d.detail(`derived requests ${sum.requests}`);
    expect(sum.requests).toBe(1);
    // nothing that looks like a span store exists, and no canary is in the scf database
    const dump = await compose.pgDump("scf");
    for (const v of Object.values(c)) expect(dump.includes(v), v.slice(0, 6)).toBe(false);
  }, 300_000);
});
