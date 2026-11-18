// SPDX-License-Identifier: Apache-2.0
// Web load generator (no k6 — AGPL; ADR-0026 "Load (10× design target)"). An open-model generator: requests are
// scheduled at a fixed rate whatever the response time, so slow answers show up as latency, not as a lower offered
// load (no coordinated omission). Each virtual visitor behaves like the tracker on an SPA: one challenge and one
// proof-of-work per page load, then several page views reusing the token and proof (wire-formats §a.3), one event
// per request. The proofs are solved ahead of time by a pool so that the client's CPU does not cap the offered rate.

import https from "node:https";
import {
  browserHeaders,
  CHROME_UA,
  GatewayClient,
  type GatewayTarget,
} from "../lib/gateway-client.ts";
import { request } from "../lib/http.ts";
import { type Summary, summarise, Timeline } from "../lib/stats.ts";

export interface WebLoadOpts {
  target: GatewayTarget;
  sites: { site_key: string; origin: string }[];
  /** Offered requests per second (one event each). */
  rate: number;
  durationS: number;
  /** Page views per page load (token + proof reuse). */
  viewsPerLoad: number;
  /** Path prefix of the generated page views (words only: pathnorm folds identifier-shaped segments). */
  pathPrefix: string;
  /** Called once per second with the running totals (progress). */
  onTick?: (sec: number, totals: Record<string, number>) => void;
  /** Stop early (chaos runner). */
  signal?: AbortSignal;
  /**
   * Give every request its own page path `<prefix>/<pathCode(n)>` and return each path's answer in `paths`, so a
   * run can tell lost, duplicated and refused-but-stored events apart exactly (chaos runner).
   */
  uniquePaths?: boolean;
  /**
   * Number of distinct User-Agents (= distinct visitor surrogates per site from this one address). Unbounded by
   * default; the ceiling run bounds it so that the multiplicity layer's adaptive proof cost does not turn the client's
   * CPU into the bottleneck.
   */
  uaVariety?: number;
  /** Event-id prefix (1–6 characters of [A-Za-z]); runs that follow each other within 10 minutes need different
   *  prefixes, or the gateway drops the second run's events as duplicates (C-37). Default "L". */
  idPrefix?: string;
  /** Proof-solving attempts in flight (default 16). */
  maxSolving?: number;
}

export interface WebLoadResult {
  offered: number;
  sent: number;
  statuses: Record<string, number>;
  latencyMs: Summary;
  achievedRps: number;
  timeline: Timeline;
  accepted: number;
  durationS: number;
  /** With `uniquePaths`: page path → the answer it got (`202`, another status, or `error` = no answer). */
  paths?: Map<string, string>;
}

/** Letters only, none of them hex digits: pathnorm keeps such a short word literal (no S6/S7/S12 fold). */
const CODE_LETTERS = "ghijklmnopqrstuvwxyz";

/** Six-letter code of a request number (20^6 = 64 M distinct codes), e.g. 0 → `gggggg`. */
export function pathCode(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 20 ** 6) throw new RangeError(`pathCode(${n})`);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out = (CODE_LETTERS[n % 20] as string) + out;
    n = Math.floor(n / 20);
  }
  return out;
}

/** 22-character event id: the prefix, then the request number in base 36, zero-padded. */
export function eventIdFor(prefix: string, n: number): string {
  if (!/^[A-Za-z]{1,6}$/.test(prefix)) throw new RangeError(`event-id prefix ${prefix}`);
  return `${prefix}${n.toString(36).padStart(22 - prefix.length, "0")}`;
}

/** Page names without digits: pathnorm folds numbers and opaque ids, words stay as they are. */
const PAGES = ["home", "pricing", "docs", "blog", "about"];

interface Proof {
  token: string;
  c: number;
  site: string;
  origin: string;
  ua: string;
  left: number;
}

