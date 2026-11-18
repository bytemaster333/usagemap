// SPDX-License-Identifier: Apache-2.0
// Chaos runner (ADR-0026 "Chaos", slo.ingest-availability, DV-29). Usage:
//   node chaos/run.ts [--rate 8] [--outage 20] [--only postgres,umami] [--no-evidence]
// A constant web load runs for the whole sequence; one dependency after the other is killed with SIGKILL
// (`docker compose kill`), kept down for --outage seconds and started again. Asserted per target:
//   - ingest keeps answering 2xx while the target is down (every target except the gateway itself);
//   - afterwards the spool drains;
// and at the end, per request (every request carries its own page path): no accepted event is missing in Umami, and
// every stored copy beyond the accepted ones is classified — duplicate forward (at-least-once after an ambiguous
// attempt), answer lost after the fsync (connection cut), refused-but-stored (bug) or unknown (bug).
// Killed services come back with `docker compose up -d --no-deps --no-recreate <svc>`: only the killed container, never
// its dependencies (`compose start` would start those too).
// The gateway target is the durability case: the engine is stopped so the spool holds records, the gateway is
// killed with SIGKILL and restarted, and every accepted record must still arrive. The local stack has one edge node,
// so ingest is down while the gateway is down — in production the tracker fails over to the second host; that
// availability case needs the multi-node stack and is reported as not run here.
// Targets that are not part of the running stack (e.g. the Collector before the OTLP front door is wired) are
// reported as not run, never as passed.
// Rate limits are tenant protections, not what is under test: all load comes from one address, and since the
// per-(site, subnet) limit is capped at a quarter of the site's share the L0 defaults
// (600/min per site → 150/min per subnet) would refuse most of the 8/s with 429. As in load/run.ts, the per-subnet and
// the L0 per-site limits are raised for the run and restored afterwards.

import { parseArgs } from "node:util";
import { Compose } from "../lib/compose.ts";
import { loadEnv } from "../lib/env.ts";
import { type Check, writeEvidence } from "../lib/evidence.ts";
import { createFixture, eventually, gatewayTarget, waitForGateway } from "../lib/fixture.ts";
import { browserHeaders, CHROME_UA, GatewayClient } from "../lib/gateway-client.ts";
import { gauge, metricSum, reconcile, runWebLoad } from "../load/web-load.ts";

const { values: a } = parseArgs({
  options: {
    rate: { type: "string", default: "8" },
    outage: { type: "string", default: "20" },
    only: { type: "string", default: "" },
    "no-evidence": { type: "boolean", default: false },
  },
});
const env = loadEnv();
const compose = new Compose(env);
const rate = Number(a.rate);
const outageS = Number(a.outage);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Target {
  service: string;
  what: string;
  ids: string[];
}
const ALL: Target[] = [
  { service: "postgres", what: "the database (scf + umami)", ids: ["slo.ingest-availability"] },
  { service: "umami", what: "the engine", ids: ["slo.ingest-availability"] },
  {
    service: "engine-proxy",
    what: "the core node's engine proxy",
    ids: ["slo.ingest-availability"],
  },
  {
    service: "control-plane",
    what: "the control plane (snapshot source)",
    ids: ["slo.ingest-availability"],
  },
  { service: "metrics-writer", what: "the metrics writer", ids: ["slo.ingest-availability"] },
  {
    service: "collector",
    what: "the Collector",
    ids: ["slo.ingest-availability", "capacity.1m-requests-day"],
  },
  { service: "jobs", what: "the jobs service", ids: ["slo.ingest-availability"] },
];
const only = a.only ? a.only.split(",") : [];
const targets = only.length ? ALL.filter((t) => only.includes(t.service)) : ALL;
const running = await compose.services(false);

