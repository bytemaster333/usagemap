// SPDX-License-Identifier: Apache-2.0
// Ceiling mode of the load suite: ramps load until the stack saturates, instead of holding one rate (run.ts,
// run-api.ts). Usage (bounded: every part stops at --max-minutes):
//   node load/ceiling.ts --part web [--steps 100,200,400,700,1000,1500] [--step-s 45] [--sites 8] [--views-per-load 250]
//   node load/ceiling.ts --part api [--span-steps 1000,2500,5000,10000,20000] [--batch 100] [--services 12] [--routes 50]
//   [--max-minutes 18] [--no-evidence] [--json-out FILE]
//
// Web part: open-model page views through the gateway (TLS, challenge, proof, fsync'd spool) → forwarder → engine
// proxy → Umami → PostgreSQL. Per step it records the offered and achieved rate, answers, latency, the spool's intake
// (fsynced/s), the forwarder's delivery into Umami (acked_stored/s) and the spool's growth. The engine is saturated when
// the spool grows during a step (delivery < intake); the ramp stops at the first saturated step. Then the load stops
// and the spool's drain rate is measured — the engine's throughput with no ingest competing. Finally Umami must hold
// exactly the accepted events (no loss, no duplicates).
// API part: OTLP/HTTP JSON SERVER spans through the gateway's OTLP front door → Collector → writer → PostgreSQL, per
// step the answers (200 / 429 / 503), latency and the writer's row writes per second (pg_stat_user_tables, inserts +
// updates on the api_* tables), then the time until the control-plane API reports every accepted span.
//
// Tenant protections (rate limits, quotas, the adaptive proof-cost multiplier) are raised for the run and restored
// after: the ceiling is a capacity figure, not a tenant figure. The adaptive multiplier is set to 1 so that the load
// client's own CPU (solving proofs) is not what saturates; this is stated in the evidence.

import { execFile } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { parseArgs, promisify } from "node:util";
import { Compose } from "../lib/compose.ts";
import { ControlPlane } from "../lib/cp-client.ts";
import { loadEnv } from "../lib/env.ts";
import { writeEvidence } from "../lib/evidence.ts";
import {
  createFixture,
  eventually,
  gatewayTarget,
  openEnrollment,
  waitForGateway,
} from "../lib/fixture.ts";
import { request } from "../lib/http.ts";
import { runOtlpLoad } from "./otlp-load.ts";
import { gauge, runWebLoad, sumSeries } from "./web-load.ts";

const run = promisify(execFile);
const { values: a } = parseArgs({
  options: {
    part: { type: "string", default: "web" },
    steps: { type: "string", default: "100,200,400,700,1000,1500" },
    "step-s": { type: "string", default: "45" },
    sites: { type: "string", default: "8" },
    "views-per-load": { type: "string", default: "250" },
    "span-steps": { type: "string", default: "1000,2500,5000,10000,20000" },
    batch: { type: "string", default: "100" },
    services: { type: "string", default: "12" },
    routes: { type: "string", default: "50" },
    "max-minutes": { type: "string", default: "18" },
    "no-evidence": { type: "boolean", default: false },
  },
});
const env = loadEnv();
const compose = new Compose(env);
const deadline = Date.now() + Number(a["max-minutes"]) * 60_000;
const stepS = Number(a["step-s"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function metrics(): Promise<string> {
  return (await request(`${env.gatewayMetricsUrl}/metrics`, { timeoutMs: 5000 })).body;
}
function series(text: string, name: string, label: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`${name}{`) && l.includes(label));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : Number.NaN;
}

/** CPU % and memory of the stack's containers right now (docker stats, one sample). */
async function dockerStats(): Promise<Record<string, string>> {
  try {
    const { stdout } = await run(
      "docker",
      ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
      { timeout: 30_000 },
    );
    const out: Record<string, string> = {};
    for (const l of stdout.trim().split("\n")) {
      const [name = "", cpu = "", mem = ""] = l.split("\t");
      if (!name.startsWith(`${env.project}-`)) continue;
      const svc = name.slice(env.project.length + 1).replace(/-\d+$/, "");
      if (
        [
          "gateway",
          "engine-proxy",
          "umami",
          "postgres",
          "pgbouncer",
          "collector",
          "metrics-writer",
          "control-plane",
          "jobs",
        ].includes(svc)
      )
        out[svc] = `${cpu} cpu, ${mem.split(" / ")[0]}`;
    }
    return out;
  } catch {
    return {};
  }
}

