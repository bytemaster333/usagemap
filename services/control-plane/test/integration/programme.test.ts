// SPDX-License-Identifier: Apache-2.0
// Programme outputs (ADR-0032, wire-formats §i; C-14, C-47, C-94, C-95): share keys, the per-tenant metrics_endpoint
// with its three access paths and the hourly public_metrics job, signed traction snapshots verified the way anyone
// can (JWKS + JCS + Ed25519), the public snapshot copy, and the platform health_endpoint.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/programme/jcs.ts";
import { verifySnapshot } from "../../src/programme/keys.ts";
import { PublicMetricsJob } from "../../src/programme/metrics-endpoint.ts";
import { call, type Harness, operatorSession, startHarness } from "../support/harness.ts";
import {
  createOperatorKey,
  type SeededProject,
  seedApiHour,
  seedProject,
  seedService,
  seedWebDay,
} from "../support/op-seed.ts";

const DAY = 86_400_000;
let h: Harness;
let p: SeededProject;
let other: SeededProject;
const today = Math.floor(Date.now() / DAY) * DAY;
const dayIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnight = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");
const silent = { info: () => {}, error: () => {} };

async function rebuild(): Promise<number> {
  const job = new PublicMetricsJob(h.jobsDb, {
    portalOrigin: h.config.portalOrigin,
    intervalMs: 3_600_000,
    log: silent,
  });
  return job.runOnce();
}

beforeAll(async () => {
  h = await startHarness();
  p = await seedProject(h, { level: 1 });
  other = await seedProject(h, { level: 1 });
  await seedWebDay(h, p, dayIso(today - DAY), {
    pvVerified: 90,
    pvRaw: 100,
    visitorsVerified: 40,
    visitorsRaw: 45,
    visits: 50,
    bounces: 20,
    durationS: 3000,
  });
  await seedWebDay(h, p, dayIso(today - 2 * DAY), {
    pvVerified: 10,
    pvRaw: 10,
    visitorsVerified: 5,
    visitorsRaw: 5,
    visits: 10,
    bounces: 5,
    durationS: 100,
  });
  // A day outside every window used below (today is never complete).
  await seedWebDay(h, p, dayIso(today), { pvVerified: 999, pvRaw: 999 });
  const svc = await seedService(h, p);
  await seedApiHour(h, p, svc, `${dayIso(today - DAY)}T10:00:00Z`, "/v1/x", 200, 95, 3, 0.004);
  await seedApiHour(h, p, svc, `${dayIso(today - DAY)}T11:00:00Z`, "/v1/x", 503, 5, 3, 0.004);
});
afterAll(async () => {
  await h?.close();
});

