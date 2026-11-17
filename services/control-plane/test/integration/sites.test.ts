// SPDX-License-Identifier: Apache-2.0
// Sites and domains (data-model §8.4; C-02, C-19, C-51, C-53, C-73, C-87, C-90).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

let h: Harness;
let owner: string;
let tenant: string;
beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
});
afterAll(async () => {
  await h?.close();
});

const sites = (t = tenant) => `/v1/tenants/${t}/sites`;

/** A new owner with a new tenant (one user may own at most 3 tenants). */
async function fresh(): Promise<{ cookie: string; t: string }> {
  const cookie = await signInGithub(h, newGithubUser());
  return { cookie, t: await createTenant(h, cookie) };
}

describe("sites", () => {
  it("creates a standard site with visitor ids on, anonymous reports on, limits from the L0 settings", async () => {
    const res = await call(h, {
      method: "POST",
      url: sites(),
      cookie: owner,
      body: { name: "Main" },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({
      name: "Main",
      tracker_profile: "standard",
      visitor_id: "on",
      anonymous_reports: true,
      path_folding: "full",
      status: "active",
      event_retention_days: null,
      effective_event_retention_days: 90,
      limits: { rate_limit_per_min: 600, daily_quota: 50000, verified_events_today: 0 },
      domains: [],
    });
    expect(s.site_key).toMatch(/^[0-9A-Za-z]{22}$/);
    const row = await h.su.query(
      `SELECT umami_website_id, umami_twin_website_id FROM scf.sites WHERE site_id = $1`,
      [s.site_id],
    );
    expect(row.rows[0].umami_website_id).toBeTruthy();
    expect(row.rows[0].umami_twin_website_id).toBeNull();
    // Engine ids are never exposed.
    expect(JSON.stringify(s)).not.toContain(row.rows[0].umami_website_id);
  });

  it("strict profile defaults to visitor_id off and assigns the twin website id (C-53, C-73)", async () => {
    const res = await call(h, {
      method: "POST",
      url: sites(),
      cookie: owner,
      body: { name: "Strict", tracker_profile: "strict" },
    });
    expect(res.json()).toMatchObject({ tracker_profile: "strict", visitor_id: "off" });
    const row = await h.su.query(`SELECT umami_twin_website_id FROM scf.sites WHERE site_id = $1`, [
      res.json().site_id,
    ]);
    expect(row.rows[0].umami_twin_website_id).toBeTruthy();
  });

  it("enforces the L0 site limit (C-19)", async () => {
    const res = await call(h, {
      method: "POST",
      url: sites(),
      cookie: owner,
      body: { name: "Third" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("quota_exceeded");
  });

  it("validates off_in countries, retention bounds and https opt-out pages", async () => {
    const { cookie: owner, t: t2 } = await fresh();
    const bad = [
      { name: "x", visitor_id: "off_in" },
      { name: "x", visitor_id: "off_in", visitor_id_off_countries: [] },
      { name: "x", event_retention_days: 20 },
      { name: "x", opt_out_page_url: "http://example.org/opt-out" },
      { name: "x", exclude_countries: ["de"] },
    ];
    for (const body of bad) {
      expect(
        (await call(h, { method: "POST", url: sites(t2), cookie: owner, body })).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
    const ok = await call(h, {
      method: "POST",
      url: sites(t2),
      cookie: owner,
      body: {
        name: "x",
        visitor_id: "off_in",
        visitor_id_off_countries: ["DE", "AT"],
        event_retention_days: 30,
        exclude_countries: ["RU"],
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      visitor_id_off_countries: ["DE", "AT"],
      effective_event_retention_days: 30,
      exclude_countries: ["RU"],
    });
  });

  it("switching to strict turns identifiers off unless chosen explicitly (C-53); the twin is assigned once", async () => {
    const { cookie: owner, t: t3 } = await fresh();
    const a = (
      await call(h, { method: "POST", url: sites(t3), cookie: owner, body: { name: "A" } })
    ).json();
    const upd = await call(h, {
      method: "PATCH",
      url: `${sites(t3)}/${a.site_id}`,
      cookie: owner,
      body: { tracker_profile: "strict" },
    });
    expect(upd.json()).toMatchObject({ tracker_profile: "strict", visitor_id: "off" });
    const twin1 = (
      await h.su.query(`SELECT umami_twin_website_id AS t FROM scf.sites WHERE site_id = $1`, [
        a.site_id,
      ])
    ).rows[0].t;
    expect(twin1).toBeTruthy();
    const back = await call(h, {
      method: "PATCH",
      url: `${sites(t3)}/${a.site_id}`,
      cookie: owner,
      body: { visitor_id: "on" },
    });
    expect(back.json().visitor_id).toBe("on");
    const again = await call(h, {
      method: "PATCH",
      url: `${sites(t3)}/${a.site_id}`,
      cookie: owner,
      body: { tracker_profile: "standard" },
    });
    expect(again.json().visitor_id).toBe("on"); // explicit choice sticks
    const twin2 = (
      await h.su.query(`SELECT umami_twin_website_id AS t FROM scf.sites WHERE site_id = $1`, [
        a.site_id,
      ])
    ).rows[0].t;
    expect(twin2).toBe(twin1);

    const b = (
      await call(h, {
        method: "POST",
        url: sites(t3),
        cookie: owner,
        body: { name: "B", visitor_id: "on" },
      })
    ).json();
    const strict = await call(h, {
      method: "PATCH",
      url: `${sites(t3)}/${b.site_id}`,
      cookie: owner,
      body: { tracker_profile: "strict" },
    });
    expect(strict.json().visitor_id).toBe("on");
  });

  it("anonymous reports are changed only by admins (C-51); archive is admin-only and idempotent", async () => {
    const { cookie: owner, t: t4 } = await fresh();
    const s = (
      await call(h, { method: "POST", url: sites(t4), cookie: owner, body: { name: "S" } })
    ).json();
    const inv = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t4}/invitations`,
        cookie: owner,
        body: { role: "member" },
      })
    ).json();
    const member = await signInGithub(h, newGithubUser());
    await call(h, {
      method: "POST",
      url: "/v1/invitations/accept",
      cookie: member,
      body: { code: inv.code },
    });
    const url = `${sites(t4)}/${s.site_id}/anonymous-reports`;
    expect(
      (await call(h, { method: "PUT", url, cookie: member, body: { anonymous_reports: false } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(h, {
          method: "PATCH",
          url: `${sites(t4)}/${s.site_id}`,
          cookie: member,
          body: { anonymous_reports: false },
        })
      ).statusCode,
    ).toBe(400);
    const off = await call(h, {
      method: "PUT",
      url,
      cookie: owner,
      body: { anonymous_reports: false },
    });
    expect(off.json().anonymous_reports).toBe(false);
    expect(
      (
        await call(h, {
          method: "PATCH",
          url: `${sites(t4)}/${s.site_id}`,
          cookie: member,
          body: { name: "S2" },
        })
      ).json().name,
    ).toBe("S2");

    expect(
      (await call(h, { method: "DELETE", url: `${sites(t4)}/${s.site_id}`, cookie: member }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(h, { method: "DELETE", url: `${sites(t4)}/${s.site_id}`, cookie: owner }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(h, { method: "DELETE", url: `${sites(t4)}/${s.site_id}`, cookie: owner }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(h, { method: "GET", url: `${sites(t4)}/${s.site_id}`, cookie: member })).json()
        .status,
    ).toBe("archived");
    expect(
      (
        await call(h, {
          method: "PATCH",
          url: `${sites(t4)}/${s.site_id}`,
          cookie: owner,
          body: { name: "x" },
        })
      ).json().status,
    ).toBe("archived");
    const actions = (
      await h.su.query(`SELECT action FROM scf.audit_log WHERE chain_id = $1 ORDER BY seq`, [t4])
    ).rows.map((r) => r.action);
    expect(actions).toEqual([
      "tenant.created",
      "site.created",
      "invitation.created",
      "invitation.accepted",
      "site.updated",
      "site.updated",
      "site.archived",
      "site.archived",
      "site.updated",
    ]);
  });

  it("site over its tenant's daily quota shows over_quota (C-90)", async () => {
    const { cookie: owner, t: t5 } = await fresh();
    const s = (
      await call(h, { method: "POST", url: sites(t5), cookie: owner, body: { name: "Q" } })
    ).json();
    await h.su.query(
      `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 'verdict', 'verified', 50000)`,
      [t5, s.site_id],
    );
    const v = (
      await call(h, { method: "GET", url: `${sites(t5)}/${s.site_id}`, cookie: owner })
    ).json();
    expect(v.status).toBe("over_quota");
    expect(v.limits.verified_events_today).toBe(50000);
  });
});

describe("domains", () => {
  it("declares, lists and removes domains; hosts become lower-case A-labels; duplicates are 409", async () => {
    const { cookie: owner, t: t6 } = await fresh();
    const s = (
      await call(h, { method: "POST", url: sites(t6), cookie: owner, body: { name: "D" } })
    ).json();
    const base = `${sites(t6)}/${s.site_id}/domains`;
    const a = await call(h, {
      method: "POST",
      url: base,
      cookie: owner,
      body: { host: "Bücher.Example.", include_subdomains: true },
    });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({
      host: "xn--bcher-kva.example",
      include_subdomains: true,
      state: "unverified",
    });
    expect(
      (
        await call(h, {
          method: "POST",
          url: base,
          cookie: owner,
          body: { host: "xn--bcher-kva.example" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(h, {
          method: "POST",
          url: base,
          cookie: owner,
          body: { host: "http://x.example" },
        })
      ).statusCode,
    ).toBe(400);
    const list = (await call(h, { method: "GET", url: base, cookie: owner })).json();
    expect(list).toHaveLength(1);
    expect(
      (await call(h, { method: "GET", url: `${sites(t6)}/${s.site_id}`, cookie: owner })).json()
        .domains,
    ).toHaveLength(1);
    expect(
      (await call(h, { method: "DELETE", url: `${base}/${a.json().domain_id}`, cookie: owner }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(h, { method: "DELETE", url: `${base}/${a.json().domain_id}`, cookie: owner }))
        .statusCode,
    ).toBe(404);
  });

  it("a host verified by another tenant can still be declared (no oracle)", async () => {
    const host = `shared-${Date.now()}.example`;
    const { cookie: owner, t: t7 } = await fresh();
    const s = (
      await call(h, { method: "POST", url: sites(t7), cookie: owner, body: { name: "D" } })
    ).json();
    const other = await signInGithub(h, newGithubUser());
    const t8 = await createTenant(h, other);
    const s8 = (
      await call(h, { method: "POST", url: sites(t8), cookie: other, body: { name: "E" } })
    ).json();
    const d8 = (
      await call(h, {
        method: "POST",
        url: `${sites(t8)}/${s8.site_id}/domains`,
        cookie: other,
        body: { host },
      })
    ).json();
    await h.su.query(
      `UPDATE scf.site_domains SET state = 'verified', verified_at = now() WHERE domain_id = $1`,
      [d8.domain_id],
    );
    await h.su.query(
      // the database claims the host for a verified domain itself at commit (migration 0069)
      `INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES ($3, $1, $2) ON CONFLICT (host) DO NOTHING`,
      [t8, d8.domain_id, host],
    );
    const mine = await call(h, {
      method: "POST",
      url: `${sites(t7)}/${s.site_id}/domains`,
      cookie: owner,
      body: { host },
    });
    expect(mine.statusCode).toBe(201);
    expect(mine.json().state).toBe("unverified");
  });

  it("removing a domain keeps the host claim another site of the same tenant still declares", async () => {
    const host = `twice-${Date.now()}.example`;
    const { cookie, t } = await fresh();
    const mk = async (name: string) =>
      (await call(h, { method: "POST", url: sites(t), cookie, body: { name } })).json();
    const a = await mk("A");
    const b = await mk("B");
    const add = async (siteId: string) =>
      (
        await call(h, {
          method: "POST",
          url: `${sites(t)}/${siteId}/domains`,
          cookie,
          body: { host },
        })
      ).json();
    const da = await add(a.site_id);
    const db = await add(b.site_id);
    await h.su.query(
      `UPDATE scf.site_domains SET state = 'verified', verified_at = now() WHERE domain_id = $1`,
      [da.domain_id],
    );
    await h.su.query(
      // the database claims the host for a verified domain itself at commit (migration 0069)
      `INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES ($3, $1, $2) ON CONFLICT (host) DO NOTHING`,
      [t, da.domain_id, host],
    );
    const claim = async () =>
      (
        await h.su.query(`SELECT domain_id::text AS d FROM scf.host_claims WHERE host = $1`, [host])
      ).rows.map((r) => r.d);

    // Site B's declaration goes; site A still declares the host, so the claim stays.
    const rb = await call(h, {
      method: "DELETE",
      url: `${sites(t)}/${b.site_id}/domains/${db.domain_id}`,
      cookie,
    });
    expect(rb.statusCode).toBe(204);
    expect(await claim()).toEqual([da.domain_id]);

    // The last declaration goes: the claim is released.
    const ra = await call(h, {
      method: "DELETE",
      url: `${sites(t)}/${a.site_id}/domains/${da.domain_id}`,
      cookie,
    });
    expect(ra.statusCode).toBe(204);
    expect(await claim()).toEqual([]);
  });
});
