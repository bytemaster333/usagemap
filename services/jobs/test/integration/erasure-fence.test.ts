// SPDX-License-Identifier: Apache-2.0
// Acceptance (privacy.tenant-erasure, C-46): web_rollup never writes back a path that an erasure removed.
// The erasure side is played here exactly as the control plane's erasure worker must do it (the contract of
// ERASURE_FENCE_KEY_SQL): one scf transaction holding the tenant's fence EXCLUSIVE across the Umami delete and the scf
// delete. The rollup reads Umami and writes scf inside one transaction holding the fence SHARED.
//   1. The race of the audit: the rollup has read Umami (the path is still there) when the erasure starts. The erasure
//      waits for the rollup's transaction, then deletes; the path is gone at the end.
//   2. An erasure holding the fence makes the rollup defer that site-day (not a failure); the next run rolls it.

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb, UmamiDb } from "../../src/db.ts";
import { ERASURE_FENCE_KEY_SQL, runWebRollup } from "../../src/jobs/web-rollup.ts";
import { utcDay } from "../../src/schedule.ts";
import {
  capture,
  jobsDb,
  type SeededSite,
  seedSite,
  superClient,
  UA,
  UmamiApi,
  umamiRo,
} from "../support/harness.ts";

const SECRET = "/users/jane-doe";
let su: pg.Pool;
let um: pg.Pool;
let db: ScfDb;
let ro: UmamiDb;
let api: UmamiApi;
let site: SeededSite;
const DAY = utcDay(new Date());

beforeAll(async () => {
  su = superClient("scf");
  um = superClient("umami");
  db = jobsDb();
  ro = umamiRo();
  api = new UmamiApi();
  await api.login();
  site = await seedSite(su);
  await api.createWebsite(site.umamiId, "wsg fence");
});

afterAll(async () => {
  await su?.end();
  await um?.end();
  await db?.pool.end();
  await ro?.pool.end();
});

async function send(path: string, n: number): Promise<void> {
  await api.send({
    website: site.umamiId,
    surrogate: `2001:db8:fe::${n.toString(16)}`,
    country: "DE",
    ua: UA.chromeWin,
    at: new Date(`${DAY}T00:00:${String(n).padStart(2, "0")}Z`),
    url: path,
    tag: "v",
  });
}

async function pathRows(value: string): Promise<number> {
  const r = await su.query(
    `SELECT 1 FROM scf.web_daily_breakdowns
      WHERE site_id = $1 AND day = $2::date AND dimension = 'path' AND value = $3`,
    [site.siteId, DAY, value],
  );
  return r.rowCount ?? 0;
}

/** The erasure as the worker must run it: fence exclusive → Umami delete → scf delete → commit. */
async function erase(onLocked?: () => void): Promise<void> {
  const c = await su.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT pg_advisory_xact_lock(${ERASURE_FENCE_KEY_SQL})`, [site.tenantId]);
    onLocked?.();
    await um.query("DELETE FROM public.website_event WHERE website_id = $1 AND url_path = $2", [
      site.umamiId,
      SECRET,
    ]);
    await c.query(
      `DELETE FROM scf.web_daily_breakdowns WHERE site_id = $1 AND dimension = 'path' AND value = $2`,
      [site.siteId, SECRET],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

const only = () => ({ siteIds: [site.siteId], tasks: [{ day: DAY, final: false }] });

describe("erasure fence between web_rollup and erasure", () => {
  it("an erasure that starts after the rollup read Umami still ends with the path erased", async () => {
    await send("/", 1);
    await send(SECRET, 2);
    let erasure: Promise<void> | null = null;
    let lockedAt = 0;
    let rollupCommitted = 0;
    const cap = capture();
    await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", only(), {
      afterRead: async () => {
        // The rollup holds the Umami rows of the secret path in memory; the erasure starts now.
        erasure = erase(() => {
          lockedAt = Date.now();
        });
        // Give it every chance to run ahead (it must not: it waits for the fence).
        await new Promise((r) => setTimeout(r, 500));
        const waiting = await su.query(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        expect(waiting.rowCount).toBeGreaterThanOrEqual(1);
        expect(lockedAt).toBe(0);
        rollupCommitted = Date.now();
      },
    });
    await erasure;
    expect(lockedAt).toBeGreaterThanOrEqual(rollupCommitted);
    // the erasure ran after the rollup's write: the path is gone, and a later rollup does not bring it back
    expect(await pathRows(SECRET)).toBe(0);
    await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", only());
    expect(await pathRows(SECRET)).toBe(0);
    expect(await pathRows("/")).toBe(2); // the verified and the raw variant
  });

  it("a rollup that meets a running erasure defers the site-day, and the next run rolls it", async () => {
    await send("/later", 3);
    const c = await su.connect();
    const cap = capture();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT pg_advisory_xact_lock(${ERASURE_FENCE_KEY_SQL})`, [site.tenantId]);
      const r = await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", only());
      expect(r).toMatchObject({ siteDays: 0, failed: 0, deferred: 1 });
      expect(await pathRows("/later")).toBe(0);
      expect(cap.lines.some((l) => l.includes('"event":"rollup_site_day_deferred_erasure"'))).toBe(
        true,
      );
    } finally {
      await c.query("COMMIT");
      c.release();
    }
    const r2 = await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", only());
    expect(r2).toMatchObject({ siteDays: 1, deferred: 0 });
    expect(await pathRows("/later")).toBe(2);
  });
});
