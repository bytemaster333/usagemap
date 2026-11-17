// SPDX-License-Identifier: Apache-2.0
// Verification ladder (ADR-0015, C-19), trust views (ADR-0028, C-44, C-80) and the SCF-operator actions on them
// (C-09, C-17): L2 Stellar-account proof (SEP-53 + medium threshold + home_domain + stellar.toml), registry candidates
// and operator decisions, L4 approval, domain disputes, annotations by both sides, trust scores, on-chain counts, the
// campaign comparison and the registry sync trigger.

import { randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { tomlAccounts } from "../../src/verify/ladder.ts";
import { declareContract } from "../support/api-seed.ts";
import {
  ageSession,
  call,
  type Harness,
  operatorSession,
  type StellarKey,
  signSep10,
  startHarness,
  stellarKey,
} from "../support/harness.ts";
import { type SeededProject, seedProject, seedWebDay } from "../support/op-seed.ts";

let h: Harness;
let p: SeededProject;
let q: SeededProject;
let op = "";
let awardedId = "";
const host = (s: SeededProject) => `${s.slug}.example`;

async function registryProject(awarded: boolean, source = "stellarlight"): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, fetched_at,
       content_sha256, raw, websites, scf_awards, source_as_of)
     VALUES ($1, $2, $3, $4, $5, now(), sha256(convert_to($3, 'UTF8')), '{}'::jsonb, '{https://x.example}',
             '[{"round":29,"award_type":"Build","amount_usd":50000,"status":"Awarded"}]'::jsonb, '2026-11-01')`,
    [id, source, `src-${id}`, `Registry ${id.slice(0, 6)}`, awarded],
  );
  return id;
}

async function level(s: SeededProject): Promise<string> {
  return (
    await call(h, {
      method: "GET",
      url: `/v1/tenants/${s.tenantId}/verification`,
      cookie: s.cookie,
    })
  ).json().level;
}

beforeAll(async () => {
  h = await startHarness();
  p = await seedProject(h, { level: 1 });
  q = await seedProject(h, { level: 1 });
  op = (await operatorSession(h, "operator")).cookie;
});
afterAll(async () => {
  await h?.close();
});

describe("stellar.toml ACCOUNTS (SEP-1)", () => {
  it("reads the top-level array only, ignoring comments and later tables", () => {
    const a = `G${"A".repeat(55)}`;
    const b = `G${"B".repeat(55)}`;
    expect(
      tomlAccounts(
        `VERSION="2.0.0"\nACCOUNTS = [\n  "${a}", # main\n  '${b}'\n]\n[DOCUMENTATION]\nORG_NAME="x"`,
      ),
    ).toEqual([a, b]);
    expect(tomlAccounts(`[[CURRENCIES]]\nACCOUNTS=["${a}"]`)).toEqual([]);
    expect(tomlAccounts(`# ACCOUNTS=["${a}"]`)).toEqual([]);
  });
});

