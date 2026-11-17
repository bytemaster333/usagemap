// SPDX-License-Identifier: Apache-2.0
// Dependency gates. A suite states what it needs (`requires: gateway`, …). When a dependency is missing the test is
// marked NOT RUN with the reason — never skipped silently — and every such decision is appended to
// `<work>/gates.jsonl`, which the evidence writer turns into the "not run" section. With SCF_REQUIRE_FULL_STACK=1
// a missing dependency FAILS the test instead.

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StackEnv } from "./env.ts";
import { insecureGet, request } from "./http.ts";

const run = promisify(execFile);

export type Capability =
  | "docker"
  | "compose"
  | "gateway"
  | "control-plane"
  | "portal"
  | "jobs"
  | "otlp"
  | "collector"
  | "metrics-writer";

export interface Probe {
  ok: boolean;
  detail: string;
}

async function httpOk(url: string): Promise<Probe> {
  try {
    const r = await insecureGet(url, 3000);
    return { ok: r.status < 500, detail: `${url} → ${r.status}` };
  } catch (e) {
    return { ok: false, detail: `${url} → ${(e as Error).message}` };
  }
}

export async function composeServiceRunning(env: StackEnv, service: string): Promise<Probe> {
  if (!env.project) return { ok: false, detail: "no compose project configured" };
  try {
    const { stdout } = await run(
      "docker",
      ["compose", "-p", env.project, "ps", "--status", "running", "--services"],
      { timeout: 15_000 },
    );
    const up = stdout.split("\n").map((s) => s.trim());
    return {
      ok: up.includes(service),
      detail: `${env.project}/${service} ${up.includes(service) ? "running" : "not running"}`,
    };
  } catch (e) {
    return { ok: false, detail: `docker compose ps: ${(e as Error).message.split("\n")[0]}` };
  }
}

export async function probe(env: StackEnv, cap: Capability): Promise<Probe> {
  switch (cap) {
    case "docker":
      try {
        await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
        return { ok: true, detail: "docker reachable" };
      } catch (e) {
        return { ok: false, detail: `docker: ${(e as Error).message.split("\n")[0]}` };
      }
    case "compose":
      return composeServiceRunning(env, "postgres");
    case "gateway":
      return httpOk(`${env.gatewayMetricsUrl}/healthz`);
    case "control-plane":
      return httpOk(`${env.controlPlaneUrl}/healthz`);
    case "portal":
      return httpOk(`${env.portalUrl}/`);
    case "jobs":
    case "collector":
    case "metrics-writer":
      return composeServiceRunning(env, cap);
    case "otlp":
      if (!env.otlpUrl)
        return { ok: false, detail: "SCF_OTLP_URL not set (OTLP front door: day 3)" };
      try {
        // the front door answers an unauthenticated export with 401 only when OTLP is enabled
        const r = await request(`${env.otlpUrl}/v1/metrics`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          servername: env.ingestHosts[0] as string,
          caFile: "",
          timeoutMs: 3000,
        });
        return {
          ok: r.status === 401,
          detail: `POST ${env.otlpUrl}/v1/metrics without token → ${r.status}`,
        };
      } catch (e) {
        return { ok: false, detail: `${env.otlpUrl}: ${(e as Error).message}` };
      }
  }
}

const cache = new Map<Capability, Promise<Probe>>();

export interface GateRecord {
  at: string;
  suite: string;
  test: string;
  missing: { cap: Capability; detail: string }[];
  outcome: "not_run" | "failed_required";
}

export function recordGate(env: StackEnv, rec: GateRecord): void {
  mkdirSync(env.workDir, { recursive: true });
  appendFileSync(join(env.workDir, "gates.jsonl"), `${JSON.stringify(rec)}\n`);
}

interface Ctx {
  skip: (note?: string) => never;
  task: { name: string; file?: { name: string } };
}

/**
 * Checks the capabilities; returns normally when all are present. Otherwise marks the test NOT RUN (with the reason)
 * or, with SCF_REQUIRE_FULL_STACK=1, throws so that the test fails.
 */
export async function requires(env: StackEnv, ctx: Ctx, caps: Capability[]): Promise<void> {
  const results = await Promise.all(
    caps.map(async (c) => {
      let p = cache.get(c);
      if (!p) {
        p = probe(env, c);
        cache.set(c, p);
      }
      return { cap: c, ...(await p) };
    }),
  );
  const missing = results.filter((r) => !r.ok).map((r) => ({ cap: r.cap, detail: r.detail }));
  if (missing.length === 0) return;
  const note = `requires: ${missing.map((m) => `${m.cap} (${m.detail})`).join("; ")}`;
  recordGate(env, {
    at: new Date().toISOString(),
    suite: ctx.task.file?.name ?? "",
    test: ctx.task.name,
    missing,
    outcome: env.requireFullStack ? "failed_required" : "not_run",
  });
  if (env.requireFullStack) throw new Error(`${note} — SCF_REQUIRE_FULL_STACK=1`);
  ctx.skip(`NOT RUN — ${note}`);
}

/** Clears the probe cache (after the chaos suite stops and restarts services). */
export function resetProbes(): void {
  cache.clear();
}
