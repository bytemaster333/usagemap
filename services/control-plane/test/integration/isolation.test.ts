// SPDX-License-Identifier: Apache-2.0
// HTTP isolation matrix generated from the OpenAPI document (ADR-0013, C-87, C-89): every public-listener operation ×
// caller (anonymous, stranger, each tenant role) × tenant id (own, foreign, unknown, malformed); and, for every built
// operation, every other path identifier (own, foreign, unknown, malformed). Expected outcomes come from
// `x-required-role` alone. Operations not built yet are covered up to their authorisation checks (then 501).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperationSpec } from "../../src/http/openapi.ts";
import { type Limit, RateLimiter } from "../../src/http/ratelimit.ts";
import { API_BODIES, apiFixtures } from "../support/api-seed.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  operatorSession,
  signInGithub,
  startHarness,
} from "../support/harness.ts";
import {
  callMetrics,
  createOperatorKey,
  METRICS_SCOPES,
  metricsOpenApi,
} from "../support/op-seed.ts";

type Role = "owner" | "admin" | "member" | "viewer";
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

let h: Harness;
const cookies = {} as Record<Role | "stranger", string>;
let tenantA = "";
let tenantB = "";
const own: Record<string, string> = {};
const foreign: Record<string, string> = {};
let built: Set<string>;

/** A value that passes the parameter schema without naming anything that exists. */
function sample(name: string, schema: Record<string, unknown>): string {
  if (schema.format === "uuid") return randomUUID();
  const fixed: Record<string, string> = {
    credentialId: "A".repeat(43),
    tokenId: "Abcdefghijk1",
    keyId: "Abcdefghijk1",
    slug: "no-such-slug",
    key: "no_such_key",
  };
  if (fixed[name]) return fixed[name] as string;
  throw new Error(`no sample for ${name}`);
}

function querySample(op: OperationSpec): string {
  // Required query parameters get schema-valid values, so the request reaches the authorisation checks.
  const item = h.openapi.doc.paths[op.path] as Record<string, Record<string, unknown>>;
  const params = ((item[op.method]?.parameters as Array<Record<string, unknown>>) ?? []).map((p) =>
    typeof p.$ref === "string"
      ? (h.openapi.doc.components.parameters as Record<string, Record<string, unknown>>)[
          p.$ref.split("/").pop() as string
        ]
      : p,
  );
  const q = new URLSearchParams();
  for (const p of params) {
    if (p?.in !== "query" || p.required !== true) continue;
    const s = (p.schema ?? {}) as Record<string, unknown>;
    const v = Array.isArray(s.enum)
      ? String(s.enum[0])
      : s.format === "date-time"
        ? "2026-11-01T00:00:00Z"
        : s.format === "date"
          ? "2026-11-01"
          : s.type === "integer"
            ? String(s.minimum ?? 1)
            : s.format === "uuid" ||
                (s.type === "array" && (s.items as Record<string, unknown>)?.format === "uuid")
              ? Array.from({ length: Number(s.minItems ?? 1) }, () => randomUUID()).join(",")
              : "x";
    q.set(String(p.name), v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

function url(op: OperationSpec, values: Record<string, string>): string {
  return op.path.replace(/\{([^}]+)\}/g, (_m, n: string) => values[n] ?? n) + querySample(op);
}

function paramSchema(op: OperationSpec, name: string): Record<string, unknown> {
  const item = h.openapi.doc.paths[op.path] as Record<string, Record<string, unknown>>;
  const ps = ((item[op.method]?.parameters as Array<Record<string, unknown>>) ?? []).map((p) =>
    typeof p.$ref === "string"
      ? (h.openapi.doc.components.parameters as Record<string, Record<string, unknown>>)[
          p.$ref.split("/").pop() as string
        ]
      : p,
  );
  return (ps.find((p) => p?.name === name)?.schema ?? {}) as Record<string, unknown>;
}

function samples(op: OperationSpec, tenant: string): Record<string, string> {
  const v: Record<string, string> = { tenantId: tenant };
  for (const n of op.pathParams) if (n !== "tenantId") v[n] = sample(n, paramSchema(op, n));
  return v;
}

const minRole = (op: OperationSpec): Role | undefined => {
  const r = op.roles.filter((x) => x.startsWith("tenant:")).map((x) => x.slice(7) as Role);
  return r.length ? r.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b)) : undefined;
};