describe("verification ladder (C-19)", () => {
  let key: StellarKey;

  async function link(s: SeededProject, k: StellarKey, sign = (m: string) => k.signMessage(m)) {
    const ch = await call(h, {
      method: "POST",
      url: `/v1/tenants/${s.tenantId}/verification/stellar/challenge`,
      cookie: s.cookie,
      body: { account: k.account },
    });
    expect(ch.statusCode, ch.body).toBe(201);
    expect(ch.json().message).toContain(s.tenantId);
    return call(h, {
      method: "POST",
      url: `/v1/tenants/${s.tenantId}/verification/stellar/verify`,
      cookie: s.cookie,
      body: { challenge_id: ch.json().challenge_id, signature: sign(ch.json().message) },
    });
  }

  it("shows L1 with domain evidence and the next steps", async () => {
    const v = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${p.tenantId}/verification`,
        cookie: p.cookie,
      })
    ).json();
    expect(v).toMatchObject({ level: "L1", registry_links: [] });
    expect(v.evidence.map((e: { kind: string }) => e.kind)).toEqual(["domain"]);
    expect(v.next_steps).toEqual([
      "link_stellar_account",
      "await_registry_match",
      "await_operator_approval",
    ]);
  });

  it("refuses each missing L2 condition with 422 and links on the complete proof (L2, audited)", async () => {
    key = stellarKey();
    // no home_domain
    h.horizon.accounts.set(key.account, { weight: 1, mediumThreshold: 1, homeDomain: null });
    expect((await link(p, key)).statusCode).toBe(422);
    // home domain not a verified domain of the tenant
    h.horizon.accounts.set(key.account, {
      weight: 1,
      mediumThreshold: 1,
      homeDomain: "elsewhere.example",
    });
    expect((await link(p, key)).statusCode).toBe(422);
    // stellar.toml unreachable, then without the account
    h.horizon.accounts.set(key.account, { weight: 1, mediumThreshold: 1, homeDomain: host(p) });
    expect((await link(p, key)).statusCode).toBe(422);
    h.fetcher.bodies.set(
      `${host(p)}/.well-known/stellar.toml`,
      `ACCOUNTS=["${stellarKey().account}"]`,
    );
    expect((await link(p, key)).statusCode).toBe(422);
    // below the medium threshold
    h.fetcher.bodies.set(`${host(p)}/.well-known/stellar.toml`, `ACCOUNTS=["${key.account}"]`);
    h.horizon.accounts.set(key.account, { weight: 1, mediumThreshold: 2, homeDomain: host(p) });
    expect((await link(p, key)).statusCode).toBe(422);
    // a signature by another key
    h.horizon.accounts.set(key.account, { weight: 1, mediumThreshold: 1, homeDomain: host(p) });
    const intruder = stellarKey();
    expect((await link(p, key, (m) => intruder.signMessage(m))).statusCode).toBe(422);
    expect(await level(p)).toBe("L1");
    // complete
    const ok = await link(p, key);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().level).toBe("L2");
    const ev = ok.json().evidence.find((e: { kind: string }) => e.kind === "stellar_account");
    expect(ev).toMatchObject({ subject: key.account, status: "valid" });
    expect(ev.details).toMatchObject({
      method: "sep53",
      home_domain: host(p),
      signer_weight: 1,
      medium_threshold: 1,
    });
  });

  it("a challenge is single-use and bound to its tenant and member", async () => {
    const k = stellarKey();
    const ch = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/verification/stellar/challenge`,
        cookie: p.cookie,
        body: { account: k.account },
      })
    ).json();
    const body = { challenge_id: ch.challenge_id, signature: k.signMessage(ch.message) };
    // another tenant's admin cannot use it
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${q.tenantId}/verification/stellar/verify`,
          cookie: q.cookie,
          body,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${p.tenantId}/verification/stellar/verify`,
          cookie: p.cookie,
          body,
        })
      ).statusCode,
    ).toBe(422); // no home domain for this account
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${p.tenantId}/verification/stellar/verify`,
          cookie: p.cookie,
          body,
        })
      ).statusCode,
    ).toBe(404); // consumed
    // SEP-10 linking (hardware wallets, multisig): the signed challenge must reach the medium threshold
    const a = Keypair.random();
    const b2 = Keypair.random();
    h.horizon.accounts.set(a.publicKey(), {
      weight: 1,
      mediumThreshold: 2,
      homeDomain: host(p),
      signers: [
        { key: a.publicKey(), weight: 1 },
        { key: b2.publicKey(), weight: 1 },
      ],
    });
    h.fetcher.bodies.set(`${host(p)}/.well-known/stellar.toml`, `ACCOUNTS=["${a.publicKey()}"]`);
    const sep10 = async (...keys: Keypair[]) => {
      const c = await call(h, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/verification/stellar/challenge`,
        cookie: p.cookie,
        body: { account: a.publicKey(), method: "sep10" },
      });
      expect(c.statusCode, c.body).toBe(201);
      return call(h, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/verification/stellar/verify`,
        cookie: p.cookie,
        body: {
          challenge_id: c.json().challenge_id,
          signed_transaction_xdr: signSep10(
            c.json().transaction_xdr,
            c.json().network_passphrase,
            ...keys,
          ),
        },
      });
    };
    expect((await sep10(a)).statusCode).toBe(422);
    const linked = await sep10(a, b2);
    expect(linked.statusCode, linked.body).toBe(200);
    const ev = linked.json().evidence.find((e: { subject: string }) => e.subject === a.publicKey());
    expect(ev.details).toMatchObject({ method: "sep10", signer_weight: 2, medium_threshold: 2 });
  });

  it("registry candidates, operator confirmation (L3 with an SCF award) and rejection", async () => {
    const awarded = await registryProject(true);
    awardedId = awarded;
    const plain = await registryProject(false, "pg_atlas");
    await h.su.query(
      `INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
       VALUES ($1, $2, '{registrable_domain}', 'candidate'), ($1, $3, '{daoip5}', 'candidate')`,
      [q.tenantId, awarded, plain],
    );
    const cands = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${q.tenantId}/verification/registry-candidates`,
        cookie: q.cookie,
      })
    ).json();
    expect(cands).toHaveLength(2);
    expect(
      cands.find((c: { registry_project_id: string }) => c.registry_project_id === awarded),
    ).toMatchObject({
      registry_project_id: awarded,
      source: "stellarlight",
      scf_awarded: true,
      status: "candidate",
      source_as_of: "2026-11-01",
    });
    const decide = (id: string, decision: string) =>
      call(h, {
        method: "PUT",
        url: `/v1/operator/tenants/${q.tenantId}/registry-links/${id}`,
        cookie: op,
        body: { decision },
      });
    expect((await decide(awarded, "confirm")).statusCode).toBe(204);
    expect((await decide(plain, "reject")).statusCode).toBe(204);
    expect(await level(q)).toBe("L3");
    const links = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${q.tenantId}/verification`,
        cookie: q.cookie,
      })
    ).json().registry_links;
    expect(links.map((l: { status: string }) => l.status).sort()).toEqual([
      "confirmed",
      "rejected",
    ]);
    expect((await decide(randomUUID(), "confirm")).statusCode).toBe(404);
    expect(
      (
        await call(h, {
          method: "PUT",
          url: `/v1/operator/tenants/${randomUUID()}/registry-links/${awarded}`,
          cookie: op,
          body: { decision: "confirm" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("SCF-operator approval gives L4 and needs a fresh step-up (C-09)", async () => {
    const res = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${q.tenantId}/approval`,
      cookie: op,
      body: { note: "checked" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      kind: "operator_approval",
      subject: "operator",
      status: "valid",
    });
    expect(res.json().details).toEqual({ note: "checked" });
    expect(await level(q)).toBe("L4");
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/operator/tenants/${randomUUID()}/approval`,
          cookie: op,
          body: { note: "x" },
        })
      ).statusCode,
    ).toBe(404);
    const stale = (await operatorSession(h, "operator")).cookie;
    await ageSession(h, stale, 11);
    const r = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${q.tenantId}/approval`,
      cookie: stale,
      body: { note: "x" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("step_up_required");
  });

  it("dispute resolution keeps or releases a disputed domain", async () => {
    const d = await h.su.query<{ domain_id: string }>(
      `INSERT INTO scf.site_domains (tenant_id, site_id, host, state) VALUES ($1, $2, $3, 'disputed')
       RETURNING domain_id::text AS domain_id`,
      [p.tenantId, p.siteId, `disputed-${randomUUID().slice(0, 6)}.example`],
    );
    const id = d.rows[0]?.domain_id as string;
    const r = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${p.tenantId}/domains/${id}/dispute-resolution`,
      cookie: op,
      body: { decision: "release" },
    });
    expect(r.statusCode).toBe(204);
    expect(
      (await h.su.query(`SELECT state::text FROM scf.site_domains WHERE domain_id = $1`, [id]))
        .rows[0].state,
    ).toBe("unverified");
  });
});

describe("trust: annotations, scores, on-chain counts", () => {
  it("tenant members annotate (no marks_explained); SCF operators may mark a flag explained", async () => {
    const body = {
      site_id: p.siteId,
      start: "2026-11-01T00:00:00Z",
      end: "2026-11-03T00:00:00Z",
      body: "launch",
      explains_reason_codes: ["step_change"],
    };
    const t = await call(h, {
      method: "POST",
      url: `/v1/tenants/${p.tenantId}/annotations`,
      cookie: p.cookie,
      body,
    });
    expect(t.statusCode, t.body).toBe(201);
    expect(t.json()).toMatchObject({
      author_kind: "tenant",
      marks_explained: false,
      start: body.start,
      end: body.end,
    });
    const o = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${p.tenantId}/annotations`,
      cookie: op,
      body: { ...body, body: "checked with the team", marks_explained: true },
    });
    expect(o.statusCode, o.body).toBe(201);
    expect(o.json()).toMatchObject({ author_kind: "scf_operator", marks_explained: true });
    const list = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${p.tenantId}/annotations`,
        cookie: p.cookie,
      })
    ).json();
    expect(list).toHaveLength(2);
    for (const bad of [
      { ...body, end: "2027-11-05T00:00:00Z" },
      { ...body, end: body.start },
      { ...body, explains_reason_codes: ["made_up"] },
      { ...body, start: "2026-11-01T10:00:00Z" },
    ])
      expect(
        (
          await call(h, {
            method: "POST",
            url: `/v1/tenants/${p.tenantId}/annotations`,
            cookie: p.cookie,
            body: bad,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${p.tenantId}/annotations`,
          cookie: p.cookie,
          body: { ...body, site_id: q.siteId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/operator/tenants/${p.tenantId}/annotations`,
          cookie: op,
          body: { ...body, site_id: q.siteId },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("lists the trust scores the job wrote, components closed to the contract shape", async () => {
    await h.su.query(
      `INSERT INTO scf.web_trust_scores (tenant_id, site_id, day, window_days, score, components, reason_codes, decision_rate, algorithm_version)
       VALUES ($1, $2, '2026-11-02', 28, 72, '{"proof_coverage":{"p":0.12,"value":0.88,"eco_percentile":null,"explanation":"share of events with a valid proof","extra":1}}', '{step_change}', 0.95, 'trust/1'),
              ($1, $2, '2026-11-03', 1, NULL, '{}', '{insufficient_data}', NULL, 'trust/1')`,
      [p.tenantId, p.siteId],
    );
    const r = await call(h, {
      method: "GET",
      url: `/v1/tenants/${p.tenantId}/sites/${p.siteId}/trust-scores?start=2026-11-01T00:00:00Z&end=2026-11-04T00:00:00Z`,
      cookie: p.cookie,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual([
      {
        site_id: p.siteId,
        day: "2026-11-02",
        window_days: 28,
        score: 72,
        components: {
          proof_coverage: {
            p: 0.12,
            value: 0.88,
            eco_percentile: null,
            explanation: "share of events with a valid proof",
          },
        },
        reason_codes: ["step_change"],
        decision_rate: 0.95,
        algorithm_version: "trust/1",
      },
      {
        site_id: p.siteId,
        day: "2026-11-03",
        window_days: 1,
        score: null,
        components: {},
        reason_codes: ["insufficient_data"],
        decision_rate: null,
        algorithm_version: "trust/1",
      },
    ]);
    const bad = await call(h, {
      method: "GET",
      url: `/v1/tenants/${p.tenantId}/sites/${p.siteId}/trust-scores?start=2026-11-04T00:00:00Z&end=2026-11-01T00:00:00Z`,
      cookie: p.cookie,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("on-chain daily: empty before the job ran, then exact counts per contract", async () => {
    const url = `/v1/tenants/${p.tenantId}/onchain/daily?start=2026-11-01T00:00:00Z&end=2026-11-04T00:00:00Z`;
    expect((await call(h, { method: "GET", url, cookie: p.cookie })).json()).toEqual([]);
    const c = await declareContract(h, p.cookie, p.tenantId);
    const ref = await h.su.query<{ contract_ref: string }>(
      `SELECT contract_ref::text FROM scf.declared_contracts WHERE tenant_id = $1 LIMIT 1`,
      [p.tenantId],
    );
    await h.su.query(
      `INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations, distinct_invokers, data_source)
       VALUES ($1, $2, '2026-11-02', 1302, 1288, 311, 'ledger_files')`,
      [p.tenantId, ref.rows[0]?.contract_ref],
    );
    const rows = (await call(h, { method: "GET", url, cookie: p.cookie })).json();
    expect(rows).toEqual([
      expect.objectContaining({
        contract_status: "declared",
        day: "2026-11-02",
        invocations: 1302,
        successful_invocations: 1288,
        distinct_invokers: 311,
      }),
    ]);
    expect(rows[0].contract_id).toMatch(/^C[A-Z2-7]{55}$/);
    expect(c).toBeTruthy();
  });
});

describe("SCF-operator programme views", () => {
  it("campaign vs baseline: exact totals per window and per-day ratios (ADR-0032)", async () => {
    for (const d of ["2026-10-01", "2026-10-02"])
      await seedWebDay(h, p, d, { pvVerified: 10, pvRaw: 10, visitorsVerified: 4, visitorsRaw: 4 });
    await seedWebDay(h, p, "2026-10-10", {
      pvVerified: 60,
      pvRaw: 60,
      visitorsVerified: 20,
      visitorsRaw: 20,
    });
    const url = `/v1/operator/comparisons/campaign?tenant_ids=${p.tenantId},${q.tenantId}&campaign_start=2026-10-10T00:00:00Z&campaign_end=2026-10-11T00:00:00Z&baseline_start=2026-10-01T00:00:00Z&baseline_end=2026-10-03T00:00:00Z`;
    const r = await call(h, { method: "GET", url, cookie: op });
    expect(r.statusCode, r.body).toBe(200);
    const row = r.json().rows.find((x: { tenant_id: string }) => x.tenant_id === p.tenantId);
    expect(row).toMatchObject({
      slug: p.slug,
      campaign_days: 1,
      baseline_days: 2,
      campaign: { pageviews: 60, visitors_sum: 20 },
      baseline: { pageviews: 20, visitors_sum: 8 },
      pageviews_per_day_ratio: 6,
      visitors_per_day_ratio: 5,
    });
    expect(
      r.json().rows.find((x: { tenant_id: string }) => x.tenant_id === q.tenantId)
        .pageviews_per_day_ratio,
    ).toBeNull();
    const csv = await call(h, { method: "GET", url, cookie: op, headers: { accept: "text/csv" } });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(
      (await call(h, { method: "GET", url: url.replace(q.tenantId, randomUUID()), cookie: op }))
        .statusCode,
    ).toBe(404);
  });

  it("registry projects with provenance and linked tenants; on-demand sync is queued once while running", async () => {
    const r = await call(h, {
      method: "GET",
      url: `/v1/operator/registry/projects?scf_awarded=true&q=${awardedId.slice(0, 6)}`,
      cookie: op,
    });
    expect(r.statusCode, r.body).toBe(200);
    const linked = r
      .json()
      .items.find((i: { linked_tenant_ids: string[] }) => i.linked_tenant_ids.includes(q.tenantId));
    expect(linked).toMatchObject({
      source: "stellarlight",
      scf_awarded: true,
      scf_awards: [{ round: 29, award_type: "Build", amount_usd: 50000, status: "Awarded" }],
    });

    const listener = new pg.Client({ connectionString: inject("pgSuperUrl") });
    await listener.connect();
    const got: string[] = [];
    listener.on("notification", (n) => got.push(String(n.payload)));
    await listener.query("LISTEN scf_registry_sync");
    try {
      const s = await call(h, { method: "POST", url: "/v1/operator/registry/sync", cookie: op });
      expect(s.statusCode, s.body).toBe(202);
      expect(s.json().status).toBe("running");
      await new Promise((res) => setTimeout(res, 200));
      expect(got).toEqual([s.json().run_id]);
      // a run in progress is returned instead of queuing another
      await h.su.query(
        `INSERT INTO scf.registry_sync_runs (run_id, source) VALUES ($1, 'stellarlight')`,
        [randomUUID()],
      );
      const again = await call(h, {
        method: "POST",
        url: "/v1/operator/registry/sync",
        cookie: op,
      });
      expect(again.statusCode).toBe(202);
      await new Promise((res) => setTimeout(res, 200));
      expect(got).toHaveLength(1);
    } finally {
      await h.su.query(
        `UPDATE scf.registry_sync_runs SET status = 'succeeded', finished_at = now() WHERE status = 'running'`,
      );
      await listener.end();
    }
  });
});
