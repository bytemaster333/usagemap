// SPDX-License-Identifier: Apache-2.0
// Acceptance (C-76, wire-formats §d.4, §o): job durability_reconcile reports spool accounting per edge node
// (balanced / loss / unaccounted / pending) from edge_spool_accounting, and the canary count check per probe source —
// accepted canaries from Prometheus (a fake Prometheus HTTP API here) against the page views the REAL Umami holds for
// the canary tenant's site (read through the scf_ro view as scf_umami_ro); re-checks pending days; idempotent upserts;
// alert metrics.

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb, UmamiDb } from "../../src/db.ts";
import { PrometheusCanarySource, runDurability } from "../../src/jobs/durability.ts";
import { addDays, dayStart, utcDay } from "../../src/schedule.ts";
import {
  capture,
  jobsDb,
  seedSite,
  superClient,
  UA,
  UmamiApi,
  umamiRo,
} from "../support/harness.ts";

let su: pg.Pool;
let db: ScfDb;
let ro: UmamiDb;
let prom: Server;
let promUrl: string;
let promQueries: URLSearchParams[] = [];
const api = new UmamiApi();

const now = new Date();
const today = utcDay(now);
const D = addDays(today, -1);
const D3 = addDays(today, -3);
const at = (day: string, h: number, m = 10) =>
  new Date(dayStart(day).getTime() + h * 3_600_000 + m * 60_000);

