// SPDX-License-Identifier: Apache-2.0
// Contract tests of the adapter against our pinned Umami image BEHIND THE REAL ENGINE PROXY with mutual TLS
// (wire-formats §c.5, §j; S-01 items 1, 3, 5, 6). Each call uses the certificate of the role that makes it in
// production: provisioner (B1–B5, P1–P13, visit-token purge), reader (R1–R5), edge (POST /api/send).
// The suite is ordered: bootstrap → provisioning → events → reads → isolation → rotation → deletion → purge.

import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  HttpClient,
  purgeTenantEngine,
  type Range,
  SEED_ADMIN_PASSWORD,
  SEED_ADMIN_USERNAME,
  type TenantEngineIdentity,
  UmamiConflictError,
  UmamiHttpError,
  UmamiProvisioner,
  UmamiReader,
  visitTokenPurgeOnEveryCore,
} from "../../src/index.ts";
import { engineTools, waitForGate } from "../support/engine-stack.ts";

const info = inject("engine");
const tools = engineTools(info);
/** Provisioning identity (job umami_reconcile). */
const http = tools.client("provisioner");
/** Live-window reader (the control plane's reader certificate). */
const readHttp = tools.client("reader");
const prov = new UmamiProvisioner(http);
const reader = new UmamiReader(readHttp);

const secrets = {
  seedInterimPassword: randomBytes(18).toString("base64url"),
  provisioningUsername: info.provisionerUser,
  provisioningPassword: info.provisionerPassword,
};
const DAY_MS = 86_400_000;
// Yesterday 00:00 UTC: the run does not depend on the time of day (as in S-01).
const D = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
const at = (h: number, m: number, s = 0) => D + ((h * 60 + m) * 60 + s) * 1000;

let adminToken = "";
let tenantA: TenantEngineIdentity;
let tenantB: TenantEngineIdentity;
const tenantAId = randomUUID();
const tenantBId = randomUUID();
const mainA = randomUUID();
const twinA = randomUUID();
const mainB = randomUUID();

/** A client that "crashes" (throws) right after the B2 password change succeeded: simulates a restart mid-bootstrap. */
class CrashAfterB2 extends HttpClient {
  override async expect(
    opts: Parameters<HttpClient["expect"]>[0],
    ok?: readonly number[],
  ): Promise<unknown> {
    const body = await super.expect(opts, ok);
    if (opts.template === "/api/me/password") throw new Error("simulated crash after B2");
    return body;
  }
}

/** An edge forwarder's event through the engine proxy (wire-formats §c.2), with the edge certificate. */
function send(
  website: string,
  ms: number,
  tag: "v" | "s",
  surrogate: string,
  extra: {
    url?: string;
    name?: string;
    referrer?: string;
    userAgent?: string;
    visit?: "track" | "none";
  } = {},
): Promise<number> {
  return tools.sendEvent(website, { tag, ts: ms, surrogate, ...extra });
}

const fullDay: Range = { start: D, end: D + DAY_MS };

