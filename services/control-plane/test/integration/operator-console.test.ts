// SPDX-License-Identifier: Apache-2.0
// SCF-operator console (operator.global-view-credentials, operator.web-*, operator.api-*): aggregate, filter, sort, compare, breakdowns with the
// minimum count and rounding (C-95), verdicts, API totals with merged percentiles and accuracy class, tenant detail,
// the audit log; every read goes through an op_* function that writes its audit row (C-17). Responses are validated
// against the OpenAPI document by `call()`, which also checks the audit actions of each audited operation.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  type Harness,
  newGithubUser,
  operatorSession,
  signInGithub,
  startHarness,
} from "../support/harness.ts";
import {
  type SeededProject,
  type SeededService,
  seedApiHour,
  seedBreakdown,
  seedProject,
  seedService,
  seedVerdict,
  seedWebDay,
} from "../support/op-seed.ts";

let h: Harness;
let operator: string;
let operatorUserId: string;
let startedAt: string;
let A: SeededProject;
let B: SeededProject;
let C: SeededProject; // L0
let svcA: SeededService;
let svcB: SeededService;
const D1 = "2026-11-03";
const D2 = "2026-11-04";
const RANGE = "start=2026-11-03T00:00:00Z&end=2026-11-06T00:00:00Z";

async function auditActions(
  requestId: string,
): Promise<Array<{ action: string; actor_kind: string }>> {
  return (
    await h.su.query<{ action: string; actor_kind: string }>(
      `SELECT action, actor_kind FROM scf.audit_log WHERE request_id = $1 ORDER BY seq`,
      [requestId],
    )
  ).rows;
}

beforeAll(async () => {
  startedAt = new Date(Date.now() - 1000).toISOString();
  h = await startHarness();
  const op = await operatorSession(h, "operator");
  operator = op.cookie;
  operatorUserId = op.userId;
  A = await seedProject(h, { level: 1, awarded: true });
  B = await seedProject(h, { level: 1, awarded: false });
  C = await seedProject(h, { level: 0 });
  await seedWebDay(h, A, D1, {
    pvVerified: 100,
    pvRaw: 120,
    visits: 50,
    bounces: 10,
    durationS: 500,
  });
  await seedWebDay(h, A, D2, {
    pvVerified: 200,
    pvRaw: 220,
    visits: 50,
    bounces: 20,
    durationS: 1000,
  });
  await seedWebDay(h, B, D1, { pvVerified: 40, pvRaw: 40, visits: 10, bounces: 5 });
  await seedWebDay(h, C, D1, { pvVerified: 7, pvRaw: 9, visits: 3 });
  // breakdown rows: 14 → 10, 16 → 20, 5 → omitted (k = 10, rounded to 10, C-95)
  await seedBreakdown(h, A, D1, "country", "DE", 14, 30);
  await seedBreakdown(h, A, D2, "country", "FR", 16, 40);
  await seedBreakdown(h, A, D2, "country", "XX", 5, 9);
  await seedVerdict(h, A, D1, "verdict", "verified", 3);
  await seedVerdict(h, A, D1, "reason", "proof_missing", 1);
  svcA = await seedService(h, A, "horizon-proxy");
  svcB = await seedService(h, B, "rpc-gateway");
  // A: 90 × 2xx in (0.1, 0.25] and 10 × 5xx in (1, 2.5] on D1; B: 30 × 2xx in (0.01, 0.025]
  await seedApiHour(h, A, svcA, `${D1}T10:00:00Z`, "/v1/accounts/{strkey}", 200, 90, 7, 0.2);
  await seedApiHour(h, A, svcA, `${D1}T11:00:00Z`, "/v1/accounts/{strkey}", 503, 10, 11, 2);
  await seedApiHour(h, B, svcB, `${D2}T09:00:00Z`, "/rpc", 200, 30, 3, 0.02);
});

afterAll(async () => {
  await h?.close();
});

