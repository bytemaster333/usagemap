// SPDX-License-Identifier: Apache-2.0
// Secret-seed leak warning (migration 0072; wire-formats §h.3 `route_seed_redacted`): the tenant-wide count of API data
// points whose request path held a Stellar secret seed, per service, since the last acknowledgement; viewers read it,
// admins acknowledge it (audited); seeds seen after the acknowledgement on the same UTC day raise it again; another
// tenant's counters never show.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createService } from "../support/api-seed.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const DAY = 86_400_000;
const ZERO = "00000000-0000-0000-0000-000000000000";
let h: Harness;
let owner = "";
let viewer = "";
let stranger = "";
let tenant = "";
let other = "";
let svcA = "";
let svcB = "";
let otherSvc = "";
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

async function counter(t: string, svc: string, d: string, reason: string, n: number) {
  await h.su.query(
    `INSERT INTO scf.api_ingest_counters (tenant_id, day, service_id, reason, count) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, day, service_id, reason) DO UPDATE SET count = scf.api_ingest_counters.count + EXCLUDED.count`,
    [t, d, svc, reason, n],
  );
}

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  await h.su.query(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'domain', 'seed-warning.example')`,
    [tenant],
  );
  svcA = await createService(h, owner, tenant, "horizon-proxy");
  svcB = await createService(h, owner, tenant, "anchor-api");
  const inv = (
    await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/invitations`,
      cookie: owner,
      body: { role: "viewer" },
    })
  ).json();
  viewer = await signInGithub(h, newGithubUser());
  await call(h, {
    method: "POST",
    url: "/v1/invitations/accept",
    cookie: viewer,
    body: { code: inv.code },
  });
  stranger = await signInGithub(h, newGithubUser());
  other = await createTenant(h, stranger);
  otherSvc = await createService(h, stranger, other, "other-api");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const get = (cookie: string, t = tenant) =>
  call(h, { method: "GET", url: `/v1/tenants/${t}/secret-seed-warning`, cookie });
const ack = (cookie: string, t = tenant) =>
  call(h, { method: "POST", url: `/v1/tenants/${t}/secret-seed-warning/acknowledge`, cookie });

describe("secret-seed warning", () => {
  it("is empty without seeds, even with other redactions", async () => {
    await counter(tenant, svcA, day(-1), "route_redacted", 9);
    const r = await get(viewer);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      count: 0,
      since: null,
      last_seen: null,
      acknowledged_at: null,
      services: [],
    });
  });

  it("sums route_seed_redacted over days and services, largest service first", async () => {
    await counter(tenant, svcA, day(-10), "route_seed_redacted", 2);
    await counter(tenant, svcB, day(-3), "route_seed_redacted", 5);
    await counter(tenant, svcA, day(0), "route_seed_redacted", 1);
    await counter(tenant, ZERO, day(-2), "route_seed_redacted", 1); // not attributable to a service
    await counter(other, otherSvc, day(-1), "route_seed_redacted", 100); // another tenant: never shown
    const r = (await get(viewer)).json();
    expect(r.count).toBe(9);
    expect(r.since).toBe(day(-10));
    expect(r.last_seen).toBe(day(0));
    expect(r.services).toEqual([
      { service_id: svcB, service_name: "anchor-api", count: 5 },
      { service_id: svcA, service_name: "horizon-proxy", count: 3 },
      { service_id: ZERO, service_name: null, count: 1 },
    ]);
    // nothing but counts: no route, no value
    expect(JSON.stringify(r)).not.toMatch(/route|redacted/i);
  });

  it("is acknowledged by an admin only, audited, and raised again by later seeds of the same day", async () => {
    expect((await ack(viewer)).statusCode).toBe(403);
    const a = await ack(owner);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ count: 0, since: null, last_seen: null, services: [] });
    expect(a.json().acknowledged_at).not.toBeNull();
    const audit = await h.su.query<{ details: { fields: string[] } }>(
      `SELECT details FROM scf.audit_log WHERE tenant_id = $1 AND action = 'tenant.updated' ORDER BY seq DESC LIMIT 1`,
      [tenant],
    );
    expect(audit.rows[0]?.details.fields).toEqual(["secret_seed_warning"]);

    await counter(tenant, svcB, day(0), "route_seed_redacted", 2); // after the acknowledgement, same UTC day
    const r = (await get(viewer)).json();
    expect(r.count).toBe(2);
    expect(r.since).toBe(day(0));
    expect(r.services).toEqual([{ service_id: svcB, service_name: "anchor-api", count: 2 }]);
  });

  it("answers another tenant's id with the same 404 as an unknown one", async () => {
    expect((await get(owner, other)).statusCode).toBe(404);
    expect((await ack(owner, other)).statusCode).toBe(404);
    expect((await get(owner, crypto.randomUUID())).statusCode).toBe(404);
    // the other tenant's own view is untouched by our acknowledgement
    expect((await get(stranger, other)).json().count).toBe(100);
  });
});
