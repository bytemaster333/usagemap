// SPDX-License-Identifier: Apache-2.0
// Tenant lifecycle by SCF operators (C-08, C-09, C-64, C-70, C-91, C-94), enrollment in both modes (ADR-0015, C-19),
// suspend → ingest refused at the next snapshot (≤ 60 s), tombstones, the tenant audit log (with operator actions on the
// tenant, hash chain verified), the installation check (C-39) and the snippet (SRI, both profiles, consent mode).

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SnapshotBuilder,
  type SnapshotPayload,
  SnapshotSigner,
  verifyEnvelope,
} from "../../src/edge/snapshot.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";
import {
  ageSession,
  call,
  createTenant,
  type Harness,
  newGithubUser,
  operatorSession,
  signInGithub,
  startHarness,
  uniqueSlug,
  verifyAuditChain,
} from "../support/harness.ts";

const fixtureManifest = JSON.parse(
  readFileSync(new URL("../support/fixtures/tracker/1.0.0/manifest.json", import.meta.url), "utf8"),
) as { files: Array<{ profile: string; integrity: string }> };
const integrityOf = (profile: string) =>
  fixtureManifest.files.find((f) => f.profile === profile)?.integrity;

let h: Harness;
let builder: SnapshotBuilder;
let signer: SnapshotSigner;
let admin = "";
let operator = "";

async function payloadNow(): Promise<SnapshotPayload> {
  await builder.build();
  const res = await h.internal.inject({
    method: "GET",
    url: "/internal/v1/edge/snapshot",
    headers: { "x-scf-edge-node": "edge-a1" },
  });
  expect(res.statusCode).toBe(200);
  return verifyEnvelope(res.body, { [signer.kid]: signer.publicKey });
}

const statusAtEdge = async (tenantId: string) =>
  (await payloadNow()).tenants.find((t) => t.tenant_id === tenantId)?.status;

