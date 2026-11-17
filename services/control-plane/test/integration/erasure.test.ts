// SPDX-License-Identifier: Apache-2.0
// Tenant-triggered erasure end to end (privacy.tenant-erasure, privacy.erasure-workflow; data-model §8.8, §16; docs/privacy/erasure.md §3): the API on
// the real database (scf_app through PgBouncer), job `erasure` as scf_jobs against a REAL `umami` database migrated by
// the pinned Umami image, with our roles from db/umami/scf_ro.sql — the job deletes as scf_umami_maint exactly as in
// production. Exact deletions are asserted row by row, including that another tenant's websites and rows are untouched,
// and that no audit row ever carries a literal selector (C-88).
//
// Umami database: compose project `scf-wsf-c-umami` (test/support/erasure/compose.yaml), host port 56152
// (SCF_WSF_C_UMAMI_PORT); SCF_WSF_C_UMAMI_REUSE=1 uses a running one; KEEP=1 leaves it running.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startErasureWorker, umamiMaintPool } from "../../src/erasure/start.ts";
import { UmamiEraser } from "../../src/erasure/umami.ts";
import { ErasureWorker } from "../../src/erasure/worker.ts";
import { loadWorkerConfig, type WorkerConfig } from "../../src/workers/config.ts";
import {
  ageSession,
  call,
  createTenant,
  type Harness,
  newGithubUser,
  operatorSession,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const UMAMI_PORT = process.env.SCF_WSF_C_UMAMI_PORT ?? "56152";
const UMAMI_PGB_PORT = process.env.SCF_WSF_C_UMAMI_PGB_PORT ?? "56153";
const UMAMI_PROJECT = process.env.SCF_WSF_C_UMAMI_PROJECT ?? "scf-wsf-c-umami";
const composeFile = join(import.meta.dirname, "..", "support", "erasure", "compose.yaml");
const reuse = process.env.SCF_WSF_C_UMAMI_REUSE === "1";

function dc(args: string[]): void {
  execFileSync("docker", ["compose", "-p", UMAMI_PROJECT, "-f", composeFile, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      SCF_WSF_C_UMAMI_PORT: UMAMI_PORT,
      SCF_WSF_C_UMAMI_PGB_PORT: UMAMI_PGB_PORT,
    },
  });
}

let h: Harness;
let umamiSu: pg.Pool;
let maint: pg.Pool;
let worker: ErasureWorker;
let clock = Date.now();
const SWEEP_MS = 72 * 3_600_000;

let owner = "";
let adminCookie = "";
let memberCookie = "";
let tenantA = "";
let tenantB = "";
let ownerB = "";
let siteA = "";
let siteB = "";
let webA = { main: "", twin: "" };
let webB = { main: "", twin: "" };
let serviceA = "";
let serviceB = "";

const IN = "2026-09-14T10:00:00Z";
const RANGE = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" };