const f = await createFixture(env, compose, `wsl-chaos-${Date.now().toString(36)}`, [
  { key: "chaos", host: "chaos.wsl.test" },
]);
const site = f.sites.chaos;
if (!site) throw new Error("fixture");
const LIMITS = ["web_requests_per_min_subnet", "l0_web_requests_per_min_site"];
const limitsBefore = (
  await compose.sql(
    "scf",
    `SELECT key, value::text FROM scf.settings WHERE key IN (${LIMITS.map((k) => `'${k}'`).join(",")})`,
  )
).map(([k, v]) => [k as string, v as string] as const);
await compose.sql(
  "scf",
  `BEGIN; UPDATE scf.settings SET value = '1000000' WHERE key IN (${LIMITS.map((k) => `'${k}'`).join(",")}); COMMIT; NOTIFY scf_edge;`,
);
const restoreLimits = () =>
  compose.sql(
    "scf",
    `BEGIN; ${limitsBefore
      .map(([k, v]) => `UPDATE scf.settings SET value = '${v}'::jsonb WHERE key = '${k}';`)
      .join(" ")} COMMIT; NOTIFY scf_edge;`,
  );
await waitForGateway(env, compose, [site]);
await sleep(12_000); // two snapshot intervals: the raised limits are live at the edge
const prefix = "/chaos"; // the site is new for this run: all its page views are ours

const ctl = new AbortController();
const totalS = (targets.length + 2) * (outageS + 40) + 120;
console.log(
  `load ${rate}/s for up to ${totalS} s; targets: ${targets.map((t) => t.service).join(", ")}`,
);
const loadP = runWebLoad({
  target: gatewayTarget(env),
  sites: [site],
  rate,
  durationS: totalS,
  viewsPerLoad: 5,
  pathPrefix: prefix,
  signal: ctl.signal,
  uniquePaths: true,
});
const ambiguousBefore = await metricSum(
  env.gatewayMetricsUrl,
  "scf_gateway_forward_ambiguous_retries_total",
);
const checks: Check[] = [];
const windows: { service: string; from: number; to: number }[] = [];
await sleep(10_000); // a steady state first
// the load generator's timeline starts at its own clock; align by wall time
const t0 = Date.now() - 10_000;

for (const t of targets) {
  if (!running.includes(t.service)) {
    checks.push({
      name: `kill ${t.service}: ingest keeps answering 2xx`,
      outcome: "not_run",
      detail: `requires: ${t.service} (not running in project ${env.project})`,
      ids: t.ids,
    });
    continue;
  }
  const from = Math.floor((Date.now() - t0) / 1000);
  console.log(`t=${from}s kill -9 ${t.service}`);
  await compose.kill(t.service);
  await sleep(outageS * 1000);
  await compose.upNoDeps(t.service);
  // recovery: the service is back and the spool has drained
  let drained = true;
  try {
    await eventually(
      `${t.service}: spool drained`,
      () => gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued"),
      (n) => n === 0,
      240_000,
      1000,
    );
  } catch {
    drained = false;
  }
  const to = Math.floor((Date.now() - t0) / 1000) + 1;
  windows.push({ service: t.service, from, to });
  checks.push({
    name: `kill ${t.service} (${t.what}) for ${outageS} s: spool drains afterwards`,
    outcome: drained ? "pass" : "fail",
    detail: `window t=${from}…${to} s`,
    ids: t.ids,
  });
  await sleep(5000);
}