export async function runWebLoad(o: WebLoadOpts): Promise<WebLoadResult> {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 256 });
  const loadsPerSecond = o.rate / o.viewsPerLoad;
  const pool: Proof[] = [];
  let visitor = 0;
  let solving = 0;
  const maxSolving = o.maxSolving ?? 16;
  const want = Math.ceil(loadsPerSecond * 3) + 8; // ~3 s of page loads ready

  async function solveOne(): Promise<void> {
    solving++;
    try {
      const s = o.sites[visitor % o.sites.length] as { site_key: string; origin: string };
      const v = o.uaVariety ? visitor % o.uaVariety : visitor;
      const ua = CHROME_UA(100 + (v % 40), `Windows NT 10.0; Win64; x64; v${v}`);
      visitor++;
      const gw = new GatewayClient(o.target, browserHeaders(s.origin, ua));
      const p = await gw.solved(s.site_key);
      pool.push({ ...p, site: s.site_key, origin: s.origin, ua, left: o.viewsPerLoad });
    } catch {
      // challenge refused (e.g. 429/503 during chaos): retried by the refill loop
    } finally {
      solving--;
    }
  }
  const refill = setInterval(() => {
    while (pool.length + solving < want && solving < maxSolving) void solveOne();
  }, 20);
  // warm-up: a pool before the clock starts
  while (pool.length < Math.min(want, 8)) {
    while (pool.length + solving < want && solving < maxSolving) void solveOne();
    await new Promise((r) => setTimeout(r, 50));
  }

  const timeline = new Timeline();
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let sent = 0;
  let accepted = 0;
  let offered = 0;
  const inflight = new Set<Promise<void>>();
  const start = performance.now();
  const total = Math.floor(o.rate * o.durationS);
  let seq = 0;
  let lastTick = -1;
  const paths = o.uniquePaths ? new Map<string, string>() : undefined;

  function fire(): void {
    offered++;
    const p = pool[0];
    if (!p) {
      statuses.no_proof_ready = (statuses.no_proof_ready ?? 0) + 1;
      timeline.add("no_proof_ready");
      return;
    }
    p.left--;
    if (p.left <= 0) pool.shift();
    const n = seq++;
    const path = paths
      ? `${o.pathPrefix}/${pathCode(n)}`
      : `${o.pathPrefix}/${PAGES[n % PAGES.length]}`;
    paths?.set(path, "pending");
    const body = JSON.stringify({
      v: 1,
      s: p.site,
      p: "standard",
      tv: "1.0.0",
      t: p.token,
      c: p.c,
      sg: { wd: 0, vis: "v", act: 1 },
      e: [
        {
          id: eventIdFor(o.idPrefix ?? "L", n),
          k: "pv",
          u: path,
          w: "l",
          l: "en",
        },
      ],
    });
    sent++;
    const pr = request(`${o.target.url}/v1/e`, {
      method: "POST",
      headers: browserHeaders(p.origin, p.ua),
      body,
      servername: o.target.servername,
      caFile: o.target.caFile,
      agent,
      timeoutMs: 10_000,
    })
      .then((r) => {
        latencies.push(r.ms);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        timeline.add(String(r.status));
        paths?.set(path, String(r.status));
        if (r.status === 202) accepted++;
      })
      .catch(() => {
        statuses.error = (statuses.error ?? 0) + 1;
        timeline.add("error");
        paths?.set(path, "error");
      })
      .finally(() => inflight.delete(pr));
    inflight.add(pr);
  }

  while (offered < total && !o.signal?.aborted) {
    const due = Math.floor(((performance.now() - start) / 1000) * o.rate);
    while (offered < Math.min(due, total)) fire();
    const sec = Math.floor((performance.now() - start) / 1000);
    if (sec !== lastTick) {
      lastTick = sec;
      o.onTick?.(sec, { ...statuses });
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  const elapsed = (performance.now() - start) / 1000;
  clearInterval(refill);
  await Promise.allSettled([...inflight]);
  agent.destroy();
  return {
    offered,
    sent,
    statuses,
    latencyMs: summarise(latencies),
    achievedRps: sent / elapsed,
    timeline,
    accepted,
    durationS: elapsed,
    ...(paths ? { paths } : {}),
  };
}

/** Sum of every series of a metric (any labels) from the gateway's Prometheus text endpoint; NaN when absent. */
export async function metricSum(metricsUrl: string, name: string): Promise<number> {
  const r = await request(`${metricsUrl}/metrics`, { timeoutMs: 5000 });
  return sumSeries(r.body, name);
}

export function sumSeries(text: string, name: string): number {
  let sum = Number.NaN;
  for (const l of text.split("\n")) {
    if (!(l.startsWith(`${name} `) || l.startsWith(`${name}{`))) continue;
    const v = Number(l.slice(l.lastIndexOf(" ") + 1));
    sum = (Number.isNaN(sum) ? 0 : sum) + v;
  }
  return sum;
}

/**
 * Classifies the stored copies of uniquely-pathed requests (see `uniquePaths`) against the answers the client got.
 * `stored` maps page path → number of events Umami holds for it.
 */
export interface Reconciliation {
  accepted: number;
  storedTotal: number;
  /** Accepted (202) and stored at least once. */
  acceptedStored: number;
  /** Accepted (202) and never stored: loss. */
  lost: string[];
  /** Extra copies of a path stored more than once (at-least-once forwarding after an ambiguous attempt, C-37). */
  duplicateCopies: number;
  /** Stored although the client got no answer (connection cut after the fsync): the 202 was lost, not the event. */
  answerLostButStored: number;
  /** Stored although the gateway answered with a non-202 status: a bug (a refusal must never be persisted). */
  refusedButStored: string[];
  /** Stored paths this run never sent: a bug in the test or someone else's events. */
  unknown: string[];
}

export function reconcile(sent: Map<string, string>, stored: Map<string, number>): Reconciliation {
  const r: Reconciliation = {
    accepted: 0,
    storedTotal: 0,
    acceptedStored: 0,
    lost: [],
    duplicateCopies: 0,
    answerLostButStored: 0,
    refusedButStored: [],
    unknown: [],
  };
  for (const [path, answer] of sent) {
    const n = stored.get(path) ?? 0;
    if (answer === "202") {
      r.accepted++;
      if (n === 0) r.lost.push(path);
      else r.acceptedStored++;
    } else if (n > 0) {
      if (answer === "error" || answer === "pending") r.answerLostButStored++;
      else r.refusedButStored.push(`${path} (${answer})`);
    }
    if (n > 1) r.duplicateCopies += n - 1;
  }
  for (const [path, n] of stored) {
    r.storedTotal += n;
    if (!sent.has(path)) r.unknown.push(path);
  }
  return r;
}

/** Reads one gauge from the gateway's Prometheus text endpoint. */
export async function gauge(metricsUrl: string, name: string): Promise<number> {
  const r = await request(`${metricsUrl}/metrics`, { timeoutMs: 5000 });
  const line = r.body.split("\n").find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(" ")[1]) : Number.NaN;
}
