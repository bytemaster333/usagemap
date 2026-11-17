// SPDX-License-Identifier: Apache-2.0
// Onboarding of SCF-awarded projects against real PostgreSQL (migration 0073): the public picker (public fields only,
// merged sources, no enumeration of non-awarded or missing rows, its own rate limit), the pre-fill and claim state
// ("claim, not grab": a pre-fill grants nothing; a project verified by another tenant shows as claimed), the
// sign-up through the existing operations, the integration kit, and the SCF operator's coverage view. All registry
// rows here are fake.

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  type Harness,
  newGithubUser,
  operatorSession,
  PORTAL,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

let h: Harness;
const C1 = `C${"F".repeat(54)}A`;
const run = randomUUID().slice(0, 6);
const DOMAIN = `fakeorbit-${run}.example`;
const ids = {
  orbit: randomUUID(),
  orbitAtlas: randomUUID(),
  tool: randomUUID(),
  notAwarded: randomUUID(),
  missing: randomUUID(),
};
const sha = (s: string) => createHash("sha256").update(s).digest();

async function seedRow(p: {
  id: string;
  source: "stellarlight" | "pg_atlas";
  name: string;
  websites?: string[];
  domains?: string[];
  contracts?: string[];
  categories?: string[];
  round?: number | null;
  stage?: string | null;
  awarded?: boolean;
  missing?: boolean;
}) {
  await h.su.query(
    `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, websites, registrable_domains,
       contract_ids, scf_categories, award_round, award_stage, scf_awarded, fetched_at, content_sha256, raw,
       missing_since)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12, '{}', CASE WHEN $13 THEN now() END)`,
    [
      p.id,
      p.source,
      `onb-${p.id}`,
      p.name,
      p.websites ?? [],
      p.domains ?? [],
      p.contracts ?? [],
      p.categories ?? [],
      p.round ?? null,
      p.stage ?? null,
      p.awarded ?? true,
      sha(p.id),
      p.missing ?? false,
    ],
  );
}

beforeAll(async () => {
  h = await startHarness();
  await seedRow({
    id: ids.orbit,
    source: "stellarlight",
    name: `Fakeorbit Wallet ${run}`,
    websites: [`https://${DOMAIN}`],
    domains: [DOMAIN],
    contracts: [C1],
    categories: ["end_user_application"],
    round: 33,
  });
  await seedRow({
    id: ids.orbitAtlas,
    source: "pg_atlas",
    name: `FakeOrbit ${run}`,
    websites: [`https://${DOMAIN}/`],
    domains: [DOMAIN],
    categories: ["applications"],
    stage: "t3_mainnet",
  });
  await seedRow({
    id: ids.tool,
    source: "stellarlight",
    name: `Fakeorbit Devtool ${run}`,
    websites: [`https://fakeorbit-devtool-${run}.vercel.app`],
    domains: [`fakeorbit-devtool-${run}.vercel.app`],
    categories: ["developer_tooling"],
    round: 30,
  });
  await seedRow({
    id: ids.notAwarded,
    source: "pg_atlas",
    name: `Fakeorbit Applicant ${run}`,
    awarded: false,
  });
  await seedRow({
    id: ids.missing,
    source: "stellarlight",
    name: `Fakeorbit Gone ${run}`,
    missing: true,
  });
});

afterAll(async () => {
  expect(h.responseProblems).toEqual([]);
  await h?.close();
});

const search = (q: string, extra = "") =>
  call(h, {
    method: "GET",
    url: `/public/v1/registry/projects?q=${encodeURIComponent(q)}${extra}`,
  });

describe("public picker", () => {
  it("finds a project by name or domain, merges its sources, hides non-awarded and missing rows", async () => {
    const res = await search(`fakeorbit wallet ${run}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toEqual([
      {
        registry_project_id: ids.orbit,
        name: `Fakeorbit Wallet ${run}`,
        website: `https://${DOMAIN}`,
        domain: DOMAIN,
        categories: ["applications", "end_user_application"],
        award_round: 33,
        award_stage: "t3_mainnet",
        sources: ["stellarlight", "pg_atlas"],
      },
    ]);
    const all = (await search(run)).json();
    const names = all.items.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual([`Fakeorbit Devtool ${run}`, `Fakeorbit Wallet ${run}`]);
    expect(all.more).toBe(false);
    expect((await search(DOMAIN.toUpperCase())).json().items[0].registry_project_id).toBe(
      ids.orbit,
    );
  });

  it("small pages, a minimum query and literal wildcards: no enumeration", async () => {
    const one = (await search(run, "&limit=1")).json();
    expect(one.items).toHaveLength(1);
    expect(one.more).toBe(true);
    expect((await search("f")).statusCode).toBe(400);
    expect((await search(run, "&limit=11")).statusCode).toBe(400);
    expect((await search("%%")).json().items).toEqual([]);
    expect((await search("__")).json().items).toEqual([]);
  });
});

