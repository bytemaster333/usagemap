// SPDX-License-Identifier: Apache-2.0
// Failure drills against a DEPLOYED host under steady web + OTLP load, with exact accounting of what the gateway
// acknowledged against what reached the analytics engine (Umami) and the metrics writer. tests/chaos/run.ts does the
// same against a local Compose stack (container kills); this one runs whole-host events: a reboot, a hard power-off,
// a credential rotation by the playbook — any shell command given as a drill action.
//
//   1. a DEMO-labelled site (domain verified by DNS TXT) and one DEMO API service per drill are created through the
//      API in the operator's tenant, with one ingest token for them; the per-site/per-subnet rate limits and the
//      adaptive proof cost are raised for the run and restored afterwards (one workstation address sends everything);
//   2. per drill: steady web load (every request its own page path `/demo/drill/<drill>/<code>`, so each event is
//      followed individually) and steady OTLP load (SERVER spans, counted per acknowledged request) start; after
//      `--pre-s` the action runs (`bash -c`); the loads keep running until the gateway has answered 202 again without
//      a gap for `--post-s` (bound `--max-minutes`), then stop;
//   3. after the last drill the gateway spool must drain to 0 and the writer must flush; then, per drill:
//      web: every page path → its answer vs. the number of copies Umami holds (reconcile(): acknowledged-but-lost,
//      duplicates, answer-lost-but-stored, refused-but-stored); API: acknowledged spans vs. the service's request count
//      in the tenant API (`/api/summary`);
//   4. the DEMO data are erased through the tenant erasure API, the token revoked, the TXT record removed, the
//      settings restored — whatever happened (`--keep` skips the erasure; `--erase-only <site>,<svc>[,<svc>…]`).
//
//   node infra/compose/scripts/live-drill.ts --phrase-file <owner phrase> --onboard <dir with onboard.json> \
//     --cf-token-file <f> --cf-zone <id> --ssh usagemap-host --out <file> \
//     --drill 'reboot=ssh usagemap-host sudo systemctl reboot' --drill 'poweroff=az vm stop … --skip-shutdown && az vm start …'
//
// The superuser psql over SSH reads settings and the DEMO site's own events only (to count them per page path).
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs, promisify } from "node:util";
import type { Timeline } from "../../../tests/lib/stats.ts";
import { runOtlpLoad } from "../../../tests/load/otlp-load.ts";
import { pathCode, reconcile, runWebLoad, sumSeries } from "../../../tests/load/web-load.ts";
import { ApiClient } from "../../../tools/demo-seed/src/api.ts";
import { demoKey } from "../../../tools/demo-seed/src/stellar.ts";
import {
  cleanupDemo,
  cloudflare,
  type Demo,
  ensureDemo,
  eraseDemo,
  gatewayMetrics,
  log,
  readSettings,
  sleep,
  sqlIn,
  writeSettings,
} from "./live-lib.ts";

const run = promisify(execFile);
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
    drill: { type: "string", multiple: true, default: [] },
    "web-rate": { type: "string", default: "10" },
    spans: { type: "string", default: "100" },
    batch: { type: "string", default: "20" },
    "pre-s": { type: "string", default: "60" },
    "post-s": { type: "string", default: "60" },
    "settle-s": { type: "string", default: "60" },
    "max-minutes": { type: "string", default: "25" },
    keep: { type: "boolean", default: false },
    "erase-only": { type: "string" },
  },
});
const ssh = a.ssh as string;
const onboard = JSON.parse(readFileSync(`${a.onboard}/onboard.json`, "utf8")) as {
  tenant_id: string;
};
const T = `/v1/tenants/${onboard.tenant_id}`;
const target = {
  url: `https://${a.ingest}`,
  servername: a.ingest as string,
  caFile: "/etc/ssl/certs/ca-certificates.crt",
};
const cf = cloudflare(a["cf-token-file"] as string, a["cf-zone"] as string);
const HOST = "drill-demo.usagemap.dev";
const PREFIX = "/demo/drill";
/** Letters-only tag of this run (minutes since the epoch): page paths of an earlier, interrupted run never count. */
const RUN = pathCode(Math.floor(Date.now() / 60_000) % 20 ** 6);
const drills = (a.drill as string[]).map((d) => {
  const i = d.indexOf("=");
  const name = d.slice(0, i);
  if (i < 1 || !/^[a-z]{2,16}$/.test(name))
    throw new Error(`--drill <name>=<command>: bad name in ${d}`);
  return { name, cmd: d.slice(i + 1) };
});

