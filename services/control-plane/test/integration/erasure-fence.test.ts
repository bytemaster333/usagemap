// SPDX-License-Identifier: Apache-2.0
// Erasure races on the real database (no Umami: the Umami side is a
// scripted eraser, so the races can be staged deterministically):
//   #9  the erasure fence against job web_rollup (src/erasure/fence.ts): the erasure holds the tenant's fence from
//       before its Umami delete until its scf delete commits; a rollup (shared fence) defers meanwhile, and one already
//       running finishes first and its rows are erased;
//   #15 a run abandoned and re-claimed by another core: the first worker's late completion or failure changes nothing
//       (owner token = started_at) and writes no audit row; a running erasure heartbeats its claim;
//   #16 a request without a selector covering sites or services must span whole UTC days;
//   #17 path and event-name selectors also erase scf.web_dev_events;
//   #18 a preview that keeps failing ends `failed` instead of re-running forever.

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Counts, zeroCounts } from "../../src/erasure/criteria.ts";
import { FENCE_TRY_SHARED_SQL } from "../../src/erasure/fence.ts";
import type { UmamiEraser, UmamiTarget } from "../../src/erasure/umami.ts";
import { ErasureWorker, PREVIEW_MAX_ATTEMPTS } from "../../src/erasure/worker.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

let h: Harness;
let owner = "";
let tenant = "";
let site = "";
let otherSite = "";

/** Policies the migrations add: job erasure erases dev events. */
const FENCE_POLICIES = `
DROP POLICY IF EXISTS jobs_select ON scf.web_dev_events;
CREATE POLICY jobs_select ON scf.web_dev_events FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['retention','tenant_purge','erasure']::text[]));
DROP POLICY IF EXISTS jobs_delete ON scf.web_dev_events;
CREATE POLICY jobs_delete ON scf.web_dev_events FOR DELETE TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['retention','tenant_purge','erasure']::text[]));`;

type EraseFn = (t: UmamiTarget, o?: { onBatch?: () => Promise<void> }) => Promise<Counts>;

function eraser(erase: EraseFn, preview?: () => Promise<Counts>): UmamiEraser {
  return {
    preview: preview ?? (async () => zeroCounts()),
    erase,
  } as unknown as UmamiEraser;
}

const quick: EraseFn = async () => ({ ...zeroCounts(), website_events: 7 });

function worker(e: UmamiEraser, heartbeatMs = 0): ErasureWorker {
  return new ErasureWorker(h.jobsDb, e, {
    intervalMs: 60_000,
    sweepDelayMs: 3_600_000,
    heartbeatMs,
  });
}

function gate() {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

async function create(body: unknown) {
  return call(h, {
    method: "POST",
    url: `/v1/tenants/${tenant}/erasure-requests`,
    cookie: owner,
    body,
  });
}

async function get(id: string) {
  return (
    await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/erasure-requests/${id}`,
      cookie: owner,
    })
  ).json();
}

/** Created, previewed and confirmed: ready for the execute step. */
async function confirmed(body: unknown): Promise<string> {
  const c = await create(body);
  expect(c.statusCode, c.body).toBe(202);
  const id = c.json().request_id as string;
  await worker(eraser(quick)).process(tenant, id);
  expect((await get(id)).status).toBe("previewed");
  const conf = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenant}/erasure-requests/${id}/confirm`,
    cookie: owner,
  });
  expect(conf.statusCode, conf.body).toBe(202);
  return id;
}

async function audits(id: string): Promise<string[]> {
  const r = await h.su.query<{ action: string }>(
    `SELECT action FROM scf.audit_log WHERE target_id = $1 ORDER BY seq`,
    [id],
  );
  return r.rows.map((x) => x.action);
}

