// SPDX-License-Identifier: Apache-2.0
// Operator metrics API `/op/v1` (keys.operator-api-keys, keys.revocation, operator.api-*, operator.web-* machine side): bearer operator keys,
// offline checksum, constant-time hash check, revocation effective within the 5-s cache (C-06), expiry, per-key rate
// limit, scopes per operation, tenant restriction (403 / single project 404), op_* functions under `op_key` context
// with their audit rows, CSV and privacy echo. Every response is validated against operator-metrics.openapi.yaml.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_CACHE_MS } from "../../src/opmetrics/routes.ts";
import { type Harness, operatorSession, startHarness } from "../support/harness.ts";
import {
  callMetrics,
  createOperatorKey,
  METRICS_SCOPES,
  metricsOpenApi,
  type SeededProject,
  type SeededService,
  seedApiHour,
  seedBreakdown,
  seedProject,
  seedService,
  seedWebDay,
} from "../support/op-seed.ts";

let h: Harness;
let admin: string;
let A: SeededProject;
let B: SeededProject;
let svcA: SeededService;
let all: string; // web:read, api:read, registry:read
const D1 = "2026-11-03";
const RANGE = "start=2026-11-03T00:00:00Z&end=2026-11-05T00:00:00Z";

beforeAll(async () => {
  h = await startHarness();
  admin = (await operatorSession(h, "operator_admin")).cookie;
  A = await seedProject(h, { level: 1, awarded: true });
  B = await seedProject(h, { level: 1 });
  await seedWebDay(h, A, D1, { pvVerified: 100, pvRaw: 130, visits: 40, bounces: 10 });
  await seedWebDay(h, B, D1, { pvVerified: 50, pvRaw: 50, visits: 10 });
  await seedBreakdown(h, A, D1, "path", "/docs", 26, 60);
  await seedBreakdown(h, A, D1, "path", "/rare", 4, 4);
  svcA = await seedService(h, A, "soroban-rpc");
  await seedApiHour(h, A, svcA, `${D1}T10:00:00Z`, "/rpc", 200, 40, 3, 0.02);
  all = (await createOperatorKey(h, admin, { scopes: ["web:read", "api:read", "registry:read"] }))
    .key;
});

afterAll(async () => {
  await h?.close();
});

const two = () => `project_ids=${A.tenantId},${B.tenantId}`;