/** Longest stretch without any `ok` answer that overlaps [from, to] (epoch ms), from a per-second timeline. */
function outage(t: Timeline, ok: string, from: number, to: number) {
  const okSecs = [...t.buckets.entries()]
    .filter(([, b]) => (b.get(ok) ?? 0) > 0)
    .map(([s]) => s)
    .sort((x, y) => x - y);
  let best = { last_ok: "", next_ok: "", gap_s: 0 };
  for (let i = 1; i < okSecs.length; i++) {
    const s0 = t.start + (okSecs[i - 1] as number) * 1000;
    const s1 = t.start + (okSecs[i] as number) * 1000;
    if (s1 < from || s0 > to + 15 * 60_000) continue;
    const gap = (s1 - s0) / 1000 - 1;
    if (gap > best.gap_s)
      best = {
        last_ok: new Date(s0).toISOString(),
        next_ok: new Date(s1).toISOString(),
        gap_s: gap,
      };
  }
  return best;
}

/** Best effort host facts (the host may be down): boot time; containers starting, unhealthy or exited with an error
 *  (none listed = the whole stack is up; one-shot containers that exited 0 are fine). */
async function hostFacts(): Promise<string> {
  try {
    const { stdout } = await run(
      "ssh",
      [
        "-o",
        "ConnectTimeout=5",
        ssh,
        "echo boot=$(uptime -s); sudo docker ps -a --format '{{.Names}} {{.Status}}' | grep -E 'unhealthy|health: starting|Restarting|Created|Exited \\([1-9]|Dead' | tr '\\n' ';'",
      ],
      { timeout: 20_000 },
    );
    return stdout.trim();
  } catch (e) {
    return `unreachable (${(e as Error).message.split("\n")[0]})`;
  }
}

function runAction(cmd: string): Promise<{ code: number | null; ms: number; tail: string }> {
  const t0 = Date.now();
  return new Promise((res) => {
    const p = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (d: Buffer) => {
      process.stdout.write(d);
      tail = (tail + d.toString()).slice(-2000);
    };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    p.on("close", (code) => res({ code, ms: Date.now() - t0, tail }));
  });
}

async function storedByPath(siteId: string): Promise<Map<string, number>> {
  const ws = await sqlIn(ssh, `SELECT umami_website_id FROM scf.sites WHERE site_id = '${siteId}'`);
  if (!/^[0-9a-f-]{36}$/.test(ws)) throw new Error(`no engine website for ${siteId}`);
  const rows = await sqlIn(
    ssh,
    `SELECT url_path || '|' || count(*) FROM website_event WHERE website_id = '${ws}' AND event_type = 1 AND url_path LIKE '${PREFIX}/%/${RUN}/%' GROUP BY url_path;`,
    "umami",
  );
  return new Map(
    rows
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.lastIndexOf("|")), Number(l.slice(l.lastIndexOf("|") + 1))]),
  );
}

const apiRequests = async (api: ApiClient, serviceId: string) =>
  (await api.call<{ requests: number }>("GET", `${T}/services/${serviceId}/api/summary?range=24h`))
    .requests;