/** Bodies that pass validation for built operations, so a foreign identifier is what decides the answer. */
const ERASURE_RANGE = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" };
const BODIES: Record<string, (ids: Record<string, string>) => unknown> = {
  ...API_BODIES,
  createErasureRequest: (ids) => ({ site_id: ids.siteId ?? randomUUID(), criteria: ERASURE_RANGE }),
  updateMember: () => ({ role: "viewer" }),
  updateSite: () => ({ name: "renamed" }),
  setSiteAnonymousReports: () => ({ anonymous_reports: true }),
  addDomain: () => ({ host: `iso-${randomUUID().slice(0, 8)}.example` }),
  transferOwnership: (ids) => ({ new_owner_user_id: ids.userId ?? randomUUID() }),
  startDomainVerification: () => ({ method: "dns_txt" }),
  revokeTractionSnapshot: () => ({ reason: "isolation" }),
  setSiteDebugMode: () => ({ enabled: true, duration_minutes: 5 }),
  verifyFootprintItem: () => ({ method: "deployer_admin_match" }),
};

/**
 * The matrix sends every operation for every role from a handful of signed-in users, well over the production limit
 * of 600 requests per user and minute. Only that per-user session bucket (`s:<userId>`) is widened here; every other
 * limit (anonymous, creation, footprint keys, registry search) applies exactly as in production, and the production
 * limits themselves are unchanged (pipeline.ts `limitsFor`, covered by the unit tests).
 */
class MatrixLimiter extends RateLimiter {
  override hit(limits: readonly Limit[]) {
    return super.hit(
      limits.map((l) => (l.key.startsWith("s:") ? { ...l, limit: l.limit * 100 } : l)),
    );
  }
}

beforeAll(async () => {
  h = await startHarness({}, { limiter: new MatrixLimiter() });
  cookies.owner = await signInGithub(h, newGithubUser());
  tenantA = await createTenant(h, cookies.owner);
  for (const role of ["admin", "member", "viewer"] as const) {
    const inv = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${tenantA}/invitations`,
        cookie: cookies.owner,
        body: { role },
      })
    ).json();
    cookies[role] = await signInGithub(h, newGithubUser());
    expect(
      (
        await call(h, {
          method: "POST",
          url: "/v1/invitations/accept",
          cookie: cookies[role],
          body: { code: inv.code },
        })
      ).statusCode,
    ).toBe(200);
  }
  cookies.stranger = await signInGithub(h, newGithubUser());
  tenantB = await createTenant(h, cookies.stranger);

  for (const [t, c, bag] of [
    [tenantA, cookies.owner, own],
    [tenantB, cookies.stranger, foreign],
  ] as const) {
    const site = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: c,
        body: { name: "S" },
      })
    ).json();
    bag.siteId = site.site_id;
    bag.domainId = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites/${site.site_id}/domains`,
        cookie: c,
        body: { host: `d-${randomUUID().slice(0, 8)}.example` },
      })
    ).json().domain_id;
    bag.verificationId = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites/${site.site_id}/domains/${bag.domainId}/verifications`,
        cookie: c,
        body: { method: "dns_txt" },
      })
    ).json().verification_id;
    bag.invitationId = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/invitations`,
        cookie: c,
        body: { role: "viewer" },
      })
    ).json().invitation_id;
    bag.userId = (await call(h, { method: "GET", url: "/v1/me", cookie: c })).json().user_id;
    await apiFixtures(h, c, t, bag);
    bag.keyId = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/share-keys`,
        cookie: c,
        body: { label: "iso" },
      })
    ).json().key_id;
    const snap = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/traction-snapshots`,
      cookie: c,
      body: { period_start: "2026-09-01T00:00:00Z", period_end: "2026-10-01T00:00:00Z" },
    });
    expect(snap.statusCode, snap.body).toBe(201);
    bag.snapshotId = snap.json().snapshot.snapshot_id;
    // C-136: a footprint item (a contract) per tenant, so itemId has an own and a foreign value
    bag.itemId = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/footprint`,
        cookie: c,
        body: {
          kind: "contract",
          subject: `C${randomUUID()
            .replace(/-/g, "")
            .toUpperCase()
            .replace(/[0189]/g, "A")
            .padEnd(55, "B")
            .slice(0, 55)}`,
          network: "testnet",
        },
      })
    ).json().item_id;
    bag.requestId = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/erasure-requests`,
        cookie: c,
        body: { site_id: bag.siteId, criteria: ERASURE_RANGE },
      })
    ).json().request_id;
  }
  built = h.built;
});
afterAll(async () => {
  // Leave no work in the shared erasure queue for later files (their workers' runOnce counts every due request); the
  // matrix creates one request per tenant and confirms none.
  if (h && tenantA)
    await h.su.query(
      `UPDATE scf.erasure_requests SET status = 'cancelled', finished_at = now()
        WHERE tenant_id = ANY ($1::uuid[]) AND status IN ('previewing', 'previewed', 'confirmed', 'running')`,
      [[tenantA, tenantB].filter(Boolean)],
    );
  await h?.close();
});