describe("share keys (C-14, C-70, wire-formats §k)", () => {
  it("are created once-shown, listed by display only, and revoked idempotently", async () => {
    const created = await call(h, {
      method: "POST",
      url: `/v1/tenants/${p.tenantId}/share-keys`,
      cookie: p.cookie,
      body: { label: "grant committee" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const k = created.json();
    expect(k.key).toMatch(/^scfa_pub_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/);
    expect(created.headers["cache-control"]).toBe("no-store");
    const list = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${p.tenantId}/share-keys`,
        cookie: p.cookie,
      })
    ).json();
    expect(list[0]).toMatchObject({ key_id: k.key_id, display: k.display, revoked_at: null });
    expect(JSON.stringify(list)).not.toContain(k.key);
    const stored = await h.su.query(`SELECT * FROM scf.share_keys WHERE key_id = $1`, [k.key_id]);
    expect(JSON.stringify(stored.rows)).not.toContain(k.key.slice(22, 49));
    for (let i = 0; i < 2; i++) {
      const r = await call(h, {
        method: "DELETE",
        url: `/v1/tenants/${p.tenantId}/share-keys/${k.key_id}`,
        cookie: p.cookie,
      });
      expect(r.statusCode).toBe(204);
    }
    const past = await call(h, {
      method: "POST",
      url: `/v1/tenants/${p.tenantId}/share-keys`,
      cookie: p.cookie,
      body: { label: "x", expires_at: "2020-01-01T00:00:00Z" },
    });
    expect(past.statusCode).toBe(400);
  });

  it("need a recent sign-in to create and revoke (C-129, like ingest tokens C-119)", async () => {
    const setSignIn = (age: string) =>
      h.su.query(
        `UPDATE scf.auth_sessions SET reauthenticated_at = now() - $2::interval
          WHERE session_hash = sha256(convert_to($1, 'UTF8'))`,
        [p.cookie.split("=")[1], age],
      );
    const k = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/share-keys`,
        cookie: p.cookie,
        body: { label: "stale test" },
      })
    ).json();
    await setSignIn("11 minutes");
    try {
      const create = await call(h, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/share-keys`,
        cookie: p.cookie,
        body: { label: "late" },
      });
      expect(create.statusCode).toBe(403);
      expect(create.json().code).toBe("recent_auth_required");
      const revoke = await call(h, {
        method: "DELETE",
        url: `/v1/tenants/${p.tenantId}/share-keys/${k.key_id}`,
        cookie: p.cookie,
      });
      expect(revoke.statusCode).toBe(403);
      expect(revoke.json().code).toBe("recent_auth_required");
      // Listing stays available without a fresh sign-in.
      const list = await call(h, {
        method: "GET",
        url: `/v1/tenants/${p.tenantId}/share-keys`,
        cookie: p.cookie,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().some((x: { label: string }) => x.label === "late")).toBe(false);
    } finally {
      await setSignIn("0 minutes");
    }
  });
});

describe("metrics_endpoint (wire-formats §i.1)", () => {
  let shareKey = "";
  beforeAll(async () => {
    shareKey = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/share-keys`,
        cookie: p.cookie,
        body: { label: "programme" },
      })
    ).json().key;
    expect(await rebuild()).toBeGreaterThanOrEqual(2);
  });

  const get = (slug: string, headers: Record<string, string> = {}) =>
    call(h, { method: "GET", url: `/public/v1/projects/${slug}/metrics.json`, headers });

  it("job public_metrics writes the exact §i.1 document from the rollups (last 30 complete UTC days)", async () => {
    const res = await get(p.slug, { authorization: `Bearer ${shareKey}` });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({
      schema: "scf-analytics/metrics-endpoint/1",
      project: { slug: p.slug, verification_level: "L1" },
      window: { start: midnight(today - 30 * DAY), end: midnight(today), days: 30 },
      web: {
        verified: { pageviews: 100, visitors_sum: 45 },
        raw: { pageviews: 110, visitors_sum: 50 },
        visit_metrics: {
          visits: 60,
          bounces: 25,
          bounce_rate_pct: 41.7,
          avg_visit_duration_s: 51.7,
          suspect_pageview_share: 0.0909,
        },
      },
      api: {
        label: "self-attested telemetry",
        requests: 100,
        error_rate_5xx: 0.05,
        accuracy_class: "explicit15",
      },
      links: { definitions: `${h.config.portalOrigin}/docs/metric-definitions/1` },
    });
    expect(d.web.daily).toHaveLength(30);
    expect(d.web.daily.at(-1)).toEqual({
      start: midnight(today - DAY),
      pageviews_verified: 90,
      pageviews_raw: 100,
      visitors_sum_verified: 40,
      visitors_sum_raw: 45,
    });
    expect(d.api.daily.at(-1)).toEqual({ start: midnight(today - DAY), requests: 100 });
    expect(JSON.stringify(d)).not.toContain("trust"); // C-47
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers.etag).toBeTruthy();
    const again = await get(p.slug, {
      authorization: `Bearer ${shareKey}`,
      "if-none-match": String(res.headers.etag),
    });
    expect(again.statusCode).toBe(304);
  });

  it("publishes the traffic not counted, with reasons under the k-threshold left out (2026-11-19)", async () => {
    // web_edge_counters of the window (yesterday) and one day outside it (today): only the window counts
    const day = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const todayDay = new Date().toISOString().slice(0, 10);
    const rows: Array<[string, string, string, number]> = [
      [day, "verdict", "verified", 800],
      [day, "verdict", "suspect", 150],
      [day, "verdict", "rejected", 50],
      [day, "reason", "proof_missing", 120],
      [day, "reason", "net_datacenter", 34],
      [day, "reason", "ua_bot", 46],
      [day, "reason", "token_flood", 4], // under op_min_count (10): left out
      [day, "reason", "not_a_reason", 500], // not a §h.2 code: never published
      [todayDay, "verdict", "rejected", 999],
    ];
    for (const [d, counter, label, n] of rows)
      await h.su.query(
        `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, site_id, day, counter, label) DO UPDATE SET count = EXCLUDED.count`,
        [p.tenantId, p.siteId, d, counter, label, n],
      );
    await rebuild();
    const d = (await get(p.slug, { authorization: `Bearer ${shareKey}` })).json();
    expect(d.web.filtered).toEqual({
      events_received: 1000,
      verified: 800,
      suspect: 150,
      rejected: 50,
      not_counted_share: 0.2,
      suspect_share: 0.15,
      rejected_share: 0.05,
      reasons: [
        { code: "proof_missing", verdict: "suspect", count: 120 },
        { code: "ua_bot", verdict: "rejected", count: 50 },
        { code: "net_datacenter", verdict: "suspect", count: 30 },
      ],
      reasons_suppressed: 1,
    });
  });

  it("anonymous only with public stats on; then public caching", async () => {
    expect((await get(p.slug)).statusCode).toBe(404);
    await h.su.query(`UPDATE scf.tenants SET public_stats_enabled = true WHERE tenant_id = $1`, [
      p.tenantId,
    ]);
    const res = await get(p.slug);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    await h.su.query(`UPDATE scf.tenants SET public_stats_enabled = false WHERE tenant_id = $1`, [
      p.tenantId,
    ]);
  });

  it("the same 404 for an unknown slug, another tenant's key, a bad or revoked key, a key in the URL, and a suspended tenant", async () => {
    const otherKey = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${other.tenantId}/share-keys`,
        cookie: other.cookie,
        body: { label: "o" },
      })
    ).json();
    const cases: Array<[string, Record<string, string>]> = [
      ["no-such-project", { authorization: `Bearer ${shareKey}` }],
      [p.slug, { authorization: `Bearer ${otherKey.key}` }],
      [
        p.slug,
        { authorization: `Bearer ${shareKey.slice(0, -1)}${shareKey.endsWith("x") ? "y" : "x"}` },
      ],
      [p.slug, { authorization: "Bearer nonsense" }],
      [p.slug, { authorization: `Basic ${shareKey}` }],
    ];
    const bodies = [];
    for (const [slug, hd] of cases) {
      const r = await get(slug, hd);
      expect(r.statusCode, `${slug} ${hd.authorization}`).toBe(404);
      bodies.push({ ...r.json(), request_id: "" });
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    const inUrl = await h.app.inject({
      method: "GET",
      url: `/public/v1/projects/${p.slug}/metrics.json?key=${shareKey}`,
    });
    expect(inUrl.statusCode).toBe(404);
    // revoked
    await call(h, {
      method: "DELETE",
      url: `/v1/tenants/${other.tenantId}/share-keys/${otherKey.key_id}`,
      cookie: other.cookie,
    });
    expect((await get(other.slug, { authorization: `Bearer ${otherKey.key}` })).statusCode).toBe(
      404,
    );
    // C-94: a suspended tenant's document is not served, even when public
    const susp = await seedProject(h);
    const c = await h.su.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica"); // test only: bypass the status guard
      await c.query(`UPDATE scf.tenants SET status = 'suspended' WHERE tenant_id = $1`, [
        susp.tenantId,
      ]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await h.su.query(
      `INSERT INTO scf.public_metrics_documents (tenant_id, document) VALUES ($1, '{"schema":"x"}'::jsonb)`,
      [susp.tenantId],
    );
    await h.su.query(`UPDATE scf.tenants SET public_stats_enabled = true WHERE tenant_id = $1`, [
      susp.tenantId,
    ]);
    expect((await get(susp.slug)).statusCode).toBe(404);
  });

  it("SCF-operator keys need web:read and api:read, honour the tenant restriction and are audited (CR-21, CR-22)", async () => {
    const admin = (await operatorSession(h, "operator_admin")).cookie;
    const both = (await createOperatorKey(h, admin, { scopes: ["web:read", "api:read"] })).key;
    const webOnly = (await createOperatorKey(h, admin, { scopes: ["web:read"] })).key;
    const restricted = (
      await createOperatorKey(h, admin, {
        scopes: ["web:read", "api:read"],
        tenant_restriction: [other.tenantId],
      })
    ).key;
    const ok = await get(p.slug, { authorization: `Bearer ${both}` });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().project.slug).toBe(p.slug);
    expect((await get(p.slug, { authorization: `Bearer ${webOnly}` })).statusCode).toBe(404);
    const denied = await get(p.slug, { authorization: `Bearer ${restricted}` });
    expect(denied.statusCode).toBe(404);
    const audit = await h.su.query<{ outcome: string }>(
      `SELECT outcome FROM scf.audit_log WHERE request_id = $1 AND action = 'operator.read.op_metrics_document'`,
      [String(denied.headers["x-request-id"])],
    );
    expect(audit.rows.map((r) => r.outcome)).toEqual(["denied"]);
  });
});

describe("traction snapshots (C-47, wire-formats §i.3)", () => {
  // The v1 document (§i.3.1; still accepted with schema_version 1, C-136); v2 is covered in differentiation.test.ts.
  const period = {
    period_start: midnight(today - 3 * DAY),
    period_end: midnight(today),
    schema_version: 1,
  };

  it("signs JCS(snapshot) with Ed25519; the JWKS verifies it; the stored copy is byte-identical; revocation is reported", async () => {
    const created = await call(h, {
      method: "POST",
      url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
      cookie: p.cookie,
      body: period,
    });
    expect(created.statusCode, created.body).toBe(201);
    const signed = created.json();
    expect(signed.signature).toMatchObject({ alg: "Ed25519", kid: "snap-test" });
    expect(signed.snapshot).toMatchObject({
      schema: "scf-analytics/traction-snapshot/1",
      issuer: new URL(h.config.portalOrigin).host,
      project: { slug: p.slug, verification_level: "L1", registry_matches: [] },
      period: { start: period.period_start, end: period.period_end },
      web: {
        verified: { pageviews: 100, visitors_sum: 45 },
        raw: { pageviews: 110, visitors_sum: 50 },
      },
      api: { requests: 100, error_rate_5xx: 0.05, label: "self-attested telemetry" },
    });
    expect(
      signed.snapshot.web.monthly.reduce(
        (a: number, m: { pageviews_verified: number }) => a + m.pageviews_verified,
        0,
      ),
    ).toBe(100);
    expect(signed.snapshot.web.monthly[0].start).toBe(period.period_start);
    expect(JSON.stringify(signed)).not.toMatch(/trust|referrer|route/);

    const jwks = await call(h, { method: "GET", url: "/.well-known/scf-snapshot-keys.json" });
    expect(jwks.headers["cache-control"]).toContain("public");
    expect(verifySnapshot(jwks.json(), signed)).toBe(true);
    const tampered = structuredClone(signed);
    tampered.snapshot.web.verified.pageviews += 1;
    expect(verifySnapshot(jwks.json(), tampered)).toBe(false);

    const id = signed.snapshot.snapshot_id as string;
    const pub = await call(h, { method: "GET", url: `/public/v1/snapshots/${id}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ status: "valid", revoked_at: null });
    expect(canonicalize(pub.json().snapshot)).toBe(canonicalize(signed.snapshot));
    expect(pub.json().signature).toEqual(signed.signature);

    const list = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
        cookie: p.cookie,
      })
    ).json();
    expect(list[0]).toMatchObject({
      snapshot_id: id,
      verify_url: `${h.config.portalOrigin}/public/v1/snapshots/${id}`,
      revoked_at: null,
    });

    const rev = await call(h, {
      method: "POST",
      url: `/v1/tenants/${p.tenantId}/traction-snapshots/${id}/revoke`,
      cookie: p.cookie,
      body: { reason: "superseded" },
    });
    expect(rev.statusCode).toBe(204);
    const after = (await call(h, { method: "GET", url: `/public/v1/snapshots/${id}` })).json();
    expect(after.status).toBe("revoked");
    expect(verifySnapshot(jwks.json(), after)).toBe(true); // still verifies cryptographically
    expect(
      (await call(h, { method: "GET", url: `/public/v1/snapshots/${randomUUID()}` })).statusCode,
    ).toBe(404);
  });

  it("include_api=false leaves the API out; periods are whole days, ≤ 400 days, ending by today 00:00 UTC", async () => {
    const noApi = await call(h, {
      method: "POST",
      url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
      cookie: p.cookie,
      body: { ...period, include_api: false },
    });
    expect(noApi.statusCode).toBe(201);
    expect(noApi.json().snapshot.api).toBeUndefined();
    for (const body of [
      { period_start: midnight(today - DAY), period_end: midnight(today + DAY) },
      { period_start: midnight(today - 401 * DAY), period_end: midnight(today) },
      { period_start: midnight(today), period_end: midnight(today - DAY) },
      { period_start: "2026-01-01T12:00:00Z", period_end: midnight(today) },
    ]) {
      const r = await call(h, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
        cookie: p.cookie,
        body,
      });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("without a published key: 503 to create, an empty JWKS", async () => {
    const h2 = await startHarness({ SCF_SNAPSHOT_PUBLIC_KEY: "" });
    try {
      const r = await call(h2, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
        cookie: p.cookie,
        body: period,
      });
      expect(r.statusCode).toBe(503);
      expect(
        (await call(h2, { method: "GET", url: "/.well-known/scf-snapshot-keys.json" })).json(),
      ).toEqual({ keys: [] });
    } finally {
      await h2.close();
    }
  });
});

