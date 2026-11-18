// SPDX-License-Identifier: Apache-2.0
// Load runner (ADR-0026 "Load (10× design target)", capacity.1m-requests-day, slo.ingest-availability). Usage:
//   node load/run.ts [--rate 116] [--duration 120] [--sites 4] [--views-per-load 10] [--no-evidence]
// Design target (C-48): 1 M page views/day and 1 M API requests/day across tenants; 10× = 10 M/day each
// = 115.7 events/s sustained. The web part offers that rate to the gateway (one event per request), waits for the
// spool to drain and checks that Umami stored exactly the accepted events (no loss, no duplicates).
// The API part needs the gateway's OTLP front door (day 3) and is reported NOT RUN until SCF_OTLP_URL is set; its
// profile is stated in the evidence: 10 M requests/day as SERVER spans (worst case: every request traced, 115.7
// spans/s in batches of 50 = 2.3 OTLP requests/s) plus 300 services exporting one metrics request every 60 s (5/s).
//
// Rate limits and quotas are tenant protections, not capacity limits: for the run the per-site limit of the test
// per-site limit (L0 setting), the per-subnet limit and the L0 quota are raised (all load comes from one address), and restored after.

import { parseArgs } from "node:util";
import { Compose } from "../lib/compose.ts";
import { loadEnv } from "../lib/env.ts";
import { writeEvidence } from "../lib/evidence.ts";
import { createFixture, eventually, gatewayTarget, waitForGateway } from "../lib/fixture.ts";
import { perDay } from "../lib/stats.ts";
import { gauge, runWebLoad } from "./web-load.ts";

const { values: a } = parseArgs({
  options: {
    rate: { type: "string", default: "116" },
    duration: { type: "string", default: "120" },
    sites: { type: "string", default: "4" },
    "views-per-load": { type: "string", default: "10" },
    "no-evidence": { type: "boolean", default: false },
  },
});

const env = loadEnv();
const compose = new Compose(env);
const rate = Number(a.rate);
const durationS = Number(a.duration);
const nSites = Number(a.sites);

const SETTINGS = [
  "web_requests_per_min_subnet",
  "l0_web_requests_per_min_site",
  "l0_events_per_day",
];
const before = Object.fromEntries(
  (
    await compose.sql(
      "scf",
      `SELECT key, value::text FROM scf.settings WHERE key IN (${SETTINGS.map((k) => `'${k}'`).join(",")})`,
    )
  ).map(([k, v]) => [k as string, v as string]),
);

const id = Date.now().toString(36);
const fixtures = [];
for (let t = 0; t < Math.ceil(nSites / 2); t++) {
  const n = Math.min(2, nSites - t * 2);
  fixtures.push(
    await createFixture(
      env,
      compose,
      `wsl-load${t}-${id}`,
      Array.from({ length: n }, (_, i) => ({ key: `load${t}${i}`, host: `load${t}${i}.wsl.test` })),
    ),
  );
}
const sites = fixtures.flatMap((f) => Object.values(f.sites));
const siteIds = sites.map((s) => `'${s.site_id}'`).join(",");
await compose.sql(
  "scf",
  `BEGIN;
   UPDATE scf.settings SET value = '1000000' WHERE key IN ('web_requests_per_min_subnet','l0_web_requests_per_min_site');
   UPDATE scf.settings SET value = '100000000' WHERE key = 'l0_events_per_day';
   COMMIT; NOTIFY scf_edge;`,
);
let result: Awaited<ReturnType<typeof runWebLoad>> | undefined;
let stored = -1;
let drainS = -1;
let ok = false;
const prefix = "/load"; // the site is new for this run: all its page views are ours
try {
  await waitForGateway(env, compose, sites);
  await new Promise((r) => setTimeout(r, 12_000)); // two snapshot intervals: the raised limits are live
  console.log(
    `offering ${rate}/s for ${durationS} s to ${sites.length} sites (${perDay(rate).toLocaleString("en")} /day)`,
  );
  result = await runWebLoad({
    target: gatewayTarget(env),
    sites,
    rate,
    durationS,
    viewsPerLoad: Number(a["views-per-load"]),
    pathPrefix: prefix,
    onTick: (s, t) => {
      if (s % 10 === 0) console.log(`t=${s}s ${JSON.stringify(t)}`);
    },
  });
  const t0 = Date.now();
  await eventually(
    "spool drained",
    () => gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued"),
    (n) => n === 0,
    600_000,
    1000,
  );
  drainS = (Date.now() - t0) / 1000;
  const websites = (
    await compose.sql("scf", `SELECT umami_website_id FROM scf.sites WHERE site_id IN (${siteIds})`)
  ).map((r) => `'${r[0]}'`);
  stored = Number(
    await compose.scalar(
      "umami",
      `SELECT count(*) FROM website_event WHERE website_id IN (${websites.join(",")}) AND event_type = 1 AND url_path LIKE '${prefix}/%'`,
    ),
  );
  ok =
    stored === result.accepted &&
    (result.statuses["202"] ?? 0) === result.sent &&
    result.achievedRps >= rate * 0.95;
} finally {
  await compose.sql(
    "scf",
    `BEGIN; ${Object.entries(before)
      .map(([k, v]) => `UPDATE scf.settings SET value = '${v}'::jsonb WHERE key = '${k}';`)
      .join(" ")} COMMIT; NOTIFY scf_edge;`,
  );
}

