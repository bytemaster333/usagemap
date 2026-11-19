// SPDX-License-Identifier: Apache-2.0
// Synthetic web traffic for one demo website and UTC day, as the events the analytics engine would hold: sessions with
// page views and custom/wallet events, each with a tag (`v` verified, `s` suspect) and the session attributes the
// engine keeps (country, device class, browser and OS labels). Everything is a deterministic function of the website,
// the day and the session index, so the same events give
//   - the engine rows of the live window (written to Umami's tables, see umami.ts), and
//   - the rollup rows (`web_daily_totals`, `web_daily_breakdowns`) computed with exactly the rules of the jobs
//     service's rollup SQL (services/jobs/src/rollup/sql.ts, compute.ts),
// so live and rolled-up figures agree and a later `web_rollup` run re-derives the same numbers.
// Privacy: no IP, User-Agent, end-user address, query string or page title is ever produced; paths are normalised
// path classes, referrers are hosts only, countries are ISO codes (C-52, data inventory §8).

import type { WebsitePlan } from "./plan.ts";
import { gauss, rngFor } from "./random.ts";

export const DAY_MS = 86_400_000;
export const EVENT_GAP_S = 45;

const COUNTRIES = [
  "US",
  "NG",
  "BR",
  "AR",
  "US",
  "DE",
  "GB",
  "IN",
  "MX",
  "KE",
  "PH",
  "NG",
  "US",
  "TR",
  "ES",
  "XX",
  "BR",
  "CO",
  "FR",
  "VN",
];
const DEVICES = ["mobile", "desktop", "mobile", "laptop", "mobile", "tablet", "desktop"];
const BROWSERS = [
  "chrome",
  "safari",
  "chrome",
  "ios",
  "firefox",
  "edge-chromium",
  "chrome",
  "samsung",
  "crios",
];
const OSES = ["Android OS", "Windows 10", "iOS", "Mac OS", "Android OS", "Linux", "iOS"];
const REFERRERS: (string | null)[] = [
  null,
  "google.com",
  null,
  "x.com",
  "github.com",
  null,
  "stellar.org",
  "reddit.com",
  "discord.com",
  null,
  "duckduckgo.com",
  "t.co",
];

export interface DemoEvent {
  /** seconds after the day's start */
  offsetS: number;
  type: 1 | 2;
  path: string;
  /** custom/wallet event name (type 2) */
  name: string | null;
  referrer: string | null;
}

export interface DemoSession {
  index: number;
  verified: boolean;
  country: string;
  device: string;
  browser: string;
  os: string;
  events: DemoEvent[];
}

export interface DayShape {
  sessions: number;
  suspect: number;
  spike: boolean;
}

/** The day's size: trend, weekly rhythm, noise and the planned anomaly (`daysBack` = 1 for yesterday). */
export function dayShape(
  site: WebsitePlan,
  phrase: string,
  day: string,
  daysBack: number,
  historyDays: number,
): DayShape {
  const r = rngFor(phrase, `day:${site.host}:${day}`);
  const trend = 1 - site.growth * Math.min(1, Math.max(0, daysBack) / historyDays);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const weekly = dow === 0 || dow === 6 ? 0.78 : 1.06;
  const noise = Math.max(0.6, 1 + 0.09 * gauss(r));
  const spike = site.anomaly === "spike" && daysBack === 12;
  const base = site.baseVisitors * trend * weekly * noise * (spike ? 6.5 : 1);
  const sessions = Math.max(1, Math.round(base));
  const share = spike
    ? 0.72
    : Math.min(0.9, Math.max(0, site.suspectShare * (1 + 0.15 * gauss(r))));
  return { sessions, suspect: Math.round(sessions * share), spike };
}

/** Bresenham spread: exactly `k` of `n` indices are marked, evenly. */
const marked = (i: number, n: number, k: number) =>
  Math.floor(((i + 1) * k) / n) > Math.floor((i * k) / n);

