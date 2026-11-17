// SPDX-License-Identifier: Apache-2.0
// Integration helpers: database handles for the jobs' own roles (through PgBouncer), superuser handles for seeding and
// for checking results, tenant/site seeding, a job context with captured logs, and a small client for the real Umami
// engine (event ingestion through /api/send exactly as the engine proxy forwards it, and Umami's own read API as the
// reference the rollups are compared with).

import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createPool, ScfDb, UmamiDb } from "../../src/db.ts";
import { createLogger } from "../../src/log.ts";
import { jobMetrics, Registry } from "../../src/metrics.ts";
import type { JobContext } from "../../src/runner.ts";

export function superClient(db: "scf" | "umami" = "scf"): pg.Pool {
  const pool = new pg.Pool({
    connectionString: db === "scf" ? inject("pgSuperUrl") : inject("umamiSuperUrl"),
    max: 2,
  });
  pool.on("error", () => {});
  return pool;
}

export function jobsDb(): ScfDb {
  return new ScfDb(
    createPool({ connectionString: inject("jobsUrl"), applicationName: "wsg-test" }),
  );
}

export function umamiRo(): UmamiDb {
  return new UmamiDb(
    createPool({ connectionString: inject("umamiRoUrl"), applicationName: "wsg-ro" }),
  );
}

export function umamiMaint(): UmamiDb {
  return new UmamiDb(
    createPool({ connectionString: inject("umamiMaintUrl"), applicationName: "wsg-maint" }),
  );
}

export interface Captured {
  lines: string[];
  ctx(opts?: { mode?: string; now?: Date; signal?: AbortSignal }): JobContext;
  registry: Registry;
}

export function capture(): Captured {
  const lines: string[] = [];
  const registry = new Registry();
  const metrics = jobMetrics(registry);
  const log = createLogger({ service: "jobs-test" }, (l) => lines.push(l), "debug");
  return {
    lines,
    registry,
    ctx: (o = {}) => ({
      signal: o.signal ?? new AbortController().signal,
      mode: o.mode ?? "manual",
      now: o.now ?? new Date(),
      log,
      metrics,
    }),
  };
}

export interface SeededSite {
  tenantId: string;
  siteId: string;
  userId: string;
  umamiId: string;
  twinId: string | null;
}

/** Inserts a user, an active tenant and one site (superuser; RLS does not apply to it). */
export async function seedSite(
  su: pg.Pool,
  opts: {
    twin?: boolean;
    retentionDays?: number | null;
    createdAt?: Date;
    tenantId?: string;
    userId?: string;
  } = {},
): Promise<SeededSite> {
  const tenantId = opts.tenantId ?? randomUUID();
  const userId = opts.userId ?? randomUUID();
  const siteId = randomUUID();
  const umamiId = randomUUID();
  const twinId = opts.twin ? randomUUID() : null;
  if (!opts.tenantId) {
    await su.query(`INSERT INTO scf.users (user_id, display_name) VALUES ($1, 'wsg test owner')`, [
      userId,
    ]);
    await su.query(
      `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by)
       VALUES ($1, $2, 'WSG test tenant', 'active', $3)`,
      [tenantId, `wsg-${tenantId.slice(0, 8)}`, userId],
    );
  }
  const siteKey = randomBytes(32)
    .toString("base64")
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(0, 22);
  await su.query(
    `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id,
                            visitor_id, created_by, event_retention_days, created_at)
     VALUES ($1, $2, 'wsg site', $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantId,
      siteId,
      siteKey,
      umamiId,
      twinId,
      twinId ? "off" : "on",
      userId,
      opts.retentionDays ?? null,
      opts.createdAt ?? new Date(Date.now() - 400 * 86_400_000),
    ],
  );
  return { tenantId, siteId, userId, umamiId, twinId };
}

// ---------------------------------------------------------------- Umami (the real engine)

export const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  safariIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
};

export interface SendOpts {
  website: string;
  surrogate: string;
  country: string;
  ua: string;
  at: Date;
  url: string;
  tag: "v" | "s";
  name?: string;
  referrer?: string;
  screen?: string;
  cache?: string | undefined;
}

export class UmamiApi {
  readonly base: string;
  #token = "";

  constructor(base = inject("umamiApi")) {
    this.base = base;
  }

  async login(): Promise<void> {
    const r = await fetch(`${this.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "umami" }),
    });
    if (!r.ok) throw new Error(`umami login ${r.status}`);
    this.#token = ((await r.json()) as { token: string }).token;
  }

  async createWebsite(id: string, name: string): Promise<void> {
    const r = await fetch(`${this.base}/api/websites`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ id, name, domain: "app.example.org" }),
    });
    if (!r.ok) throw new Error(`umami create website ${r.status}`);
  }

  /** POST /api/send as the engine proxy forwards it (wire-formats §c.2, §j.4); returns the cache token. */
  async send(o: SendOpts): Promise<string> {
    const payload: Record<string, unknown> = {
      website: o.website,
      hostname: "app.example.org",
      url: o.url,
      screen: o.screen ?? "1536x864",
      language: "en",
      tag: o.tag,
      timestamp: Math.floor(o.at.getTime() / 1000),
    };
    if (o.name) payload.name = o.name;
    if (o.referrer) payload.referrer = `https://${o.referrer}/`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": o.ua,
      "x-scf-surrogate-ip": o.surrogate,
      "cf-ipcountry": o.country,
    };
    if (o.cache) headers["x-umami-cache"] = o.cache;
    const r = await fetch(`${this.base}/api/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "event", payload }),
    });
    const body = (await r.json()) as { cache?: string; beep?: string };
    if (!r.ok || !body.cache) throw new Error(`umami send ${r.status}`);
    return body.cache;
  }

  async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
    const r = await fetch(`${this.base}${path}?${qs}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!r.ok) throw new Error(`umami GET ${path} ${r.status}`);
    return (await r.json()) as T;
  }
}

/** Number-or-string (wire-formats §j.3 R4: numbers may arrive as JSON strings). */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === null || v === undefined) return 0;
  throw new Error("not a number");
}