async function addEvent(
  website: string,
  session: string,
  path: string,
  at: string,
  name: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await umamiSu.query(
    `INSERT INTO session (session_id, website_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [session, website, at],
  );
  await umamiSu.query(
    `INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, event_name, tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'v')`,
    [id, website, session, randomUUID(), at, path, name ? 2 : 1, name],
  );
  return id;
}

async function addData(website: string, event: string, key: string, at: string): Promise<void> {
  await umamiSu.query(
    `INSERT INTO event_data (event_data_id, website_id, website_event_id, data_key, string_value, data_type, created_at)
     VALUES ($1, $2, $3, $4, 'v', 1, $5)`,
    [randomUUID(), website, event, key, at],
  );
}

/** The row Umami 3.5.0's saveEvent writes for event data with a numeric `revenue` and a `currency`. */
async function addRevenue(website: string, session: string, event: string, at: string) {
  await umamiSu.query(
    `INSERT INTO revenue (revenue_id, website_id, session_id, event_id, event_name, currency, revenue, created_at)
     VALUES ($1, $2, $3, $4, 'purchase', 'EUR', 12.5, $5)`,
    [randomUUID(), website, session, event, at],
  );
}

async function eventsOf(website: string): Promise<string[]> {
  return (
    await umamiSu.query<{ p: string }>(
      `SELECT url_path || coalesce('#' || event_name, '') AS p FROM website_event WHERE website_id = $1 ORDER BY 1`,
      [website],
    )
  ).rows.map((r) => r.p);
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await umamiSu.query(sql, params)).rows[0]?.n);
}

async function addBreakdown(
  tenant: string,
  site: string,
  day: string,
  dimension: "path" | "event" | "country",
  value: string,
): Promise<void> {
  await h.su.query(
    `INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews, events)
     VALUES ($1, $2, $3, 'raw', $4, $5, 1, 3, 4, $6)`,
    [tenant, site, day, dimension, value, dimension === "event" ? 5 : null],
  );
}

async function breakdowns(site: string): Promise<string[]> {
  return (
    await h.su.query<{ v: string }>(
      `SELECT day::text || ' ' || dimension || ' ' || value AS v FROM scf.web_daily_breakdowns WHERE site_id = $1 ORDER BY 1`,
      [site],
    )
  ).rows.map((r) => r.v);
}

/** One service with routes and one metric row per resolution and route (current partitions). */
async function addService(tenant: string, name: string, routes: string[]): Promise<string> {
  const service = (
    await h.su.query<{ id: string }>(
      `INSERT INTO scf.api_services (tenant_id, service_name, registration) VALUES ($1, $2, 'auto') RETURNING service_id::text AS id`,
      [tenant, name],
    )
  ).rows[0]?.id as string;
  const group = (
    await h.su.query<{ id: string }>(
      `INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
       VALUES ($1, $2, 'sdk_stable', 'http.server.request.duration', 's', '1|100|s') RETURNING group_id::text AS id`,
      [tenant, service],
    )
  ).rows[0]?.id;
  for (const route of routes) {
    const rid = (
      await h.su.query<{ id: string }>(
        `INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rules_version)
         VALUES ($1, $2, $3, '/', 'scf-path-rules/1.0.0') RETURNING route_id::text AS id`,
        [tenant, service, route],
      )
    ).rows[0]?.id;
    for (const [table, trunc] of [
      ["api_metrics_1m", "minute"],
      ["api_metrics_1h", "hour"],
      ["api_metrics_1d", "day"],
    ] as const) {
      await h.su.query(
        `INSERT INTO scf.${table} (tenant_id, service_id, route_id, method, status_code, source, stream_group_id,
                                   bucket_start, request_count, duration_sum, hist_kind, hist)
         VALUES ($1, $2, $3, 1, 200, 'sdk_metric', $4, date_trunc('${trunc}', now(), 'UTC'), 5, 0.5, 'explicit15',
                 array_fill(0, ARRAY[15]))`,
        [tenant, service, rid, group],
      );
    }
  }
  return service;
}

async function routesOf(service: string): Promise<string[]> {
  return (
    await h.su.query<{ route: string }>(
      `SELECT route FROM scf.api_routes WHERE service_id = $1 ORDER BY route`,
      [service],
    )
  ).rows.map((r) => r.route);
}

async function metricRows(service: string): Promise<number> {
  const r = await h.su.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM scf.api_metrics_1m WHERE service_id = $1) + (SELECT count(*) FROM scf.api_metrics_1h
      WHERE service_id = $1) + (SELECT count(*) FROM scf.api_metrics_1d WHERE service_id = $1) AS n`,
    [service],
  );
  return Number(r.rows[0]?.n);
}

async function create(cookie: string, tenant: string, body: unknown) {
  return call(h, { method: "POST", url: `/v1/tenants/${tenant}/erasure-requests`, cookie, body });
}

async function get(tenant: string, id: string, cookie = owner) {
  return call(h, { method: "GET", url: `/v1/tenants/${tenant}/erasure-requests/${id}`, cookie });
}

async function confirm(tenant: string, id: string, cookie = owner) {
  return call(h, {
    method: "POST",
    url: `/v1/tenants/${tenant}/erasure-requests/${id}/confirm`,
    cookie,
  });
}

/** Creates, previews (job), confirms and runs (job) a request; returns the final view. */
async function runToEnd(tenant: string, body: unknown, cookie = owner) {
  const c = await create(cookie, tenant, body);
  expect(c.statusCode, c.body).toBe(202);
  const id = c.json().request_id as string;
  await worker.runOnce();
  const previewed = (await get(tenant, id, cookie)).json();
  expect(previewed.status).toBe("previewed");
  const conf = await confirm(tenant, id, cookie);
  expect(conf.statusCode, conf.body).toBe(202);
  expect(conf.json().status).toBe("confirmed");
  await worker.runOnce();
  const done = (await get(tenant, id, cookie)).json();
  return { id, preview: previewed.preview, done };
}