async function machine(): Promise<Record<string, string | number>> {
  const c = cpus();
  let disk = "unknown";
  try {
    disk = (
      await run("sh", ["-c", 'df -h / | tail -1 | awk \'{print $2" total, "$4" free"}\''])
    ).stdout.trim();
  } catch {
    // not available
  }
  return {
    cpu_model: c[0]?.model ?? "unknown",
    logical_cpus: c.length,
    memory_gib: Math.round(totalmem() / 2 ** 30),
    root_disk: disk,
    note: "one host: load client, every service and PostgreSQL share it; other workloads may run on the host",
  };
}

async function settings(keys: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    (
      await compose.sql(
        "scf",
        `SELECT key, value::text FROM scf.settings WHERE key IN (${keys.map((k) => `'${k}'`).join(",")})`,
      )
    ).map(([k, v]) => [k as string, v as string]),
  );
}
async function setSettings(v: Record<string, string>): Promise<void> {
  await compose.sql(
    "scf",
    `BEGIN; ${Object.entries(v)
      .map(([k, x]) => `UPDATE scf.settings SET value = '${x}'::jsonb WHERE key = '${k}';`)
      .join(" ")} COMMIT; NOTIFY scf_edge;`,
  );
}

const perDay = (perS: number) => Math.round(perS * 86_400);

