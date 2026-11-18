// SPDX-License-Identifier: Apache-2.0
// API-path chaos (ADR-0026 "Chaos", slo.ingest-availability, C-107, C-130): constant OTLP load while the metrics writer, the Collector
// and the gateway are killed with SIGKILL and restarted. Usage: node chaos/run-api.ts [--spans 20] [--batch 5] [--outage 20]
// Expected (contract §f.3, C-107):
//   - writer down: the front door keeps answering 200 — the Collector's persistent queue holds the batches — and
//     the queue drains when the writer is back;
//   - Collector down: the front door answers 503 with Retry-After (it never acknowledges what it could not hand to a
//     persisting Collector); the queue on disk survives the SIGKILL;
//   - gateway down and restarted: 200 again within 20 s, the Collector untouched (own container, `otlp` network);
//   - at the end the API reports exactly the spans that were answered 200 (no loss, no double count — the writer's
//     de-duplication ledger absorbs byte-identical retries).

import { parseArgs } from "node:util";
import { Compose } from "../lib/compose.ts";
import { ControlPlane } from "../lib/cp-client.ts";
import { loadEnv } from "../lib/env.ts";
import { type Check, writeEvidence } from "../lib/evidence.ts";
import { eventually, gatewayTarget, openEnrollment } from "../lib/fixture.ts";
import { runOtlpLoad } from "../load/otlp-load.ts";

const { values: a } = parseArgs({
  options: {
    spans: { type: "string", default: "20" },
    batch: { type: "string", default: "5" },
    outage: { type: "string", default: "20" },
    "no-evidence": { type: "boolean", default: false },
  },
});
const env = loadEnv();
const compose = new Compose(env);
const outageS = Number(a.outage);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await openEnrollment(compose);
const cp = new ControlPlane(env);
await cp.signIn();
const id = Date.now().toString(36);
const svcs: { name: string; token: string; tenantId: string; serviceId: string }[] = [];
for (let i = 0; i < 2; i++) {
  const tenantId = (await cp.createTenant(`wsl-apichaos${i}-${id}`)).tenant_id;
  const name = `wsl-chaos-${i}`;
  const s = await cp.json<{ service_id: string }>("POST", `/v1/tenants/${tenantId}/services`, {
    service_name: name,
  });
  const t = await cp.json<{ token: string }>("POST", `/v1/tenants/${tenantId}/ingest-tokens`, {
    label: "ws-l chaos",
  });
  svcs.push({ name, token: t.token, tenantId, serviceId: s.service_id });
}
await sleep(12_000);

// C-130: the gateway is killed too — the Collector is its own container on the private `otlp` network, so a restarted
// gateway must reach it again at once (with the former shared network namespace, OTLP stayed 503 until the Collector
// was recreated).
const targets = ["metrics-writer", "collector", "gateway"];
const ctl = new AbortController();
const loadP = runOtlpLoad({
  target: gatewayTarget(env),
  services: svcs,
  spansPerSecond: Number(a.spans),
  batch: Number(a.batch),
  durationS: 3600,
  signal: ctl.signal,
});
await sleep(10_000);
const t0 = Date.now() - 10_000;
const windows: { service: string; from: number; downTo: number; to: number }[] = [];
for (const t of targets) {
  const from = Math.floor((Date.now() - t0) / 1000);
  console.log(`t=${from}s kill -9 ${t}`);
  await compose.kill(t);
  await sleep(outageS * 1000);
  const downTo = Math.floor((Date.now() - t0) / 1000);
  await compose.upNoDeps(t); // only the killed service, never its dependencies
  await sleep(30_000); // recovery: writer listener reopens / Collector replays its queue
  windows.push({ service: t, from, downTo, to: Math.floor((Date.now() - t0) / 1000) });
}
await sleep(10_000);
ctl.abort();
const r = await loadP;
const accepted = Object.values(r.acceptedSpans).reduce((x, y) => x + y, 0);
let stored = 0;
try {
  await eventually(
    "API counts",
    async () => {
      stored = 0;
      for (const s of svcs)
        stored += (
          await cp.json<{ requests: number }>(
            "GET",
            `/v1/tenants/${s.tenantId}/services/${s.serviceId}/api/summary?range=24h`,
          )
        ).requests;
      return stored;
    },
    (x) => x >= accepted,
    300_000,
    5000,
  );
} catch {
  // reported below
}