/** The sessions of one day; `untilS` (seconds after midnight) keeps only what happened before it (today). */
export function daySessions(site: WebsitePlan, shape: DayShape, untilS = 86_400): DemoSession[] {
  const out: DemoSession[] = [];
  const n = shape.sessions;
  for (let i = 0; i < n; i++) {
    const suspect = marked(i, n, shape.suspect);
    const start = Math.floor(((i + 0.5) * 86_400) / n);
    if (start >= untilS) continue;
    // suspect traffic is shallow: one or two page views, never a custom event
    const bounce = suspect ? i % 2 === 0 : i % 10 < 4;
    const pv = suspect ? 1 + (i % 2) : bounce ? 1 : 2 + (i % 4);
    const events: DemoEvent[] = [];
    for (let j = 0; j < pv; j++) {
      const path =
        j === 0
          ? ((i % 3 === 0 ? site.paths[0] : site.paths[i % site.paths.length]) ?? "/")
          : (site.paths[(i + j * 3) % site.paths.length] ?? "/");
      events.push({
        offsetS: start + j * EVENT_GAP_S,
        type: 1,
        path,
        name: null,
        referrer: j === 0 ? (REFERRERS[(i * 13) % REFERRERS.length] ?? null) : null,
      });
    }
    if (!bounce && !suspect) {
      const custom: string[] = [];
      if (site.wallet) {
        if (i % 6 === 1) custom.push("wallet_modal_opened");
        if (i % 12 === 1) custom.push("wallet_connect");
      } else if (i % 15 === 2) custom.push("cta_click");
      for (const [k, name] of custom.entries())
        events.push({
          offsetS: start + (pv + k) * EVENT_GAP_S,
          type: 2,
          path: events[events.length - 1]?.path ?? "/",
          name,
          referrer: null,
        });
    }
    const kept = events.filter((e) => e.offsetS < untilS && e.offsetS < 86_400);
    if (kept.length === 0) continue;
    out.push({
      index: i,
      verified: !suspect,
      country: suspect ? (i % 2 ? "US" : "DE") : (COUNTRIES[(i * 7) % COUNTRIES.length] ?? "XX"),
      device: suspect ? "desktop" : (DEVICES[(i * 3) % DEVICES.length] ?? "desktop"),
      browser: suspect ? "chrome" : (BROWSERS[(i * 5) % BROWSERS.length] ?? "chrome"),
      os: suspect ? "Linux" : (OSES[(i * 11) % OSES.length] ?? "Linux"),
      events: kept,
    });
  }
  return out;
}

export interface DayTotals {
  pageviews_verified: number;
  pageviews_raw: number;
  visitors_verified: number;
  visitors_raw: number;
  visits: number;
  bounces: number;
  total_duration_s: number;
  events_raw: number;
  custom_verified: number;
  custom_raw: number;
}

/** Totals by the rules of TOTALS_SQL (one visit per session; no twin website for the demo sites). */
export function totalsOf(sessions: DemoSession[]): DayTotals {
  const t: DayTotals = {
    pageviews_verified: 0,
    pageviews_raw: 0,
    visitors_verified: 0,
    visitors_raw: 0,
    visits: 0,
    bounces: 0,
    total_duration_s: 0,
    events_raw: 0,
    custom_verified: 0,
    custom_raw: 0,
  };
  for (const s of sessions) {
    const pvs = s.events.filter((e) => e.type === 1);
    const custom = s.events.length - pvs.length;
    t.events_raw += s.events.length;
    t.custom_raw += custom;
    if (s.verified) t.custom_verified += custom;
    if (pvs.length === 0) continue;
    t.pageviews_raw += pvs.length;
    t.visitors_raw += 1;
    t.visits += 1;
    if (pvs.length === 1 && custom === 0) t.bounces += 1;
    t.total_duration_s += Math.floor((pvs[pvs.length - 1]?.offsetS ?? 0) - (pvs[0]?.offsetS ?? 0));
    if (s.verified) {
      t.pageviews_verified += pvs.length;
      t.visitors_verified += 1;
    }
  }
  return t;
}