// Durability across a gateway crash: engine stopped → records spooled → SIGKILL the gateway → start both.
let gwDetail = "";
let markerAccepted = 0;
let queuedCheck: Check | undefined;
if (!only.length || only.includes("gateway")) {
  await compose.stop("umami");
  // 20 marker page views, each acknowledged with 202 (= fsync'd) while the engine is down
  const mk = new GatewayClient(
    gatewayTarget(env),
    browserHeaders(site.origin, CHROME_UA(131, "X11; Linux x86_64; marker")),
  );
  const proof = await mk.solved(site.site_key);
  for (let i = 0; i < 20; i++) {
    const res = await mk.send({
      site: site.site_key,
      token: proof.token,
      c: proof.c,
      sg: { wd: 0, vis: "v", act: 1 },
      events: [{ k: "pv", u: "/crash/marker", w: "l", l: "en" }],
    });
    if (res.status === 202) markerAccepted++;
  }
  await sleep(3000);
  const queued = await gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued");
  const fsyncedBefore = await gauge(
    env.gatewayMetricsUrl,
    'scf_gateway_spool_events{counter="fsynced"}',
  );
  const from = Math.floor((Date.now() - t0) / 1000);
  await compose.kill("gateway");
  await sleep(3000);
  await compose.upNoDeps("gateway"); // the gateway alone: the engine must stay down
  await eventually(
    "gateway healthy after the restart",
    async () => {
      try {
        return (await fetch(`${env.gatewayMetricsUrl}/healthz`)).status;
      } catch {
        return 0;
      }
    },
    (st) => st === 200,
    120_000,
    1000,
  );
  // Re-measure the queued gauge once the restarted process has recovered its spool: with the engine still down
  // nothing can drain, so it must come back to at least the pre-kill value (records recovered from disk count).
  let afterRestart = Number.NaN;
  try {
    afterRestart = await eventually(
      "queued gauge counts the recovered records",
      () => gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued"),
      (n) => Number.isFinite(n) && n >= queued,
      30_000,
      1000,
    );
  } catch {
    afterRestart = await gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued");
  }
  queuedCheck = {
    name: "after kill -9 the restarted gateway's queued gauge counts the records recovered from its spool",
    outcome:
      Number.isFinite(afterRestart) && afterRestart >= queued && queued > 0 ? "pass" : "fail",
    detail: `scf_gateway_spool_queued before the kill ${queued}, after the restart (engine still down) ${afterRestart}`,
    ids: ["slo.ingest-availability"],
  };
  await compose.upNoDeps("umami");
  await eventually(
    "spool drained after gateway restart",
    () => gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued"),
    (n) => n === 0,
    240_000,
    1000,
  );
  await sleep(10_000);
  const acked = await gauge(
    env.gatewayMetricsUrl,
    'scf_gateway_spool_events{counter="acked_stored"}',
  );
  const fsyncedAfter = await gauge(
    env.gatewayMetricsUrl,
    'scf_gateway_spool_events{counter="fsynced"}',
  );
  const to = Math.floor((Date.now() - t0) / 1000) + 1;
  windows.push({ service: "gateway", from, to });
  gwDetail = `marker page views acknowledged before the kill: ${markerAccepted}; spool queued before the kill ${queued} (fsynced counter ${fsyncedBefore}); after restart, engine still down: queued gauge ${afterRestart}; after the engine returned: acked_stored ${acked} vs fsynced since restart ${fsyncedAfter}`;
}
await sleep(10_000);
ctl.abort();
const r = await loadP;
await eventually(
  "final drain",
  () => gauge(env.gatewayMetricsUrl, "scf_gateway_spool_queued"),
  (n) => n === 0,
  240_000,
);
await sleep(5000);
await restoreLimits();
const websites = (
  await compose.sql(
    "scf",
    `SELECT umami_website_id FROM scf.sites WHERE site_id = '${site.site_id}'`,
  )
).map((x) => `'${x[0]}'`);
const storedRows = await compose.sql(
  "umami",
  `SELECT url_path, count(*) FROM website_event WHERE website_id IN (${websites.join(",")}) AND event_type = 1 AND url_path LIKE '${prefix}/%' GROUP BY url_path`,
);
const storedByPath = new Map(storedRows.map((x) => [x[0] as string, Number(x[1])]));
const rec = reconcile(r.paths ?? new Map(), storedByPath);
const stored = rec.storedTotal;
const ambiguousAfter = await metricSum(
  env.gatewayMetricsUrl,
  "scf_gateway_forward_ambiguous_retries_total",
);
const markerStored = Number(
  await compose.scalar(
    "umami",
    `SELECT count(*) FROM website_event WHERE website_id IN (${websites.join(",")}) AND event_type = 1 AND url_path = '/crash/marker'`,
  ),
);