// --------------------------------------------------------------------------------------------------------------- web
async function webPart() {
  const KEYS = [
    "web_requests_per_min_subnet",
    "web_requests_per_min_site",
    "l0_web_requests_per_min_site",
    "l0_events_per_day",
    "pow_max_multiplier",
  ];
  const before = await settings(KEYS);
  const nSites = Number(a.sites);
  const id = Date.now().toString(36);
  const fixtures = [];
  for (let t = 0; t < Math.ceil(nSites / 2); t++) {
    const n = Math.min(2, nSites - t * 2);
    fixtures.push(
      await createFixture(
        env,
        compose,
        `rvt-ceil${t}-${id}`,
        Array.from({ length: n }, (_, i) => ({
          key: `c${t}${i}`,
          host: `ceil${t}${i}-${id}.rvt.test`,
        })),
      ),
    );
  }
  const sites = fixtures.flatMap((f) => Object.values(f.sites));
  await setSettings({
    web_requests_per_min_subnet: "10000000",
    web_requests_per_min_site: "10000000",
    l0_web_requests_per_min_site: "10000000",
    l0_events_per_day: "100000000",
    pow_max_multiplier: "1",
  });
  const steps: Record<string, unknown>[] = [];
  let accepted = 0;
  let drain: Record<string, number> = {};
  let stored = -1;
  let saturatedAt: number | null = null;
  let stats: Record<string, string> = {};
  const prefix = `/ceil${id.replace(/[0-9]/g, "")}`;
  try {
    await waitForGateway(env, compose, sites, 180_000);
    await sleep(12_000); // raised limits reach the gateway with the next snapshots
    const rates = a.steps.split(",").map(Number);
    for (const [i, rate] of rates.entries()) {
      if (Date.now() + (stepS + 30) * 1000 > deadline) break;
      const m0 = await metrics();
      const t0 = performance.now();
      const statsP = sleep((stepS * 1000) / 2).then(dockerStats);
      const r = await runWebLoad({
        target: gatewayTarget(env),
        sites,
        rate,
        durationS: stepS,
        viewsPerLoad: Number(a["views-per-load"]),
        pathPrefix: prefix,
        uaVariety: 30,
        maxSolving: 24,
        idPrefix: `C${"abcdefghijklmnopqrstuvwxyz"[i % 26]}`,
      });
      const m1 = await metrics();
      const dt = (performance.now() - t0) / 1000;
      const s = await statsP;
      accepted += r.accepted;
      const fsynced =
        series(m1, "scf_gateway_spool_events", 'counter="fsynced"') -
        series(m0, "scf_gateway_spool_events", 'counter="fsynced"');
      const acked =
        series(m1, "scf_gateway_spool_events", 'counter="acked_stored"') -
        series(m0, "scf_gateway_spool_events", 'counter="acked_stored"');
      const q0 = sumSeries(m0, "scf_gateway_spool_queued");
      const q1 = sumSeries(m1, "scf_gateway_spool_queued");
      const row = {
        offered_per_s: rate,
        achieved_per_s: Number(r.achievedRps.toFixed(1)),
        answered_202_pct: Number(
          (((r.statuses["202"] ?? 0) / Math.max(1, r.sent)) * 100).toFixed(2),
        ),
        statuses: r.statuses,
        p50_ms: Number(r.latencyMs.p50.toFixed(1)),
        p99_ms: Number(r.latencyMs.p99.toFixed(1)),
        spool_intake_per_s: Number((fsynced / dt).toFixed(1)),
        delivered_to_umami_per_s: Number((acked / dt).toFixed(1)),
        spool_queued_start: q0,
        spool_queued_end: q1,
        spool_growth_per_s: Number(((q1 - q0) / dt).toFixed(1)),
        containers: s,
      };
      steps.push(row);
      console.log(`web step ${rate}/s: ${JSON.stringify({ ...row, containers: undefined })}`);
      const clientBound = r.achievedRps < rate * 0.9;
      const grew = q1 - q0 > Math.max(200, 0.05 * fsynced);
      const refused = row.answered_202_pct < 99 || r.latencyMs.p99 > 2000;
      if (grew || refused || clientBound) {
        saturatedAt = rate;
        stats = s;
        (row as Record<string, unknown>).saturation = [
          grew ? "spool grew (delivery to Umami below intake)" : "",
          refused ? "answers refused or p99 > 2 s" : "",
          clientBound ? "load client could not offer the rate" : "",
        ]
          .filter(Boolean)
          .join("; ");
        break;
      }
    }
    // Drain: no load; the forwarder empties the spool into Umami as fast as the engine takes it.
    const m0 = await metrics();
    const q0 = sumSeries(m0, "scf_gateway_spool_queued");
    const tD = performance.now();
    let qPeak = q0;
    for (;;) {
      const q = await gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued");
      qPeak = Math.max(qPeak, q);
      if (q === 0 || performance.now() - tD > 420_000) break;
      await sleep(1000);
    }
    const m1 = await metrics();
    const dD = (performance.now() - tD) / 1000;
    const ackedD =
      series(m1, "scf_gateway_spool_events", 'counter="acked_stored"') -
      series(m0, "scf_gateway_spool_events", 'counter="acked_stored"');
    drain = {
      queued_at_stop: q0,
      seconds: Number(dD.toFixed(1)),
      delivered: ackedD,
      drain_rate_per_s: q0 > 0 ? Number((ackedD / dD).toFixed(1)) : 0,
      queued_after: await gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued"),
    };
    console.log(`drain: ${JSON.stringify(drain)}`);
    const siteIds = sites.map((s) => `'${s.site_id}'`).join(",");
    const websites = (
      await compose.sql(
        "scf",
        `SELECT umami_website_id FROM scf.sites WHERE site_id IN (${siteIds})`,
      )
    ).map((r) => `'${r[0]}'`);
    stored = Number(
      await compose.scalar(
        "umami",
        `SELECT count(*) FROM website_event WHERE website_id IN (${websites.join(",")}) AND event_type = 1 AND url_path LIKE '${prefix}/%'`,
      ),
    );
  } finally {
    await setSettings(before);
  }
  const sustained = steps
    .filter((s) => !(s as { saturation?: string }).saturation)
    .map((s) => s.delivered_to_umami_per_s as number);
  const maxDelivered = Math.max(0, ...steps.map((s) => s.delivered_to_umami_per_s as number));
  return {
    steps,
    saturatedAt,
    drain,
    accepted,
    stored,
    statsAtSaturation: stats,
    sustained,
    maxDelivered,
    sites: sites.length,
  };
}