export type Dimension = "referrer" | "country" | "device" | "browser" | "os" | "path" | "event";
export interface BreakdownRow {
  variant: "verified" | "raw";
  dimension: Dimension;
  value: string;
  rank: number;
  visitors: number;
  pageviews: number | null;
  visits: number | null;
  events: number | null;
}

/** Breakdown rows by the rules of BREAKDOWN_SQL + topN (ranked by visitors, events for `event`, then value). */
export function breakdownsOf(sessions: DemoSession[], topN = 50): BreakdownRow[] {
  interface C {
    pv: [number, number];
    vis: [Set<number>, Set<number>];
    ev: [number, number];
    evVis: [Set<number>, Set<number>];
  }
  const acc = new Map<string, C>();
  const get = (d: Dimension, v: string) => {
    const k = `${d}\u0000${v}`;
    let c = acc.get(k);
    if (!c) {
      c = { pv: [0, 0], vis: [new Set(), new Set()], ev: [0, 0], evVis: [new Set(), new Set()] };
      acc.set(k, c);
    }
    return c;
  };
  for (const s of sessions) {
    for (const e of s.events) {
      const dims: [Dimension, string | null][] =
        e.type === 1
          ? [
              ["referrer", e.referrer],
              ["country", s.country],
              ["device", s.device],
              ["browser", s.browser],
              ["os", s.os],
              ["path", e.path],
            ]
          : [["event", e.name]];
      for (const [d, v] of dims) {
        if (!v) continue;
        const c = get(d, v);
        if (e.type === 1) {
          c.pv[1]++;
          c.vis[1].add(s.index);
          if (s.verified) {
            c.pv[0]++;
            c.vis[0].add(s.index);
          }
        } else {
          c.ev[1]++;
          c.evVis[1].add(s.index);
          if (s.verified) {
            c.ev[0]++;
            c.evVis[0].add(s.index);
          }
        }
      }
    }
  }
  const out: BreakdownRow[] = [];
  const dims: Dimension[] = ["referrer", "country", "device", "browser", "os", "path", "event"];
  for (const dimension of dims) {
    for (const [vi, variant] of (["verified", "raw"] as const).entries()) {
      const cand: BreakdownRow[] = [];
      for (const [k, c] of acc) {
        const [d, value] = k.split("\u0000") as [Dimension, string];
        if (d !== dimension) continue;
        if (dimension === "event") {
          if ((c.ev[vi] ?? 0) <= 0) continue;
          cand.push({
            variant,
            dimension,
            value,
            rank: 0,
            visitors: c.evVis[vi]?.size ?? 0,
            pageviews: null,
            visits: null,
            events: c.ev[vi] ?? 0,
          });
        } else {
          if ((c.pv[vi] ?? 0) <= 0) continue;
          const visitors = c.vis[vi]?.size ?? 0;
          // one visit per session: visits per value = sessions with a matching page view (raw only)
          cand.push({
            variant,
            dimension,
            value,
            rank: 0,
            visitors,
            pageviews: c.pv[vi] ?? 0,
            visits: variant === "raw" ? visitors : null,
            events: null,
          });
        }
      }
      const key = (r: BreakdownRow) => (dimension === "event" ? (r.events ?? 0) : r.visitors);
      cand.sort((a, b) => key(b) - key(a) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      cand.slice(0, topN).forEach((r, i) => {
        r.rank = i + 1;
        out.push(r);
      });
    }
  }
  return out;
}

/** UTC day string `YYYY-MM-DD` of `daysBack` days before `today`. */
export function dayString(today: Date, daysBack: number): string {
  const t =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - daysBack * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