async function setMode(mode: "open" | "approval_required") {
  const res = await call(h, {
    method: "PUT",
    url: "/v1/operator/settings/enrollment-mode",
    cookie: admin,
    body: { enrollment_mode: mode },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toEqual({ enrollment_mode: mode });
}

const transition = (tenantId: string, action: string, cookie = operator) =>
  call(h, {
    method: "POST",
    url: `/v1/operator/tenants/${tenantId}/transitions`,
    cookie,
    body: { action, reason: `test ${action}` },
  });

beforeAll(async () => {
  h = await startHarness();
  const { privateKey } = generateKeyPairSync("ed25519");
  signer = new SnapshotSigner(
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    "lc-test",
  );
  const dir = new URL("../support/fixtures/tracker", import.meta.url).pathname;
  builder = new SnapshotBuilder(h.jobsDb, signer, {
    pathnormRulesVersion: "scf-path-rules/1.0.0",
    tracker: loadTrackerRegistry(dir, join(dir, "releases.json")),
  });
  // Policy added here until a migration provides it: operator_admin may read the tombstone list (C-64, C-70).
  await h.su.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'scf' AND tablename = 'enrollment_tombstones'
                     AND policyname = 'app_admin_read') THEN
      GRANT SELECT ON scf.enrollment_tombstones TO scf_app;
      CREATE POLICY app_admin_read ON scf.enrollment_tombstones FOR SELECT TO scf_app
        USING ((SELECT scf.platform_role()) = 'operator_admin');
    END IF; END $$`);
  admin = (await operatorSession(h, "operator_admin")).cookie;
  operator = (await operatorSession(h, "operator")).cookie;
});
afterAll(async () => {
  await h?.close();
});

describe("enrollment in both modes (ADR-0015, C-08, C-19)", () => {
  it("approval_required: new tenants are pending (ingest refused at the edge) until an operator approves", async () => {
    expect(
      (
        await call(h, {
          method: "GET",
          url: "/v1/operator/settings/enrollment-mode",
          cookie: operator,
        })
      ).json(),
    ).toEqual({ enrollment_mode: "open" });
    await setMode("approval_required");
    try {
      const owner = await signInGithub(h, newGithubUser());
      const t = await createTenant(h, owner);
      expect(
        (await call(h, { method: "GET", url: `/v1/tenants/${t}`, cookie: owner })).json().status,
      ).toBe("pending");
      // a pending tenant can configure sites (C-08)
      const site = await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "P" },
      });
      expect(site.statusCode).toBe(201);
      expect(await statusAtEdge(t)).toBe("pending");
      // the operator console lists it
      const list = await call(h, {
        method: "GET",
        url: "/v1/operator/tenants?status=pending",
        cookie: operator,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().items.map((r: { tenant_id: string }) => r.tenant_id)).toContain(t);
      const ok = await transition(t, "approve");
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        tenant_id: t,
        status: "active",
        status_reason: "test approve",
      });
      expect(await statusAtEdge(t)).toBe("active");
      // switching back to open affects new enrollments only
      const t2 = await createTenant(h, owner);
      await setMode("open");
      expect(
        (await call(h, { method: "GET", url: `/v1/tenants/${t2}`, cookie: owner })).json().status,
      ).toBe("pending");
      const t3 = await createTenant(h, owner);
      expect(
        (await call(h, { method: "GET", url: `/v1/tenants/${t3}`, cookie: owner })).json().status,
      ).toBe("active");
    } finally {
      await setMode("open");
    }
  });

  it("enrollment-mode changes need operator_admin and a fresh step-up (C-09)", async () => {
    const r = await call(h, {
      method: "PUT",
      url: "/v1/operator/settings/enrollment-mode",
      cookie: operator,
      body: { enrollment_mode: "open" },
    });
    expect(r.json().code).toBe("forbidden");
    const settings = await call(h, {
      method: "GET",
      url: "/v1/operator/settings",
      cookie: operator,
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().find((s: { key: string }) => s.key === "enrollment_mode").value).toBe(
      "open",
    );
  });
});

describe("suspend, reinstate, remove, restore, purge (C-08, C-94)", () => {
  let owner = "";
  let ownerUser = newGithubUser();
  let t = "";
  let host = "";

  beforeAll(async () => {
    ownerUser = newGithubUser();
    owner = await signInGithub(h, ownerUser);
    t = await createTenant(h, owner);
    const site = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "L" },
      })
    ).json();
    host = `lc-${randomUUID().slice(0, 8)}.example`;
    const d = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites/${site.site_id}/domains`,
        cookie: owner,
        body: { host },
      })
    ).json();
    // the domain_verification job's result, written directly (its own tests cover the verifier)
    await h.su.query(
      `UPDATE scf.site_domains SET state = 'verified', verified_at = now() WHERE domain_id = $1`,
      [d.domain_id],
    );
  });

  it("suspend stops ingest at the next snapshot; reinstate re-opens it; invalid transitions are 409", async () => {
    expect(await statusAtEdge(t)).toBe("active");
    const s = await transition(t, "suspend");
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().status).toBe("suspended");
    expect(await statusAtEdge(t)).toBe("suspended");
    expect((await transition(t, "approve")).statusCode).toBe(409);
    expect((await transition(t, "reinstate")).json().status).toBe("active");
    expect(await statusAtEdge(t)).toBe("active");
    expect((await transition(t, "reinstate")).json().code).toBe("conflict");
    expect((await transition(randomUUID(), "suspend")).statusCode).toBe(404);
  });

  it("a stale step-up is refused; removal needs operator_admin", async () => {
    const op2 = await operatorSession(h, "operator");
    await ageSession(h, op2.cookie, 11);
    expect((await transition(t, "suspend", op2.cookie)).json().code).toBe("step_up_required");
    const byOperator = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/removal`,
      cookie: operator,
      body: { reason: "x" },
    });
    expect(byOperator.json().code).toBe("forbidden");
  });

  it("removal hides data, stops ingest, sets purge_after +30 days and tombstones domains and GitHub ids (C-64)", async () => {
    // K1: the reason code is a fixed enum
    const badCode = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/removal`,
      cookie: admin,
      body: { reason: "x", reason_code: "abuse" },
    });
    expect(badCode.statusCode).toBe(400);
    const res = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/removal`,
      cookie: admin,
      body: { reason: "not part of the ecosystem", reason_code: "not_ecosystem" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.status).toBe("removed");
    expect(body.removal_reason_code).toBe("not_ecosystem");
    // K1: the code is audited, and the members read it with the reason on their next sign-in (no e-mail)
    const audited = await h.su.query<{ code: string | null }>(
      `SELECT details ->> 'reason_code' AS code FROM scf.audit_log
        WHERE tenant_id = $1 AND action = 'tenant.removed' ORDER BY seq DESC LIMIT 1`,
      [t],
    );
    expect(audited.rows[0]?.code).toBe("not_ecosystem");
    const seen = await call(h, { method: "GET", url: `/v1/tenants/${t}`, cookie: owner });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json()).toMatchObject({
      status: "removed",
      status_reason: "not part of the ecosystem",
      removal_reason_code: "not_ecosystem",
    });
    const detail = await call(h, {
      method: "GET",
      url: `/v1/operator/tenants/${t}`,
      cookie: operator,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().tenant.removal_reason_code).toBe("not_ecosystem");
    const after = new Date(body.purge_after).getTime() - new Date(body.removed_at).getTime();
    expect(Math.round(after / 86_400_000)).toBe(30);
    expect((await payloadNow()).tenants.some((x) => x.tenant_id === t)).toBe(false);
    // the tenant is read-only for its members (C-08)
    const write = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${t}`,
      cookie: owner,
      body: { name: "x" },
    });
    expect(write.statusCode).toBe(403);
    // tombstones: the verified host and the owner's GitHub identity
    const list = await call(h, {
      method: "GET",
      url: "/v1/operator/tombstones?limit=200",
      cookie: admin,
    });
    expect(list.statusCode, list.body).toBe(200);
    const mine = list.json().items.filter((x: { tenant_id: string }) => x.tenant_id === t);
    expect(
      mine.map((x: { kind: string; subject: string }) => `${x.kind}:${x.subject}`).sort(),
    ).toEqual([`github_user:${ownerUser.id}`, `host:${host}`]);
    // the tombstoned identity cannot enroll again …
    const again = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie: owner,
      body: { slug: uniqueSlug(), name: "again" },
    });
    expect(again.statusCode).toBe(403);
    // … until an operator_admin lifts the tombstone (C-70)
    const gh = mine.find((x: { kind: string }) => x.kind === "github_user");
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/operator/tombstones/${gh.tombstone_id}/lift`,
          cookie: admin,
        })
      ).statusCode,
    ).toBe(204);
    const lifted = (
      await call(h, { method: "GET", url: "/v1/operator/tombstones?limit=200", cookie: admin })
    )
      .json()
      .items.find((x: { tombstone_id: string }) => x.tombstone_id === gh.tombstone_id);
    expect(lifted.lifted_at).not.toBeNull();
    expect(
      (
        await call(h, {
          method: "POST",
          url: "/v1/tenants",
          cookie: owner,
          body: { slug: uniqueSlug(), name: "again" },
        })
      ).statusCode,
    ).toBe(201);
  });

  it("restore returns a removed tenant to suspended; purge now sets purge_after to now", async () => {
    const restored = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/restoration`,
      cookie: admin,
      body: { reason: "appeal accepted" },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({
      status: "suspended",
      purge_after: null,
      removal_reason_code: null,
    });
    expect((await transition(t, "reinstate")).json().status).toBe("active");
    // purge only from removed
    const early = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/purge`,
      cookie: admin,
      body: { reason: "x" },
    });
    expect(early.statusCode).toBe(409);
    await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/removal`,
      cookie: admin,
      body: { reason: "r" },
    });
    const purge = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/purge`,
      cookie: admin,
      body: { reason: "confirmed" },
    });
    expect(purge.statusCode, purge.body).toBe(200);
    expect(new Date(purge.json().purge_after).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("the tenant audit log shows the operators' actions on the tenant; the chain verifies", async () => {
    // (the owner above is tombstoned again by the second removal: a fresh member)
    const owner = await signInGithub(h, newGithubUser());
    const t2 = await createTenant(h, owner);
    await transition(t2, "suspend");
    await transition(t2, "reinstate");
    const page1 = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t2}/audit?limit=2`,
      cookie: owner,
    });
    expect(page1.statusCode, page1.body).toBe(200);
    expect(page1.json().items.map((i: { action: string }) => i.action)).toEqual([
      "tenant.reinstated",
      "tenant.suspended",
    ]);
    expect(page1.json().items[0]).toMatchObject({
      actor_kind: "operator",
      chain_id: t2,
      outcome: "success",
    });
    expect(page1.json().items[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
    const page2 = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t2}/audit?limit=2&cursor=${page1.json().next_cursor}`,
      cookie: owner,
    });
    expect(page2.json().items.map((i: { action: string }) => i.action)).toEqual(["tenant.created"]);
    expect(page2.json().next_cursor).toBeNull();
    const filtered = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t2}/audit?action_prefix=tenant.sus`,
      cookie: owner,
    });
    expect(filtered.json().items).toHaveLength(1);
    expect(await verifyAuditChain(h, t2)).toBe(3);
    expect(
      (
        await call(h, {
          method: "GET",
          url: `/v1/tenants/${t2}/audit?cursor=%25%25`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("bulk re-approval (C-91, C-94)", () => {
  it("moves active tenants of the chosen levels to pending; each move is audited in the tenant's chain", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const res = await call(h, {
      method: "POST",
      url: "/v1/operator/reapprovals",
      cookie: admin,
      body: { levels: ["L0"], reason: "moving to approval-required" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const moved: string[] = res.json().tenant_ids;
    expect(moved).toContain(t);
    expect(res.json().moved_count).toBe(moved.length);
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${t}`, cookie: owner })).json().status,
    ).toBe("pending");
    // restore every moved tenant (one shared database for all test files)
    for (const id of moved) expect((await transition(id, "approve")).statusCode).toBe(200);
    const actions = await h.su.query(
      `SELECT action FROM scf.audit_log WHERE chain_id = $1 ORDER BY seq`,
      [t],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      "tenant.created",
      "tenant.reapproval_required",
      "tenant.approved",
    ]);
  });
});

describe("installation check (C-39) and snippet (ADR-0004, C-55)", () => {
  let owner = "";
  let t = "";
  let site = { site_id: "", site_key: "" };

  beforeAll(async () => {
    owner = await signInGithub(h, newGithubUser());
    t = await createTenant(h, owner);
    site = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "I" },
      })
    ).json();
  });

  it("shows the site's own verdict, reason and drop counters, exact (not rounded)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const rows: Array<[string, string, string, number]> = [
      [today, "verdict", "verified", 41],
      [today, "verdict", "suspect", 3],
      [today, "verdict", "rejected", 7],
      [today, "reason", "origin_mismatch", 5],
      [today, "reason", "proof_missing", 3],
      [today, "reason", "ua_bot", 2],
      [today, "drop", "country_excluded", 4],
      [today, "kit_present_pageviews", "all", 6],
      [today, "reason", "transport_mismatch", 1],
      [today, "multiplicity", "high", 2],
      [today, "multiplicity", "high_shadow", 9],
      // C-129: equal counts of two versions → the higher one; the old day's version is outside the range
      [today, "tracker_version", "v0_9_0", 20],
      [today, "tracker_version", "v1_0_0", 20],
      [old, "tracker_version", "v0_8_0", 900],
      [old, "verdict", "verified", 1000],
      [old, "multiplicity", "high_shadow", 500],
    ];
    for (const [day, counter, label, n] of rows)
      await h.su.query(
        `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count) VALUES ($1, $2, $3, $4, $5, $6)`,
        [t, site.site_id, day, counter, label, n],
      );
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/sites/${site.site_id}/installation?range=30d`,
      cookie: owner,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      site_id: site.site_id,
      tracker_version_seen: "1.0.0",
      outdated_tracker: false, // 1.0.0 is the newest active release of the fixture registry
      verdicts: { verified: 41, suspect: 3, rejected: 7 },
      reasons: [
        { code: "origin_mismatch", verdict: "rejected", count: 5 },
        { code: "proof_missing", verdict: "suspect", count: 3 },
        { code: "ua_bot", verdict: "rejected", count: 2 },
        { code: "transport_mismatch", verdict: "suspect", count: 1 },
      ],
      drops: [{ label: "country_excluded", count: 4 }],
      kit_present_pageviews: 6,
      multiplicity: { mode: "enforce", source: "platform", high_shadow: 9 },
    });
  });

  it("multiplicity mode (C-124): only an operator_admin with step-up sets a site's override; it reaches the snapshot and the installation check", async () => {
    const url = `/v1/operator/tenants/${t}/sites/${site.site_id}/multiplicity-mode`;
    const check = async () =>
      (
        await call(h, {
          method: "GET",
          url: `/v1/tenants/${t}/sites/${site.site_id}/installation?range=24h`,
          cookie: owner,
        })
      ).json().multiplicity;
    const atEdge = async () => {
      const p = await payloadNow();
      return {
        platform: p.settings.multiplicity_mode,
        site: p.sites.find((x) => x.site_id === site.site_id)?.multiplicity_mode,
      };
    };
    expect(await atEdge()).toEqual({ platform: "enforce", site: null });
    // the tenant cannot change it: not part of a site update (contract) …
    const own = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${t}/sites/${site.site_id}`,
      cookie: owner,
      body: { multiplicity_mode: "shadow" },
    });
    expect(own.statusCode).toBe(400);
    // … and a plain operator neither
    const plain = await call(h, {
      method: "PUT",
      url,
      cookie: operator,
      body: { multiplicity_mode: "shadow" },
    });
    expect(plain.statusCode).toBe(403);
    const bad = await call(h, {
      method: "PUT",
      url,
      cookie: admin,
      body: { multiplicity_mode: "off" },
    });
    expect(bad.statusCode).toBe(400);
    const foreign = await call(h, {
      method: "PUT",
      url: `/v1/operator/tenants/${randomUUID()}/sites/${site.site_id}/multiplicity-mode`,
      cookie: admin,
      body: { multiplicity_mode: "shadow" },
    });
    expect(foreign.statusCode).toBe(404);

    const set = await call(h, {
      method: "PUT",
      url,
      cookie: admin,
      body: { multiplicity_mode: "shadow" },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({
      site_id: site.site_id,
      multiplicity_mode: "shadow",
      effective_multiplicity_mode: "shadow",
    });
    expect(await atEdge()).toEqual({ platform: "enforce", site: "shadow" });
    expect(await check()).toMatchObject({ mode: "shadow", source: "site" });
    const audit = await h.su.query(
      `SELECT details FROM scf.audit_log WHERE action = 'site.multiplicity_mode_set' AND tenant_id = $1`,
      [t],
    );
    expect(audit.rows.map((r) => r.details)).toContainEqual({
      site_id: site.site_id,
      from: null,
      to: "shadow",
    });

    // the platform setting (operator settings, step-up) applies to every site without an override
    const platform = await call(h, {
      method: "PATCH",
      url: "/v1/operator/settings/multiplicity_mode",
      cookie: admin,
      body: { value: "shadow" },
    });
    expect(platform.statusCode, platform.body).toBe(200);
    const invalid = await call(h, {
      method: "PATCH",
      url: "/v1/operator/settings/multiplicity_mode",
      cookie: admin,
      body: { value: "off" },
    });
    expect(invalid.statusCode).toBe(422);
    const inherit = await call(h, {
      method: "PUT",
      url,
      cookie: admin,
      body: { multiplicity_mode: null },
    });
    expect(inherit.json()).toMatchObject({
      multiplicity_mode: null,
      effective_multiplicity_mode: "shadow",
    });
    expect(await atEdge()).toEqual({ platform: "shadow", site: null });
    expect(await check()).toMatchObject({ mode: "shadow", source: "platform" });
    const back = await call(h, {
      method: "PATCH",
      url: "/v1/operator/settings/multiplicity_mode",
      cookie: admin,
      body: { value: "enforce" },
    });
    expect(back.statusCode).toBe(200);
    expect(await check()).toMatchObject({ mode: "enforce", source: "platform" });
  });

  it("generates the SRI snippet for the site's profile, the consent-gated variant and the npm form", async () => {
    const url = (q: string) => `/v1/tenants/${t}/sites/${site.site_id}/snippet${q}`;
    const html = (await call(h, { method: "GET", url: url(""), cookie: owner })).json();
    expect(html).toMatchObject({
      format: "html",
      version: "1.0.0",
      integrity: integrityOf("standard"),
    });
    expect(html.code).toContain(
      'src="https://ingest-a.example-analytics.org/lib/1.0.0/standard.js"',
    );
    expect(html.code).toContain('crossorigin="anonymous"');
    expect(html.code).toContain(`data-site="${site.site_key}"`);
    expect(html.code).not.toContain("data-consent");
    const consent = (
      await call(h, { method: "GET", url: url("?format=consent_html"), cookie: owner })
    ).json();
    expect(consent.code).toContain('data-consent="required"');
    expect(consent.code).toContain("grantConsent");
    expect(consent.code).toContain("revokeConsent");
    const npm = (await call(h, { method: "GET", url: url("?format=npm"), cookie: owner })).json();
    expect(npm.integrity).toBeUndefined();
    expect(npm.code).toContain('import { init } from "@usagemap/tracker";');
    for (const f of ["nextjs", "vite", "astro", "angular"]) {
      const r = await call(h, { method: "GET", url: url(`?format=${f}`), cookie: owner });
      expect(r.statusCode).toBe(200);
      expect(r.json().code).toContain(site.site_key);
    }
    expect(
      (await call(h, { method: "GET", url: url("?version=9.9.9"), cookie: owner })).statusCode,
    ).toBe(400);
    // strict profile → strict.js with its own hash
    await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${t}/sites/${site.site_id}`,
      cookie: owner,
      body: { tracker_profile: "strict" },
    });
    const strict = (await call(h, { method: "GET", url: url(""), cookie: owner })).json();
    expect(strict.integrity).toBe(integrityOf("strict"));
    expect(strict.code).toContain("/lib/1.0.0/strict.js");
    const strictNpm = (
      await call(h, { method: "GET", url: url("?format=npm"), cookie: owner })
    ).json();
    expect(strictNpm.code).toContain("@usagemap/tracker/strict");
  });
});
