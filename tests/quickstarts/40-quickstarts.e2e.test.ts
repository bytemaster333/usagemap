// SPDX-License-Identifier: Apache-2.0
// docs.quickstarts-run — the quickstart guides run as test fixtures. The code blocks of docs/guides/quickstarts/* are extracted
// (extract.ts, recipes.ts — no copy of the code lives in tests/) and run as written against a real stack, only the
// documented placeholders replaced (ingest hosts, OTLP endpoint, site key, the tenant's APM). For each recipe the
// control-plane API must then report what the recipe sent:
//
//   web-script-tag   the snippet (SRI-pinned tracker from the gateway) + the custom-event button, in real Chromium:
//                    1 verified page view, event `signup` 1
//   web-npm          `pnpm add --save-exact` of the packed tracker package (name@version from the guide) and the
//                    guide's `init()` code as a browser module: 1 verified page view, event `signup` 1
//   api-node-express, api-python-fastapi, api-go, api-rust-axum
//                    the guide's exporter set-up dual-exporting to a stand-in tenant APM and to the gateway's OTLP
//                    front door; a fixed request mix on `/accounts/{id}`: requests, status codes = what the app served
//   api-collector-fanout
//                    the guide's tenant Collector (image pinned by the guide's digest, config as written) in front of a
//                    zero-code Node service started with the guide's command: same mix, same assertions
//
// Stack: tests/quickstarts/stack/up.sh (project scf-tgq, host ports 56460–56469). Missing dependencies mark tests
// NOT RUN through `requires` (lib/gate.ts); with SCF_REQUIRE_FULL_STACK=1 they fail.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { context, type IngestProxy, launch, startIngestProxy } from "../lib/browser.ts";
import { tag } from "../lib/canaries.ts";
import { Compose, NODE_IMAGE } from "../lib/compose.ts";
import { ControlPlane } from "../lib/cp-client.ts";
import { loadEnv, REPO_ROOT } from "../lib/env.ts";
import {
  createFixture,
  eventually,
  type Fixture,
  openEnrollment,
  waitForGateway,
} from "../lib/fixture.ts";
import { type Capability, requires } from "../lib/gate.ts";
import { CHROME_UA } from "../lib/gateway-client.ts";
import { insecureGet } from "../lib/http.ts";
import { Recorder } from "../lib/recorder.ts";
import {
  API_RECIPES,
  type ApiRecipe,
  block,
  buildRecipe,
  collectorImage,
  npmInstallSpec,
  npmPage,
  scriptTagPage,
} from "./recipes.ts";

const run = promisify(execFile);
const env = loadEnv();
const compose = new Compose(env);
const rec = new Recorder(
  env,
  "quickstarts",
  "quickstarts",
  "Quickstart guides as test fixtures (docs.quickstarts-run)",
  "The code blocks of docs/guides/quickstarts/* (script tag with SRI, npm, Node/Express, Python/FastAPI, Go, Rust/axum, tenant Collector fan-out) are extracted from the guides and run as written against the stack; the control-plane API must report what each recipe sent.",
);

const WEB_CAPS: Capability[] = ["gateway", "control-plane", "compose", "jobs"];
const API_CAPS: Capability[] = [
  "otlp",
  "control-plane",
  "compose",
  "collector",
  "metrics-writer",
  "docker",
];

/** The request mix every API recipe serves on its one route (after one readiness request that answered). */
const MIX = [
  { id: "GABC", n: 10, status: 200 },
  { id: "GMISSING", n: 5, status: 404 },
  { id: "GBOOM", n: 3, status: 500 },
];

const work = join(env.workDir, "quickstarts");
const net = `${env.project}_public`;
const containers: string[] = [];
const networks: string[] = [];
let fx: Fixture | undefined;
let proxy: IngestProxy | undefined;
let webReady = false;

interface Svc {
  cp: ControlPlane;
  tenantId: string;
  serviceId: string;
  token: string;
}
const svc: Partial<Record<ApiRecipe, Svc>> = {};

async function docker(args: string[], timeout = 1_800_000) {
  return run("docker", args, { timeout, maxBuffer: 64 * 1024 * 1024 });
}