describe("authentication (wire-formats §k, C-06)", () => {
  it("refuses a missing, malformed, wrong-checksum, wrong-secret or URL-borne key with 401", async () => {
    const none = await callMetrics(h, undefined, "/op/v1/me");
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toContain("Bearer");
    expect((await callMetrics(h, "nope", "/op/v1/me")).statusCode).toBe(401);
    const id = all.slice(8, 20);
    const flipped = all.slice(0, 30) + (all[30] === "a" ? "b" : "a") + all.slice(31);
    const bad = await callMetrics(h, flipped, "/op/v1/me");
    expect(bad.statusCode).toBe(401);
    const audit = await h.su.query(
      `SELECT actor_kind, outcome, details FROM scf.audit_log WHERE request_id = $1`,
      [String(bad.headers["x-request-id"])],
    );
    // One aggregated row per process and minute, without the caller-chosen key id.
    expect(audit.rows[0]).toMatchObject({
      actor_kind: "anonymous",
      outcome: "denied",
      details: { count: 1, window_s: 60 },
    });
    expect(JSON.stringify(audit.rows)).not.toContain(id);
    expect(JSON.stringify(audit.rows)).not.toContain(flipped.slice(21));
    // a different secret with a valid checksum for the same id
    const { checksum, newSecret } = await import("../../src/keys/keys.ts");
    const s = newSecret();
    expect(
      (await callMetrics(h, `scfa_op_${id}_${s}${checksum("op", id, s)}`, "/op/v1/me")).statusCode,
    ).toBe(401);
    expect(h.logs.text).not.toContain(all.slice(21));
  });

  it("a key seen in a URL is revoked at once and audited api_key.compromised_url (wire-formats §k, C-119)", async () => {
    const exposed = (await createOperatorKey(h, admin, { scopes: ["web:read"] })).key;
    expect((await callMetrics(h, exposed, "/op/v1/me")).statusCode).toBe(200);
    const inUrl = await h.app.inject({
      method: "GET",
      url: `/op/v1/me?key=${exposed}`,
      headers: { authorization: `Bearer ${exposed}` },
    });
    expect(inUrl.statusCode).toBe(401);
    expect(h.logs.text).not.toContain(exposed.slice(21));
    const row = await h.su.query(
      `SELECT revoked_at, revoke_reason FROM scf.operator_api_keys WHERE key_id = $1`,
      [exposed.slice(8, 20)],
    );
    expect(row.rows[0].revoked_at).not.toBeNull();
    const audit = await h.su.query(`SELECT action FROM scf.audit_log WHERE request_id = $1`, [
      String(inUrl.headers["x-request-id"]),
    ]);
    expect(audit.rows.map((r) => r.action)).toEqual(["api_key.compromised_url"]);
    expect((await callMetrics(h, exposed, "/op/v1/me")).statusCode).toBe(401);
    // a made-up secret with a real id revokes nothing (proof of possession)
    const { checksum, newSecret } = await import("../../src/keys/keys.ts");
    const s = newSecret();
    const id = all.slice(8, 20);
    await h.app.inject({
      method: "GET",
      url: `/op/v1/me?k=scfa_op_${id}_${s}${checksum("op", id, s)}`,
    });
    expect((await callMetrics(h, all, "/op/v1/me")).statusCode).toBe(200);
  });

  it("introspects the key and touches last_used_at", async () => {
    const me = await callMetrics(h, all, "/op/v1/me");
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({
      key_id: all.slice(8, 20),
      scopes: ["api:read", "registry:read", "web:read"],
    });
    expect(me.headers["ratelimit-limit"]).toBe("600");
    const used = await h.su.query(
      `SELECT last_used_at FROM scf.operator_api_keys WHERE key_id = $1`,
      [all.slice(8, 20)],
    );
    expect(used.rows[0].last_used_at).not.toBeNull();
  });

  it(`revocation takes effect within the key cache (${KEY_CACHE_MS} ms, keys.revocation)`, async () => {
    const { key, keyId } = await createOperatorKey(h, admin, { scopes: ["web:read"] });
    expect((await callMetrics(h, key, "/op/v1/me")).statusCode).toBe(200);
    const rv = await h.app.inject({
      method: "POST",
      url: `/v1/operator/api-keys/${keyId}/revoke`,
      headers: { cookie: admin, origin: "https://portal.test", "x-scf-request": "1" },
      payload: { reason: "test" },
    });
    expect(rv.statusCode).toBe(204);
    const t0 = Date.now();
    let status = 200;
    while (status === 200 && Date.now() - t0 < KEY_CACHE_MS + 2000) {
      status = (await callMetrics(h, key, "/op/v1/me")).statusCode;
      if (status === 200) await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe(401);
    expect(Date.now() - t0).toBeLessThanOrEqual(KEY_CACHE_MS + 500);
  });

  it("an expired key is refused and audited once", async () => {
    const { key, keyId } = await createOperatorKey(h, admin, { scopes: ["web:read"] });
    await h.su.query(
      `UPDATE scf.operator_api_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
        WHERE key_id = $1`,
      [keyId],
    );
    const res = await callMetrics(h, key, "/op/v1/me");
    expect(res.statusCode).toBe(401);
    const n = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.audit_log WHERE action = 'api_key.expired' AND target_id = $1`,
      [keyId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("applies the key's rate limit (429 + Retry-After)", async () => {
    const { key } = await createOperatorKey(h, admin, {
      scopes: ["web:read"],
      rate_limit_per_min: 2,
    });
    expect((await callMetrics(h, key, "/op/v1/me")).statusCode).toBe(200);
    expect((await callMetrics(h, key, "/op/v1/me")).statusCode).toBe(200);
    const third = await callMetrics(h, key, "/op/v1/me");
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    expect(third.headers["ratelimit-remaining"]).toBe("0");
  });

  it("answers 503 when the scf_metrics_ro pool is not configured", async () => {
    const h2 = await startHarness({}, { metricsDb: undefined });
    try {
      expect((await callMetrics(h2, all, "/op/v1/me")).statusCode).toBe(503);
    } finally {
      await h2.close();
    }
  });
});

describe("scopes and tenant restriction (keys.operator-api-keys)", () => {
  it("every data operation needs its scope: 403 without it, 200 with it", async () => {
    const keys: Record<string, string> = {};
    for (const s of ["web:read", "api:read", "registry:read"] as const)
      keys[s] = (await createOperatorKey(h, admin, { scopes: [s] })).key;
    const doc = metricsOpenApi();
    let n = 0;
    for (const [opId, scope] of Object.entries(METRICS_SCOPES)) {
      const spec = doc.get(opId);
      let url = spec.path.replace("{projectId}", A.tenantId);
      if (
        spec.validateQuery?.schema &&
        JSON.stringify(spec.validateQuery.schema).includes('"start"')
      )
        url +=
          opId === "metricsGetApiHourly"
            ? "?start=2026-11-03T00:00:00Z&end=2026-11-04T00:00:00Z"
            : `?${RANGE}`;
      if (opId === "metricsGetWebBreakdowns") url += "&dimension=path";
      if (opId === "metricsGetCohorts") url += "&by=round";
      for (const [s, key] of Object.entries(keys)) {
        const res = await callMetrics(h, key, url);
        if (scope === null || scope === s)
          expect(res.statusCode, `${opId} with ${s}: ${res.body}`).toBe(200);
        else expect(res.statusCode, `${opId} with ${s}`).toBe(403);
        n++;
      }
    }
    expect(n).toBe(48);
  });

  it("intersects the tenant restriction: all named outside → 403, a single foreign project → 404", async () => {
    const { key } = await createOperatorKey(h, admin, {
      scopes: ["web:read", "registry:read"],
      tenant_restriction: [A.tenantId],
    });
    const only = await callMetrics(h, key, `/op/v1/web/summary?${RANGE}&${two()}`);
    expect(only.statusCode).toBe(200);
    expect(only.json().data.map((r: { project_id: string }) => r.project_id)).toEqual([A.tenantId]);
    const unfiltered = await callMetrics(h, key, `/op/v1/web/summary?${RANGE}`);
    expect(unfiltered.json().data.map((r: { project_id: string }) => r.project_id)).toEqual([
      A.tenantId,
    ]);
    expect(
      (await callMetrics(h, key, `/op/v1/web/summary?${RANGE}&project_ids=${B.tenantId}`))
        .statusCode,
    ).toBe(403);
    for (const id of [B.tenantId, randomUUID(), "nope"])
      expect((await callMetrics(h, key, `/op/v1/projects/${id}`)).statusCode, id).toBe(404);
    expect((await callMetrics(h, key, `/op/v1/projects/${A.tenantId}`)).json().slug).toBe(A.slug);
  });
});

describe("data operations (op_* functions only, C-17)", () => {
  it("web summary, daily and aggregate are exact and audited under the key", async () => {
    const res = await callMetrics(h, all, `/op/v1/web/summary?${RANGE}&${two()}&variant=raw`);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.privacy).toEqual({
      min_count: 10,
      round_to: 10,
      rounding: "half_up_to_multiple",
      aggregation: "sum_of_unrounded_then_rounded",
      cross_tenant_deduplication: false,
    });
    expect(b.meta).toMatchObject({ min_level: "L1", variant: "raw" });
    expect(b.data[0]).toMatchObject({
      project_id: A.tenantId,
      slug: A.slug,
      scf_awarded: true,
      pageviews: 130,
    });
    expect(res.headers["x-scf-min-count"]).toBe("10");
    const audit = await h.su.query(
      `SELECT action, actor_kind, actor_id FROM scf.audit_log WHERE request_id = $1`,
      [String(res.headers["x-request-id"])],
    );
    expect(audit.rows).toContainEqual({
      action: "operator.read.op_web_metrics",
      actor_kind: "op_key",
      actor_id: all.slice(8, 20),
    });
    const daily = (
      await callMetrics(h, all, `/op/v1/web/daily?${RANGE}&${two()}&group=site`)
    ).json();
    expect(daily.data).toHaveLength(2);
    expect(daily.data[0]).toMatchObject({ day: D1, site_id: A.siteId, is_final: true });
    const agg = (await callMetrics(h, all, `/op/v1/web/aggregate?${RANGE}&${two()}`)).json();
    expect(agg.data).toEqual([expect.objectContaining({ day: D1, projects: 2, pageviews: 150 })]);
  });

  it("a key without registry:read gets rows without project labels", async () => {
    const { key } = await createOperatorKey(h, admin, { scopes: ["web:read"] });
    const res = await callMetrics(h, key, `/op/v1/web/summary?${RANGE}&${two()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].slug).toBeUndefined();
    expect(
      (await callMetrics(h, key, `/op/v1/web/summary?${RANGE}&scf_awarded=true`)).statusCode,
    ).toBe(403);
  });

  it("breakdown rows are thresholded and rounded; API rows carry percentiles, accuracy class and the label", async () => {
    const bd = (
      await callMetrics(
        h,
        all,
        `/op/v1/web/breakdowns?${RANGE}&project_ids=${A.tenantId}&dimension=path`,
      )
    ).json();
    expect(bd.data).toEqual([
      expect.objectContaining({ value: "/docs", visitors_sum: 30, pageviews: 60 }),
    ]);
    const api = await callMetrics(
      h,
      all,
      `/op/v1/api/summary?${RANGE}&project_ids=${A.tenantId}&group=route`,
    );
    expect(api.statusCode, api.body).toBe(200);
    expect(api.json().meta.label).toBe("self-attested telemetry");
    expect(api.json().data[0]).toMatchObject({
      route: "/rpc",
      requests: 40,
      status_2xx: 40,
      accuracy_class: "explicit15",
      service_id: svcA.serviceId,
    });
    expect(api.json().data[0].p95_ms).toBeGreaterThan(10);
    expect(api.json().data[0].p95_ms).toBeLessThanOrEqual(25);
    const hourly = (
      await callMetrics(
        h,
        all,
        `/op/v1/api/hourly?start=2026-11-03T00:00:00Z&end=2026-11-04T00:00:00Z&project_ids=${A.tenantId}`,
      )
    ).json();
    expect(hourly.data[0].bucket_start).toBe(`${D1}T10:00:00.000Z`);
    const tooLong = await callMetrics(
      h,
      all,
      `/op/v1/api/hourly?start=2026-09-01T00:00:00Z&end=2026-11-04T00:00:00Z`,
    );
    expect(tooLong.statusCode).toBe(400);
  });

  it("CSV by Accept header or format=csv, with a Link header for the next page", async () => {
    const csv = await callMetrics(
      h,
      all,
      `/op/v1/web/summary?${RANGE}&${two()}&format=csv&limit=1`,
    );
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toContain("project_id");
    expect(lines).toHaveLength(2);
    expect(String(csv.headers.link)).toMatch(/cursor=.*rel="next"/);
    const viaAccept = await callMetrics(h, all, `/op/v1/projects?${two()}`, { accept: "text/csv" });
    expect(viaAccept.headers["content-type"]).toContain("text/csv");
    expect((await callMetrics(h, all, "/op/v1/me", { accept: "image/png" })).statusCode).toBe(406);
  });

  it("lists projects (filters, sort) and the public registry with linked projects", async () => {
    const p = (await callMetrics(h, all, `/op/v1/projects?${two()}&scf_awarded=true`)).json();
    expect(p.data.map((x: { project_id: string }) => x.project_id)).toEqual([A.tenantId]);
    expect(p.data[0].registry_project_ids).toHaveLength(1);
    const reg = await callMetrics(h, all, `/op/v1/registry/projects?q=${A.slug}`);
    expect(reg.statusCode, reg.body).toBe(200);
    expect(reg.json().data[0].linked_project_ids).toEqual([A.tenantId]);
  });
});