const DAY_RANGE = { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" };

beforeAll(async () => {
  h = await startHarness();
  await h.su.query(FENCE_POLICIES);
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  for (const set of [(s: string) => (site = s), (s: string) => (otherSite = s)]) {
    const s = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/sites`,
      cookie: owner,
      body: { name: "S" },
    });
    expect(s.statusCode, s.body).toBe(201);
    set(s.json().site_id);
  }
});

afterAll(async () => {
  // Leave no work in the shared queue for later files (their workers' runOnce counts every due request).
  if (h && tenant)
    await h.su.query(
      `UPDATE scf.erasure_requests SET status = 'cancelled', finished_at = now()
        WHERE tenant_id = $1 AND status IN ('previewing', 'previewed', 'confirmed', 'running')`,
      [tenant],
    );
  await h?.close();
});

describe("#16 a request without a selector covers whole UTC days", () => {
  it("refuses a start or end that is not 00:00 UTC; accepts whole days and partial days with a selector", async () => {
    const s = await create({
      site_id: site,
      criteria: { start: "2026-10-01T10:00:00Z", end: "2026-10-02T00:00:00Z" },
    });
    expect(s.statusCode, s.body).toBe(400);
    expect(s.json().errors[0].pointer).toBe("/criteria/start");
    const e = await create({
      site_id: site,
      criteria: { start: "2026-10-01T00:00:00Z", end: "2026-10-01T11:00:00Z" },
    });
    expect(e.statusCode, e.body).toBe(400);
    expect(e.json().errors[0].pointer).toBe("/criteria/end");
    expect((await create({ site_id: site, criteria: DAY_RANGE })).statusCode).toBe(202);
    const sel = await create({
      site_id: site,
      criteria: {
        start: "2026-10-01T10:00:00Z",
        end: "2026-10-01T11:00:00Z",
        path_pattern: "/a/*",
      },
    });
    expect(sel.statusCode, sel.body).toBe(202);
  });
});

describe("#17 dev events", () => {
  it("path and event-name selectors erase the matching rows of scf.web_dev_events, nothing else", async () => {
    const add = (path: string, name: string, at: string, s = site) =>
      h.su.query(
        `INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict)
         VALUES ($1, $2, $3, 'custom', $4, $5, 'verified')`,
        [tenant, s, at, name, path],
      );
    const at = "2026-10-01T12:00:00Z";
    await add("/users/jane-doe", "click", at);
    await add("/home", "click", at);
    await add("/home", "signup", at);
    await add("/users/jane-doe", "click", "2026-10-03T12:00:00Z"); // outside the range
    await add("/users/jane-doe", "click", at, otherSite); // another site
    const rows = async () =>
      (
        await h.su.query<{ r: string }>(
          `SELECT site_id::text || ' ' || path_class || ' ' || event_name || ' ' || to_char(received_at AT TIME ZONE 'UTC', 'DD') AS r
             FROM scf.web_dev_events WHERE tenant_id = $1 ORDER BY 1`,
          [tenant],
        )
      ).rows
        .map((x) => x.r.replace(site, "S").replace(otherSite, "O"))
        .sort(); // site ids are random: order after the S/O labels
    const id = await confirmed({
      site_id: site,
      criteria: { ...DAY_RANGE, path_pattern: "/users/*" },
    });
    await worker(eraser(quick)).process(tenant, id);
    expect((await get(id)).status).toBe("completed");
    expect(await rows()).toEqual([
      "O /users/jane-doe click 01",
      "S /home click 01",
      "S /home signup 01",
      "S /users/jane-doe click 03",
    ]);
    const ev = await confirmed({ site_id: site, criteria: { ...DAY_RANGE, event_name: "signup" } });
    await worker(eraser(quick)).process(tenant, ev);
    expect(await rows()).toEqual([
      "O /users/jane-doe click 01",
      "S /home click 01",
      "S /users/jane-doe click 03",
    ]);
  });
});

describe("#18 a preview that keeps failing", () => {
  it(`ends failed with the error's failure code after ${PREVIEW_MAX_ATTEMPTS} attempts`, async () => {
    const c = await create({ site_id: site, criteria: DAY_RANGE });
    const id = c.json().request_id as string;
    const w = worker(
      eraser(quick, async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      }),
    );
    for (let i = 1; i < PREVIEW_MAX_ATTEMPTS; i++) {
      await w.process(tenant, id);
      expect((await get(id)).status).toBe("previewing");
    }
    await w.process(tenant, id);
    const r = await get(id);
    expect(r.status).toBe("failed");
    expect(r.failure_code).toBe("TIMEOUT");
    expect(await audits(id)).toEqual(["erasure.requested", "erasure.failed"]);
  });
});