describe("Umami adapter contract (wire-formats §j)", () => {
  beforeAll(async () => {
    // R5 for the provisioner, which the proxy lets through while its gate is closed.
    expect(await new UmamiReader(http).heartbeat()).toBe(true);
  });

  it("bootstrap resumes after a crash between B2 and B3 (C-112(7))", async () => {
    const crashing = new UmamiProvisioner(
      new CrashAfterB2({
        baseUrl: info.proxyUrl,
        tls: { ...info.provisioner, ca: info.ca },
        timeoutMs: 15_000,
      }),
    );
    // Before B5 the proxy's gate is closed: a reader is refused with 503.
    expect(
      (await readHttp.call({ method: "GET", path: "/api/heartbeat", template: "/api/heartbeat" }))
        .status,
    ).toBe(503);
    await expect(crashing.ensureBootstrap(secrets)).rejects.toThrow(/simulated crash after B2/);
    // The seed admin's password is now the interim one.
    expect(await prov.login(SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD)).toBeNull();

    const first = await prov.ensureBootstrap(secrets);
    expect(first.performed).toEqual(["B1", "B3", "B4", "B5"]);
    adminToken = first.token;

    const again = await prov.ensureBootstrap(secrets);
    expect(again.performed).toEqual(["B5"]);
    // B5: the seed admin is gone, with either password.
    expect(await prov.login(SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD)).toBeNull();
    expect(await prov.login(SEED_ADMIN_USERNAME, secrets.seedInterimPassword)).toBeNull();
    await waitForGate(tools);
    expect(await reader.heartbeat()).toBe(true); // R5 through the open gate
  });

  it("enforces the per-role allow-lists of the proxy (§c.5)", async () => {
    const edge = tools.client("edge");
    const status = async (c: HttpClient, method: "GET" | "POST", path: string, body?: unknown) =>
      (
        await c.call({
          method,
          path,
          template: path,
          bearer: adminToken,
          ...(body ? { body } : {}),
        })
      ).status;
    // A reader cannot provision, an edge cannot read, a provisioner cannot read tenant figures.
    expect(await status(readHttp, "POST", "/api/users", { username: "x", password: "y" })).toBe(
      403,
    );
    expect(await status(readHttp, "GET", "/api/admin/websites")).toBe(403);
    expect(
      await status(
        edge,
        "GET",
        `/api/websites/${randomUUID()}/stats?startAt=1&endAt=2&timezone=UTC`,
      ),
    ).toBe(403);
    expect(
      await status(
        http,
        "GET",
        `/api/websites/${randomUUID()}/stats?startAt=1&endAt=2&timezone=UTC`,
      ),
    ).toBe(403);
    // Only the documented read parameters pass (no `period`, no other filter).
    expect(
      await status(
        readHttp,
        "GET",
        `/api/websites/${randomUUID()}/stats?startAt=1&endAt=2&timezone=UTC&period=day`,
      ),
    ).toBe(403);
    // The deny-list applies to everyone, the provisioner included.
    expect(await status(http, "GET", "/api/teams/join")).toBe(403);
    expect(
      await status(http, "POST", "/api/me/password", { currentPassword: "a", newPassword: "b" }),
    ).toBe(403);
  });

  it("provisions a tenant: view-only user, team, team-view-only membership, API key (P2–P6)", async () => {
    tenantA = await prov.provisionTenant(adminToken, tenantAId);
    tenantB = await prov.provisionTenant(adminToken, tenantBId);
    // P5 answers user.id and the user's teams (what the restartable provisioning relies on).
    const login = await prov.loginDetail(tenantA.username, tenantA.password);
    expect(login?.userId).toBe(tenantA.userId);
    expect(login?.teamIds).toEqual([tenantA.teamId]);
    expect(tenantA.username).toBe(`scf-t-${tenantAId.replace(/-/g, "")}`);
    expect(tenantA.apiKey).toMatch(/^umami_[A-Za-z0-9]{32}$/);
    expect(tenantA.password.length).toBeGreaterThanOrEqual(43);
    expect(tenantA.teamId).not.toBe(tenantB.teamId);
  });

  it("restartable provisioning resumes after a crash after P2 and after P3 (C-85)", async () => {
    const id = randomUUID();
    const pw = randomBytes(32).toString("base64url");
    await expect(
      prov.ensureTenantIdentity(adminToken, id, pw, (s) => {
        if (s === "P2") throw new Error("crash after P2");
      }),
    ).rejects.toThrow(/crash after P2/);
    const done = await prov.ensureTenantIdentity(adminToken, id, pw);
    const login = await prov.loginDetail(done.username, pw);
    expect(login?.userId).toBe(done.userId);
    expect(login?.teamIds).toEqual([done.teamId]);
    // A crash between P4 and P6: the retry only mints a key.
    const id2 = randomUUID();
    const steps: string[] = [];
    await expect(
      prov.ensureTenantIdentity(adminToken, id2, pw, (s) => {
        if (s === "P4") throw new Error("crash after P4");
      }),
    ).rejects.toThrow(/crash after P4/);
    const again = await prov.ensureTenantIdentity(adminToken, id2, pw, (s) => steps.push(s));
    expect(steps).toEqual(["P6"]);
    expect(again.apiKey).toMatch(/^umami_[A-Za-z0-9]{32}$/);
    await prov.purgeTenant(adminToken, done.userId, done.teamId);
    await prov.purgeTenant(adminToken, again.userId, again.teamId);
  });

  it("creates main and twin websites in the tenant's team, idempotently (P7, P7t)", async () => {
    const spec = (id: string, name: string, teamId: string) => ({
      id,
      name,
      domain: "app.example.org",
      teamId,
    });
    expect(await prov.createWebsite(adminToken, spec(mainA, "site-a", tenantA.teamId))).toBe(
      "created",
    );
    expect(await prov.createWebsite(adminToken, spec(twinA, "site-a/twin", tenantA.teamId))).toBe(
      "created",
    );
    expect(await prov.createWebsite(adminToken, spec(mainB, "site-b", tenantB.teamId))).toBe(
      "created",
    );
    expect(await prov.createWebsite(adminToken, spec(mainA, "site-a", tenantA.teamId))).toBe(
      "exists",
    );
    await prov.updateWebsite(adminToken, mainA, "site-a", "www.example.org"); // P8
    // #26: an id already in use in ANOTHER team is a conflict, never "exists" (the GET carries the owning team).
    await expect(
      prov.createWebsite(adminToken, spec(mainB, "site-b", tenantA.teamId)),
    ).rejects.toBeInstanceOf(UmamiConflictError);
  });

  it("a tenant's key cannot create websites, mint keys or use admin routes (S-01 §6)", async () => {
    const create = await http.call({
      method: "POST",
      path: "/api/websites",
      template: "/api/websites",
      bearer: tenantA.apiKey,
      body: { name: "personal", domain: "x.example" },
    });
    expect(create.status).toBe(401);
    const admin = await http.call({
      method: "GET",
      path: "/api/admin/websites",
      template: "/api/admin/websites",
      bearer: tenantA.apiKey,
    });
    expect(admin.status).toBe(401);
  });

  it("accepts the forwarded event shape through the proxy and drops bots (§c.2, §j.4, C-69)", async () => {
    // Main website: three visits. S1 bounce (v); S2 two page views 2 min apart (v) + a custom event; S3 bounce (s).
    expect(await send(mainA, at(12, 0), "v", "2001:db8:1::1")).toBe(200);
    expect(
      await send(mainA, at(12, 0), "v", "2001:db8:1::2", {
        referrer: "https://news.ycombinator.com/",
      }),
    ).toBe(200);
    expect(await send(mainA, at(12, 2), "v", "2001:db8:1::2", { url: "/pricing" })).toBe(200);
    expect(await send(mainA, at(12, 3), "v", "2001:db8:1::2", { name: "wallet_selected" })).toBe(
      200,
    );
    expect(await send(mainA, at(12, 10), "s", "2001:db8:1::3")).toBe(200);
    // Twin website: unidentified page views, one verified and one suspect.
    expect(await send(twinA, at(12, 20), "v", "2001:db8:2::1", { visit: "none" })).toBe(200);
    expect(await send(twinA, at(12, 21), "s", "2001:db8:2::2", { visit: "none" })).toBe(200);
    // Tenant B.
    expect(await send(mainB, at(12, 30), "v", "2001:db8:3::1")).toBe(200);

    // Umami's own bot check stays on behind the proxy: answered 200, nothing stored (R1 below counts 4 raw).
    expect(await send(mainA, at(13, 0), "v", "2001:db8:9::9", { userAgent: "curl/8.5.0" })).toBe(
      200,
    );
  });

  it("R1: verified with tag=v, raw without a tag; visit metrics from the one unfiltered call (C-73)", async () => {
    const v = await reader.stats(tenantA.apiKey, mainA, fullDay, "verified");
    const r = await reader.stats(tenantA.apiKey, mainA, fullDay, "raw");
    expect(v.pageviews).toBe(3);
    expect(v.visitors).toBe(2);
    expect(r).toEqual({ pageviews: 4, visitors: 3, visits: 3, bounces: 2, totaltime: 120 });

    const totals = await reader.siteTotals(tenantA.apiKey, { main: mainA, twin: twinA }, fullDay);
    expect(totals).toEqual({
      pageviews: { verified: 4, raw: 6 },
      pageviewsUnidentified: { verified: 1, raw: 2 },
      visitors: { verified: 2, raw: 3 },
      visits: 3,
      bounces: 2,
      totaltimeSeconds: 120,
      suspectPageviewShare: 1 - 4 / 6,
    });
  });

  it("sends endAt = end − 1 ms: an event exactly at `end` is excluded, one at `end − 1 ms` is not (C-99)", async () => {
    const before = await reader.stats(tenantA.apiKey, mainA, { start: D, end: at(12, 0) }, "raw");
    expect(before.pageviews).toBe(0);
    const incl = await reader.stats(tenantA.apiKey, mainA, { start: D, end: at(12, 0) + 1 }, "raw");
    expect(incl.pageviews).toBe(2);
    const fromNoon = await reader.stats(
      tenantA.apiKey,
      mainA,
      { start: at(12, 0), end: at(12, 2) },
      "raw",
    );
    expect(fromNoon.pageviews).toBe(2);
  });

  it("R2: hourly page views and sessions", async () => {
    const s = await reader.pageviews(tenantA.apiKey, mainA, fullDay, "hour", "raw");
    const noon = (pts: { x: string; y: number }[]) =>
      pts.filter((p) => new Date(p.x).getTime() === at(12, 0)).reduce((a, p) => a + p.y, 0);
    expect(noon(s.pageviews)).toBe(4);
    expect(noon(s.sessions)).toBe(3);
    const sv = await reader.pageviews(tenantA.apiKey, mainA, fullDay, "day", "verified");
    expect(sv.pageviews.reduce((a, p) => a + p.y, 0)).toBe(3);
  });

  it("R3: event counts per name", async () => {
    expect(await reader.events(tenantA.apiKey, mainA, fullDay, "raw")).toEqual([
      { name: "wallet_selected", events: 1 },
    ]);
    expect(await reader.events(tenantA.apiKey, mainA, fullDay, "verified")).toEqual([
      { name: "wallet_selected", events: 1 },
    ]);
  });

  it("R4: expanded metrics, numbers parsed even when sent as strings", async () => {
    const paths = await reader.expanded(tenantA.apiKey, mainA, fullDay, "path", "raw");
    const byName = Object.fromEntries(paths.map((p) => [p.name, p]));
    expect(byName["/"]?.pageviews).toBe(3);
    expect(byName["/"]?.visitors).toBe(3);
    expect(byName["/pricing"]?.pageviews).toBe(1);
    for (const p of paths)
      for (const k of ["pageviews", "visitors", "visits", "bounces", "totaltime"] as const) {
        expect(typeof p[k]).toBe("number");
      }
    const countries = await reader.expanded(tenantA.apiKey, mainA, fullDay, "country", "verified");
    expect(countries).toEqual([expect.objectContaining({ name: "DE", pageviews: 3, visitors: 2 })]);
    const refs = await reader.expanded(tenantA.apiKey, mainA, fullDay, "referrer", "raw");
    expect(refs.map((r) => r.name)).toContain("news.ycombinator.com");
  });

  describe("report reads R6–R8: funnel, goal, journey (Umami 3.5.0 ad-hoc GET routes)", () => {
    // A third website of tenant A with its own visitors (D 14:00–16:00 UTC), so the figures above stay untouched:
    //   V1 (v): /  → /pricing → signup            V4 (s): / → /pricing → signup
    //   V2 (v): /  → /pricing                     V5 (v): /pricing
    //   V3 (v): /  → /docs                        V6 (v): / at 14:30, /pricing at 16:00 (a second visit, 90 min later)
    const repA = randomUUID();
    const pv = (v: string, h: number, m: number, url: string, tag: "v" | "s" = "v") =>
      send(repA, at(h, m), tag, `2001:db8:5::${v}`, { url });
    const ev = (v: string, h: number, m: number, tag: "v" | "s" = "v") =>
      send(repA, at(h, m), tag, `2001:db8:5::${v}`, { url: "/pricing", name: "signup" });
    const FUNNEL = [
      { type: "path" as const, value: "/" },
      { type: "path" as const, value: "/pricing" },
      { type: "event" as const, value: "signup" },
    ];

    beforeAll(async () => {
      expect(
        await prov.createWebsite(adminToken, {
          id: repA,
          name: "site-a-reports",
          domain: "app.example.org",
          teamId: tenantA.teamId,
        }),
      ).toBe("created");
      const sent = [
        await pv("1", 14, 0, "/"),
        await pv("1", 14, 1, "/pricing"),
        await ev("1", 14, 2),
        await pv("2", 14, 5, "/"),
        await pv("2", 14, 6, "/pricing"),
        await pv("3", 14, 10, "/"),
        await pv("3", 14, 11, "/docs"),
        await pv("4", 14, 15, "/", "s"),
        await pv("4", 14, 16, "/pricing", "s"),
        await ev("4", 14, 17, "s"),
        await pv("5", 14, 20, "/pricing"),
        await pv("6", 14, 30, "/"),
        await pv("6", 16, 0, "/pricing"),
      ];
      expect(sent.every((st) => st === 200)).toBe(true);
    });

    it("R6 funnel: sessions per step within the window; tag=v filters the first step only", async () => {
      const raw = await reader.funnel(tenantA.apiKey, repA, fullDay, FUNNEL, 60, "raw");
      // V6's /pricing is 90 min after its /: outside the 60-minute window
      expect(raw.map((r) => r.visitors)).toEqual([5, 3, 2]);
      expect(raw.map((r) => [r.type, r.value])).toEqual(FUNNEL.map((f) => [f.type, f.value]));
      const verified = await reader.funnel(tenantA.apiKey, repA, fullDay, FUNNEL, 60, "verified");
      expect(verified.map((r) => r.visitors)).toEqual([4, 2, 1]);
      const wide = await reader.funnel(tenantA.apiKey, repA, fullDay, FUNNEL, 120, "raw");
      expect(wide.map((r) => r.visitors)).toEqual([5, 4, 2]);
      // [start, end): ending at 14:01 keeps only the first page views of V1
      const early = await reader.funnel(
        tenantA.apiKey,
        repA,
        { start: D, end: at(14, 1) },
        FUNNEL.slice(0, 2),
        60,
        "raw",
      );
      expect(early.map((r) => r.visitors)).toEqual([1, 0]);
    });

    it("R7 goal: sessions reaching a path or an event, of all sessions in the range; `*` wildcard", async () => {
      expect(
        await reader.goal(
          tenantA.apiKey,
          repA,
          fullDay,
          { type: "path", value: "/pricing" },
          "raw",
        ),
      ).toEqual({ visitors: 5, total: 6 });
      expect(
        await reader.goal(
          tenantA.apiKey,
          repA,
          fullDay,
          { type: "path", value: "/pricing" },
          "verified",
        ),
      ).toEqual({ visitors: 4, total: 5 });
      expect(
        await reader.goal(tenantA.apiKey, repA, fullDay, { type: "event", value: "signup" }, "raw"),
      ).toEqual({ visitors: 2, total: 6 });
      expect(
        await reader.goal(tenantA.apiKey, repA, fullDay, { type: "path", value: "/p*" }, "raw"),
      ).toEqual({ visitors: 5, total: 6 });
    });

    it("R8 journey: visit sequences (event name else path) with visit counts; start and end steps", async () => {
      const key = (rows: { items: string[]; count: number }[]) =>
        rows.map((r) => `${r.items.join(" > ")} = ${r.count}`).sort();
      expect(key(await reader.journey(tenantA.apiKey, repA, fullDay, { steps: 3 }, "raw"))).toEqual(
        [
          "/ > /pricing > signup = 2",
          "/pricing = 2", // V5, and V6's second visit (the engine proxy's 30-minute rule)
          "/ > /pricing = 1",
          "/ > /docs = 1",
          "/ = 1",
        ].sort(),
      );
      expect(
        key(await reader.journey(tenantA.apiKey, repA, fullDay, { steps: 3 }, "verified")),
      ).toEqual(
        [
          "/ > /pricing > signup = 1",
          "/pricing = 2",
          "/ > /pricing = 1",
          "/ > /docs = 1",
          "/ = 1",
        ].sort(),
      );
      expect(
        key(
          await reader.journey(
            tenantA.apiKey,
            repA,
            fullDay,
            { steps: 3, endStep: "signup" },
            "raw",
          ),
        ),
      ).toEqual(["/ > /pricing > signup = 2"]);
      expect(
        key(
          await reader.journey(tenantA.apiKey, repA, fullDay, { steps: 2, startStep: "/" }, "raw"),
        ),
      ).toEqual(["/ > /pricing = 3", "/ > /docs = 1", "/ = 1"].sort());
    });

    it("answers aggregates only: no session, visit or visitor id in any report answer", async () => {
      const ids = new Set<string>();
      for (const path of [
        `/api/websites/${repA}/funnels/stats?startAt=${D}&endAt=${D + DAY_MS - 1}&timezone=UTC&window=60&steps=${encodeURIComponent(JSON.stringify(FUNNEL))}`,
        `/api/websites/${repA}/goals/stats?startAt=${D}&endAt=${D + DAY_MS - 1}&timezone=UTC&type=path&value=%2F`,
        `/api/websites/${repA}/journeys?startAt=${D}&endAt=${D + DAY_MS - 1}&timezone=UTC&steps=7`,
      ]) {
        const res = await readHttp.call({
          method: "GET",
          path,
          template: "report",
          bearer: tenantA.apiKey,
        });
        expect(res.status).toBe(200);
        for (const m of JSON.stringify(res.body).matchAll(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        ))
          ids.add(m[0]);
      }
      expect([...ids]).toEqual([]);
    });

    it("isolates tenants and keeps every other report route closed to the reader", async () => {
      // Thunks, not promises: a request started before the loop reaches it would reject unhandled meanwhile.
      for (const p of [
        () => reader.funnel(tenantB.apiKey, repA, fullDay, FUNNEL, 60, "raw"),
        () => reader.goal(tenantB.apiKey, repA, fullDay, { type: "path", value: "/" }, "raw"),
        () => reader.journey(tenantB.apiKey, repA, fullDay, { steps: 3 }, "raw"),
      ]) {
        const err = await p().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UmamiHttpError);
        expect((err as UmamiHttpError).status).toBe(401);
      }
      const r = `startAt=${D}&endAt=${D + DAY_MS - 1}&timezone=UTC`;
      for (const path of [
        `/api/websites/${repA}/retention?${r}`,
        `/api/websites/${repA}/utm/metrics?${r}&type=utm_source`,
        `/api/websites/${repA}/sessions?${r}`,
        `/api/websites/${repA}/funnels`,
        `/api/websites/${repA}/goals`,
        `/api/websites/${repA}/journeys?${r}&steps=3&eventType=1`,
      ]) {
        const res = await readHttp.call({
          method: "GET",
          path,
          template: "report",
          bearer: tenantA.apiKey,
        });
        expect(res.status, path).toBe(403);
      }
    });
  });

  it("isolates tenants: B's key gets 401 on A's websites", async () => {
    const err = await reader.stats(tenantB.apiKey, mainA, fullDay, "raw").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmamiHttpError);
    expect((err as UmamiHttpError).status).toBe(401);
    expect((await reader.stats(tenantB.apiKey, mainB, fullDay, "raw")).pageviews).toBe(1);
  });

  describe("isolation per Umami object type (isolation.tenant-rls)", () => {
    // Tenant keys are used in production only with the reader certificate; the provisioner certificate reaches more
    // engine routes, so it is used here to exercise UMAMI's own checks too (defence in depth behind the proxy).
    const call = (
      c: HttpClient,
      method: "GET" | "POST" | "DELETE",
      path: string,
      bearer: string,
      body?: unknown,
    ) => c.call({ method, path, template: path, bearer, ...(body ? { body } : {}) });
    const REFUSED = [401, 403, 404];
    const websiteName = async (id: string) =>
      ((await call(http, "GET", `/api/websites/${id}`, adminToken)).body as { name?: string })
        ?.name;

    it("teams: B cannot read A's team or its members, add itself, or delete it", async () => {
      for (const c of [readHttp, http]) {
        expect(REFUSED).toContain(
          (await call(c, "GET", `/api/teams/${tenantA.teamId}`, tenantB.apiKey)).status,
        );
        expect(REFUSED).toContain(
          (await call(c, "GET", `/api/teams/${tenantA.teamId}/users`, tenantB.apiKey)).status,
        );
        expect(REFUSED).toContain(
          (
            await call(c, "POST", `/api/teams/${tenantA.teamId}/users`, tenantB.apiKey, {
              userId: tenantB.userId,
              role: "team-member",
            })
          ).status,
        );
        expect(REFUSED).toContain(
          (await call(c, "DELETE", `/api/teams/${tenantA.teamId}`, tenantB.apiKey)).status,
        );
      }
      // The team-join route (access codes) is refused for everyone, B included.
      expect(
        (await call(http, "POST", "/api/teams/join", tenantB.apiKey, { accessCode: "team_x" }))
          .status,
      ).toBe(403);
      expect(await prov.exists(adminToken, "team", tenantA.teamId)).toBe(true);
      expect((await prov.loginDetail(tenantB.username, tenantB.password))?.teamIds).toEqual([
        tenantB.teamId,
      ]);
    });

    it("websites: B cannot read, rename, delete or read figures of A's website", async () => {
      for (const c of [readHttp, http]) {
        expect(REFUSED).toContain(
          (await call(c, "GET", `/api/websites/${mainA}`, tenantB.apiKey)).status,
        );
        expect(REFUSED).toContain(
          (await call(c, "POST", `/api/websites/${mainA}`, tenantB.apiKey, { name: "owned" }))
            .status,
        );
        expect(REFUSED).toContain(
          (await call(c, "DELETE", `/api/websites/${mainA}`, tenantB.apiKey)).status,
        );
      }
      // Even A's own (view-only) key cannot change A's website: tenants never write engine objects.
      expect(REFUSED).toContain(
        (await call(http, "POST", `/api/websites/${mainA}`, tenantA.apiKey, { name: "x" })).status,
      );
      expect(await websiteName(mainA)).toBe("site-a");
      expect(await prov.exists(adminToken, "website", mainA)).toBe(true);
      const err = await reader
        .pageviews(tenantB.apiKey, mainA, fullDay, "day", "raw")
        .catch((e) => e);
      expect((err as UmamiHttpError).status).toBe(401);
    });

    it("shares: no share can be created, listed or opened by anyone (deny-list), A's data stays private", async () => {
      for (const c of [readHttp, http, tools.client("edge")])
        for (const bearer of [tenantA.apiKey, tenantB.apiKey, adminToken]) {
          expect((await call(c, "GET", `/api/websites/${mainA}/shares`, bearer)).status).toBe(403);
          expect(
            (await call(c, "POST", `/api/websites/${mainA}/shares`, bearer, { name: "s" })).status,
          ).toBe(403);
          expect(
            (await call(c, "POST", "/api/share", bearer, { entityId: mainA, shareType: 1 })).status,
          ).toBe(403);
          expect((await call(c, "GET", "/api/share/some-slug", bearer)).status).toBe(403);
        }
    });

    it("pixels, links and boards: unreachable through the proxy for every role and key", async () => {
      for (const c of [readHttp, http, tools.client("edge")])
        for (const bearer of [tenantB.apiKey, adminToken])
          for (const kind of ["pixels", "links", "boards"]) {
            expect((await call(c, "GET", `/api/${kind}`, bearer)).status).toBe(403);
            expect(
              (await call(c, "POST", `/api/${kind}`, bearer, { name: "x", teamId: tenantA.teamId }))
                .status,
            ).toBe(403);
            expect(
              (await call(c, "GET", `/api/teams/${tenantA.teamId}/${kind}`, bearer)).status,
            ).toBe(403);
          }
      // The public pixel and link collectors are refused too.
      expect((await call(http, "GET", "/p/abc", tenantB.apiKey)).status).toBe(403);
      expect((await call(http, "GET", "/q/abc", tenantB.apiKey)).status).toBe(403);
    });

    it("API keys: B cannot list, mint for or revoke A's key; A's key keeps working", async () => {
      expect((await call(readHttp, "GET", "/api/me/api-keys", tenantB.apiKey)).status).toBe(403);
      // The provisioner route deletes by key id AND the caller's user id: B naming A's key deletes nothing.
      const del = await call(
        http,
        "DELETE",
        `/api/me/api-keys/${tenantA.apiKeyId}`,
        tenantB.apiKey,
      );
      expect(del.status).toBeLessThan(500);
      expect((await reader.stats(tenantA.apiKey, mainA, fullDay, "raw")).pageviews).toBe(4);
      // B's key cannot read A's user record either.
      expect(REFUSED).toContain(
        (await call(http, "GET", `/api/users/${tenantA.userId}`, tenantB.apiKey)).status,
      );
    });
  });

  it("rotates the tenant key: P5 → P6 → verified read → P10; the old key is refused (C-85)", async () => {
    const verified: string[] = [];
    const fresh = await prov.rotateApiKey(
      tenantA.username,
      tenantA.password,
      tenantA.apiKeyId,
      async (k) => {
        verified.push(k.id);
        expect((await reader.stats(k.key, mainA, fullDay, "raw")).pageviews).toBe(4);
      },
    );
    expect(verified).toEqual([fresh.id]);
    const old = await reader.stats(tenantA.apiKey, mainA, fullDay, "raw").catch((e: unknown) => e);
    expect((old as UmamiHttpError).status).toBe(401);
    tenantA = { ...tenantA, apiKey: fresh.key, apiKeyId: fresh.id };
  });

  it("lists websites for reconciliation (P12)", async () => {
    const ids = await prov.listWebsiteIds(adminToken, 2);
    expect(ids).toEqual(expect.arrayContaining([mainA, twinA, mainB]));
    // P12 carries the owning team: the reconciler reports a site's website outside its tenant's team (a 401 for
    // every live read with the tenant's key — the 2026-11-13 journey failure).
    const listed = await prov.listWebsites(adminToken, 2);
    expect(listed.find((w) => w.id === mainA)?.teamId).toBe(tenantA.teamId);
    expect(listed.find((w) => w.id === mainB)?.teamId).toBe(tenantB.teamId);
  });

  it("deletes a website only after the visit-token purge resolved (C-112(9), P9)", async () => {
    const order: string[] = [];
    await expect(
      prov.deleteWebsite(adminToken, twinA, async () => {
        throw new Error("one core did not answer 204");
      }),
    ).rejects.toThrow(/did not answer/);
    expect(await prov.listWebsiteIds(adminToken)).toContain(twinA);

    await prov.deleteWebsite(adminToken, twinA, async (id) => {
      order.push(`purge:${id}`);
    });
    order.push("deleted");
    expect(order).toEqual([`purge:${twinA}`, "deleted"]);
    expect(await prov.listWebsiteIds(adminToken)).not.toContain(twinA);
    // Idempotent.
    await prov.deleteWebsite(adminToken, twinA, async () => {});
    // The proxy remembers the deleted website (72 h) and Umami no longer knows it: refused, nothing stored.
    expect(
      await send(twinA, at(14, 0), "v", "2001:db8:2::9", { visit: "none" }),
    ).toBeGreaterThanOrEqual(400);
  });

  it("purges a tenant's websites, user and team (P9 with token purge first, P11), idempotently", async () => {
    const purged: string[] = [];
    const purge = visitTokenPurgeOnEveryCore([http]);
    const spec = { userId: tenantB.userId, teamId: tenantB.teamId, websiteIds: [mainB] };
    await purgeTenantEngine(prov, adminToken, spec, async (id) => {
      await purge(id);
      purged.push(id);
    });
    await purgeTenantEngine(prov, adminToken, spec, purge);
    expect(purged).toEqual([mainB]);
    expect(await prov.exists(adminToken, "website", mainB)).toBe(false);
    expect(await prov.exists(adminToken, "team", tenantB.teamId)).toBe(false);
    expect(await prov.login(tenantB.username, tenantB.password)).toBeNull();
    const err = await reader.stats(tenantB.apiKey, mainA, fullDay, "raw").catch((e: unknown) => e);
    expect((err as UmamiHttpError).status).toBe(401);
  });
});