// --------------------------------------------------------------------------------------------------------------- api
async function apiPart() {
  const KEYS = [
    "otlp_requests_per_s",
    "otlp_burst",
    "otlp_bytes_per_s",
    "l0_events_per_day",
    "l0_routes_per_day",
  ];
  const before = await settings(KEYS);
  await openEnrollment(compose);
  const n = Number(a.services);
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
    const name = `rvt-ceil-${i}`;
    const tenantId = (await cp.createTenant(`rvt-apiceil${i}-${id}`)).tenant_id;
    const s = await cp.json<{ service_id: string }>("POST", `/v1/tenants/${tenantId}/services`, {
      service_name: name,
    });
    const t = await cp.json<{ token: string }>("POST", `/v1/tenants/${tenantId}/ingest-tokens`, {
      label: "ceiling",
    });
    svcs.push({ name, token: t.token, cp, tenantId, serviceId: s.service_id });
  }
  await setSettings({
    otlp_requests_per_s: "100000",
    otlp_burst: "100000",
    otlp_bytes_per_s: "999999999",
    l0_events_per_day: "100000000",
    l0_routes_per_day: "100000",
  });
  const steps: Record<string, unknown>[] = [];
  const acceptedSpans: Record<string, number> = {};
  let saturatedAt: number | null = null;
  const rowWrites = async () =>
    Number(
      await compose.scalar(
        "scf",
        "SELECT coalesce(sum(n_tup_ins + n_tup_upd), 0) FROM pg_stat_user_tables WHERE schemaname = 'scf' AND relname LIKE 'api\\_%'",
      ),
    );
  let lagS = -1;
  let storedTotal = 0;
  let acceptedTotal = 0;
  let writerTimeline: { t: number; rows: number }[] = [];
  try {
    await sleep(12_000);
    const w0 = await rowWrites();
    const tStart = performance.now();
    writerTimeline = [{ t: 0, rows: 0 }];
    const sampler = setInterval(() => {
      void rowWrites().then((r) =>
        writerTimeline.push({ t: (performance.now() - tStart) / 1000, rows: r - w0 }),
      );
    }, 5000);
    try {
      for (const sps of a["span-steps"].split(",").map(Number)) {
        if (Date.now() + (stepS + 60) * 1000 > deadline) break;
        const r0 = await rowWrites();
        const t0 = performance.now();
        const statsP = sleep((stepS * 1000) / 2).then(dockerStats);
        const r = await runOtlpLoad({
          target: gatewayTarget(env),
          services: svcs,
          spansPerSecond: sps,
          batch: Number(a.batch),
          durationS: stepS,
          routes: Number(a.routes),
        });
        const dt = (performance.now() - t0) / 1000;
        const r1 = await rowWrites();
        for (const [k, v] of Object.entries(r.acceptedSpans))
          acceptedSpans[k] = (acceptedSpans[k] ?? 0) + v;
        const ok = r.statuses["200"] ?? 0;
        const row = {
          offered_spans_per_s: sps,
          achieved_spans_per_s: Number(r.achievedSpansPerSecond.toFixed(1)),
          otlp_requests_per_s: Number((r.requests / dt).toFixed(1)),
          answered_200_pct: Number(((ok / Math.max(1, r.requests)) * 100).toFixed(2)),
          statuses: r.statuses,
          p50_ms: Number(r.latencyMs.p50.toFixed(1)),
          p99_ms: Number(r.latencyMs.p99.toFixed(1)),
          writer_row_writes_per_s_during_step: Number(((r1 - r0) / dt).toFixed(1)),
          containers: await statsP,
        };
        steps.push(row);
        console.log(
          `api step ${sps} spans/s: ${JSON.stringify({ ...row, containers: undefined })}`,
        );
        if (
          row.answered_200_pct < 99 ||
          r.latencyMs.p99 > 2000 ||
          r.achievedSpansPerSecond < sps * 0.9
        ) {
          saturatedAt = sps;
          (row as Record<string, unknown>).saturation =
            row.answered_200_pct < 99
              ? "front door refused (429/503: Collector queue or in-flight bound)"
              : r.latencyMs.p99 > 2000
                ? "p99 > 2 s"
                : "load client could not offer the rate";
          break;
        }
      }
      acceptedTotal = Object.values(acceptedSpans).reduce((x, y) => x + y, 0);
      const tL = performance.now();
      try {
        await eventually(
          "every accepted span visible in the API",
          async () => {
            storedTotal = 0;
            for (const s of svcs) {
              const sum = await s.cp.json<{ requests: number }>(
                "GET",
                `/v1/tenants/${s.tenantId}/services/${s.serviceId}/api/summary?range=24h`,
              );
              storedTotal += sum.requests;
            }
            return storedTotal;
          },
          (x) => x >= acceptedTotal,
          Math.max(60_000, Math.min(420_000, deadline - Date.now())),
          5000,
        );
        lagS = (performance.now() - tL) / 1000;
      } catch {
        // reported as not caught up
      }
    } finally {
      clearInterval(sampler);
    }
  } finally {
    await setSettings(before);
  }
  // Peak writer rate over any 10-s window of the samples.
  let peakRows = 0;
  for (let i = 0; i < writerTimeline.length; i++)
    for (let j = i + 1; j < writerTimeline.length; j++) {
      const A = writerTimeline[i] as { t: number; rows: number };
      const B = writerTimeline[j] as { t: number; rows: number };
      if (B.t - A.t >= 9.5) {
        peakRows = Math.max(peakRows, (B.rows - A.rows) / (B.t - A.t));
        break;
      }
    }
  return {
    steps,
    saturatedAt,
    acceptedTotal,
    storedTotal,
    lagS,
    peakRowWritesPerS: Number(peakRows.toFixed(1)),
    services: n,
    routes: Number(a.routes),
    writerTimeline,
  };
}

