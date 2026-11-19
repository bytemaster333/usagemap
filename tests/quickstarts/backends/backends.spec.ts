// SPDX-License-Identifier: Apache-2.0
// api.*, docs.quickstarts-run: the backend examples (examples/api-*) run in both documented modes against a local
// OTLP receiver that stands in for UsageMap's front door (bearer token required, logs refused) and, for dual export, a
// second receiver that stands in for the tenant's APM. For every example and mode:
//
//   - the app answers a fixed request mix (with canary query strings, User-Agent, X-Forwarded-For and a secret-seed
//     header on every request), then is stopped with SIGTERM — the last export must be flushed on shutdown;
//   - UsageMap received `/v1/metrics` only, OTLP/HTTP protobuf, every request with the right bearer token;
//   - the HTTP server duration histogram arrived with `http.route`, the status code and a positive duration sum, and
//     its request counts per (route, status) equal what the app served — nothing lost, nothing counted twice;
//   - no forbidden attribute key (client address, user agent, query, full URL, headers, end-user ids) on any
//     resource or point, and none of the canary strings anywhere in any byte UsageMap received;
//   - dual export: the APM got its metrics with its own key; that key never reached UsageMap; UsageMap got only the duration
//     metric, except where the stack cannot filter per exporter (Java agent, Rust 0.33.1), which is listed.
//
// No UsageMap stack is needed. Run: tests/quickstarts/backends/run.sh (QS_BACKENDS=node-express,go-nethttp limits it).
// A backend whose toolchain is missing fails, unless QS_BACKENDS_ALLOW_SKIP=1.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { TESTS_DIR } from "../../lib/env.ts";
import { BACKENDS, type Backend, type Launch, type Mode, type Runner } from "./backends.ts";
import {
  attributeKeys,
  DURATION_METRICS,
  FORBIDDEN_KEY,
  metricNames,
  type Receiver,
  requestsByRouteStatus,
  startReceiver,
} from "./otlp-receiver.ts";

const exec = promisify(execFile);
const CACHE = process.env.QS_BACKENDS_CACHE ?? join(tmpdir(), "scf-qs-backends");
const EVIDENCE = join(TESTS_DIR, ".work", "backends");
const only = (process.env.QS_BACKENDS ?? "").split(",").filter(Boolean);
const allowSkip = process.env.QS_BACKENDS_ALLOW_SKIP === "1";
const MODES: Mode[] = ["scf-only", "dual-export"];

const CANARY = {
  query: "?email=qs.canary%40example.com&wallet=GQSCANARYWALLETADDRESSNEVERSTORED",
  ua: "QsCanaryAgent/9.9",
  xff: "198.51.100.77",
  seed: "SQSCANARYSECRETSEEDNEVERSTORED",
};
const CANARY_STRINGS = [
  "qs.canary",
  "GQSCANARY",
  "QsCanaryAgent",
  CANARY.xff,
  "SQSCANARY",
  "email=",
];