describe("health_endpoint (wire-formats §i.2, C-119)", () => {
  it("reports edge nodes from counter-report freshness, hostnames from their nodes, and the worst component", async () => {
    const h2 = await startHarness({
      SCF_HEALTH_INGEST_HOSTS: "i.example.org=hz-a1|hz-a2,i.example.net=hz-b1",
      SCF_STATUS_PAGE_URL: "https://status.example.org/",
    });
    try {
      await h2.su.query(`DELETE FROM scf.edge_spool_accounting WHERE node_id LIKE 'hz-%'`);
      const first = await call(h2, { method: "GET", url: "/public/v1/health" });
      expect(first.headers["cache-control"]).toBe("no-store");
      const row = (node: string, ageS: number, queued: number) =>
        h2.su.query(
          `INSERT INTO scf.edge_spool_accounting (node_id, day, queued_end, last_period_end)
           VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $3, now() - make_interval(secs => $2))
           ON CONFLICT (node_id, day) DO UPDATE SET queued_end = $3, last_period_end = EXCLUDED.last_period_end`,
          [node, ageS, queued],
        );
      await row("hz-a1", 30, 0);
      await row("hz-a2", 30, 0);
      await row("hz-b1", 30, 0);
      let r = await call(h2, { method: "GET", url: "/public/v1/health" });
      let b = r.json();
      expect(r.statusCode).toBe(200);
      expect(b.edge_nodes.filter((n: { node: string }) => n.node.startsWith("hz-"))).toEqual([
        { node: "hz-a1", status: "ok" },
        { node: "hz-a2", status: "ok" },
        { node: "hz-b1", status: "ok" },
      ]);
      expect(b.status_page).toBe("https://status.example.org/");
      // one node silent for 10 minutes: degraded; a hostname whose only node is down is down
      await row("hz-b1", 600, 0);
      b = (await call(h2, { method: "GET", url: "/public/v1/health" })).json();
      expect(b.components.web_ingest).toBe("degraded");
      expect(b.ingest_hostnames).toEqual([
        { host: "i.example.org", status: "ok" },
        { host: "i.example.net", status: "down" },
      ]);
      expect(b.status).toBe("degraded");
      // backlog → processing degraded
      await row("hz-a1", 30, 50_000);
      expect(
        (await call(h2, { method: "GET", url: "/public/v1/health" })).json().components.processing,
      ).toBe("degraded");
      // every node silent for over an hour → down, 503
      for (const n of ["hz-a1", "hz-a2", "hz-b1"]) await row(n, 7200, 0);
      await h2.su.query(`DELETE FROM scf.edge_spool_accounting WHERE node_id NOT LIKE 'hz-%'`);
      r = await call(h2, { method: "GET", url: "/public/v1/health" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({
        status: "down",
        components: { web_ingest: "down", processing: "down", dashboards: "ok" },
      });
    } finally {
      await h2.su.query(`DELETE FROM scf.edge_spool_accounting WHERE node_id LIKE 'hz-%'`);
      await h2.close();
    }
  });
});