async function main() {
  const api = new ApiClient(a.portal as string);
  const key = demoKey(readFileSync(a["phrase-file"] as string, "utf8").trim(), "usagemap-owner");
  await api.signIn(key);
  if (a["erase-only"]) {
    const [siteId = "", ...svcIds] = (a["erase-only"] as string).split(",");
    const erased = await eraseDemo(api, key, T, siteId, svcIds, 4);
    writeFileSync(
      a.out as string,
      `${JSON.stringify({ at: new Date().toISOString(), erasure: erased }, null, 2)}\n`,
    );
    return;
  }
  if (drills.length === 0) throw new Error("no --drill given");
  const deadline = Date.now() + Number(a["max-minutes"]) * 60_000 * drills.length;
  const result: Record<string, unknown> = {
    at: new Date().toISOString(),
    ingest: a.ingest,
    web_rate_per_s: Number(a["web-rate"]),
    spans_per_s: Number(a.spans),
    spans_per_request: Number(a.batch),
    drills: [],
  };
  const demo: Demo = await ensureDemo(api, T, cf, {
    host: HOST,
    siteName: "DEMO · live failure drills (synthetic, erased after the run)",
    serviceName: `demo-drill-${drills[0]?.name}`,
    serviceDisplay: "DEMO · live failure drill (synthetic)",
    tokenLabel: "demo-drill",
    extraServices: drills.slice(1).map((d) => `demo-drill-${d.name}`),
  });
  result.run_tag = RUN;
  result.demo = {
    site_id: demo.site.site_id,
    services: demo.services.map((s) => ({ id: s.service_id, name: s.service_name })),
    host: HOST,
  };
  log(
    `DEMO site ${demo.site.site_id}, services ${demo.services.map((s) => s.service_name).join(", ")}`,
  );

  const restore = await readSettings(ssh);
  result.settings_before = restore;
  // One workstation address offers everything; the web rate is far below the host's capacity (live-load-2026-11-19).
  const raise = {
    web_requests_per_min_subnet: "100000",
    web_requests_per_min_site: "100000",
    l0_web_requests_per_min_site: "100000",
    l0_events_per_day: "10000000",
    pow_max_multiplier: "1",
  };
  const runs: {
    name: string;
    web: Awaited<ReturnType<typeof runWebLoad>>;
    otlp: Awaited<ReturnType<typeof runOtlpLoad>>;
    row: Record<string, unknown>;
    serviceId: string;
    apiBefore: number;
  }[] = [];
  try {
    await writeSettings(ssh, raise);
    await sleep(20_000); // the raised limits and the new site reach the gateway with the next snapshots
    for (const [i, d] of drills.entries()) {
      const svc = demo.services[i] as Demo["services"][number];
      // baseline BEFORE the loads start (read after, it already held the first acknowledged requests: 2026-11-19 run)
      const before = {
        host: await hostFacts(),
        api_requests: await apiRequests(api, svc.service_id),
      };
      const ctl = new AbortController();
      let lastWebOk = Date.now();
      let webOk = 0;
      const webP = runWebLoad({
        target,
        sites: [{ site_key: demo.site.site_key, origin: `https://${HOST}` }],
        rate: Number(a["web-rate"]),
        durationS: 6 * 3600,
        viewsPerLoad: 2, // few views per proof: proofs issued before a gateway restart go stale with K_chal
        pathPrefix: `${PREFIX}/${d.name}/${RUN}`,
        uniquePaths: true,
        uaVariety: 20,
        maxSolving: 8,
        // Event ids must never repeat an earlier run's: the engine proxy remembers delivered event keys for 1 h
        // (EP_DEDUP_WINDOW) and answers a repeat without storing it. A prefix from this drill's own start minute
        // (2026-11-19: a time-derived letter repeated the previous drill's prefix and 632 events were de-duplicated).
        idPrefix: `${pathCode(Math.floor(Date.now() / 60_000) % 20 ** 6).slice(1)}`,
        signal: ctl.signal,
        onTick: (_s, totals) => {
          const n = totals["202"] ?? 0;
          if (n > webOk) {
            webOk = n;
            lastWebOk = Date.now();
          }
        },
      });
      const otlpP = runOtlpLoad({
        target,
        services: [{ name: svc.service_name, token: demo.token.token }],
        spansPerSecond: Number(a.spans),
        batch: Number(a.batch),
        durationS: 6 * 3600,
        routes: 4,
        signal: ctl.signal,
      });
      log(`drill ${d.name}: load running, action in ${a["pre-s"]} s`);
      await sleep(Number(a["pre-s"]) * 1000);
      const actionStart = Date.now();
      log(`drill ${d.name}: action: ${d.cmd}`);
      const action = await runAction(d.cmd);
      const actionEnd = Date.now();
      log(`drill ${d.name}: action exit ${action.code} after ${(action.ms / 1000).toFixed(1)} s`);
      // recovered = 202s flowing again, continuously for post-s
      // An action that returns at once (a reboot request) is followed by the outage; one that takes long (stop + start,
      // a playbook run) contains it. Recovery counts only after the outage was seen.
      let recoveredAt = 0;
      let healthyAt = "";
      let sawDown = action.ms > 30_000;
      while (Date.now() < deadline) {
        await sleep(5000);
        const flowing = Date.now() - lastWebOk < 5000 && lastWebOk > actionEnd;
        // no outage within 3 min of the action (e.g. a rotation without a restart): recovery = now
        if (!sawDown && Date.now() - actionEnd > 180_000) sawDown = true;
        if (!flowing) {
          sawDown = true;
          recoveredAt = 0;
          continue;
        }
        if (!sawDown) continue;
        if (!recoveredAt) recoveredAt = Date.now();
        if (!healthyAt) {
          const f = await hostFacts();
          if (f.startsWith("boot=") && !f.includes(";")) healthyAt = new Date().toISOString();
        }
        if (recoveredAt && Date.now() - recoveredAt >= Number(a["post-s"]) * 1000 && healthyAt)
          break;
      }
      ctl.abort();
      const [web, otlp] = await Promise.all([webP, otlpP]);
      const row = {
        drill: d.name,
        command: d.cmd,
        action_start: new Date(actionStart).toISOString(),
        action_end: new Date(actionEnd).toISOString(),
        action_exit: action.code,
        action_s: Number((action.ms / 1000).toFixed(1)),
        host_before: before.host,
        host_after: await hostFacts(),
        all_containers_healthy_by: healthyAt || "not within the bound",
        web_outage: outage(web.timeline, "202", actionStart, actionEnd),
        otlp_outage: outage(otlp.timeline, "200", actionStart, actionEnd),
        web_statuses: web.statuses,
        otlp_statuses: otlp.statuses,
        web_sent: web.sent,
        otlp_requests: otlp.requests,
      };
      log(`drill ${d.name}: ${JSON.stringify(row)}`);
      runs.push({
        name: d.name,
        web,
        otlp,
        row,
        serviceId: svc.service_id,
        apiBefore: before.api_requests,
      });
      if (i < drills.length - 1) await sleep(Number(a["settle-s"]) * 1000);
    }
  } finally {
    await writeSettings(ssh, restore).then(
      () => log("settings restored"),
      (e) => log(`RESTORE FAILED: ${e}`),
    );
    result.settings_restored = await readSettings(ssh).catch((e) => String(e));
  }

  // 3. accounting after the spool drained and the writer flushed
  for (let i = 0; i < 60; i++) {
    const q = sumSeries(await gatewayMetrics(ssh), "scf_gateway_spool_queued");
    if (q === 0) break;
    log(`spool queued ${q}, waiting`);
    await sleep(10_000);
  }
  await sleep(30_000);
  await api.signIn(key); // a session created before a host restart is still valid, but be fresh
  let stored = new Map<string, number>();
  let prevTotal = -1;
  for (let i = 0; i < 20; i++) {
    stored = await storedByPath(demo.site.site_id);
    const total = [...stored.values()].reduce((x, y) => x + y, 0);
    if (total === prevTotal) break;
    prevTotal = total;
    await sleep(15_000);
  }
  for (const r of runs) {
    const mine = new Map([...stored].filter(([p]) => p.startsWith(`${PREFIX}/${r.name}/${RUN}/`)));
    const rec = reconcile(r.web.paths ?? new Map(), mine);
    const acceptedSpans = Object.values(r.otlp.acceptedSpans).reduce((x, y) => x + y, 0);
    let apiStored = 0;
    for (let i = 0; i < 30; i++) {
      apiStored = (await apiRequests(api, r.serviceId)) - r.apiBefore;
      if (apiStored >= acceptedSpans) break;
      await sleep(10_000);
    }
    const row = {
      ...r.row,
      web: {
        acknowledged_202: rec.accepted,
        acknowledged_and_stored: rec.acceptedStored,
        acknowledged_but_lost: rec.lost.length,
        lost_examples: rec.lost.slice(0, 10),
        stored_total: rec.storedTotal,
        duplicate_copies: rec.duplicateCopies,
        answer_lost_but_stored: rec.answerLostButStored,
        refused_but_stored: rec.refusedButStored.length,
        unknown_paths: rec.unknown.length,
      },
      api: {
        acknowledged_spans: acceptedSpans,
        stored_requests: apiStored,
        requests_before_the_drill: r.apiBefore,
        acknowledged_but_lost: Math.max(0, acceptedSpans - apiStored),
        surplus: Math.max(0, apiStored - acceptedSpans),
      },
    };
    (result.drills as unknown[]).push(row);
    log(
      `drill ${r.name} accounting: web ${JSON.stringify(row.web)} api ${JSON.stringify(row.api)}`,
    );
  }
  writeFileSync(a.out as string, `${JSON.stringify(result, null, 2)}\n`);

  // 4. erase the DEMO data
  if (!a.keep) {
    await sleep(30_000);
    result.erasure = await eraseDemo(
      api,
      key,
      T,
      demo.site.site_id,
      demo.services.map((s) => s.service_id),
      4,
    );
  }
  await cleanupDemo(api, T, cf, { host: HOST, tokenId: demo.token.token_id });
  writeFileSync(a.out as string, `${JSON.stringify(result, null, 2)}\n`);
  log(`written ${a.out}`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
