// SPDX-License-Identifier: Apache-2.0
// Bounded ceiling measurement against a DEPLOYED host (tests/load/ceiling.ts drives a local Compose stack and cannot
// target a remote one). Uses the same open-model generators (tests/load/web-load.ts, otlp-load.ts) through the public
// ingest name, with real TLS, challenges and proofs of work:
//   1. a DEMO-labelled site and API service are created through the API in the operator's tenant (domain verified by
//      DNS TXT), with an ingest token for the service;
//   2. the platform protections that would cap one site (per-site and per-subnet rate limits, the L0 daily quotas, the
//      adaptive proof cost) are raised for the run through the database and restored afterwards — the figure is the
//      host's capacity, not a tenant's allowance;
//   3. web ramp, then API ramp, each step `--step-s` seconds; a ramp stops at the first step with < 99 % accepted,
//      p99 > 2 s, the client unable to offer the rate, or (web) the gateway's spool growing (delivery < intake);
//   4. the DEMO site's and service's data are erased through the tenant erasure API (whole UTC day) and the settings
//      restored, whatever happened.
// Hard bound: --max-minutes (default 10) for steps 3; JSON result to --out.
//
//   node infra/compose/scripts/live-load.ts --portal https://app.usagemap.dev --ingest e1.usagemap.dev \
//     --phrase-file <owner phrase> --onboard <dir with onboard.json> --cf-token-file <f> --cf-zone <id> \
//     --ssh usagemap-host --out <file> [--web-steps 25,50,100,200] [--span-steps 500,1000,2000,4000] [--step-s 45]
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runOtlpLoad } from "../../../tests/load/otlp-load.ts";
import { runWebLoad, sumSeries } from "../../../tests/load/web-load.ts";
import { ApiClient } from "../../../tools/demo-seed/src/api.ts";
import { demoKey } from "../../../tools/demo-seed/src/stellar.ts";
import {
  cleanupDemo,
  cloudflare,
  ensureDemo,
  eraseDemo,
  gatewayMetrics as gm,
  hostLoad as hl,
  PROTECTION_KEYS as KEYS,
  log,
  readSettings,
  series,
  sleep,
  writeSettings,
} from "./live-lib.ts";

const { values: a } = parseArgs({
  options: {
    portal: { type: "string", default: "https://app.usagemap.dev" },
    ingest: { type: "string", default: "e1.usagemap.dev" },
    "phrase-file": { type: "string" },
    onboard: { type: "string" },
    "cf-token-file": { type: "string" },
    "cf-zone": { type: "string" },
    ssh: { type: "string", default: "usagemap-host" },
    out: { type: "string" },
    "web-steps": { type: "string", default: "25,50,100,200" },
    "span-steps": { type: "string", default: "500,1000,2000,4000" },
    "step-s": { type: "string", default: "45" },
    "max-minutes": { type: "string", default: "10" },
    "erase-only": { type: "string" }, // "<site id>,<service id>": only step 4 (after an interrupted run)
  },
});
const stepS = Number(a["step-s"]);
const deadline = Date.now() + Number(a["max-minutes"]) * 60_000;
const onboard = JSON.parse(readFileSync(`${a.onboard}/onboard.json`, "utf8")) as {
  tenant_id: string;
};
const T = `/v1/tenants/${onboard.tenant_id}`;
const target = {
  url: `https://${a.ingest}`,
  servername: a.ingest as string,
  caFile: "/etc/ssl/certs/ca-certificates.crt",
};

const ssh = a.ssh as string;
const gatewayMetrics = () => gm(ssh);
const hostLoad = () => hl(ssh);
const cf = cloudflare(a["cf-token-file"] as string, a["cf-zone"] as string);

