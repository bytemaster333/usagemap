// SPDX-License-Identifier: Apache-2.0
// The whole Stellar client-metric chain (C-153): @usagemap/stellar-otel's real OTLP export (recorded fresh by
// services/metrics-writer/integration/stellar-chain/run.sh with the package's scenario) → the built Collector
// (collector/config/collector.yaml, stellar_client_metrics on, as the gateway would call it) → the metrics-writer
// binary over mutual TLS → this suite's PostgreSQL → GET …/stellar-client. Opt-in: it runs only when the script sets
// SCF_STELLAR_CHAIN_DIR (binaries, PKI, export); otherwise it is reported as skipped, never as passed.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const DIR = process.env.SCF_STELLAR_CHAIN_DIR ?? "";
const BASE = Number(process.env.SCF_STELLAR_CHAIN_PORT_BASE ?? 56950);
const P = {
  writer: BASE,
  writerAdmin: BASE + 1,
  grpc: BASE + 2,
  http: BASE + 3,
  health: BASE + 4,
  metrics: BASE + 5,
};
const REPO = join(import.meta.dirname, "../../../..");

let h: Harness;
let owner = "";
let tenant = "";
const procs: ChildProcess[] = [];
const logs: string[] = [];

function start(cmd: string, args: string[], env: Record<string, string>): void {
  const p = spawn(cmd, args, { env: { PATH: process.env.PATH ?? "", ...env }, cwd: DIR });
  p.stdout?.on("data", (b) => logs.push(String(b)));
  p.stderr?.on("data", (b) => logs.push(String(b)));
  procs.push(p);
}

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} not ready:\n${logs.join("").slice(-3000)}`);
}

/** Totals of one export per metric: histogram counts and sum values (the package's cumulative state). */
function totals(doc: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  type Dp = { count?: string | number; asInt?: string | number };
  type M = { name: string; histogram?: { dataPoints: Dp[] }; sum?: { dataPoints: Dp[] } };
  const rms = doc.resourceMetrics as Array<{ scopeMetrics: Array<{ metrics: M[] }> }>;
  for (const rm of rms)
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics) {
        const dps = m.histogram?.dataPoints ?? m.sum?.dataPoints ?? [];
        for (const dp of dps)
          out[m.name] = (out[m.name] ?? 0) + Number(m.histogram ? dp.count : dp.asInt);
      }
  return out;
}

describe.skipIf(DIR === "")("package → Collector → writer → API (C-153)", () => {
  beforeAll(async () => {
    h = await startHarness();
    owner = await signInGithub(h, newGithubUser());
    tenant = await createTenant(h, owner);
    const su = new URL(inject("pgSuperUrl"));
    start(join(DIR, "metrics-writer"), [], {
      SCF_WRITER_LISTEN_ADDR: `127.0.0.1:${P.writer}`,
      SCF_WRITER_ADMIN_ADDR: `127.0.0.1:${P.writerAdmin}`,
      SCF_WRITER_TLS_CERT_FILE: join(DIR, "writer.crt"),
      SCF_WRITER_TLS_KEY_FILE: join(DIR, "writer.key"),
      SCF_WRITER_TLS_CLIENT_CA_FILE: join(DIR, "ca.crt"),
      SCF_WRITER_DATABASE_URL: `postgres://scf_writer:wsf-test-writer@${su.host}/scf?sslmode=disable`,
      SCF_WRITER_PROBE_INTERVAL: "500ms",
    });
    await waitFor("writer", async () => {
      const r = await fetch(`http://127.0.0.1:${P.writerAdmin}/readyz`);
      return r.status === 200;
    });
    start(
      join(REPO, "collector/_build/scf-otelcol"),
      ["--config", join(REPO, "collector/config/collector.yaml")],
      {
        SCF_WRITER_ENDPOINT: `https://localhost:${P.writer}`,
        SCF_MTLS_CA_FILE: join(DIR, "ca.crt"),
        SCF_MTLS_CERT_FILE: join(DIR, "edge.crt"),
        SCF_MTLS_KEY_FILE: join(DIR, "edge.key"),
        SCF_OTLP_GRPC_ENDPOINT: `127.0.0.1:${P.grpc}`,
        SCF_OTLP_HTTP_ENDPOINT: `127.0.0.1:${P.http}`,
        SCF_HEALTH_ENDPOINT: `127.0.0.1:${P.health}`,
        SCF_SELF_METRICS_PORT: String(P.metrics),
        SCF_QUEUE_DIR: join(DIR, "queue"),
        SCF_QUEUE_BYTES: "67108864",
        GOMAXPROCS: "2",
      },
    );
    await waitFor("collector", async () => {
      const r = await fetch(`http://127.0.0.1:${P.health}/`);
      return r.status === 200;
    });
  }, 120_000);
  afterAll(async () => {
    for (const p of procs) p.kill("SIGINT");
    await h?.close();
  });

  it("stores the package's export and serves it per method, route and outcome", async () => {
    const raw = readFileSync(join(DIR, "export.json"), "utf8");
    const want = totals(JSON.parse(raw));
    expect(Object.keys(want).sort()).toEqual([
      "http.client.request.duration",
      "rpc.client.call.duration",
      "stellar.tx.polls",
      "stellar.tx.simulations",
      "stellar.tx.submissions",
    ]);
    // the gateway's call (wire-formats §f.4): the package's own OTLP/JSON body plus the x-scf-* headers
    const res = await fetch(`http://127.0.0.1:${P.http}/v1/metrics`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scf-tenant-id": tenant,
        "x-scf-token-id": "tok_chain",
        "x-scf-allowed-services": "*",
        "x-scf-tenant-level": "1",
        "x-scf-received-at": String(Date.now() * 1_000_000),
        "x-scf-node": "edge-a1",
      },
      body: raw,
    });
    expect(res.status, await res.text()).toBe(200);
    let svc = "";
    await waitFor(
      "the writer's rows",
      async () => {
        const r = await h.su.query<{ service_id: string; n: string }>(
          `SELECT service_id::text, sum(count)::text AS n FROM scf.stellar_client_1m WHERE tenant_id = $1 GROUP BY 1`,
          [tenant],
        );
        const expected = Object.values(want).reduce((a, b) => a + b, 0);
        if (r.rows.length === 1 && Number(r.rows[0]?.n) === expected) {
          svc = r.rows[0]?.service_id as string;
          return true;
        }
        return false;
      },
      60_000,
    );
    const api = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services/${svc}/stellar-client?range=24h`,
      cookie: owner,
    });
    expect(api.statusCode, api.body).toBe(200);
    const b = api.json();
    expect(b.networks).toEqual(["testnet"]);
    const sum = (xs: Array<{ calls?: number; count?: number }>) =>
      xs.reduce((a, x) => a + (x.calls ?? x.count ?? 0), 0);
    expect(sum(b.rpc_methods)).toBe(want["rpc.client.call.duration"]);
    expect(sum(b.horizon_routes)).toBe(want["http.client.request.duration"]);
    expect(sum(b.transactions.submissions)).toBe(want["stellar.tx.submissions"]);
    expect(sum(b.transactions.polls)).toBe(want["stellar.tx.polls"]);
    expect(sum(b.transactions.simulations)).toBe(want["stellar.tx.simulations"]);
    // closed sets only: an unknown method becomes _OTHER; no URL, host or key anywhere in the answer
    expect(api.body).not.toMatch(/https?:|127\.0\.0\.1|getAccountSecrets/);
    for (const r of b.rpc_methods) expect(r.p50_ms).not.toBeNull();
    // the API figures stay untouched
    const summary = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services/${svc}/api/summary?range=24h`,
      cookie: owner,
    });
    expect(summary.json().requests).toBe(0);
  });
});