beforeAll(async () => {
  mkdirSync(work, { recursive: true });
  try {
    const h = await insecureGet(`${env.gatewayMetricsUrl}/healthz`, 3000);
    const c = await insecureGet(`${env.controlPlaneUrl}/healthz`, 3000);
    if (h.status !== 200 || c.status !== 200) return;
  } catch {
    return;
  }
  const id = Date.now().toString(36);
  fx = await createFixture(env, compose, `qs-web-${id}`, [
    // anonymous reports off: the suite reads exact small counts (with them on, small cells are suppressed)
    { key: "tag", host: `qs-tag-${id}.tgq.test`, anonymousReports: false },
    { key: "npm", host: `qs-npm-${id}.tgq.test`, anonymousReports: false },
  ]);
  await waitForGateway(env, compose, Object.values(fx.sites));
  const gw = new URL(env.gatewayUrl);
  proxy = await startIngestProxy(env.ingestHosts, gw.hostname, Number(gw.port));
  webReady = true;

  if (!env.otlpUrl) return;
  // One tenant per API recipe (an L0 tenant registers one service; a user owns at most 3 tenants). Every guide names
  // its service `my-api`.
  await openEnrollment(compose);
  let cp = new ControlPlane(env);
  let owned = 0;
  for (const r of API_RECIPES) {
    if (owned === 0) await cp.signIn();
    const tenantId = (await cp.createTenant(`qs-${r.slice(0, 12)}-${id}`)).tenant_id;
    const s = await cp.json<{ service_id: string }>("POST", `/v1/tenants/${tenantId}/services`, {
      service_name: "my-api",
    });
    const t = await cp.json<{ token: string }>("POST", `/v1/tenants/${tenantId}/ingest-tokens`, {
      label: "quickstart fixture",
    });
    svc[r] = { cp, tenantId, serviceId: s.service_id, token: t.token };
    if (++owned === 3) {
      cp = new ControlPlane(env);
      owned = 0;
    }
  }
}, 300_000);

afterAll(async () => {
  await proxy?.close();
  for (const c of containers) await docker(["rm", "-f", c]).catch(() => undefined);
  for (const n of networks) await docker(["network", "rm", n]).catch(() => undefined);
  const out = rec.write();
  if (out) console.log(`evidence: ${out.md}`);
});

// --- web ---

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
};

/** Opens the tenant page in Chromium (through the ingest proxy) and waits for `n` accepted events. */
async function visit(
  origin: string,
  serve: (path: string) => { body: string | Buffer; type: string } | null,
  after: (page: Page) => Promise<void>,
  n: number,
): Promise<number> {
  const b = await launch("chromium", (proxy as IngestProxy).url);
  try {
    // A desktop Chrome profile, as in the web e2e suite: headless Chromium's own User-Agent says "HeadlessChrome",
    // which the gateway (rightly) does not count as a visitor.
    const ctx = await context(b, {
      userAgent: CHROME_UA(Number(b.version().split(".")[0]), "Windows NT 10.0; Win64; x64"),
      viewport: { width: 1366, height: 768 },
    });
    const page = await ctx.newPage();
    await page.route(`${origin}/**`, (r) => {
      const f = serve(new URL(r.request().url()).pathname);
      return f
        ? r.fulfill({ status: 200, contentType: f.type, body: f.body })
        : r.fulfill({ status: 404 });
    });
    let accepted = 0;
    const done = new Promise<void>((resolve) => {
      page.on("response", (res) => {
        if (res.url().endsWith("/v1/e") && res.status() === 202 && ++accepted >= n) resolve();
      });
    });
    await page.goto(`${origin}/`);
    await after(page);
    await Promise.race([done, page.waitForTimeout(30_000)]);
    return accepted;
  } finally {
    await b.close();
  }
}

async function expectWebCounts(siteKey: "tag" | "npm") {
  const f = fx as Fixture;
  const s = f.sites[siteKey];
  if (!s) throw new Error(`no site ${siteKey}`);
  const stats = await eventually(
    `${siteKey} web stats`,
    () => f.cp.webStats(f.tenantId, s.site_id, "range=24h&variant=both"),
    (x) => (x.verified?.pageviews ?? 0) >= 1,
    90_000,
    2000,
  );
  const events = await eventually(
    `${siteKey} events`,
    () => f.cp.webBreakdown(f.tenantId, s.site_id, "event"),
    (x) => (x.verified ?? []).some((r) => r.value === "signup"),
    60_000,
    2000,
  );
  expect(stats.verified?.pageviews).toBe(1);
  expect((events.verified ?? []).map((r) => [r.value, r.events])).toEqual([["signup", 1]]);
  return { verified: stats.verified, events: events.verified };
}