async function main() {
  const api = new ApiClient(a.portal as string);
  const key = demoKey(readFileSync(a["phrase-file"] as string, "utf8").trim(), "usagemap-owner");
  await api.signIn(key);
  if (a["erase-only"]) {
    const [siteId = "", serviceId = ""] = (a["erase-only"] as string).split(",");
    const erased = await eraseDemo(api, key, T, siteId, serviceId);
    writeFileSync(
      a.out as string,
      `${JSON.stringify({ at: new Date().toISOString(), erasure: erased }, null, 2)}\n`,
    );
    return;
  }
  const result: Record<string, unknown> = {
    at: new Date().toISOString(),
    ingest: a.ingest,
    web: [],
    api: [],
  };

  // 1. DEMO site + service
  const host = "load-demo.usagemap.dev";
  const demo = await ensureDemo(api, T, cf, {
    host,
    siteName: "DEMO · live load test (synthetic, erased after the run)",
    serviceName: "demo-load",
    serviceDisplay: "DEMO · live load test (synthetic)",
    tokenLabel: "demo-load",
  });
  const { site, service: svc, token: tok } = demo;
  result.demo = { site_id: site.site_id, service_id: svc.service_id, host };
  log(`DEMO site ${site.site_id}, service ${svc.service_id}`);

  // 2. raise protections
  const restore = await readSettings(ssh);
  result.settings_before = Object.entries(restore).map(([k, v]) => `${k}=${v}`);
  const raise: Record<string, string> = {
    web_requests_per_min_subnet: "10000000",
    web_requests_per_min_site: "10000000",
    l0_web_requests_per_min_site: "10000000",
    l0_events_per_day: "100000000",
    pow_max_multiplier: "1",
    otlp_requests_per_s: "100000",
    otlp_burst: "100000",
    otlp_bytes_per_s: "999999999",
    l0_routes_per_day: "100000",
  };
  const setAll = (v: Record<string, string>) => writeSettings(ssh, v);
  try {
    await setAll(raise);
    await sleep(20_000); // the raised limits and the new site reach the gateway with the next snapshots

    // 3a. web ramp
    for (const [i, rate] of (a["web-steps"] as string).split(",").map(Number).entries()) {
      if (Date.now() + (stepS + 30) * 1000 > deadline) break;
      const m0 = await gatewayMetrics();
      const t0 = performance.now();
      const loadP = sleep((stepS * 1000) / 2).then(hostLoad);
      const r = await runWebLoad({
        target,
        sites: [{ site_key: site.site_key, origin: `https://${host}` }],
        rate,
        durationS: stepS,
        viewsPerLoad: 50,
        pathPrefix: "/demo/load",
        uaVariety: 30,
        maxSolving: 24,
        idPrefix: `D${"abcdefghijklmnopqrstuvwxyz"[i % 26]}`,
      });
      const m1 = await gatewayMetrics();
      const dt = (performance.now() - t0) / 1000;
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
        delivered_to_engine_per_s: Number((acked / dt).toFixed(1)),
        spool_growth_per_s: Number(((q1 - q0) / dt).toFixed(1)),
        host: await loadP,
      };
      (result.web as unknown[]).push(row);
      log(`web ${rate}/s: ${JSON.stringify(row)}`);
      const why =
        row.answered_202_pct < 99
          ? "answers < 99 % 202"
          : r.latencyMs.p99 > 2000
            ? "p99 > 2 s"
            : r.achievedRps < rate * 0.9
              ? "client could not offer the rate"
              : q1 - q0 > Math.max(200, 0.05 * fsynced)
                ? "spool grew (engine slower than intake)"
                : "";
      if (why) {
        result.web_saturated = { at_offered_per_s: rate, reason: why };
        break;
      }
    }
    await sleep(15_000);

    // 3b. API ramp
    for (const sps of (a["span-steps"] as string).split(",").map(Number)) {
      if (Date.now() + (stepS + 20) * 1000 > deadline) break;
      const t0 = performance.now();
      const loadP = sleep((stepS * 1000) / 2).then(hostLoad);
      const r = await runOtlpLoad({
        target,
        services: [{ name: "demo-load", token: tok.token }],
        spansPerSecond: sps,
        batch: 100,
        durationS: stepS,
        routes: 20,
      });
      const dt = (performance.now() - t0) / 1000;
      const ok = r.statuses["200"] ?? 0;
      const row = {
        offered_spans_per_s: sps,
        achieved_spans_per_s: Number(r.achievedSpansPerSecond.toFixed(1)),
        otlp_requests_per_s: Number((r.requests / dt).toFixed(1)),
        answered_200_pct: Number(((ok / Math.max(1, r.requests)) * 100).toFixed(2)),
        statuses: r.statuses,
        p50_ms: Number(r.latencyMs.p50.toFixed(1)),
        p99_ms: Number(r.latencyMs.p99.toFixed(1)),
        host: await loadP,
      };
      (result.api as unknown[]).push(row);
      log(`api ${sps} spans/s: ${JSON.stringify(row)}`);
      const why =
        row.answered_200_pct < 99
          ? "answers < 99 % 200 (429/503)"
          : r.latencyMs.p99 > 2000
            ? "p99 > 2 s"
            : r.achievedSpansPerSecond < sps * 0.9
              ? "client could not offer the rate"
              : "";
      if (why) {
        result.api_saturated = { at_offered_spans_per_s: sps, reason: why };
        break;
      }
    }
  } finally {
    await setAll(restore).then(
      () => log("settings restored"),
      (e) => log(`RESTORE FAILED: ${e}`),
    );
    result.settings_restored = Object.entries(await readSettings(ssh, KEYS)).map(
      ([k, v]) => `${k}=${v}`,
    );
  }

  // 4. erase the DEMO data (fresh sign-in = recent authentication for the erasure)
  await sleep(60_000); // let the spool drain and the writer flush before erasing
  result.erasure = await eraseDemo(api, key, T, site.site_id, svc.service_id);
  await cleanupDemo(api, T, cf, { host, tokenId: tok.token_id });
  writeFileSync(a.out as string, `${JSON.stringify(result, null, 2)}\n`);
  log(`written ${a.out}`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