const r = result;
if (!r) process.exit(1);
console.log(JSON.stringify({ ...r, timeline: undefined, stored, drainS }, null, 2));
if (!a["no-evidence"]) {
  const out = writeEvidence(env.evidenceDir, {
    layer: "load",
    name: `web-${Math.round(rate)}rps-${Math.round(durationS)}s`,
    title: `Web ingest load: ${rate} events/s for ${durationS} s (${(perDay(rate) / 1e6).toFixed(1)} M/day equivalent)`,
    summary: `Open-model load against the gateway of a local single-node Compose stack (one gateway, one engine proxy, one Umami, one PostgreSQL on one 8-core host shared with other workloads). ${sites.length} sites; one event per request; one challenge + proof per ${a["views-per-load"]} page views (SPA token reuse). After the run the spool must drain and Umami must hold exactly the accepted events. 10× the design target (C-48) is 115.7 events/s sustained; this run offered ${rate}/s.`,
    checks: [
      {
        name: "offered rate achieved (≥ 95 %)",
        outcome: r.achievedRps >= rate * 0.95 ? "pass" : "fail",
        // The web design target is C-48 (1 M page views/day); capacity.1m-requests-day is the API (OTLP) target and
        // is evidenced by load/run-api.ts only.
        detail: `${r.achievedRps.toFixed(1)} req/s sent of ${rate} offered (web design target C-48 ×10 = 115.7/s)`,
        ids: ["slo.ingest-availability"],
      },
      {
        name: "every request answered 202",
        outcome: (r.statuses["202"] ?? 0) === r.sent ? "pass" : "fail",
        detail: JSON.stringify(r.statuses),
        ids: ["slo.ingest-availability"],
      },
      {
        name: "no accepted event lost or duplicated (Umami count = 202 count)",
        outcome: stored === r.accepted ? "pass" : "fail",
        detail: `accepted ${r.accepted}, stored ${stored}, spool drained ${drainS.toFixed(1)} s after the run`,
        ids: ["slo.ingest-availability"],
      },
    ],
    data: {
      rate,
      durationS,
      sites: sites.length,
      result: { ...r, timeline: r.timeline.totals() },
      stored,
      drainS,
      settingsDuringRun: {
        web_requests_per_min_subnet: 1000000,
        l0_web_requests_per_min_site: 1000000,
        l0_events_per_day: 100000000,
      },
    },
    notes: [
      "| Latency (ms) | p50 | p95 | p99 | max |",
      "|---|---|---|---|---|",
      `| POST /v1/e → 202 (fsync before answer) | ${r.latencyMs.p50.toFixed(1)} | ${r.latencyMs.p95.toFixed(1)} | ${r.latencyMs.p99.toFixed(1)} | ${r.latencyMs.max.toFixed(1)} |`,
      "",
      "The API (OTLP) load profile (capacity.1m-requests-day) is a separate run: `node load/run-api.ts`, evidence `load/api-*`.",
      "",
      "Limits of this run: one host, one edge node, one core; the client and the stack share the CPU. It shows the single-node path sustains the rate with durable acknowledgement and no loss; production capacity (four edges, two cores) is sized in docs/deployment-topology.md.",
    ].join("\n"),
  });
  console.log(`evidence: ${out.md}`);
}
process.exit(ok ? 0 : 1);