beforeAll(async () => {
  if (!reuse) {
    dc(["down", "-v", "--remove-orphans"]);
    dc(["up", "-d", "--wait", "db", "pgbouncer"]);
    dc(["--profile", "tools", "run", "--rm", "umami-migrate"]);
    dc(["--profile", "tools", "run", "--rm", "views"]);
  }
  umamiSu = new pg.Pool({
    connectionString: `postgres://postgres:wsfc-test-super@127.0.0.1:${UMAMI_PORT}/umami`,
    max: 2,
  });
  // scf_umami_maint's privileges on Umami's `revenue` table, as db/umami/scf_ro.sql grants them
  // once the database workstream has added them; idempotent.
  await umamiSu.query(`GRANT DELETE ON public.revenue TO scf_umami_maint`);
  await umamiSu.query(
    `GRANT SELECT (revenue_id, website_id, session_id, event_id, created_at) ON public.revenue TO scf_umami_maint`,
  );
  // A reused database starts empty too.
  await umamiSu.query(
    `TRUNCATE website_event, event_data, revenue, session, session_data, session_link`,
  );
  // Through PgBouncer (transaction mode) with the production pool settings (C-115, C-119).
  maint = umamiMaintPool(
    `postgres://scf_umami_maint:wsfc-test-umami-maint@127.0.0.1:${UMAMI_PGB_PORT}/umami`,
  );
  h = await startHarness();
  worker = new ErasureWorker(h.jobsDb, new UmamiEraser(maint, { batchSize: 2 }), {
    intervalMs: 60_000,
    sweepDelayMs: SWEEP_MS,
    now: () => clock,
  });

  owner = await signInGithub(h, newGithubUser());
  tenantA = await createTenant(h, owner);
  for (const [role, set] of [
    ["admin", (c: string) => (adminCookie = c)],
    ["member", (c: string) => (memberCookie = c)],
  ] as const) {
    const inv = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${tenantA}/invitations`,
        cookie: owner,
        body: { role },
      })
    ).json();
    const c = await signInGithub(h, newGithubUser());
    await call(h, {
      method: "POST",
      url: "/v1/invitations/accept",
      cookie: c,
      body: { code: inv.code },
    });
    set(c);
  }
  ownerB = await signInGithub(h, newGithubUser());
  tenantB = await createTenant(h, ownerB);
  for (const [t, c, setter] of [
    [tenantA, owner, (id: string) => (siteA = id)],
    [tenantB, ownerB, (id: string) => (siteB = id)],
  ] as const) {
    const s = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/sites`,
      cookie: c,
      body: { name: "S" },
    });
    setter(s.json().site_id);
  }
  const web = async (site: string) => {
    // The twin website (events without a visitor id, C-73) as umami_reconcile would have provisioned it.
    const r = (
      await h.su.query<{ main: string; twin: string }>(
        `UPDATE scf.sites SET umami_twin_website_id = COALESCE(umami_twin_website_id, gen_random_uuid()),
                twin_provisioned_at = COALESCE(twin_provisioned_at, now())
          WHERE site_id = $1 RETURNING umami_website_id::text AS main, umami_twin_website_id::text AS twin`,
        [site],
      )
    ).rows[0];
    return { main: r?.main as string, twin: r?.twin as string };
  };
  webA = await web(siteA);
  webB = await web(siteB);
  serviceA = await addService(tenantA, "svc-a", [
    "/users/{id}/jane-doe",
    "/users/{id}/jane-doe/posts",
    "/health",
  ]);
  serviceB = await addService(tenantB, "svc-b", ["/users/{id}/jane-doe", "/health"]);
});

afterAll(async () => {
  await h?.close();
  await maint?.end();
  await umamiSu?.end();
  if (!reuse && process.env.KEEP !== "1") dc(["down", "-v", "--remove-orphans"]);
});

