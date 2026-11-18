// SPDX-License-Identifier: Apache-2.0
// API-path load runner (ADR-0026 "Load (10× design target)", capacity.1m-requests-day). Usage:
//   node load/run-api.ts [--spans 116] [--batch 50] [--duration 120] [--services 10] [--no-evidence]
// 10× the design target (C-48: 1 M API requests/day) = 115.7 requests/s. Profile: every request arrives as a
// local-root SERVER span (worst case for us: tenants exporting traces, not SDK metrics), batched 50 per OTLP request
// (≈ 2.3 requests/s at the front door) over --services tenants. The Collector derives the metrics, the writer stores
// them; afterwards the control-plane API must report exactly the accepted spans as requests.

import { parseArgs } from "node:util";
import { Compose } from "../lib/compose.ts";
import { ControlPlane } from "../lib/cp-client.ts";
import { loadEnv } from "../lib/env.ts";
import { writeEvidence } from "../lib/evidence.ts";
import { eventually, gatewayTarget, openEnrollment } from "../lib/fixture.ts";
import { perDay } from "../lib/stats.ts";
import { runOtlpLoad } from "./otlp-load.ts";

const { values: a } = parseArgs({
  options: {
    spans: { type: "string", default: "116" },
    batch: { type: "string", default: "50" },
    duration: { type: "string", default: "120" },
    services: { type: "string", default: "10" },
    "no-evidence": { type: "boolean", default: false },
  },
});
const env = loadEnv();
const compose = new Compose(env);
const spansPerSecond = Number(a.spans);
const batch = Number(a.batch);
const durationS = Number(a.duration);
const n = Number(a.services);

await openEnrollment(compose);
const id = Date.now().toString(36);
const svcs: {
  name: string;
  token: string;
  cp: ControlPlane;
  tenantId: string;
  serviceId: string;
}[] = [];
let cp = new ControlPlane(env);
for (let i = 0; i < n; i++) {
  if (i % 3 === 0) {
    cp = new ControlPlane(env);
    await cp.signIn();
  }
  const name = `wsl-load-${i}`;
  const tenantId = (await cp.createTenant(`wsl-apiload${i}-${id}`)).tenant_id;
  const s = await cp.json<{ service_id: string }>("POST", `/v1/tenants/${tenantId}/services`, {
    service_name: name,
  });
  const t = await cp.json<{ token: string }>("POST", `/v1/tenants/${tenantId}/ingest-tokens`, {
    label: "ws-l load",
  });
  svcs.push({ name, token: t.token, cp, tenantId, serviceId: s.service_id });
}
await new Promise((r) => setTimeout(r, 12_000)); // tokens reach the gateway with the next snapshots

console.log(
  `offering ${spansPerSecond} spans/s (${(spansPerSecond / batch).toFixed(2)} OTLP req/s) for ${durationS} s to ${n} services`,
);
const r = await runOtlpLoad({
  target: gatewayTarget(env),
  services: svcs,
  spansPerSecond,
  batch,
  durationS,
});
const accepted = Object.values(r.acceptedSpans).reduce((x, y) => x + y, 0);
const t0 = Date.now();
let stored = 0;
const perService: Record<string, number> = {};
try {
  await eventually(
    "derived requests in the API",
    async () => {
      stored = 0;
      for (const s of svcs) {
        const sum = await s.cp.json<{ requests: number }>(
          "GET",
          `/v1/tenants/${s.tenantId}/services/${s.serviceId}/api/summary?range=24h`,
        );
        perService[s.name] = sum.requests;
        stored += sum.requests;
      }
      return stored;
    },
    (x) => x >= accepted,
    300_000,
    5000,
  );
} catch {
  // reported below
}
const visibleS = (Date.now() - t0) / 1000;
console.log(
  JSON.stringify({ ...r, timeline: undefined, accepted, stored, perService, visibleS }, null, 2),
);
const ok = stored === accepted && (r.statuses["200"] ?? 0) === r.requests;
if (!a["no-evidence"]) {
  const out = writeEvidence(env.evidenceDir, {
    layer: "load",
    name: `api-${Math.round(spansPerSecond)}sps-${Math.round(durationS)}s`,
    title: `API ingest load: ${spansPerSecond} spans/s for ${durationS} s (${(perDay(spansPerSecond) / 1e6).toFixed(1)} M requests/day equivalent)`,
    summary: `Open-model OTLP/HTTP (JSON) load against the gateway's OTLP front door of the local single-node Compose stack (gateway → Collector on the private otlp network (C-130) → metrics writer → PostgreSQL). ${n} tenants with one service each; every simulated tenant request is a local-root SERVER span, ${batch} spans per OTLP request (${(spansPerSecond / batch).toFixed(2)} requests/s). After the run the control-plane API must report exactly the accepted spans as requests. 10× the design target (C-48) is 115.7 requests/s.`,
    checks: [
      {
        name: "offered span rate achieved (≥ 95 %)",
        outcome: r.achievedSpansPerSecond >= spansPerSecond * 0.95 ? "pass" : "fail",
        detail: `${r.achievedSpansPerSecond.toFixed(1)} spans/s sent`,
        ids: ["capacity.1m-requests-day"],
      },
      {
        name: "every OTLP request answered 200",
        outcome: (r.statuses["200"] ?? 0) === r.requests ? "pass" : "fail",
        detail: JSON.stringify(r.statuses),
        ids: ["capacity.1m-requests-day", "slo.ingest-availability"],
      },
      {
        name: "derived request counts in the API equal the accepted spans",
        outcome: stored === accepted ? "pass" : "fail",
        detail: `accepted ${accepted}, API requests ${stored}, visible ${visibleS.toFixed(0)} s after the run`,
        ids: ["capacity.1m-requests-day", "api.postgres-metrics"],
      },
    ],
    data: {
      spansPerSecond,
      batch,
      durationS,
      services: n,
      result: { ...r, timeline: r.timeline.totals() },
      accepted,
      stored,
      perService,
    },
    notes: [
      "| Latency (ms) | p50 | p95 | p99 | max |",
      "|---|---|---|---|---|",
      `| POST /v1/traces (${batch} spans) → 200 | ${r.latencyMs.p50.toFixed(1)} | ${r.latencyMs.p95.toFixed(1)} | ${r.latencyMs.p99.toFixed(1)} | ${r.latencyMs.max.toFixed(1)} |`,
      "",
      "Limits of this run: one host, one edge node (gateway + Collector), one writer; client and stack share the CPU.",
    ].join("\n"),
  });
  console.log(`evidence: ${out.md}`);
}
process.exit(ok ? 0 : 1);