describe("#15 owner token and heartbeat", () => {
  it("a re-claimed run: the first worker's late completion neither overwrites the result nor audits", async () => {
    const id = await confirmed({ site_id: site, criteria: DAY_RANGE });
    const g = gate();
    const entered = gate();
    const slow = worker(
      eraser(async () => {
        entered.open();
        await g.p;
        return { ...zeroCounts(), website_events: 3 };
      }),
    );
    const first = slow.process(tenant, id);
    await entered.p;
    // The first worker looks abandoned (no heartbeat for over the re-claim bound).
    await h.su.query(
      `UPDATE scf.erasure_requests SET started_at = now() - interval '2 hours' WHERE request_id = $1`,
      [id],
    );
    // The re-claim waits for the erasure fence the first (live) worker still holds …
    const second = worker(eraser(quick)).process(tenant, id);
    g.open();
    await first; // … which finds its claim taken over at completion, rolls back and releases the fence
    await second;
    expect((await get(id)).result.website_events).toBe(7);
    const after = await get(id);
    expect(after.status).toBe("completed");
    expect(after.result.website_events).toBe(7);
    expect(await audits(id)).toEqual([
      "erasure.requested",
      "erasure.confirmed",
      "erasure.completed",
    ]);
  });

  it("a re-claimed run: the first worker's late failure writes neither the failure nor an audit row", async () => {
    const id = await confirmed({ site_id: site, criteria: DAY_RANGE });
    const g = gate();
    const entered = gate();
    const slow = worker(
      eraser(async () => {
        entered.open();
        await g.p;
        throw Object.assign(new Error("gone"), { code: "ECONNRESET" });
      }),
    );
    const first = slow.process(tenant, id);
    await entered.p;
    await h.su.query(
      `UPDATE scf.erasure_requests SET started_at = now() - interval '2 hours' WHERE request_id = $1`,
      [id],
    );
    const second = worker(eraser(quick)).process(tenant, id); // waits for the first worker's fence
    g.open();
    await first;
    await second;
    const after = await get(id);
    expect(after.status).toBe("completed");
    expect(after.failure_code).toBeNull();
    expect((await audits(id)).filter((a) => a === "erasure.failed")).toEqual([]);
  });

  it("a running erasure renews its claim on every batch", async () => {
    const id = await confirmed({ site_id: site, criteria: DAY_RANGE });
    let renewed: Date | null = null;
    const startedAt = async () =>
      (
        await h.su.query<{ s: Date }>(
          `SELECT started_at AS s FROM scf.erasure_requests WHERE request_id = $1`,
          [id],
        )
      ).rows[0]?.s as Date;
    await worker(
      eraser(async (_t, o) => {
        await h.su.query(
          `UPDATE scf.erasure_requests SET started_at = now() - interval '50 minutes' WHERE request_id = $1`,
          [id],
        );
        // The worker's token is now stale: a heartbeat must not take over a claim that changed under it…
        await expect(o?.onBatch?.()).rejects.toThrow(/claim/);
        return zeroCounts();
      }),
    ).process(tenant, id);
    // …so the run stops without completing; the request is re-claimed later.
    expect((await get(id)).status).toBe("running");
    await h.su.query(
      `UPDATE scf.erasure_requests SET started_at = now() - interval '2 hours' WHERE request_id = $1`,
      [id],
    );
    await worker(
      eraser(async (_t, o) => {
        const before = await startedAt();
        await o?.onBatch?.();
        renewed = await startedAt();
        expect(renewed.getTime()).toBeGreaterThan(before.getTime());
        return zeroCounts();
      }),
    ).process(tenant, id);
    expect(renewed).not.toBeNull();
    expect((await get(id)).status).toBe("completed");
  });
});