describe("erasure by path pattern on a site", () => {
  let id = "";
  const s1 = randomUUID(); // only Jane's pages → orphaned and deleted
  const s2 = randomUUID(); // Jane's page and the home page → kept
  const s3 = randomUUID(); // twin website (no visitor id)

  it("previews the exact counts, deletes exactly the matching rows of the tenant's main and twin websites", async () => {
    const e1 = await addEvent(webA.main, s1, "/users/jane-doe/profile", IN);
    await addEvent(webA.main, s1, "/users/jane-doe", "2026-09-15T08:00:00Z");
    await addData(webA.main, e1, "plan", IN);
    await addData(webA.main, e1, "seats", IN);
    await addEvent(webA.main, s2, "/users/jane-doe/x", IN);
    await addEvent(webA.main, s2, "/home", IN);
    await addEvent(webA.main, randomUUID(), "/users/jane-doe/old", "2026-08-31T23:59:59Z"); // before the range
    await addEvent(webA.main, randomUUID(), "/users/jane-doe/late", "2026-10-01T00:00:00Z"); // end is exclusive
    await addEvent(webA.main, randomUUID(), "/users/jane_doe", IN); // `_` is literal, not a wildcard
    await addEvent(webA.twin, s3, "/users/jane-doe/z", "2026-09-20T00:00:00Z");
    // Another tenant with the very same paths: untouched.
    const eb = await addEvent(webB.main, randomUUID(), "/users/jane-doe/profile", IN);
    await addData(webB.main, eb, "plan", IN);
    await addBreakdown(tenantA, siteA, "2026-09-14", "path", "/users/jane-doe/profile");
    await addBreakdown(tenantA, siteA, "2026-09-14", "path", "/home");
    await addBreakdown(tenantA, siteA, "2026-08-31", "path", "/users/jane-doe/old");
    await addBreakdown(tenantA, siteA, "2026-09-14", "country", "DE");
    await addBreakdown(tenantB, siteB, "2026-09-14", "path", "/users/jane-doe/profile");

    const c = await create(adminCookie, tenantA, {
      site_id: siteA,
      criteria: { ...RANGE, path_pattern: "/users/jane-doe*" },
    });
    expect(c.statusCode, c.body).toBe(202);
    const created = c.json();
    id = created.request_id;
    expect(created).toMatchObject({
      status: "previewing",
      scope: "filtered",
      site_id: siteA,
      service_id: null,
      selector: { type: "path_pattern", length: 16 },
      selector_redacted_at: null,
      criteria: {
        ...RANGE,
        path_pattern: "/users/jane-doe*",
        event_name: null,
        property_key: null,
      },
      preview: null,
      result: null,
      spool_sweep: null,
    });

    expect(await worker.runOnce()).toBe(1);
    const p = (await get(tenantA, id)).json();
    expect(p.status).toBe("previewed");
    expect(p.preview).toEqual({
      website_events: 4,
      event_data_rows: 2,
      sessions_orphaned: 2, // s1 and s3
      breakdown_rows: 1,
      api_routes: 0,
      api_metric_rows: 0,
      aggregate_days: ["2026-09-14", "2026-09-15", "2026-09-20"],
    });
    // The preview changed nothing.
    expect(await eventsOf(webA.main)).toHaveLength(7);

    // Member cannot confirm (owner/admin only); an admin with a stale sign-in must sign in again (C-87).
    expect((await confirm(tenantA, id, memberCookie)).statusCode).toBe(403);
    await ageSession(h, adminCookie, 11);
    const stale = await confirm(tenantA, id, adminCookie);
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe("recent_auth_required");

    const conf = await confirm(tenantA, id, owner);
    expect(conf.statusCode, conf.body).toBe(202);
    expect(conf.json().confirmed_at).not.toBeNull();
    // A second confirmation is a conflict.
    expect((await confirm(tenantA, id, owner)).statusCode).toBe(409);

    expect(await worker.runOnce()).toBe(1);
    const done = (await get(tenantA, id)).json();
    expect(done.status).toBe("completed");
    expect(done.result).toEqual(p.preview);
    expect(done.failure_code).toBeNull();
    const clearBy = new Date(Date.parse(done.completed_at) + 56 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(done.backup_expiry_note).toBe(
      `Erased data leaves all backups within 56 days (by ${clearBy}).`,
    );
    expect(done.spool_sweep).toEqual({
      due_at: new Date(clock + SWEEP_MS).toISOString(),
      done_at: null,
      counts: null,
      skipped: null,
    });

    expect(await eventsOf(webA.main)).toEqual([
      "/home",
      "/users/jane-doe/late",
      "/users/jane-doe/old",
      "/users/jane_doe",
    ]);
    expect(await eventsOf(webA.twin)).toEqual([]);
    expect(
      await count(`SELECT count(*) AS n FROM event_data WHERE website_id = $1`, [webA.main]),
    ).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM session WHERE session_id = ANY ($1::uuid[])`, [
        [s1, s3],
      ]),
    ).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM session WHERE session_id = $1`, [s2])).toBe(1);
    expect(await eventsOf(webB.main)).toEqual(["/users/jane-doe/profile"]);
    expect(
      await count(`SELECT count(*) AS n FROM event_data WHERE website_id = $1`, [webB.main]),
    ).toBe(1);
    expect(await breakdowns(siteA)).toEqual([
      "2026-08-31 path /users/jane-doe/old",
      "2026-09-14 country DE",
      "2026-09-14 path /home",
    ]);
    expect(await breakdowns(siteB)).toEqual(["2026-09-14 path /users/jane-doe/profile"]);
  });

  it("writes erasure.requested / confirmed / completed with the selector type and counts — never the literal", async () => {
    const rows = (
      await h.su.query<{ action: string; actor_kind: string; details: Record<string, unknown> }>(
        `SELECT action, actor_kind, details FROM scf.audit_log WHERE target_id = $1 ORDER BY occurred_at, seq`,
        [id],
      )
    ).rows;
    expect(rows.map((r) => r.action)).toEqual([
      "erasure.requested",
      "erasure.confirmed",
      "erasure.completed",
    ]);
    expect(rows[2]?.actor_kind).toBe("job");
    for (const r of rows) {
      expect(r.details).toMatchObject({
        request_id: id,
        scope: "filtered",
        selector_type: "path_pattern",
      });
    }
    expect(rows[2]?.details.counts).toMatchObject({ website_events: 4, breakdown_rows: 1 });
    const all = await h.su.query<{ n: string }>(
      `SELECT count(*) AS n FROM scf.audit_log WHERE action LIKE 'erasure.%' AND details::text ~ 'jane|users/'`,
    );
    expect(Number(all.rows[0]?.n)).toBe(0);
  });

  it("re-applies the selectors as the spool sweep 72 h later and records it", async () => {
    // An event that was still on an edge spool during the run arrives later.
    await addEvent(webA.main, randomUUID(), "/users/jane-doe/from-spool", "2026-09-16T00:00:00Z");
    expect(await worker.runOnce()).toBe(0); // not due yet
    // 72 h later, after a restart: a new worker finds the due sweep in the queue (migration 0056, C-119).
    clock += SWEEP_MS + 1000;
    await h.su.query(
      `UPDATE scf.erasure_requests
          SET result = jsonb_set(result, '{spool_sweep,due_at}', to_jsonb((now() - interval '1 second')::text))
        WHERE request_id = $1`,
      [id],
    );
    const restarted = new ErasureWorker(h.jobsDb, new UmamiEraser(maint, { batchSize: 2 }), {
      intervalMs: 60_000,
      sweepDelayMs: SWEEP_MS,
      now: () => clock,
    });
    expect(await restarted.runOnce()).toBe(1);
    const v = (await get(tenantA, id)).json();
    expect(v.spool_sweep.done_at).not.toBeNull();
    expect(v.spool_sweep.counts).toMatchObject({ website_events: 1, sessions_orphaned: 1 });
    expect(v.result.website_events).toBe(4); // the run's own report is unchanged
    expect(await eventsOf(webA.main)).not.toContain("/users/jane-doe/from-spool");
    expect(await worker.process(tenantA, id)).toBe(false); // done once
  });

  it("renders a redacted request (jobs service, C-88/C-112) without the literal and skips a later sweep", async () => {
    await h.su.query(
      `UPDATE scf.erasure_requests SET finished_at = now() - interval '57 days', completed_at = now() - interval '57 days'
        WHERE request_id = $1`,
      [id],
    );
    const redacted = await h.jobsDb.tx(
      { tenantId: tenantA, actorKind: "job", actorId: "retention", job: "retention" },
      (tx) => tx.one<{ n: number }>(`SELECT scf.erasure_redact_selectors() AS n`),
    );
    expect(Number(redacted.n)).toBe(1);
    const v = (await get(tenantA, id)).json();
    expect(v.selector_redacted_at).not.toBeNull();
    expect(v.selector).toEqual({ type: "path_pattern", length: 16 });
    expect(v.criteria).toEqual({
      ...RANGE,
      path_pattern: null,
      event_name: null,
      property_key: null,
    });
    expect(JSON.stringify(v)).not.toContain("jane");
    const list = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenantA}/erasure-requests`,
        cookie: owner,
      })
    ).json();
    expect(JSON.stringify(list)).not.toContain("jane");
    // A sweep still pending when the selector is redacted cannot run any more: it is recorded as skipped.
    await h.su.query(
      `UPDATE scf.erasure_requests
          SET result = jsonb_set(result, '{spool_sweep}', jsonb_build_object('due_at', now() - interval '1 day'))
        WHERE request_id = $1`,
      [id],
    );
    expect(await worker.process(tenantA, id)).toBe(false);
    const after = (await get(tenantA, id)).json();
    expect(after.spool_sweep.skipped).toBe("selector_redacted");
    expect(after.spool_sweep.done_at).not.toBeNull();
  });
});

describe("other selectors and scopes", () => {
  it("event name: deletes the events of that name and their properties only", async () => {
    const s = randomUUID();
    const e = await addEvent(webA.main, s, "/checkout", IN, "jane-signup");
    await addData(webA.main, e, "email_hash", IN);
    await addEvent(webA.main, s, "/checkout", IN, "other");
    await addBreakdown(tenantA, siteA, "2026-09-14", "event", "jane-signup");
    await addBreakdown(tenantA, siteA, "2026-09-14", "event", "other");
    const r = await runToEnd(tenantA, {
      site_id: siteA,
      criteria: { ...RANGE, event_name: "jane-signup" },
    });
    expect(r.done.result).toMatchObject({
      website_events: 1,
      event_data_rows: 1,
      sessions_orphaned: 0,
      breakdown_rows: 1,
    });
    expect(await eventsOf(webA.main)).toContain("/checkout#other");
    expect(await eventsOf(webA.main)).not.toContain("/checkout#jane-signup");
    expect(await breakdowns(siteA)).toContain("2026-09-14 event other");
  });

  it("Umami's revenue rows go with their event, and with a revenue/currency property key", async () => {
    const at = "2026-09-22T12:00:00Z";
    const s1 = randomUUID();
    const e1 = await addEvent(webA.main, s1, "/pay/jane", at, "purchase");
    await addData(webA.main, e1, "revenue", at);
    await addData(webA.main, e1, "currency", at);
    await addRevenue(webA.main, s1, e1, at);
    const s2 = randomUUID();
    const e2 = await addEvent(webA.main, s2, "/pay/other", at, "purchase");
    await addRevenue(webA.main, s2, e2, at);
    const eb = await addEvent(webB.main, randomUUID(), "/pay/jane", at, "purchase");
    await addRevenue(webB.main, randomUUID(), eb, at);
    const revenueOf = (e: string) =>
      count(`SELECT count(*) AS n FROM revenue WHERE event_id = $1`, [e]);
    const byPath = await runToEnd(tenantA, {
      site_id: siteA,
      criteria: { ...RANGE, path_pattern: "/pay/jane" },
    });
    // 2 event_data rows + 1 revenue row
    expect(byPath.preview).toMatchObject({ website_events: 1, event_data_rows: 3 });
    expect(byPath.done.result).toMatchObject({ website_events: 1, event_data_rows: 3 });
    expect(await revenueOf(e1)).toBe(0);
    expect(await revenueOf(e2)).toBe(1);
    expect(await revenueOf(eb)).toBe(1);
    const byKey = await runToEnd(tenantA, {
      site_id: siteA,
      criteria: { ...RANGE, property_key: "currency" },
    });
    expect(byKey.done.result).toMatchObject({ website_events: 0, event_data_rows: 1 });
    expect(await revenueOf(e2)).toBe(0);
    expect(await revenueOf(eb)).toBe(1);
    expect(await eventsOf(webA.main)).toContain("/pay/other#purchase");
  });

  it("property key: deletes only event_data rows with that key, events stay", async () => {
    const e = await addEvent(webA.main, randomUUID(), "/form", "2026-09-21T12:00:00Z", "submit");
    await addData(webA.main, e, "full_name", "2026-09-21T12:00:00Z");
    await addData(webA.main, e, "plan", "2026-09-21T12:00:00Z");
    const eb = await addEvent(webB.main, randomUUID(), "/form", "2026-09-21T12:00:00Z", "submit");
    await addData(webB.main, eb, "full_name", "2026-09-21T12:00:00Z");
    const r = await runToEnd(tenantA, {
      scope: "site",
      site_id: siteA,
      criteria: { ...RANGE, property_key: "full_name" },
    });
    expect(r.preview).toMatchObject({
      event_data_rows: 1,
      website_events: 0,
      aggregate_days: ["2026-09-21"],
    });
    expect(r.done.result).toMatchObject({ event_data_rows: 1, website_events: 0 });
    expect(
      await count(`SELECT count(*) AS n FROM event_data WHERE website_event_id = $1`, [e]),
    ).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM event_data WHERE website_event_id = $1`, [eb]),
    ).toBe(1);
    expect(await eventsOf(webA.main)).toContain("/form#submit");
  });

  it("API service: every matching route goes with all its metric rows; other routes and tenants stay (C-46)", async () => {
    expect(await metricRows(serviceA)).toBe(9);
    const r = await runToEnd(tenantA, {
      service_id: serviceA,
      criteria: { ...RANGE, path_pattern: "/users/*/jane-doe*" },
    });
    expect(r.preview).toMatchObject({ api_routes: 2, api_metric_rows: 6, website_events: 0 });
    expect(r.done.result).toEqual(r.preview);
    expect(await routesOf(serviceA)).toEqual(["/health"]);
    expect(await metricRows(serviceA)).toBe(3);
    expect(await routesOf(serviceB)).toEqual(["/health", "/users/{id}/jane-doe"]);
    expect(await metricRows(serviceB)).toBe(6);
  });

  it("tenant scope without a selector: everything of the range in every site and service of the tenant", async () => {
    await addEvent(webA.main, randomUUID(), "/a", "2026-07-02T00:00:00Z");
    await addEvent(webA.twin, randomUUID(), "/b", "2026-07-02T05:00:00Z");
    await addEvent(webA.main, randomUUID(), "/c", "2026-07-03T00:00:00Z"); // outside
    await addEvent(webB.main, randomUUID(), "/a", "2026-07-02T00:00:00Z");
    await addBreakdown(tenantA, siteA, "2026-07-02", "country", "FR");
    const r = await runToEnd(tenantA, {
      scope: "tenant",
      criteria: { start: "2026-07-02T00:00:00Z", end: "2026-07-03T00:00:00Z" },
    });
    expect(r.done.result).toMatchObject({
      website_events: 2,
      sessions_orphaned: 2,
      breakdown_rows: 1,
      api_metric_rows: 0,
    });
    expect(await eventsOf(webA.main)).toContain("/c");
    expect(await eventsOf(webA.main)).not.toContain("/a");
    expect(await eventsOf(webB.main)).toContain("/a");
  });
});