// Fake Prometheus: per source the hourly increases of scf_probe_canary_accepted_total for day D.
const accepted: Record<string, Record<number, number>> = {
  "mon-c": { 3: 2, 5: 1 },
  "probe-d": { 4: 1 },
};

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  ro = umamiRo();
  await api.login();
  prom = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    promQueries.push(u.searchParams);
    const start = Number(u.searchParams.get("start"));
    const day = utcDay(new Date((start - 3600) * 1000));
    const result =
      day === D
        ? Object.entries(accepted).map(([source, hours]) => ({
            metric: { source },
            values: Array.from({ length: 24 }, (_, h) => [
              start + h * 3600,
              String((hours[h] ?? 0) + 0.0001),
            ]),
          }))
        : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { resultType: "matrix", result } }));
  });
  await new Promise<void>((r) =>
    prom.listen(Number(process.env.SCF_WSG_PROM_PORT ?? 56268), "127.0.0.1", r),
  );
  promUrl = `http://127.0.0.1:${(prom.address() as AddressInfo).port}`;

  // Canary tenant (is_canary is set by the bootstrap playbook, here as superuser) with one site in Umami.
  const canary = await seedSite(su);
  await su.query("UPDATE scf.tenants SET is_canary = true WHERE tenant_id = $1", [canary.tenantId]);
  await api.createWebsite(canary.umamiId, "canary");
  const send = (path: string, when: Date, i: number) =>
    api.send({
      website: canary.umamiId,
      surrogate: `2001:db8::c${i}`,
      country: "DE",
      ua: UA.chromeWin,
      at: when,
      url: path,
      tag: "v",
    });
  // mon-c: 2 in hour 3, but the one in hour 5 never arrived; probe-d: 1 in hour 4. A normal tenant's page with a
  // canary-like path is not counted (other site).
  await send("/canary/mon-c/round", at(D, 3), 1);
  await send("/canary/mon-c/host-a", at(D, 3, 20), 2);
  await send("/canary/probe-d/edge-a1", at(D, 4), 3);
  const other = await seedSite(su);
  await api.createWebsite(other.umamiId, "not canary");
  await api.send({
    website: other.umamiId,
    surrogate: "2001:db8::99",
    country: "DE",
    ua: UA.chromeWin,
    at: at(D, 5),
    url: "/canary/mon-c/round",
    tag: "v",
  });

  // Spool accounting for D (and a pending D-3 from an earlier run whose reports are now complete).
  await su.query("DELETE FROM scf.edge_spool_accounting WHERE node_id LIKE 'wsg-%'");
  await su.query(
    "DELETE FROM scf.durability_reports WHERE subject LIKE 'node:wsg-%' OR subject LIKE 'canary:%'",
  );
  const end = dayStart(today);
  const acct = (node: string, day: string, v: Partial<Record<string, unknown>>) =>
    su.query(
      `INSERT INTO scf.edge_spool_accounting (node_id, day, queued_start, fsynced, acked_stored, acked_engine_bot,
         acked_engine_rejected, expired_72h, queued_end, last_period_end, restarts)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        node,
        day,
        v.qs ?? 0,
        v.f ?? 0,
        v.as ?? 0,
        v.ab ?? 0,
        v.ar ?? 0,
        v.ex ?? 0,
        v.qe ?? 0,
        v.lpe ?? dayStart(addDays(day, 1)),
        v.rs ?? 0,
      ],
    );
  await acct("wsg-a1", D, { qs: 5, f: 1000, as: 990, ab: 7, ar: 1, ex: 2, qe: 5 }); // 1005 = 1005
  await acct("wsg-a2", D, { qs: 0, f: 1000, as: 990, qe: 0 }); // 10 lost
  await acct("wsg-b1", D, { qs: 0, f: 500, as: 450, qe: 0, rs: 1 }); // restart window
  await acct("wsg-b2", D, { qs: 0, f: 10, as: 5, qe: 0, lpe: new Date(end.getTime() - 3_600_000) }); // reports due
  await acct("wsg-c1", D3, { qs: 1, f: 9, as: 10, qe: 0 });
  await su.query(
    `INSERT INTO scf.durability_reports (day, subject, expected, observed, status) VALUES ($1::date, 'node:wsg-c1', 0, 0,
     'pending')`,
    [D3],
  );
});

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
  await ro?.pool.end();
  await new Promise((r) => prom?.close(r));
});

async function reports(day: string) {
  const r = await su.query<{
    subject: string;
    expected: string;
    observed: string;
    status: string;
    details: unknown;
  }>(
    `SELECT subject, expected, observed, status, details FROM scf.durability_reports
      WHERE day = $1::date AND (subject LIKE 'node:wsg-%' OR subject LIKE 'canary:%') ORDER BY subject`,
    [day],
  );
  return Object.fromEntries(
    r.rows.map((x) => [
      x.subject,
      { e: Number(x.expected), o: Number(x.observed), s: x.status, d: x.details },
    ]),
  );
}

describe("durability_reconcile", () => {
  it("balances every node and checks the canary counts; shortfalls inside 72 h stay pending", async () => {
    const cap = capture();
    promQueries = [];
    await runDurability(
      db,
      { canary: new PrometheusCanarySource(promUrl), umami: ro, canaryLagHours: 72 },
      cap.ctx({ now }),
    );
    const r = await reports(D);
    expect(r["node:wsg-a1"]).toMatchObject({ e: 1005, o: 1005, s: "balanced" });
    expect(r["node:wsg-a2"]).toMatchObject({ e: 1000, o: 990, s: "loss" });
    expect(r["node:wsg-b1"]).toMatchObject({ e: 500, o: 450, s: "unaccounted" });
    expect(r["node:wsg-b2"]).toMatchObject({ s: "pending" });
    expect(r["canary:mon-c"]).toMatchObject({ e: 3, o: 2, s: "pending" });
    expect(
      (r["canary:mon-c"]?.d as { hourly_differences?: unknown } | undefined)?.hourly_differences,
    ).toEqual({
      h05: -1,
    });
    expect(r["canary:probe-d"]).toMatchObject({ e: 1, o: 1, s: "balanced" });
    // The pending D-3 row was re-checked and is now balanced.
    expect((await reports(D3))["node:wsg-c1"]).toMatchObject({ e: 10, o: 10, s: "balanced" });
    expect(promQueries[0]?.get("query")).toBe(
      "sum by (source) (increase(scf_probe_canary_accepted_total[1h]))",
    );
    const m = cap.registry.render();
    expect(m).toContain('scf_durability_reports{kind="node",status="loss"} 1');
    expect(m).toContain('scf_durability_shortfall_records{kind="node"} 10');
    expect(m).toContain('scf_durability_reports{kind="canary",status="pending"} 1');
  });

  it("turns a settled canary shortfall into loss, is idempotent, and survives a dead Prometheus", async () => {
    const cap = capture();
    await runDurability(
      db,
      { canary: new PrometheusCanarySource(promUrl), umami: ro, canaryLagHours: 0 },
      cap.ctx({ now }),
    );
    await runDurability(
      db,
      { canary: new PrometheusCanarySource(promUrl), umami: ro, canaryLagHours: 0 },
      cap.ctx({ now }),
    );
    const r = await reports(D);
    expect(r["canary:mon-c"]).toMatchObject({ e: 3, o: 2, s: "loss" });
    expect(Object.keys(r).sort()).toEqual([
      "canary:mon-c",
      "canary:probe-d",
      "node:wsg-a1",
      "node:wsg-a2",
      "node:wsg-b1",
      "node:wsg-b2",
    ]);
    expect(cap.registry.render()).toContain('scf_durability_shortfall_records{kind="canary"} 1');

    const dead = new PrometheusCanarySource("http://127.0.0.1:56269", 2000);
    const cap2 = capture();
    await runDurability(db, { canary: dead, umami: ro, canaryLagHours: 0 }, cap2.ctx({ now }));
    expect(cap2.registry.render()).toContain('reason="canary_source_unavailable"');
    expect((await reports(D))["node:wsg-a1"]).toMatchObject({ s: "balanced" });
  });

  it("writes nothing a runtime role outside the job may read except SCF operators", async () => {
    // Policy check: scf_jobs under another job cannot write durability_reports (C-76 rows are the job's own).
    await expect(
      db.tx("trust_scoring", null, (tx) =>
        tx.exec(
          `INSERT INTO scf.durability_reports (day, subject, expected, observed, status)
           VALUES (current_date, $1, 0, 0, 'balanced')`,
          [`node:x${randomUUID().slice(0, 6)}`],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