describe("SCF-operator web views (operator.web-*)", () => {
  it("ecosystem totals per day are exact sums over the selected tenants; L0 only on request; audited", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/web/summary?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId},${C.tenantId}`,
      cookie: operator,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.privacy).toEqual({
      min_count: 10,
      round_to: 10,
      aggregation: "sum_of_unrounded_then_rounded",
      excluded_levels_below: "L1",
    });
    expect(b.days.map((d: { day: string }) => d.day)).toEqual([D1, D2, "2026-11-05"]);
    expect(b.days[0].pageviews).toBe(140); // 100 + 40, C (L0) excluded
    expect(b.days[1].pageviews).toBe(200);
    expect(b.days[2]).toMatchObject({ pageviews: 0, bounce_rate_pct: null });
    expect(b.days[0].visits).toBe(60);
    const raw = await call(h, {
      method: "GET",
      url: `/v1/operator/web/summary?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId},${C.tenantId}&min_level=L0&variant=raw`,
      cookie: operator,
    });
    expect(raw.json().days[0].pageviews).toBe(120 + 40 + 9);
    expect(raw.json().variant).toBe("raw");
    const audit = await auditActions(String(res.headers["x-request-id"]));
    expect(audit).toContainEqual({
      action: "operator.read.op_web_metrics",
      actor_kind: "operator",
    });
  });

  it("per-project table: filter (scf_awarded, min_pageviews), sort, paging and CSV", async () => {
    const base = `/v1/operator/web/projects?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId}`;
    const all = (await call(h, { method: "GET", url: base, cookie: operator })).json();
    expect(all.items.map((r: { tenant_id: string }) => r.tenant_id)).toEqual([
      A.tenantId,
      B.tenantId,
    ]);
    expect(all.items[0]).toMatchObject({
      slug: A.slug,
      verification_level: "L1",
      scf_awarded: true,
      pageviews: 300,
      visits: 100,
      bounce_rate_pct: 30,
      avg_visit_duration_s: 15,
    });
    const asc = (
      await call(h, { method: "GET", url: `${base}&sort=pageviews`, cookie: operator })
    ).json();
    expect(asc.items[0].tenant_id).toBe(B.tenantId);
    const awarded = (
      await call(h, { method: "GET", url: `${base}&scf_awarded=true`, cookie: operator })
    ).json();
    expect(awarded.items.map((r: { tenant_id: string }) => r.tenant_id)).toEqual([A.tenantId]);
    const big = (
      await call(h, { method: "GET", url: `${base}&min_pageviews=100`, cookie: operator })
    ).json();
    expect(big.items).toHaveLength(1);
    const p1 = (await call(h, { method: "GET", url: `${base}&limit=1`, cookie: operator })).json();
    expect(p1.items).toHaveLength(1);
    expect(p1.next_cursor).toBeTypeOf("string");
    const p2 = (
      await call(h, {
        method: "GET",
        url: `${base}&limit=1&cursor=${p1.next_cursor}`,
        cookie: operator,
      })
    ).json();
    expect(p2.items[0].tenant_id).toBe(B.tenantId);
    expect(p2.next_cursor).toBeNull();
    const bad = await call(h, {
      method: "GET",
      url: `${base}&limit=1&sort=name&cursor=${p1.next_cursor}`,
      cookie: operator,
    });
    expect(bad.statusCode).toBe(400);
    const csv = await call(h, {
      method: "GET",
      url: base,
      cookie: operator,
      headers: { accept: "text/csv" },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toContain("tenant_id,slug,name");
    expect(csv.headers["x-scf-min-count"]).toBe("10");
  });

  it("side-by-side comparison on aligned days; an unknown tenant is 404", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/web/compare?${RANGE}&tenant_ids=${A.tenantId},${C.tenantId}`,
      cookie: operator,
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json().series;
    expect(s.map((x: { slug: string }) => x.slug)).toEqual([A.slug, C.slug]);
    expect(s[0].days).toHaveLength(3);
    expect(s[1].days).toHaveLength(3);
    expect(s[1].days[0].pageviews).toBe(7); // a named L0 tenant is compared too
    const unknown = await call(h, {
      method: "GET",
      url: `/v1/operator/web/compare?${RANGE}&tenant_ids=${A.tenantId},${randomUUID()}`,
      cookie: operator,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("breakdown rows: below the minimum count omitted, the rest rounded once (C-95)", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/web/breakdown?${RANGE}&tenant_ids=${A.tenantId}&dimension=country`,
      cookie: operator,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().rows as Array<{
      value: string;
      visitors_sum: number;
      pageviews: number;
    }>;
    expect(rows.map((r) => r.value).sort()).toEqual(["DE", "FR"]);
    expect(rows.find((r) => r.value === "DE")?.visitors_sum).toBe(10);
    expect(rows.find((r) => r.value === "FR")).toMatchObject({ visitors_sum: 20, pageviews: 40 });
    expect(await auditActions(String(res.headers["x-request-id"]))).toContainEqual({
      action: "operator.read.op_web_breakdown",
      actor_kind: "operator",
    });
  });

  it("verdict counters are exact (no threshold)", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/web/verdicts?${RANGE}&tenant_ids=${A.tenantId}`,
      cookie: operator,
    });
    expect(res.json().rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ counter: "verdict", label: "verified", count: 3 }),
        expect.objectContaining({ counter: "reason", label: "proof_missing", count: 1 }),
      ]),
    );
  });
});