describe("request validation, isolation and lifecycle", () => {
  it("refuses invalid criteria and combinations", async () => {
    const bad: unknown[] = [
      { site_id: siteA, criteria: { ...RANGE, path_pattern: "/a*", event_name: "x" } }, // two selectors
      { site_id: siteA, criteria: { start: RANGE.end, end: RANGE.start } }, // empty range (C-86)
      { site_id: siteA, criteria: { start: "2026-09-01T00:00:00+02:00", end: RANGE.end } }, // not UTC
      { site_id: siteA, criteria: { ...RANGE, path_pattern: "users/*" } }, // not absolute
      { service_id: serviceA, criteria: { ...RANGE, property_key: "email" } }, // property keys: sites only
      { service_id: serviceA, criteria: { ...RANGE, event_name: "signup" } }, // services have no event names
      { scope: "tenant", site_id: siteA, criteria: RANGE },
      { site_id: siteA, service_id: serviceA, criteria: RANGE },
      { criteria: RANGE }, // filtered needs a site or a service
    ];
    for (const b of bad) {
      const r = await create(owner, tenantA, b);
      expect(r.statusCode, JSON.stringify(b)).toBe(400);
    }
  });

  it("another tenant's or an unknown site/service id is the same 404 (C-87); members and viewers are refused", async () => {
    for (const b of [
      { site_id: siteB, criteria: RANGE },
      { site_id: randomUUID(), criteria: RANGE },
      { service_id: serviceB, criteria: RANGE },
      { service_id: randomUUID(), criteria: RANGE },
    ]) {
      const r = await create(owner, tenantA, b);
      expect(r.statusCode).toBe(404);
      expect(r.json().code).toBe("not_found");
    }
    expect(
      (await create(memberCookie, tenantA, { site_id: siteA, criteria: RANGE })).statusCode,
    ).toBe(403);
    // A request id of another tenant is a 404 for every request operation.
    const other = (await create(ownerB, tenantB, { site_id: siteB, criteria: RANGE })).json()
      .request_id;
    for (const [m, suffix] of [
      ["GET", ""],
      ["POST", "/confirm"],
      ["POST", "/cancel"],
    ] as const) {
      const r = await call(h, {
        method: m,
        url: `/v1/tenants/${tenantA}/erasure-requests/${other}${suffix}`,
        cookie: owner,
      });
      expect(r.statusCode, `${m} ${suffix}`).toBe(404);
    }
    expect((await get(tenantB, other, ownerB)).json().status).toBe("previewing");
  });

  it("cancels before confirmation only; confirming a request still previewing is a conflict", async () => {
    const id = (await create(owner, tenantA, { site_id: siteA, criteria: RANGE })).json()
      .request_id;
    expect((await confirm(tenantA, id)).statusCode).toBe(409);
    const c = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenantA}/erasure-requests/${id}/cancel`,
      cookie: owner,
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().status).toBe("cancelled");
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${tenantA}/erasure-requests/${id}/cancel`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(409);
    await worker.runOnce(); // a cancelled request is never previewed or run
    expect((await get(tenantA, id)).json().status).toBe("cancelled");
  });

  it("lists the tenant's requests newest first with a cursor", async () => {
    const first = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenantA}/erasure-requests?limit=2`,
        cookie: owner,
      })
    ).json();
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenantA}/erasure-requests?limit=200&cursor=${first.next_cursor}`,
        cookie: owner,
      })
    ).json();
    const ids = [...first.items, ...second.items].map((x: { request_id: string }) => x.request_id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      (
        await call(h, {
          method: "GET",
          url: `/v1/tenants/${tenantA}/erasure-requests?cursor=bm9wZQ`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("an unreachable umami database fails the run with UMAMI_UNAVAILABLE and audit erasure.failed", async () => {
    const dead = new pg.Pool({
      connectionString: "postgres://scf_umami_maint:x@127.0.0.1:56157/umami",
      connectionTimeoutMillis: 1000,
    });
    dead.on("error", () => {});
    const offline = new ErasureWorker(h.jobsDb, new UmamiEraser(dead), {
      intervalMs: 60_000,
      sweepDelayMs: SWEEP_MS,
    });
    const id = (await create(owner, tenantA, { site_id: siteA, criteria: RANGE })).json()
      .request_id;
    await worker.runOnce(); // preview with the working database
    expect((await confirm(tenantA, id)).statusCode).toBe(202);
    await offline.runOnce();
    const v = (await get(tenantA, id)).json();
    expect(v.status).toBe("failed");
    expect(v.failure_code).toBe("UMAMI_UNAVAILABLE");
    const a = await h.su.query(
      `SELECT outcome FROM scf.audit_log WHERE target_id = $1 AND action = 'erasure.failed'`,
      [id],
    );
    expect(a.rows[0]?.outcome).toBe("failure");
    await dead.end();
  });

  it("the job (in the jobs service, F16) starts only with both connections configured", async () => {
    const base = { SCF_JOBS_DATABASE_URL: "postgres://x@127.0.0.1:1/scf" };
    const log = { warn: () => {}, info: () => {}, error: () => {} };
    expect(startErasureWorker(loadWorkerConfig(base) as WorkerConfig, log)).toBeUndefined();
    const runner = startErasureWorker(
      loadWorkerConfig({
        ...base,
        SCF_UMAMI_MAINT_URL: "postgres://x@127.0.0.1:1/umami",
      }) as WorkerConfig,
      log,
    );
    expect(runner).toBeDefined();
    await runner?.stop();
  });
});

describe("erasure through PgBouncer (C-119)", () => {
  it("PgBouncer refuses statement_timeout as a startup parameter; the job's pool sets it per transaction instead", async () => {
    const url = `postgres://scf_umami_maint:wsfc-test-umami-maint@127.0.0.1:${UMAMI_PGB_PORT}/umami`;
    const old = new pg.Pool({ connectionString: url, max: 1, statement_timeout: 120_000 });
    old.on("error", () => {});
    await expect(old.query("SELECT 1")).rejects.toMatchObject({ code: "08P01" });
    await old.end();
    const pool = umamiMaintPool(url, 1);
    try {
      const ok = await new UmamiEraser(pool).preview({
        websiteIds: [randomUUID()],
        range: { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-02T00:00:00Z") },
        selector: null,
      });
      expect(ok.website_events).toBe(0);
      // The transaction-local timeout does not leak to the next transaction on the same server connection.
      const r = await pool.query("SHOW statement_timeout");
      expect(r.rows[0].statement_timeout).toBe("0");
    } finally {
      await pool.end();
    }
  });

  it("a run abandoned by a crashed worker for over an hour is claimed again from the queue (migration 0056)", async () => {
    const id = (await create(owner, tenantA, { site_id: siteA, criteria: RANGE })).json()
      .request_id;
    await worker.runOnce();
    expect((await confirm(tenantA, id)).statusCode).toBe(202);
    // the worker crashed right after claiming it
    await h.su.query(
      `UPDATE scf.erasure_requests SET status = 'running', started_at = now() - interval '2 hours' WHERE request_id = $1`,
      [id],
    );
    expect(await worker.runOnce()).toBeGreaterThanOrEqual(1);
    expect((await get(tenantA, id)).json().status).toBe("completed");
  });

  it("SCF operators list erasure requests with status, dates and counts — never the literal selector (C-119)", async () => {
    const op = (await operatorSession(h, "operator")).cookie;
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/erasure-requests?tenant_id=${tenantA}&start=2025-01-01T00:00:00Z&end=2032-01-01T00:00:00Z`,
      cookie: op,
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.tenant_id).toBe(tenantA);
    expect(items.some((i) => i.selector_type === "path_pattern" && i.status === "completed")).toBe(
      true,
    );
    expect(res.body).not.toMatch(/jane|users\//);
    const done = await call(h, {
      method: "GET",
      url: `/v1/operator/erasure-requests?status=completed&start=2025-01-01T00:00:00Z&end=2032-01-01T00:00:00Z&limit=1`,
      cookie: op,
    });
    expect(done.json().items[0].status).toBe("completed");
    expect(done.json().next_cursor).not.toBeNull();
    // tenant members cannot use it
    expect(
      (await call(h, { method: "GET", url: "/v1/operator/erasure-requests", cookie: owner }))
        .statusCode,
    ).toBe(403);
  });
});