const offset = Math.round((t0 - r.timeline.start) / 1000);
const checks: Check[] = [];
const statusesIn = (from: number, to: number) => {
  const out: Record<string, number> = {};
  for (const [sec, b] of r.timeline.buckets)
    if (sec >= from + offset && sec < to + offset)
      for (const [k, v] of b) out[k] = (out[k] ?? 0) + v;
  return out;
};
for (const w of windows) {
  const down = statusesIn(w.from, w.downTo);
  const after = statusesIn(w.downTo + 15, w.to);
  if (w.service === "metrics-writer") {
    checks.push({
      name: "kill the metrics writer: the front door keeps answering 200 (Collector queue buffers)",
      outcome: Object.keys(down).every((k) => k === "200") ? "pass" : "fail",
      detail: `during the outage ${JSON.stringify(down)}`,
      ids: ["slo.ingest-availability", "capacity.1m-requests-day"],
    });
  } else if (w.service === "gateway") {
    const settled = statusesIn(w.downTo + 20, w.to);
    checks.push({
      name: "kill -9 the gateway: OTLP through the restarted gateway answers 200 again without touching the Collector (C-130)",
      outcome:
        Object.keys(settled).length > 0 && Object.keys(settled).every((k) => k === "200")
          ? "pass"
          : "fail",
      detail: `during the outage ${JSON.stringify(down)}; from 20 s after the restart ${JSON.stringify(settled)}`,
      ids: ["slo.ingest-availability"],
    });
  } else {
    // Judged from 2 s after the kill: requests answered just before the SIGKILL land in the first second's bucket of
    // the timeline (seen in test runs: 3 such 200s), they are not acknowledgements of unpersisted data.
    const downSettled = statusesIn(w.from + 2, w.downTo);
    checks.push({
      name: "kill the Collector: the front door refuses with 503 (never acknowledges unpersisted data), 200 again after restart",
      outcome:
        !("200" in downSettled) && Object.keys(after).every((k) => k === "200") ? "pass" : "fail",
      detail: `during the outage ${JSON.stringify(down)} (from 2 s after the kill ${JSON.stringify(downSettled)}); from 15 s after restart ${JSON.stringify(after)}`,
      ids: ["slo.ingest-availability"],
    });
  }
}
checks.push({
  name: "every span answered 200 is counted exactly once in the API (queue on disk survived, retries de-duplicated)",
  outcome: stored === accepted ? "pass" : "fail",
  detail: `accepted ${accepted}, API requests ${stored}, statuses ${JSON.stringify(r.statuses)}`,
  ids: ["slo.ingest-availability", "api.postgres-metrics"],
});
checks.push({
  name: "writer failover to a second core (C-77)",
  outcome: "not_run",
  detail: "requires: two writers behind writers.mesh.local (the local stack has one)",
  ids: ["slo.ingest-availability"],
});
for (const c of checks) console.log(`${c.outcome.toUpperCase().padEnd(8)} ${c.name} — ${c.detail}`);
if (!a["no-evidence"]) {
  const out = writeEvidence(env.evidenceDir, {
    layer: "chaos",
    name: "api-ingest",
    title: "Chaos: metrics writer, Collector and gateway killed under constant OTLP load",
    summary: `Constant OTLP/HTTP span load (${a.spans} spans/s, ${a.batch} per request) against the gateway's OTLP front door of the local single-node stack (project ${env.project}); the metrics writer, the Collector and then the gateway killed with SIGKILL for ${outageS} s each and started again (the Collector is not touched after the gateway restart, C-130). Status codes are judged per second of the load timeline; completeness by comparing the API's request counts with the spans answered 200.`,
    checks,
    data: { windows, load: { ...r, timeline: r.timeline.totals() }, accepted, stored },
  });
  console.log(`evidence: ${out.md}`);
}
process.exit(checks.some((c) => c.outcome === "fail") ? 1 : 0);