describe("SCF-operator API views (operator.api-*)", () => {
  it("ecosystem API totals merge histograms; percentiles carry the accuracy class; self-attested label", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/api/summary?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId}`,
      cookie: operator,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.label).toBe("self-attested telemetry");
    expect(b.days[0]).toMatchObject({
      day: D1,
      requests: 100,
      s2xx: 90,
      s5xx: 10,
      error_rate_5xx: 0.1,
    });
    expect(b.days[0].accuracy_class).toBe("explicit15");
    expect(b.days[0].p50_ms).toBeGreaterThan(100);
    expect(b.days[0].p50_ms).toBeLessThanOrEqual(250);
    expect(b.days[0].p99_ms).toBeGreaterThan(1000);
    expect(b.days[0].p99_ms).toBeLessThanOrEqual(2500);
    expect(b.days[1]).toMatchObject({ requests: 30, s2xx: 30 });
    expect(b.days[2]).toMatchObject({ requests: 0, p50_ms: null, accuracy_class: null });
  });

  it("per-service table with names, active days, sort and the high/low-usage filter", async () => {
    const base = `/v1/operator/api/services?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId}`;
    const res = await call(h, { method: "GET", url: base, cookie: operator });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items;
    expect(items.map((r: { service_name: string }) => r.service_name)).toEqual([
      "horizon-proxy",
      "rpc-gateway",
    ]);
    expect(items[0]).toMatchObject({
      slug: A.slug,
      requests: 100,
      active_days: 1,
      verification_level: "L1",
    });
    const low = (
      await call(h, { method: "GET", url: `${base}&sort=requests`, cookie: operator })
    ).json();
    expect(low.items[0].service_name).toBe("rpc-gateway");
    const busy = (
      await call(h, { method: "GET", url: `${base}&min_requests=50`, cookie: operator })
    ).json();
    expect(busy.items).toHaveLength(1);
    const byName = (
      await call(h, { method: "GET", url: `${base}&sort=name`, cookie: operator })
    ).json();
    expect(byName.items).toHaveLength(2);
  });

  it("API comparison and per-route view; a service of another tenant is 404 (C-87)", async () => {
    const cmp = await call(h, {
      method: "GET",
      url: `/v1/operator/api/compare?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId}`,
      cookie: operator,
    });
    expect(cmp.statusCode, cmp.body).toBe(200);
    expect(cmp.json().series[0].days[0].requests).toBe(100);
    const routes = await call(h, {
      method: "GET",
      url: `/v1/operator/api/routes?${RANGE}&tenant_id=${A.tenantId}&service_id=${svcA.serviceId}`,
      cookie: operator,
    });
    expect(routes.statusCode, routes.body).toBe(200);
    expect(routes.json().items).toEqual([
      expect.objectContaining({ route: "/v1/accounts/{strkey}", requests: 100, s5xx: 10 }),
    ]);
    for (const url of [
      `/v1/operator/api/routes?${RANGE}&tenant_id=${A.tenantId}&service_id=${svcB.serviceId}`,
      `/v1/operator/api/routes?${RANGE}&tenant_id=${randomUUID()}`,
    ]) {
      expect((await call(h, { method: "GET", url, cookie: operator })).statusCode).toBe(404);
    }
  });

  it("trust scores and API assurance come from op_trust / op_api_assurance", async () => {
    await h.su.query(
      `INSERT INTO scf.web_trust_scores (tenant_id, site_id, day, window_days, score, components, reason_codes,
         decision_rate, algorithm_version)
       VALUES ($1, $2, $3::date, 28, 84, '{"proof_coverage_low": {"p": 0.1, "value": 0.9}}', '{}', 0.02, 'trust/1.0.0')`,
      [A.tenantId, A.siteId, D2],
    );
    await h.su.query(
      `INSERT INTO scf.api_service_assurance (tenant_id, service_id, day, level, onchain_badge, checks, reason_codes)
       VALUES ($1, $2, $3::date, 1, 'not_applicable', '{}', '{a2_no_base_url}')`,
      [A.tenantId, svcA.serviceId, D1],
    );
    const t = await call(h, {
      method: "GET",
      url: `/v1/operator/trust-scores?${RANGE}&tenant_ids=${A.tenantId}`,
      cookie: operator,
    });
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json().items[0]).toMatchObject({ slug: A.slug, score: 84, window_days: 28 });
    const band = await call(h, {
      method: "GET",
      url: `/v1/operator/web/projects?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId}&trust_band=high`,
      cookie: operator,
    });
    expect(band.json().items.map((r: { tenant_id: string }) => r.tenant_id)).toEqual([A.tenantId]);
    const unscored = await call(h, {
      method: "GET",
      url: `/v1/operator/web/projects?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId}&trust_band=unscored`,
      cookie: operator,
    });
    expect(unscored.json().items.map((r: { tenant_id: string }) => r.tenant_id)).toEqual([
      B.tenantId,
    ]);
    const a = await call(h, {
      method: "GET",
      url: `/v1/operator/api-assurance?${RANGE}&tenant_ids=${A.tenantId}`,
      cookie: operator,
    });
    expect(a.json().items).toEqual([
      expect.objectContaining({
        service_id: svcA.serviceId,
        level: "A1",
        onchain_badge: "not_applicable",
      }),
    ]);
    const s = await call(h, {
      method: "GET",
      url: `/v1/operator/api/services?${RANGE}&tenant_ids=${A.tenantId}`,
      cookie: operator,
    });
    expect(s.json().items[0]).toMatchObject({
      assurance_level: "A1",
      onchain_badge: "not_applicable",
    });
  });
});

describe("tenant detail and audit log (operator.global-view-credentials)", () => {
  it("maps op_tenant_detail to OperatorTenantDetail; unknown tenant 404", async () => {
    await h.su.query(
      `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 'verdict', 'verified', 1234)
       ON CONFLICT DO NOTHING`,
      [A.tenantId, A.siteId],
    );
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/tenants/${A.tenantId}`,
      cookie: operator,
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d.tenant).toMatchObject({
      tenant_id: A.tenantId,
      slug: A.slug,
      verification_level: "L1",
    });
    // C-119 (migration 0054): today's quota counter per site
    expect(d.sites[0]).toMatchObject({
      site_id: A.siteId,
      limits: { verified_events_today: 1234 },
    });
    expect(d.services.map((s: { service_name: string }) => s.service_name)).toEqual([
      "horizon-proxy",
    ]);
    expect(d.evidence[0]).toMatchObject({ kind: "domain", status: "valid" });
    expect(d.registry_links[0]).toMatchObject({ status: "confirmed", scf_awarded: true });
    expect(d.members).toHaveLength(1);
    expect(JSON.stringify(d)).not.toContain("secret_hash");
    expect(JSON.stringify(d)).not.toContain("umami_website_id");
    expect(
      (
        await call(h, {
          method: "GET",
          url: `/v1/operator/tenants/${randomUUID()}`,
          cookie: operator,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("lists the audit log with a cursor and filters; reads are themselves audited", async () => {
    const q = `/v1/operator/audit?tenant_id=${A.tenantId}&limit=1`;
    const p1 = await call(h, { method: "GET", url: q, cookie: operator });
    expect(p1.statusCode, p1.body).toBe(200);
    expect(p1.json().items).toHaveLength(1);
    const p2 = await call(h, {
      method: "GET",
      url: `${q}&cursor=${p1.json().next_cursor}`,
      cookie: operator,
    });
    expect(p2.statusCode).toBe(200);
    expect(p2.json().items[0].seq).not.toEqual(p1.json().items[0].seq + 0 === 0 ? -1 : undefined);
    const k1 = `${p1.json().items[0].chain_id}/${p1.json().items[0].seq}`;
    const k2 = `${p2.json().items[0].chain_id}/${p2.json().items[0].seq}`;
    expect(k1).not.toBe(k2);
    const ops = await call(h, {
      method: "GET",
      url: `/v1/operator/audit?action_prefix=operator.read.&limit=200&start=${startedAt}&end=${new Date(Date.now() + 60_000).toISOString()}`,
      cookie: operator,
    });
    const actions = ops.json().items.map((i: { action: string }) => i.action);
    expect(actions.length).toBeGreaterThan(5);
    expect(actions.every((a: string) => a.startsWith("operator.read."))).toBe(true);
    expect(ops.json().items.some((i: { actor_id: string }) => i.actor_id === operatorUserId)).toBe(
      true,
    );
  });
});

describe("SCF-operator API keys and grants (operator.global-view-credentials, keys.operator-api-keys, keys.revocation)", () => {
  it("operator_admin creates (shown once, hash only), lists and revokes keys; an operator cannot", async () => {
    const admin = await operatorSession(h, "operator_admin");
    const denied = await call(h, {
      method: "POST",
      url: "/v1/operator/api-keys",
      cookie: operator,
      body: { label: "x", scopes: ["web:read"] },
    });
    expect(denied.statusCode).toBe(403);
    const res = await call(h, {
      method: "POST",
      url: "/v1/operator/api-keys",
      cookie: admin.cookie,
      body: {
        label: "dashboard export",
        scopes: ["web:read", "api:read"],
        tenant_restriction: [A.tenantId],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = res.json();
    expect(k.key).toMatch(/^scfa_op_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/);
    expect(k.display).toBe(`scfa_op_${k.key_id}_…${k.key.slice(-10, -6)}`);
    expect(k).toMatchObject({
      scopes: ["api:read", "web:read"],
      rate_limit_per_min: 600,
      created_by: admin.userId,
    });
    const days = (Date.parse(k.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const row = (
      await h.su.query(
        `SELECT secret_hash, row_to_json(k)::text AS j FROM scf.operator_api_keys k WHERE key_id = $1`,
        [k.key_id],
      )
    ).rows[0];
    expect(row.secret_hash).toHaveLength(32);
    expect(row.j).not.toContain(k.key.slice(21, 48));
    expect(h.logs.text).not.toContain(k.key.slice(21, 48));
    const list = await call(h, { method: "GET", url: "/v1/operator/api-keys", cookie: operator });
    const mine = list.json().find((x: { key_id: string }) => x.key_id === k.key_id);
    expect(mine).toMatchObject({ display: k.display, revoked_at: null, flagged_for_review: false });
    expect(mine.key).toBeUndefined();
    const long = await call(h, {
      method: "POST",
      url: "/v1/operator/api-keys",
      cookie: admin.cookie,
      body: { label: "too long", scopes: ["web:read"], expires_in_days: 366 },
    });
    expect(long.statusCode).toBe(400);
    const rv = await call(h, {
      method: "POST",
      url: `/v1/operator/api-keys/${k.key_id}/revoke`,
      cookie: admin.cookie,
      body: { reason: "rotation" },
    });
    expect(rv.statusCode).toBe(204);
    const again = await call(h, {
      method: "POST",
      url: `/v1/operator/api-keys/${k.key_id}/revoke`,
      cookie: admin.cookie,
      body: { reason: "rotation" },
    });
    expect(again.statusCode).toBe(204);
    const after = (await call(h, { method: "GET", url: "/v1/operator/api-keys", cookie: operator }))
      .json()
      .find((x: { key_id: string }) => x.key_id === k.key_id);
    expect(after.revoked_at).toBeTypeOf("string");
    expect(
      (
        await call(h, {
          method: "POST",
          url: "/v1/operator/api-keys/Zzzzzzzzzzzz/revoke",
          cookie: admin.cookie,
          body: { reason: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("without pepper_op key creation answers 503", async () => {
    const h2 = await startHarness({ SCF_PEPPER_OP: "" });
    try {
      const admin = await operatorSession(h2, "operator_admin");
      const res = await call(h2, {
        method: "POST",
        url: "/v1/operator/api-keys",
        cookie: admin.cookie,
        body: { label: "x", scopes: ["web:read"] },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await h2.close();
    }
  });

  it("operator_admin grants and revokes the operator role; the grant ends the user's sessions (C-114)", async () => {
    const admin = await operatorSession(h, "operator_admin");
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    const userId = (await call(h, { method: "GET", url: "/v1/me", cookie })).json()
      .user_id as string;
    const g = await call(h, {
      method: "POST",
      url: "/v1/operator/operators",
      cookie: admin.cookie,
      body: { user_id: userId, role: "operator", note: "programme team" },
    });
    expect(g.statusCode, g.body).toBe(201);
    expect(g.json()).toMatchObject({
      user_id: userId,
      role: "operator",
      granted_by: admin.userId,
      passkey_count: 0,
    });
    expect((await call(h, { method: "GET", url: "/v1/me", cookie })).statusCode).toBe(401);
    const list = await call(h, { method: "GET", url: "/v1/operator/operators", cookie: operator });
    expect(list.json().some((o: { user_id: string }) => o.user_id === userId)).toBe(true);
    const unknown = await call(h, {
      method: "POST",
      url: "/v1/operator/operators",
      cookie: admin.cookie,
      body: { user_id: randomUUID(), role: "operator" },
    });
    expect(unknown.statusCode).toBe(404);
    const r = await call(h, {
      method: "DELETE",
      url: `/v1/operator/operators/${userId}`,
      cookie: admin.cookie,
    });
    expect(r.statusCode).toBe(204);
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/operator/operators/${userId}`,
          cookie: admin.cookie,
        })
      ).statusCode,
    ).toBe(404);
    const ops = (
      await call(h, { method: "GET", url: "/v1/operator/operators", cookie: operator })
    ).json();
    expect(ops.some((o: { user_id: string }) => o.user_id === userId)).toBe(false);
  });
});

describe("operator console redesign (K1): registry filters, movers, hidden values, overview", () => {
  const PREV_DAY = "2026-11-01"; // inside the previous window of RANGE (2026-10-31 … 2026-11-03)
  let D: SeededProject; // figures only in the previous window: a full drop
  beforeAll(async () => {
    D = await seedProject(h, { level: 1 });
    await seedWebDay(h, D, PREV_DAY, { pvVerified: 70, pvRaw: 70, visitorsVerified: 30 });
    const svcD = await seedService(h, D, "dropped-api");
    await seedApiHour(h, D, svcD, `${PREV_DAY}T09:00:00Z`, "/rpc", 200, 15, 3, 0.02);
    // A: awarded, round 35, testnet stage, two categories; B: round 20, MVP stage; C: no registry link.
    for (const [p, round, stage, cats] of [
      [A, 35, "t2_testnet", "{developer_tooling,infrastructure_services}"],
      [B, 20, "t1_mvp", "{applications}"],
    ] as const) {
      await h.su.query(
        `UPDATE scf.registry_projects SET award_round = $2, award_stage = $3, scf_categories = $4::text[],
                source_url = 'https://registry.example/' || source_id
          WHERE registry_project_id IN (SELECT registry_project_id FROM scf.tenant_registry_links WHERE tenant_id = $1)`,
        [p.tenantId, round, stage, cats],
      );
    }
    await seedWebDay(h, A, PREV_DAY, { pvVerified: 50, pvRaw: 50, visitorsVerified: 20 });
    await seedApiHour(
      h,
      A,
      svcA,
      `${PREV_DAY}T08:00:00Z`,
      "/v1/accounts/{strkey}",
      200,
      20,
      7,
      0.2,
    );
  });

  const ids = (b: { items: Array<{ tenant_id: string }> }) => b.items.map((r) => r.tenant_id);

  it("web projects carry the registry facts and filter on round, stage and category", async () => {
    const base = `/v1/operator/web/projects?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId},${C.tenantId}&min_level=L0`;
    const all = (await call(h, { method: "GET", url: base, cookie: operator })).json();
    const byId = new Map(all.items.map((r: { tenant_id: string }) => [r.tenant_id, r]));
    expect(byId.get(A.tenantId)).toMatchObject({
      scf_awarded: true,
      award_round: 35,
      award_stage: "t2_testnet",
      categories: ["developer_tooling", "infrastructure_services"],
    });
    expect(byId.get(C.tenantId)).toMatchObject({
      scf_awarded: null,
      award_round: null,
      award_stage: null,
      categories: [],
    });
    for (const [q, want] of [
      ["award_round=35", [A.tenantId]],
      ["award_stage=t1_mvp", [B.tenantId]],
      ["category=applications", [B.tenantId]],
      ["category=developer_tooling&award_round=20", []],
    ] as const) {
      const res = await call(h, { method: "GET", url: `${base}&${q}`, cookie: operator });
      expect(res.statusCode, res.body).toBe(200);
      expect(ids(res.json()), q).toEqual(want);
    }
    const bad = await call(h, { method: "GET", url: `${base}&category=nope`, cookie: operator });
    expect(bad.statusCode).toBe(400);
  });

  it("movers: compare=previous adds the equal-length window before start and sorts by the change", async () => {
    const base = `/v1/operator/web/projects?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId},${D.tenantId}&compare=previous`;
    const res = await call(h, {
      method: "GET",
      url: `${base}&sort=-pageviews_change`,
      cookie: operator,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.previous).toEqual({
      start: "2026-10-31T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
    });
    expect(b.items[0]).toMatchObject({
      tenant_id: A.tenantId,
      pageviews: 300,
      pageviews_prev: 50,
      visitors_prev: 20,
      pageviews_change: 250,
    });
    expect(b.items[1]).toMatchObject({
      tenant_id: B.tenantId,
      pageviews_prev: 0,
      pageviews_change: 40,
    });
    const asc = (
      await call(h, { method: "GET", url: `${base}&sort=pageviews_change`, cookie: operator })
    ).json();
    expect(ids(asc)).toEqual([D.tenantId, B.tenantId, A.tenantId]);
    // a project with figures only before: zero now, the full drop as its change
    expect(b.items[2]).toMatchObject({
      tenant_id: D.tenantId,
      pageviews: 0,
      pageviews_prev: 70,
      visitors_prev: 30,
      pageviews_change: -70,
      bounce_rate_pct: null,
    });
    // without compare: no *_prev fields, and a change sort is refused
    const plain = (
      await call(h, {
        method: "GET",
        url: `/v1/operator/web/projects?${RANGE}&tenant_ids=${A.tenantId}`,
        cookie: operator,
      })
    ).json();
    expect(plain.items[0]).not.toHaveProperty("pageviews_prev");
    expect(plain).not.toHaveProperty("previous");
    const refused = await call(h, {
      method: "GET",
      url: `/v1/operator/web/projects?${RANGE}&sort=-pageviews_change`,
      cookie: operator,
    });
    expect(refused.statusCode).toBe(400);
  });

  it("API services: registry facts, filters and requests_prev / requests_change", async () => {
    const base = `/v1/operator/api/services?${RANGE}&tenant_ids=${A.tenantId},${B.tenantId},${D.tenantId}`;
    const res = await call(h, {
      method: "GET",
      url: `${base}&compare=previous&sort=-requests_change`,
      cookie: operator,
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items;
    expect(items[0]).toMatchObject({
      service_name: "horizon-proxy",
      scf_awarded: true,
      award_round: 35,
      award_stage: "t2_testnet",
      requests: 100,
      requests_prev: 20,
      requests_change: 80,
    });
    expect(items[1]).toMatchObject({
      service_name: "rpc-gateway",
      requests_prev: 0,
      requests_change: 30,
    });
    expect(items[2]).toMatchObject({
      service_name: "dropped-api",
      requests: 0,
      requests_prev: 15,
      requests_change: -15,
      p95_ms: null,
      accuracy_class: null,
    });
    const r20 = (
      await call(h, { method: "GET", url: `${base}&award_round=20`, cookie: operator })
    ).json();
    expect(r20.items.map((r: { service_name: string }) => r.service_name)).toEqual(["rpc-gateway"]);
    const refused = await call(h, {
      method: "GET",
      url: `${base}&sort=requests_change`,
      cookie: operator,
    });
    expect(refused.statusCode).toBe(400);
  });

  it("breakdown: withheld values are counted only in groups of cohort_min_tenants, never shown or summed", async () => {
    const url = `/v1/operator/web/breakdown?${RANGE}&tenant_ids=${A.tenantId}&dimension=country`;
    const min = Math.max(
      Number(
        (
          await h.su.query<{ v: number }>(
            `SELECT (value #>> '{}')::int AS v FROM scf.settings WHERE key = 'cohort_min_tenants'`,
          )
        ).rows[0]?.v ?? 5,
      ),
      2,
    );
    // one withheld value (XX): not reported, so 0 and 1 look the same
    const one = (await call(h, { method: "GET", url, cookie: operator })).json();
    expect(one).toMatchObject({
      hidden_rows: null,
      hidden_rows_min: min,
      hidden_total_suppressed: true,
      hidden_by_tenant: [],
    });
    // `min` more withheld values: now reported as a count, still without any value or figure
    for (let i = 0; i < min; i++) await seedBreakdown(h, A, D1, "country", `H${i}`, 1, 1);
    const many = await call(h, { method: "GET", url, cookie: operator });
    expect(many.statusCode, many.body).toBe(200);
    const b = many.json();
    expect(b.hidden_rows).toBe(min + 1);
    expect(b.hidden_by_tenant).toEqual([{ tenant_id: A.tenantId, hidden_rows: min + 1 }]);
    expect(b.rows.map((r: { value: string }) => r.value).sort()).toEqual(["DE", "FR"]);
    expect(JSON.stringify(b)).not.toMatch(/"XX"|"H0"/);
    // the operator metrics API lists the same values and no summary row
    expect(b.rows.every((r: { value: unknown }) => typeof r.value === "string")).toBe(true);
  });

  it("projects page: the registry link with its URL and round; the tenant detail too", async () => {
    const list = await call(h, {
      method: "GET",
      url: `/v1/operator/tenants?q=${A.slug}`,
      cookie: operator,
    });
    expect(list.statusCode, list.body).toBe(200);
    const row = list.json().items.find((r: { tenant_id: string }) => r.tenant_id === A.tenantId);
    expect(row.registry_link).toMatchObject({
      registry_project_id: row.registry_project_ids[0],
      source: "operator",
      source_id: `src-${A.slug}`,
      url: `https://registry.example/src-${A.slug}`,
      award_round: 35,
      award_stage: "t2_testnet",
    });
    const none = (
      await call(h, { method: "GET", url: `/v1/operator/tenants?q=${C.slug}`, cookie: operator })
    ).json();
    expect(none.items[0].registry_link).toBeNull();
    const detail = (
      await call(h, { method: "GET", url: `/v1/operator/tenants/${A.tenantId}`, cookie: operator })
    ).json();
    expect(detail.registry_links[0]).toMatchObject({
      source_url: `https://registry.example/src-${A.slug}`,
      award_round: 35,
      award_stage: "t2_testnet",
      categories: ["developer_tooling", "infrastructure_services"],
    });
    expect(detail.tenant.removal_reason_code).toBeNull();
  });

  it("overview: enrolment counts with deltas; a new tenant moves enrolled and new_this_month; audited", async () => {
    const get = async () => {
      const res = await call(h, { method: "GET", url: "/v1/operator/overview", cookie: operator });
      expect(res.statusCode, res.body).toBe(200);
      return res;
    };
    const first = await get();
    const a = first.json();
    for (const k of ["enrolled", "pending_approval", "new_this_month", "removed_this_month"]) {
      expect(a[k].delta, k).toBe(a[k].value - a[k].previous);
    }
    expect(a.month_start).toBe(`${new Date().toISOString().slice(0, 7)}-01`);
    expect(await auditActions(String(first.headers["x-request-id"]))).toEqual([
      { action: "operator.read.op_enrolment_summary", actor_kind: "operator" },
    ]);
    await seedProject(h, { level: 1 });
    await seedProject(h, { level: 0 });
    const b = (await get()).json();
    expect(b.enrolled.value).toBe(a.enrolled.value + 2);
    expect(b.pending_approval.value).toBe(a.pending_approval.value);
    expect(b.new_this_month.value).toBe(a.new_this_month.value + 2);
    expect(b.enrolled.previous).toBe(a.enrolled.previous); // created this month: not in the start-of-month count
  });
});