const ops = () => h.openapi.operations.filter((o) => !o.internal && !o.roles.includes("public"));

describe("isolation matrix", () => {
  it("anonymous callers get 401 on every non-public operation", async () => {
    let n = 0;
    for (const op of ops()) {
      const res = await call(h, {
        method: op.method.toUpperCase() as "GET",
        url: url(op, samples(op, tenantA)),
      });
      expect(res.statusCode, `${op.operationId}`).toBe(401);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });

  it("a foreign, unknown or malformed tenant id is the same 404 for every tenant-scoped operation and caller", async () => {
    const tenantOps = ops().filter((o) => o.pathParams.includes("tenantId") && minRole(o));
    expect(tenantOps.length).toBeGreaterThan(50);
    for (const op of tenantOps) {
      for (const who of ["owner", "viewer"] as const) {
        const m = op.method.toUpperCase() as "GET";
        const foreignRes = await call(h, {
          method: m,
          url: url(op, samples(op, tenantB)),
          cookie: cookies[who],
        });
        expect(foreignRes.statusCode, `${op.operationId} foreign as ${who}`).toBe(404);
        const unknownRes = await call(h, {
          method: m,
          url: url(op, samples(op, randomUUID())),
          cookie: cookies[who],
        });
        expect(unknownRes.statusCode, `${op.operationId} unknown`).toBe(404);
        expect({ ...unknownRes.json(), request_id: "" }).toEqual({
          ...foreignRes.json(),
          request_id: "",
        });
        const bad = await call(h, {
          method: m,
          url: url(op, { ...samples(op, tenantA), tenantId: "not-a-uuid" }),
          cookie: cookies[who],
        });
        expect(bad.statusCode, `${op.operationId} malformed`).toBe(404);
      }
    }
  });

  it("each tenant role gets 403 below the operation's minimum role and passes authorisation at or above it", async () => {
    for (const op of ops().filter((o) => minRole(o))) {
      const min = minRole(op) as Role;
      for (const role of ["viewer", "member", "admin", "owner"] as const) {
        const res = await call(h, {
          method: op.method.toUpperCase() as "GET",
          url: url(op, samples(op, tenantA)),
          cookie: cookies[role],
        });
        if (RANK[role] < RANK[min]) {
          expect(res.statusCode, `${op.operationId} as ${role}`).toBe(403);
          expect(res.json().code).toBe("forbidden");
        } else {
          expect(
            [401, 403],
            `${op.operationId} as ${role}: ${res.body.slice(0, 200)}`,
          ).not.toContain(res.statusCode);
          if (op.pathParams.length === 1 && res.statusCode === 404)
            throw new Error(`${op.operationId} as ${role}: own tenant 404`);
        }
      }
    }
  });

  it("built operations answer the same 404 for another tenant's, an unknown and a malformed identifier", async () => {
    let cases = 0;
    for (const op of ops().filter(
      (o) =>
        built.has(o.operationId) &&
        minRole(o) !== undefined &&
        o.pathParams.includes("tenantId") &&
        o.pathParams.length > 1,
    )) {
      const m = op.method.toUpperCase() as "GET";
      const subs = op.pathParams.filter((p) => p !== "tenantId");
      for (const p of subs) {
        const ownIds = Object.fromEntries(subs.map((s) => [s, own[s] as string]));
        const variants: Array<[string, Record<string, string>, number]> = [
          ["foreign", { ...ownIds, [p]: foreign[p] as string }, 404],
          ["unknown", { ...ownIds, [p]: randomUUID() }, 404],
          ["malformed", { ...ownIds, [p]: "nope" }, 404],
        ];
        for (const [label, ids, expected] of variants) {
          const body = BODIES[op.operationId]?.(ids);
          const res = await call(h, {
            method: m,
            url: url(op, { tenantId: tenantA, ...ids }),
            cookie: cookies.owner,
            ...(body !== undefined ? { body } : {}),
          });
          expect(res.statusCode, `${op.operationId} ${p} ${label}: ${res.body.slice(0, 200)}`).toBe(
            expected,
          );
          cases++;
        }
      }
    }
    // Body identifiers are tenant-checked too (C-87): a member of another tenant cannot become owner here.
    const transfer = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenantA}/ownership-transfer`,
      cookie: cookies.owner,
      body: { new_owner_user_id: foreign.userId },
    });
    expect(transfer.statusCode).toBe(404);
    expect(cases).toBeGreaterThan(20);
    // Nothing of tenant B changed through any of this.
    const b = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenantB}/sites/${foreign.siteId}`,
        cookie: cookies.stranger,
      })
    ).json();
    expect(b.name).toBe("S");
    expect(b.domains).toHaveLength(1);
  });

  it("web reports (funnel, goals, journey): another tenant's site is the same 404 as an unknown one, with valid parameters", async () => {
    const reports: Array<[string, string]> = [
      ["getWebFunnelReport", "funnel?range=7d&step=path:/&step=event:signup&window=30"],
      ["getWebGoalsReport", "goals?range=7d&goal=path:/pricing&goal=event:signup"],
      ["getWebJourneyReport", "journey?range=7d&steps=3&start_step=path:/"],
    ];
    for (const [opId, q] of reports) {
      expect(built.has(opId), opId).toBe(true);
      const at = (siteId: string, who: "owner" | "viewer" = "owner") =>
        call(h, {
          method: "GET",
          url: `/v1/tenants/${tenantA}/sites/${siteId}/web/reports/${q}`,
          cookie: cookies[who],
        });
      const foreignRes = await at(foreign.siteId as string);
      const unknownRes = await at(randomUUID());
      expect(foreignRes.statusCode, `${opId} foreign`).toBe(404);
      expect(unknownRes.statusCode, `${opId} unknown`).toBe(404);
      expect({ ...foreignRes.json(), request_id: "" }).toEqual({
        ...unknownRes.json(),
        request_id: "",
      });
      // B's own site through B's tenant id but A's session: 404 as well
      const crossTenant = await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenantB}/sites/${foreign.siteId}/web/reports/${q}`,
        cookie: cookies.viewer,
      });
      expect(crossTenant.statusCode, `${opId} cross-tenant`).toBe(404);
      // the own site passes every check up to the engine, which this harness does not have: 503
      expect((await at(own.siteId as string, "viewer")).statusCode, `${opId} own`).toBe(503);
    }
  });

  it("SCF-operator operations: 403 for tenant members, operator_admin ones 403 for an operator", async () => {
    const operator = (await operatorSession(h, "operator")).cookie;
    const opOps = ops().filter(
      (o) => o.roles.includes("operator") || o.roles.includes("operator_admin"),
    );
    expect(opOps.length).toBeGreaterThan(30);
    for (const op of opOps) {
      const u = url(op, samples(op, tenantA));
      const m = op.method.toUpperCase() as "GET";
      const asOwner = await call(h, { method: m, url: u, cookie: cookies.owner });
      expect(asOwner.statusCode, `${op.operationId} as tenant owner`).toBe(403);
      const asOperator = await call(h, { method: m, url: u, cookie: operator });
      if (op.roles.includes("operator_admin") && !op.roles.includes("operator"))
        expect(asOperator.json().code, `${op.operationId} as operator`).toBe("forbidden");
      else expect([401, 403], `${op.operationId} as operator`).not.toContain(asOperator.statusCode);
    }
  });

  it("operator tenant operations answer 404 for an unknown or malformed tenant id", async () => {
    const admin = (await operatorSession(h, "operator_admin")).cookie;
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/v1/operator/tenants/{id}/transitions", { action: "suspend", reason: "x" }],
      ["POST", "/v1/operator/tenants/{id}/removal", { reason: "x" }],
      ["POST", "/v1/operator/tenants/{id}/removal", { reason: "x", reason_code: "spam" }],
      ["POST", "/v1/operator/tenants/{id}/restoration", { reason: "x" }],
      ["POST", "/v1/operator/tenants/{id}/purge", { reason: "x" }],
      ["POST", "/v1/operator/tombstones/{id}/lift", undefined],
      ["POST", "/v1/operator/tenants/{id}/approval", { note: "x" }],
      [
        "POST",
        "/v1/operator/tenants/{id}/annotations",
        { start: "2026-11-01T00:00:00Z", end: "2026-11-02T00:00:00Z", body: "x" },
      ],
      ["PUT", `/v1/operator/tenants/{id}/registry-links/${randomUUID()}`, { decision: "confirm" }],
    ];
    for (const [m, path, body] of cases) {
      for (const id of [randomUUID(), "nope"]) {
        const res = await call(h, {
          method: m as "POST",
          url: path.replace("{id}", id),
          cookie: admin,
          ...(body !== undefined ? { body } : {}),
        });
        // lifting an unknown tombstone changes nothing (idempotent 204); a malformed id is 404
        const expected = path.includes("tombstones") && id !== "nope" ? 204 : 404;
        expect(res.statusCode, `${path} ${id}`).toBe(expected);
      }
    }
  });

  it("identities and passkeys of another user are 404", async () => {
    const other = (
      await call(h, { method: "GET", url: "/v1/me/identities", cookie: cookies.stranger })
    ).json()[0].identity_id;
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/me/identities/${other}`,
          cookie: cookies.viewer,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/me/passkeys/${"B".repeat(43)}`,
          cookie: cookies.viewer,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("operator metrics API: bearer operator keys only, every operation's scope as documented", async () => {
    const doc = metricsOpenApi();
    const item = (o: OperationSpec) =>
      (doc.doc.paths[o.path] as Record<string, Record<string, unknown>>)[o.method] ?? {};
    // The scope table used by the tests is exactly the document's x-required-scope (no operation left out).
    expect(
      Object.fromEntries(
        doc.operations.map((o) => [o.operationId, item(o)["x-required-scope"] ?? null]),
      ),
    ).toEqual(METRICS_SCOPES);
    const admin = (await operatorSession(h, "operator_admin")).cookie;
    const wrongKind = `scfa_ing_${"A".repeat(12)}_${"0".repeat(33)}`;
    const keys = {
      web: (await createOperatorKey(h, admin, { scopes: ["web:read"] })).key,
      api: (await createOperatorKey(h, admin, { scopes: ["api:read"] })).key,
      registry: (await createOperatorKey(h, admin, { scopes: ["registry:read"] })).key,
    };
    let n = 0;
    for (const op of doc.operations) {
      const u = op.path.replace("{projectId}", tenantA);
      // no key, a session cookie (tenant owner or SCF operator), a key of another kind: 401
      // One client subnet per operation: failed authentications are limited per subnet.
      const from = `10.9.${n}.1`;
      expect(
        (await callMetrics(h, undefined, u, {}, from)).statusCode,
        `${op.operationId} anonymous`,
      ).toBe(401);
      for (const cookie of [cookies.owner, admin]) {
        const r = await h.app.inject({
          method: "GET",
          url: u,
          headers: { cookie: cookie as string },
          remoteAddress: from,
        });
        expect(r.statusCode, `${op.operationId} with a session cookie`).toBe(401);
      }
      expect(
        (await callMetrics(h, wrongKind, u, {}, from)).statusCode,
        `${op.operationId} ing key`,
      ).toBe(401);
      // a valid key without the operation's scope: 403 before any parameter or project is looked at
      const scope = METRICS_SCOPES[op.operationId];
      if (scope) {
        const other = Object.entries(keys).find(([k]) => `${k}:read` !== scope)?.[1] as string;
        expect(
          (await callMetrics(h, other, u)).statusCode,
          `${op.operationId} without ${scope}`,
        ).toBe(403);
      }
      n++;
    }
    expect(n).toBe(16);
    // a single project: foreign-to-the-restriction, unknown and malformed ids are the same 404
    const restricted = (
      await createOperatorKey(h, admin, {
        scopes: ["registry:read"],
        tenant_restriction: [tenantA],
      })
    ).key;
    const bodies = [];
    for (const id of [tenantB, randomUUID(), "nope"]) {
      const r = await callMetrics(h, restricted, `/op/v1/projects/${id}`);
      expect(r.statusCode, id).toBe(404);
      bodies.push({ ...r.json(), request_id: "" });
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });
});

// Footprint registration keys `scfa_reg_…` (migration 0081): role `footprint_key` is one operation
// (registerFootprintContract) for the key's own tenant. Another tenant's path is the same 404 as an unknown tenant; the
// key opens no other public-listener operation of any tenant (401, as for an anonymous caller).
describe("isolation matrix: footprint registration keys", () => {
  it("answer for their own tenant only and open nothing else", async () => {
    const keyOf = async (t: string, cookie: string) => {
      const r = await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/footprint-keys`,
        cookie,
        body: { label: "iso" },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().key as string;
    };
    const keyA = await keyOf(tenantA, cookies.owner);
    const keyB = await keyOf(tenantB, cookies.stranger);
    const register = (key: string, t: string) =>
      call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/footprint/register`,
        noCsrf: true,
        headers: { authorization: `Bearer ${key}` },
        body: { subject: `C${"A".repeat(55)}`, network: "testnet" },
      });
    const foreignRes = await register(keyA, tenantB);
    const unknownRes = await register(keyA, randomUUID());
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect({ ...foreignRes.json(), request_id: "" }).toEqual({
      ...unknownRes.json(),
      request_id: "",
    });
    expect((await register(keyB, tenantA)).statusCode).toBe(404);
    expect((await register(keyA, "not-a-uuid")).statusCode).toBe(404);
    let n = 0;
    for (const op of ops().filter((o) => !o.roles.includes("footprint_key"))) {
      // alternately the key's own tenant and another one (one request per operation: the per-subnet limit)
      const t = n % 2 === 0 ? tenantA : tenantB;
      const body = BODIES[op.operationId]?.(own);
      const res = await call(h, {
        method: op.method.toUpperCase() as "GET",
        url: url(op, samples(op, t)),
        headers: { authorization: `Bearer ${keyA}` },
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.statusCode, `${op.operationId} with a footprint key`).toBe(401);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });
});