describe("#9 the erasure fence against web_rollup", () => {
  /** What job web_rollup does per site-day: the fence shared, then read Umami and write, in one transaction. */
  const rollupFence = async (c: pg.PoolClient, t = tenant) =>
    (await c.query<{ ok: boolean }>(FENCE_TRY_SHARED_SQL, [t])).rows[0]?.ok;
  const addBreakdown = (c: pg.PoolClient | pg.Pool, value: string) =>
    c.query(
      `INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews)
       VALUES ($1, $2, '2026-10-01', 'raw', 'path', $3, 1, 3, 4)`,
      [tenant, site, value],
    );
  const paths = async () =>
    (
      await h.su.query<{ v: string }>(
        `SELECT value AS v FROM scf.web_daily_breakdowns
          WHERE tenant_id = $1 AND site_id = $2 AND day = '2026-10-01' AND dimension = 'path' ORDER BY 1`,
        [tenant, site],
      )
    ).rows.map((r) => r.v);

  it("a rollup starting while the erasure runs defers (fence taken); other tenants are not fenced", async () => {
    const id = await confirmed({ site_id: site, criteria: { ...DAY_RANGE, path_pattern: "/u/*" } });
    const g = gate();
    const entered = gate();
    const run = worker(
      eraser(async () => {
        entered.open();
        await g.p;
        return zeroCounts();
      }),
    ).process(tenant, id);
    await entered.p;
    const c = await h.su.connect();
    try {
      await c.query("BEGIN");
      expect(await rollupFence(c)).toBe(false); // held by the erasure during the Umami delete
      const other = await createTenant(h, owner);
      expect(await rollupFence(c, other)).toBe(true);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    g.open();
    await run;
    expect((await get(id)).status).toBe("completed");
    const c2 = await h.su.connect();
    try {
      await c2.query("BEGIN");
      expect(await rollupFence(c2)).toBe(true); // released at commit
      await c2.query("ROLLBACK");
    } finally {
      c2.release();
    }
  });

  it("a concurrent rollup cannot re-add an erased path: the erasure waits for it, then erases its rows", async () => {
    const id = await confirmed({
      site_id: site,
      criteria: { ...DAY_RANGE, path_pattern: "/race/*" },
    });
    // The rollup has read Umami before the erasure started (the path was still there) and is about to write.
    const rollup = await h.su.connect();
    let umamiEntered = false;
    try {
      await rollup.query("BEGIN");
      expect(await rollupFence(rollup)).toBe(true);
      const run = worker(
        eraser(async () => {
          umamiEntered = true;
          return { ...zeroCounts(), website_events: 1 };
        }),
      ).process(tenant, id);
      await new Promise((r) => setTimeout(r, 500));
      // The erasure has not started deleting in Umami: it waits for the rollup's transaction.
      expect(umamiEntered).toBe(false);
      expect((await get(id)).status).toBe("running");
      await addBreakdown(rollup, "/race/jane-doe");
      await addBreakdown(rollup, "/race-free");
      await rollup.query("COMMIT");
      await run;
      expect(umamiEntered).toBe(true);
      expect((await get(id)).status).toBe("completed");
      expect(await paths()).toContain("/race-free");
      expect(await paths()).not.toContain("/race/jane-doe");
    } finally {
      rollup.release();
    }
  });

  it("an Umami failure rolls the fenced transaction back, releases the fence and fails the request", async () => {
    const id = await confirmed({ site_id: site, criteria: { ...DAY_RANGE, path_pattern: "/f/*" } });
    await worker(
      eraser(async () => {
        throw Object.assign(new Error("boom"), { code: "57014" });
      }),
    ).process(tenant, id);
    expect((await get(id)).status).toBe("failed");
    const c = await h.su.connect();
    try {
      await c.query("BEGIN");
      expect(await rollupFence(c)).toBe(true);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});