describe("web quickstarts", () => {
  it("web-script-tag.md: the SRI snippet and the custom-event button, as written, in Chromium", async (ctx) => {
    const d = rec.start(ctx, ["docs.quickstarts-run"]);
    await requires(env, ctx, WEB_CAPS);
    expect(webReady).toBe(true);
    const s = (fx as Fixture).sites.tag;
    if (!s) throw new Error("no site");
    // The guide's hash must be what the gateway serves for that file, or the browser would refuse to run it.
    const src = /src="(https:\/\/[^"]+)"/.exec(block("scriptTag").code)?.[1] as string;
    const m = JSON.parse((await insecureGet(`${env.gatewayUrl}/lib/manifest.json`)).body) as {
      versions: { version: string; files: { path: string; integrity: string }[] }[];
    };
    const [, version, file] = /\/lib\/([^/]+)\/([^/]+)$/.exec(src) as RegExpExecArray;
    const served = m.versions
      .find((v) => v.version === version)
      ?.files.find((f) => f.path === file);
    expect(block("scriptTag").code).toContain(`integrity="${served?.integrity}"`);
    const html = scriptTagPage(s.site_key);
    const accepted = await visit(
      s.origin,
      (p) => (p === "/" ? { body: html, type: CONTENT_TYPES[".html"] as string } : null),
      async (page) => {
        await page.waitForResponse((r) => r.url().endsWith("/v1/e") && r.status() === 202, {
          timeout: 30_000,
        });
        await page.getByRole("button", { name: "Sign up" }).click();
      },
      2,
    );
    expect(accepted).toBe(2);
    const got = await expectWebCounts("tag");
    rec.data.scriptTag = got;
    d.detail(`accepted ${accepted}; API ${JSON.stringify(got)}`);
  }, 240_000);

  it("web-npm.md: pnpm add of the packed package and the guide's init() code, in Chromium", async (ctx) => {
    const d = rec.start(ctx, ["docs.quickstarts-run"]);
    await requires(env, ctx, [...WEB_CAPS, "docker"]);
    expect(webReady).toBe(true);
    const s = (fx as Fixture).sites.npm;
    if (!s) throw new Error("no site");
    const spec = npmInstallSpec();
    // The package as it would be published (`npm pack` of tracker/, files from its manifest), installed with the
    // guide's command; only the registry spec is replaced by the tarball (the scope may differ from the published one).
    const proj = mkdtempSync(join(tmpdir(), "scf-qs-npm-"));
    try {
      const packed = await run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", proj],
        {
          cwd: join(REPO_ROOT, "tracker"),
        },
      );
      const tgz = join(
        proj,
        (JSON.parse(packed.stdout) as { filename: string }[])[0]?.filename as string,
      );
      writeFileSync(
        join(proj, "package.json"),
        '{"name":"qs-npm","private":true,"type":"module"}\n',
      );
      // `--store-dir`: a private pnpm store (the default follows the project directory's file system)
      const argv = [...spec.command.slice(1, -1), tgz, "--store-dir", join(proj, ".pnpm-store")];
      await run(spec.command[0] as string, argv, { cwd: proj, timeout: 120_000 });
      const pkgDir = join(proj, "node_modules", ...spec.name.split("/"));
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
        name: string;
        version: string;
        exports: Record<string, { default: string }>;
      };
      expect([pkg.name, pkg.version]).toEqual([spec.name, spec.version]);
      const deps = (
        JSON.parse(readFileSync(join(proj, "package.json"), "utf8")) as {
          dependencies: Record<string, string>;
        }
      ).dependencies;
      expect(Object.keys(deps)).toEqual([spec.name]);
      const base = `/node_modules/${spec.name}`;
      const importMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(pkg.exports))
        if (typeof v === "object" && v.default?.endsWith(".js"))
          importMap[k === "." ? spec.name : `${spec.name}${k.slice(1)}`] =
            `${base}/${normalize(v.default)}`;
      const html = npmPage(s.site_key, importMap);
      const accepted = await visit(
        s.origin,
        (p) => {
          if (p === "/") return { body: html, type: CONTENT_TYPES[".html"] as string };
          if (!p.startsWith(`${base}/`)) return null;
          const f = normalize(join(pkgDir, p.slice(base.length)));
          if (!f.startsWith(pkgDir) || !statSync(f, { throwIfNoEntry: false })?.isFile())
            return null;
          return {
            body: readFileSync(f),
            type: CONTENT_TYPES[extname(f)] ?? "application/octet-stream",
          };
        },
        async () => undefined,
        // init() and the track() right after it leave in one batch (one request with both events)
        1,
      );
      expect(accepted).toBeGreaterThanOrEqual(1);
      const got = await expectWebCounts("npm");
      rec.data.npm = { ...got, importMap };
      d.detail(
        `installed ${pkg.name}@${pkg.version}; accepted ${accepted}; API ${JSON.stringify(got)}`,
      );
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 240_000);
});