// ------------------------------------------------------------------------------------------------------------- main
const host = await machine();
console.log(`machine: ${JSON.stringify(host)}`);
if (a.part === "web") {
  const w = await webPart();
  const ceiling = w.drain.drain_rate_per_s || w.maxDelivered;
  const ok = w.stored === w.accepted;
  console.log(JSON.stringify({ ...w, ceiling }, null, 2));
  if (!a["no-evidence"])
    console.log(
      `evidence: ${
        writeEvidence(env.evidenceDir, {
          layer: "load",
          name: "ceiling-web",
          title: "Web engine ceiling (ramp until Umami saturates)",
          summary: `Stepped open-model load (${stepS} s per step) of page views through the gateway of the local single-node stack into Umami, ${w.sites} sites, one event per request; ramp stopped at the first saturated step (${w.saturatedAt ?? "none reached"} events/s offered); then the spool's drain rate with no load. Engine ceiling ≈ ${ceiling} events/s = ${perDay(ceiling).toLocaleString("en")} events/day.`,
          checks: [
            {
              name: "no accepted event lost or duplicated (Umami count = 202 count)",
              outcome: ok ? "pass" : "fail",
              detail: `accepted ${w.accepted}, stored ${w.stored}`,
              ids: ["slo.ingest-availability"],
            },
            {
              name: "spool drained after the ramp",
              outcome: w.drain.queued_after === 0 ? "pass" : "fail",
              detail: JSON.stringify(w.drain),
              ids: ["slo.ingest-availability"],
            },
          ],
          data: { machine: host, ...w, ceiling },
        }).md
      }`,
    );
  process.exit(ok ? 0 : 1);
} else if (a.part === "api") {
  const r = await apiPart();
  const ok = r.storedTotal === r.acceptedTotal;
  console.log(JSON.stringify(r, null, 2));
  if (!a["no-evidence"])
    console.log(
      `evidence: ${
        writeEvidence(env.evidenceDir, {
          layer: "load",
          name: "ceiling-api",
          title: "API path ceiling (OTLP front door → Collector → writer)",
          summary: `Stepped OTLP/HTTP JSON load (${stepS} s per step, ${a.batch} SERVER spans per request, ${r.services} tenants, ${r.routes} routes each) through the gateway's OTLP front door; saturation at ${r.saturatedAt ?? "none reached"} spans/s offered; writer peak ${r.peakRowWritesPerS} row writes/s.`,
          checks: [
            {
              name: "derived request counts equal the accepted spans",
              outcome: ok ? "pass" : "fail",
              detail: `accepted ${r.acceptedTotal}, API ${r.storedTotal}, caught up ${r.lagS} s after the ramp`,
              ids: ["capacity.1m-requests-day", "slo.ingest-availability"],
            },
          ],
          data: { machine: host, ...r },
        }).md
      }`,
    );
  process.exit(ok ? 0 : 1);
} else {
  console.error("--part must be web or api");
  process.exit(2);
}