const run: Runner = async (cmd, args, opts = {}) => {
  const r = await exec(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.stdout;
};

async function have(tool: "docker" | "go" | "node"): Promise<boolean> {
  try {
    if (tool === "node") return true;
    await exec(tool, tool === "docker" ? ["info", "--format", "{{.ServerVersion}}"] : ["version"], {
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hit(port: number, path: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}${path}${CANARY.query}`, {
    headers: {
      "user-agent": CANARY.ua,
      "x-forwarded-for": CANARY.xff,
      "x-stellar-seed": CANARY.seed,
    },
    signal: AbortSignal.timeout(10_000),
  });
  await r.arrayBuffer();
  return r.status;
}

interface Running {
  child: ChildProcess;
  exited: Promise<number | null>;
  log: string[];
  launch: Launch;
}

function start(l: Launch): Running {
  const log: string[] = [];
  const child = spawn(l.cmd, l.args, {
    cwd: l.cwd,
    env: { ...process.env, ...l.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (b: Buffer) => {
    log.push(b.toString());
    if (log.length > 400) log.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, log, launch: l };
}

async function stop(r: Running, timeoutMs = 60_000): Promise<number | null> {
  if (r.launch.container)
    await run("docker", ["stop", "-t", "45", r.launch.container]).catch(() => "");
  else r.child.kill("SIGTERM");
  const code = await Promise.race([r.exited, sleep(timeoutMs).then(() => "timeout" as const)]);
  if (code === "timeout") {
    r.child.kill("SIGKILL");
    throw new Error(`the app did not exit within ${timeoutMs} ms of SIGTERM`);
  }
  return code;
}

const prepared = new Map<string, Promise<void>>();
function prepare(b: Backend): Promise<void> {
  let p = prepared.get(b.id);
  if (!p) {
    for (const d of ["python", "go", "java", "m2", "cargo", "rust-target", "anchor-otel"])
      mkdirSync(join(CACHE, d), { recursive: true });
    p = b.prepare(CACHE, run);
    prepared.set(b.id, p);
  }
  return p;
}

const cleanup: string[] = [];
afterAll(async () => {
  for (const c of cleanup) await run("docker", ["rm", "-f", c]).catch(() => "");
});

const evidence: Record<string, unknown> = {};
afterAll(() => {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, "backends.json"), `${JSON.stringify(evidence, null, 2)}\n`);
});

describe("backend examples: OpenTelemetry to UsageMap", () => {
  for (const b of BACKENDS) {
    for (const mode of MODES) {
      const selected = only.length === 0 || only.includes(b.id);
      it.skipIf(!selected)(
        `${b.dir} (${mode}): ${b.guide}`,
        async (ctx) => {
          for (const n of b.needs)
            if (!(await have(n))) {
              if (allowSkip) return ctx.skip(`${n} unavailable`);
              throw new Error(`${b.id} needs ${n}`);
            }
          await prepare(b);

          const token = `scfa_ing_qsbackend_${Math.random().toString(36).slice(2)}`;
          const apmKey = `apm-secret-${Math.random().toString(36).slice(2)}`;
          const scf: Receiver = await startReceiver({ token, refuseLogs: true });
          const apm: Receiver = await startReceiver();
          const id = `${b.id}-${mode}-${Date.now().toString(36)}`;
          const port = await freePort();
          const launch = b.launch({
            mode,
            port,
            scf: scf.url,
            token,
            apm: apm.url,
            apmKey,
            id,
            cache: CACHE,
            extraPorts: [await freePort(), await freePort()],
          });
          let app: Running | undefined;
          try {
            for (const s of launch.sidecars ?? []) {
              cleanup.push(s.name);
              await run("docker", s.args);
              for (let i = 0; ; i++) {
                try {
                  await run("docker", s.ready);
                  break;
                } catch (e) {
                  if (i > 60) throw e;
                  await sleep(1000);
                }
              }
            }
            if (launch.container) cleanup.push(launch.container);
            app = start(launch);

            // readiness: the first request the app answers counts as one more of the first mix entry
            const first = b.mix[0] as (typeof b.mix)[number];
            const served: Record<string, number> = {};
            const deadline = Date.now() + b.startTimeoutMs;
            for (;;) {
              if (app.child.exitCode !== null)
                throw new Error(`app exited early:\n${app.log.join("")}`);
              try {
                const s = await hit(port, first.path);
                served[`${first.route} ${s}`] = (served[`${first.route} ${s}`] ?? 0) + 1;
                break;
              } catch {
                if (Date.now() > deadline)
                  throw new Error(`app never answered on :${port}\n${app.log.join("")}`);
                await sleep(500);
              }
            }
            for (const m of b.mix)
              for (let i = 0; i < m.n; i++) {
                const s = await hit(port, m.path);
                expect(s, `${m.path}`).toBe(m.status);
                served[`${m.route} ${s}`] = (served[`${m.route} ${s}`] ?? 0) + 1;
              }

            // SIGTERM straight away: the shutdown flush must deliver what no periodic export has sent yet
            const code = await stop(app);
            await sleep(500);

            const rms = scf.metrics();
            const byRS = requestsByRouteStatus(rms);
            const names = [...metricNames(rms)].sort();
            const keys = attributeKeys(rms);
            evidence[`${b.id} ${mode}`] = {
              exitCode: code,
              served,
              scfRequests: scf.received.map((r) => ({
                path: r.path,
                status: r.status,
                contentType: r.contentType,
                gzip: r.gzip,
                authorized: r.authorized,
                headerNames: r.headerNames,
              })),
              scfMetricNames: names,
              scfRouteStatus: byRS,
              scfResourceKeys: [...keys.resource].sort(),
              scfPointKeys: [...keys.point].sort(),
              scfExemplarKeys: [...keys.exemplar].sort(),
              apmRequests: apm.received.map((r) => `${r.path} ${r.status}`),
            };

            // transport and auth
            expect(scf.received.length, "UsageMap got at least one export").toBeGreaterThan(0);
            for (const r of scf.received) {
              expect(r.path, "UsageMap gets metrics only").toBe("/v1/metrics");
              expect(r.authorized, "every UsageMap request carries the ingest token").toBe(true);
              expect(r.status).toBe(200);
              expect(r.contentType).toBe("application/x-protobuf");
              expect(r.headerNames, "the APM key never reaches UsageMap").not.toContain("api-key");
            }

            // the metric: route, status code, duration; counts equal what was served
            expect(
              names.some((n) => DURATION_METRICS.includes(n)),
              `duration metric among ${names}`,
            ).toBe(true);
            const got = Object.fromEntries(byRS.map((x) => [`${x.route} ${x.status}`, x.count]));
            expect(got).toEqual(served);
            for (const x of byRS)
              expect(x.sum, `duration sum ${x.route} ${x.status}`).toBeGreaterThan(0);
            expect(keys.point).toContain("http.route");

            // privacy: no forbidden key, no canary byte
            for (const k of [...keys.resource, ...keys.point, ...keys.exemplar])
              expect(
                FORBIDDEN_KEY.some((re) => re.test(k)),
                `forbidden attribute ${k}`,
              ).toBe(false);
            for (const r of scf.received)
              for (const c of [...CANARY_STRINGS, apmKey])
                expect(r.body.includes(c), `canary "${c}" in a body UsageMap received`).toBe(false);

            // the identity of the stream: service name and a per-replica instance id
            for (const rm of rms) {
              expect(String(rm.resource["service.name"])).toMatch(/^my-(api|anchor)$/);
              expect(rm.resource["service.instance.id"], "service.instance.id").toBeDefined();
            }

            if (mode === "dual-export") {
              const extra = names.filter((n) => !DURATION_METRICS.includes(n));
              if (b.dualExtraMetrics) for (const n of extra) expect(n).toMatch(b.dualExtraMetrics);
              else expect(extra, "UsageMap gets only the duration metric").toEqual([]);
              const apmMetrics = apm.received.filter((r) => r.path === "/v1/metrics");
              expect(apmMetrics.length, "the APM still gets its metrics").toBeGreaterThan(0);
              for (const r of apmMetrics) expect(r.headerNames).toContain("api-key");
            }
          } catch (e) {
            if (app) console.error(`--- ${b.id} ${mode} log ---\n${app.log.join("").slice(-6000)}`);
            throw e;
          } finally {
            if (app && app.child.exitCode === null) await stop(app).catch(() => null);
            for (const s of launch.sidecars ?? [])
              await run("docker", ["rm", "-f", s.name]).catch(() => "");
            await scf.close();
            await apm.close();
          }
        },
        900_000,
      );
    }
  }
});