// --- API ---

async function gatewayIp(): Promise<string> {
  return (
    await docker([
      "inspect",
      "-f",
      `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`,
      await compose.containerId("gateway"),
    ])
  ).stdout.trim();
}

/** A stand-in for the tenant's APM: counts OTLP requests per path. */
async function startSink(name: string, network: string): Promise<void> {
  containers.push(name);
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
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
}

async function sinkCount(name: string): Promise<Record<string, number>> {
  const r = await docker([
    "exec",
    name,
    "node",
    "-e",
    "fetch('http://127.0.0.1:4318/count').then(r=>r.text()).then(console.log)",
  ]);
  return JSON.parse(r.stdout) as Record<string, number>;
}

/** Drives the mix from a container on the app's network; returns status → requests the app answered. */
async function drive(network: string, app: string): Promise<Record<string, number>> {
  const script = `const mix=${JSON.stringify(MIX)};const out={};const hit=async(id)=>{const r=await fetch('http://${app}:8080/accounts/'+id);await r.arrayBuffer();out[r.status]=(out[r.status]||0)+1};
let up=false;for(let i=0;i<180&&!up;i++){try{await hit('GABC');up=true}catch{await new Promise(r=>setTimeout(r,1000))}}
if(!up){console.log(JSON.stringify({error:'app never answered'}));process.exit(1)}
for(const m of mix)for(let i=0;i<m.n;i++)await hit(m.id);console.log(JSON.stringify(out))`;
  const r = await docker([
    "run",
    "--rm",
    "--network",
    network,
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
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as Record<string, number>;
}

const GUIDE: Record<ApiRecipe, string> = {
  "node-express": "api-node-express.md",
  "python-fastapi": "api-python-fastapi.md",
  "go-nethttp": "api-go.md",
  "rust-axum": "api-rust-axum.md",
  "collector-fanout": "api-collector-fanout.md",
};

const EXPECTED_SERVED = { 200: 11, 404: 5, 500: 3 };
const TOTAL = 19;

describe("API quickstarts", () => {
  for (const r of API_RECIPES) {
    it(`${GUIDE[r]}: the recipe as written lands; requests and status codes equal what the app served`, async (ctx) => {
      const d = rec.start(ctx, [
        "docs.quickstarts-run",
        "api.dual-export",
        "api.drop-traces",
        "api.postgres-metrics",
      ]);
      await requires(env, ctx, API_CAPS);
      const S = svc[r];
      if (!S) throw new Error(`no tenant for ${r}`);
      const t = tag();
      const gw = await gatewayIp();
      const ingest = env.ingestHosts[0] as string;
      const sink = `qs-apm-${r}-${t}`;
      const app = `qs-app-${r}-${t}`;
      const fanout = r === "collector-fanout";
      // Fan-out: the tenant's own network holds the app, its Collector (alias `collector`, as in the guide's
      // command) and its APM; the Collector also joins the stack's public network to reach UsageMap.
      const appNet = fanout ? `qs-tenant-${t}` : net;
      if (fanout) {
        await docker(["network", "create", appNet]);
        networks.push(appNet);
      }
      await startSink(sink, appNet);
      const built = buildRecipe(r, work, {
        scf: `https://${ingest}:8443`,
        apm: `http://${sink}:4318`,
      });
      const image = `scf-tgq/quickstart-${r}:test`;
      await docker(["build", "-q", "-t", image, built.dir]);
      const common = [
        "-e",
        `SCF_OTLP_TOKEN=${S.token}`,
        "-e",
        "APM_API_KEY=apm-key",
        "-e",
        "OTEL_SERVICE_NAME=my-api",
        "-e",
        `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=qs-${r}-1`,
        "-e",
        "OTEL_METRIC_EXPORT_INTERVAL=5000",
      ];
      if (fanout) {
        const col = `qs-collector-${t}`;
        containers.push(col);
        await docker([
          "create",
          "--name",
          col,
          "--network",
          appNet,
          "--network-alias",
          "collector",
          "--add-host",
          `${ingest}:${gw}`,
          "--read-only",
          "--cap-drop",
          "ALL",
          "-v",
          `${built.collectorConfig}:/etc/otelcol-contrib/config.yaml:ro`,
          "-v",
          `${env.gatewayCaFile}:/ca.pem:ro`,
          "-e",
          "SSL_CERT_FILE=/ca.pem",
          ...common,
          collectorImage(),
        ]);
        await docker(["network", "connect", net, col]);
        await docker(["start", col]);
      }
      containers.push(app);
      await docker([
        "run",
        "-d",
        "--name",
        app,
        "--network",
        appNet,
        "--add-host",
        `${ingest}:${gw}`,
        "-v",
        `${env.gatewayCaFile}:/ca.pem:ro`,
        "-e",
        "NODE_EXTRA_CA_CERTS=/ca.pem",
        "-e",
        "REQUESTS_CA_BUNDLE=/ca.pem",
        "-e",
        "SSL_CERT_FILE=/ca.pem",
        "-e",
        `APM_ENDPOINT=http://${sink}:4318`,
        // Go's guide: the APM exporter is configured from the standard environment
        ...(r === "go-nethttp" ? ["-e", `OTEL_EXPORTER_OTLP_ENDPOINT=http://${sink}:4318`] : []),
        ...common,
        image,
      ]);
      const served = await drive(appNet, app);
      expect(served).toEqual(EXPECTED_SERVED);
      const sum = await eventually(
        `${r} api summary`,
        () =>
          S.cp.json<{ requests: number; status: Record<string, number> }>(
            "GET",
            `/v1/tenants/${S.tenantId}/services/${S.serviceId}/api/summary?range=24h`,
          ),
        (x) => x.requests >= TOTAL,
        240_000,
        5000,
      );
      const codes = await S.cp.json<{ codes: { status_code: number; requests: number }[] }>(
        "GET",
        `/v1/tenants/${S.tenantId}/services/${S.serviceId}/api/status-codes?range=24h`,
      );
      // nothing counted twice: after more export intervals (the Node guide's reader keeps the SDK default of 60 s)
      await new Promise((res) => setTimeout(res, r === "node-express" ? 70_000 : 15_000));
      const settled = await S.cp.json<{ requests: number }>(
        "GET",
        `/v1/tenants/${S.tenantId}/services/${S.serviceId}/api/summary?range=24h`,
      );
      const apm = await sinkCount(sink);
      rec.data[r] = { served, summary: sum, codes, apm };
      d.detail(
        `served ${JSON.stringify(served)}; API requests ${sum.requests} (settled ${settled.requests}), status ${JSON.stringify(sum.status)}; tenant APM ${JSON.stringify(apm)}`,
      );
      expect(sum.requests).toBe(TOTAL);
      expect(settled.requests).toBe(TOTAL);
      expect(sum.status).toMatchObject({ s2xx: 11, s4xx: 5, s5xx: 3 });
      expect(
        Object.fromEntries(codes.codes.map((c) => [String(c.status_code), c.requests])),
      ).toEqual({
        200: 11,
        404: 5,
        500: 3,
      });
      expect(apm["/v1/metrics"] ?? 0, "the tenant's own APM got its copy").toBeGreaterThan(0);
    }, 1_800_000);
  }
});