let owner = "";
let tenantId = "";
let siteId = "";

describe("pre-fill and claim", () => {
  it("needs a session; unknown, missing and non-awarded projects are 404", async () => {
    expect(
      (await call(h, { method: "GET", url: `/v1/onboarding/registry-projects/${ids.orbit}` }))
        .statusCode,
    ).toBe(401);
    owner = await signInGithub(h, newGithubUser());
    for (const id of [randomUUID(), ids.missing, ids.notAwarded]) {
      const r = await call(h, {
        method: "GET",
        url: `/v1/onboarding/registry-projects/${id}`,
        cookie: owner,
      });
      expect(r.statusCode, id).toBe(404);
    }
  });

  it("pre-fills from the registry and claims nothing", async () => {
    const r = await call(h, {
      method: "GET",
      url: `/v1/onboarding/registry-projects/${ids.orbitAtlas}`,
      cookie: owner,
    });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.project.registry_project_id).toBe(ids.orbit);
    expect(b.prefill).toEqual({
      tenant_name: `Fakeorbit Wallet ${run}`,
      slug: `fakeorbit-wallet-${run}`.toLowerCase(),
      site_name: DOMAIN,
      site_domain: DOMAIN,
      contracts: [{ contract_id: C1, status: "claimed" }],
    });
    expect(b.claim).toEqual({ state: "open", your_tenant_ids: [] });
    expect(b.is_dapp).toBe(true);
    expect(b.verification_options[0].method).toBe("dns_txt");
    const tool = await call(h, {
      method: "GET",
      url: `/v1/onboarding/registry-projects/${ids.tool}`,
      cookie: owner,
    });
    expect(tool.json().framework_hint.framework).toBe("nextjs");
    expect(tool.json().is_dapp).toBe(false);
  });

  it("signs up through the existing operations; the project is then `yours`, still open for others", async () => {
    const pre = (
      await call(h, {
        method: "GET",
        url: `/v1/onboarding/registry-projects/${ids.orbit}`,
        cookie: owner,
      })
    ).json();
    const t = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie: owner,
      body: { slug: pre.prefill.slug, name: pre.prefill.tenant_name },
    });
    expect(t.statusCode, t.body).toBe(201);
    tenantId = t.json().tenant_id;
    const s = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenantId}/sites`,
      cookie: owner,
      body: { name: pre.prefill.site_name },
    });
    expect(s.statusCode, s.body).toBe(201);
    siteId = s.json().site_id;
    const d = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenantId}/sites/${siteId}/domains`,
      cookie: owner,
      body: { host: DOMAIN },
    });
    expect(d.statusCode, d.body).toBe(201);
    const v = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenantId}/sites/${siteId}/domains/${d.json().domain_id}/verifications`,
      cookie: owner,
      body: { method: "dns_txt" },
    });
    expect(v.statusCode, v.body).toBe(201);
    expect(v.json().instructions.dns_name).toBe(`_scf-verify.${DOMAIN}`);
    const f = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenantId}/footprint`,
      cookie: owner,
      body: { kind: "contract", subject: C1, network: "mainnet" },
    });
    expect(f.statusCode, f.body).toBe(201);
    expect(f.json().status).toBe("claimed");

    const mine = await call(h, {
      method: "GET",
      url: `/v1/onboarding/registry-projects/${ids.orbit}`,
      cookie: owner,
    });
    expect(mine.json().claim).toEqual({ state: "yours", your_tenant_ids: [tenantId] });
    const other = await signInGithub(h, newGithubUser());
    const theirs = await call(h, {
      method: "GET",
      url: `/v1/onboarding/registry-projects/${ids.orbit}`,
      cookie: other,
    });
    // only declared, not verified: nobody holds the project yet
    expect(theirs.json().claim).toEqual({ state: "open", your_tenant_ids: [] });
  });

  it("the integration kit carries the site key, the registry match and the progress", async () => {
    const r = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenantId}/onboarding/kit`,
      cookie: owner,
    });
    expect(r.statusCode, r.body).toBe(200);
    const k = r.json();
    const key = k.site.site_key as string;
    expect(k.site.site_id).toBe(siteId);
    expect(k.registry_project.registry_project_id).toBe(ids.orbit);
    expect(k.framework).toEqual({ selected: "html", detected: { framework: null, basis: null } });
    expect(k.script_tag.code).toContain(`data-site="${key}"`);
    expect(k.script_tag.code).toContain('integrity="sha384-');
    expect(k.wallets.recommended).toBe(true);
    expect(k.contracts).toEqual([{ contract_id: C1, registered: true }]);
    expect(k.test_commands[0].code).toContain(key);
    expect(k.test_commands[0].code).toContain(`Origin: https://${DOMAIN}`);
    expect(JSON.stringify(k)).not.toMatch(/scfa_ing_/);
    const done = Object.fromEntries(
      k.checklist.map((c: { id: string; done: boolean }) => [c.id, c.done]),
    );
    expect(done).toMatchObject({
      project: true,
      website: true,
      domain_declared: true,
      domain_verified: false,
      snippet_live: false,
      contracts: true,
      registry_match: false,
    });
    const nuxt = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenantId}/onboarding/kit?framework=nuxt&service_name=fake-api`,
      cookie: owner,
    });
    expect(nuxt.json().framework_snippet.filename).toBe("app/plugins/scf-analytics.client.ts");
    expect(nuxt.json().otel.env.OTEL_SERVICE_NAME).toBe("fake-api");
    const unknownSite = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenantId}/onboarding/kit?site_id=${randomUUID()}`,
      cookie: owner,
    });
    expect(unknownSite.statusCode).toBe(404);
    expect(
      (
        await call(h, {
          method: "GET",
          url: `/v1/tenants/${tenantId}/onboarding/kit?framework=cobol`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("once verified by this tenant, another user sees `claimed` (dispute path), the owner still `yours`", async () => {
    await h.su.query(
      `BEGIN;
       UPDATE scf.site_domains SET state = 'verified', verified_at = now() WHERE tenant_id = '${tenantId}' AND host = '${DOMAIN}';
       INSERT INTO scf.host_claims (host, tenant_id, domain_id)
         SELECT host, tenant_id, domain_id FROM scf.site_domains WHERE tenant_id = '${tenantId}' AND host = '${DOMAIN}';
       COMMIT;`,
    );
    const other = await signInGithub(h, newGithubUser());
    const theirs = await call(h, {
      method: "GET",
      url: `/v1/onboarding/registry-projects/${ids.orbitAtlas}`,
      cookie: other,
    });
    expect(theirs.json().claim).toEqual({ state: "claimed", your_tenant_ids: [] });
    const mine = await call(h, {
      method: "GET",
      url: `/v1/onboarding/registry-projects/${ids.orbit}`,
      cookie: owner,
    });
    expect(mine.json().claim.state).toBe("yours");
    const kit = (
      await call(h, { method: "GET", url: `/v1/tenants/${tenantId}/onboarding/kit`, cookie: owner })
    ).json();
    expect(kit.checklist.find((c: { id: string }) => c.id === "domain_verified").done).toBe(true);
  });
});

describe("operator coverage", () => {
  it("lists every SCF-awarded project with its status and an invite link; tenants get 403", async () => {
    const op = await operatorSession(h, "operator");
    const res = await call(h, {
      method: "GET",
      url: "/v1/operator/onboarding/coverage",
      cookie: op.cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    type Item = {
      project: { registry_project_id: string };
      status: string;
      tenants_verified: number;
      invite_url: string;
    };
    const byId = new Map<string, Item>(
      b.items.map((i: Item) => [i.project.registry_project_id, i]),
    );
    expect(byId.get(ids.orbit)).toMatchObject({ status: "verified", tenants_verified: 1 });
    expect(byId.get(ids.orbit)?.invite_url).toBe(`${PORTAL}/onboard?project=${ids.orbit}`);
    expect(byId.get(ids.tool)?.status).toBe("not_enrolled");
    expect(byId.has(ids.orbitAtlas)).toBe(false); // merged into its Stellarlight row
    expect(byId.has(ids.notAwarded) || byId.has(ids.missing)).toBe(false);
    expect(b.totals.projects).toBe(
      b.totals.not_enrolled + b.totals.enrolled + b.totals.verified + b.totals.measuring,
    );

    // page views yesterday: measuring
    await h.su.query(
      `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
         pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
         total_duration_s, events_raw, is_final, engine_version)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 1, 4, 5, 0, 0, 2, 2, 2, 1, 60, 5, true, 'umami/3.5.0')`,
      [tenantId, siteId],
    );
    const m = await call(h, {
      method: "GET",
      url: `/v1/operator/onboarding/coverage?status=measuring&q=${encodeURIComponent(DOMAIN)}`,
      cookie: op.cookie,
    });
    expect(m.json().items.map((i: Item) => i.project.registry_project_id)).toEqual([ids.orbit]);

    const tenantUser = await call(h, {
      method: "GET",
      url: "/v1/operator/onboarding/coverage",
      cookie: owner,
    });
    expect(tenantUser.statusCode).toBe(403);
  });
});

describe("picker rate limit", () => {
  it("answers 429 once the per-subnet search limit is used up; other public reads continue", async () => {
    let limited = 0;
    for (let i = 0; i < 31 && limited === 0; i++) {
      const r = await search(`zz-${i}`);
      if (r.statusCode === 429) limited = i + 1;
      else expect(r.statusCode).toBe(200);
    }
    expect(limited).toBeGreaterThan(0);
    expect((await call(h, { method: "GET", url: "/public/v1/thresholds" })).statusCode).toBe(200);
  });
});