// availability per outage window (seconds of the load timeline; the generator started ~10 s before t0's origin)
const offset = Math.round((t0 - r.timeline.start) / 1000);
for (const w of windows) {
  if (w.service === "gateway") continue;
  const bad = r.timeline.failingSeconds(w.from + offset, w.to + offset);
  const c = checks.find((x) => x.name.startsWith(`kill ${w.service} `));
  checks.push({
    name: `kill ${w.service}: ingest answered 2xx throughout the outage and recovery`,
    outcome: bad.length === 0 ? "pass" : "fail",
    detail: bad.length
      ? `non-2xx in seconds ${bad.join(",")}`
      : `0 failed requests in t=${w.from}…${w.to} s`,
    ids: c?.ids ?? ["slo.ingest-availability"],
  });
}
checks.push({
  name: "kill -9 the gateway with records in the spool: they survive the restart and drain",
  outcome: gwDetail
    ? markerAccepted === 20 && markerStored === markerAccepted
      ? "pass"
      : "fail"
    : "not_run",
  detail: gwDetail
    ? `${gwDetail}; marker page views stored in Umami: ${markerStored}`
    : "not selected",
  ids: ["slo.ingest-availability"],
});
if (queuedCheck) checks.push(queuedCheck);
checks.push({
  name: "gateway outage with a second edge node (tracker fails over to the other host)",
  outcome: "not_run",
  detail:
    "requires: multi-node stack (two edge nodes on two host names); the local stack has one gateway",
  ids: ["slo.ingest-availability"],
});
// The ambiguous-retry counter is node-wide and restarts at 0 with the process (the gateway kill): it is reported
// as a cross-check, the classification itself is per page path.
const ambiguous =
  Number.isFinite(ambiguousBefore) && Number.isFinite(ambiguousAfter)
    ? `${ambiguousAfter - ambiguousBefore} (counter ${ambiguousBefore} → ${ambiguousAfter}; restarts at 0 with the gateway process)`
    : "metric scf_gateway_forward_ambiguous_retries_total not exported";
const surplus = rec.storedTotal - rec.acceptedStored;
checks.push({
  name: "no accepted event lost over the whole run (every 202 page path is in Umami)",
  outcome: rec.accepted === r.accepted && rec.lost.length === 0 ? "pass" : "fail",
  detail: `accepted (202) ${r.accepted}, of them stored ${rec.acceptedStored}, lost ${rec.lost.length}${rec.lost.length ? ` (${rec.lost.slice(0, 10).join(", ")})` : ""}; statuses ${JSON.stringify(r.statuses)}`,
  ids: ["slo.ingest-availability"],
});
checks.push({
  name: "every stored copy beyond the accepted events is classified (no refused-but-stored, no unknown)",
  outcome: rec.refusedButStored.length === 0 && rec.unknown.length === 0 ? "pass" : "fail",
  detail: `stored ${rec.storedTotal} = accepted-and-stored ${rec.acceptedStored} + surplus ${surplus}: duplicate copies (at-least-once forward after an ambiguous attempt; event ids are not forwarded to Umami, C-37) ${rec.duplicateCopies}, stored although the client got no answer (connection cut after the fsync) ${rec.answerLostButStored}, refused but stored ${rec.refusedButStored.length}${rec.refusedButStored.length ? ` (${rec.refusedButStored.slice(0, 5).join(", ")})` : ""}, unknown paths ${rec.unknown.length}; gateway ambiguous retries over the run ${ambiguous}`,
  ids: ["slo.ingest-availability"],
});
checks.push({
  name: "API path under chaos (Collector queue, writer)",
  outcome: "not_run",
  detail:
    "covered by chaos/run-api.ts (evidence chaos/<date>-api-ingest); writer failover needs two writers (C-77)",
  ids: ["slo.ingest-availability", "capacity.1m-requests-day"],
});

for (const c of checks)
  console.log(`${c.outcome.toUpperCase().padEnd(8)} ${c.name} — ${c.detail ?? ""}`);
if (!a["no-evidence"]) {
  const out = writeEvidence(env.evidenceDir, {
    layer: "chaos",
    name: "web-ingest",
    title: "Chaos: dependencies killed under constant web load",
    summary: `Constant open-model web load (${rate} events/s, one event per request) against the local single-node Compose stack (project ${env.project}); each dependency killed with SIGKILL for ${outageS} s, then started; finally the gateway itself killed with records in its spool. Killed services come back with \`compose up -d --no-deps --no-recreate\` (only that container). Availability is judged per second of the load timeline over each outage-and-recovery window; durability per request: every request has its own page path, so each accepted (202) event is looked up in Umami and every surplus copy is classified.`,
    checks,
    data: {
      rate,
      outageS,
      windows,
      load: { ...r, timeline: r.timeline.totals(), paths: undefined },
      stored,
      reconciliation: { ...rec, lost: rec.lost.slice(0, 100), unknown: rec.unknown.slice(0, 100) },
      ambiguousRetries: { before: ambiguousBefore, after: ambiguousAfter },
    },
  });
  console.log(`evidence: ${out.md}`);
}
process.exit(checks.some((c) => c.outcome === "fail") ? 1 : 0);
