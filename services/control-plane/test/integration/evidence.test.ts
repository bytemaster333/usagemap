// SPDX-License-Identifier: Apache-2.0
// SCF Evidence Link (traction snapshot v3) against real PostgreSQL: created through the API, signed by the jobs
// service's signer (F16), verifiable with the published key; the funnel (verified vs raw, daily, small-count floor),
// the Growth Hack and Public Goods blocks, the cohort percentile read across tenants by job public_metrics (migration
// 0078) with its floors, and the public document's privacy: no account or contract address, no other project's
// identity or figure, no per-day cell under op_min_count.

import { createPublicKey, randomUUID, verify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/programme/jcs.ts";
import {
  call,
  type Harness,
  SNAPSHOT_PUBLIC_PEM,
  startHarness,
  stellarKey,
} from "../support/harness.ts";
import { type SeededProject, seedProject, seedWebDay } from "../support/op-seed.ts";

const DAY = 86_400_000;
const round = 100 + Math.floor(Math.random() * 800);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const D = (s: string) => Date.parse(`${s}T00:00:00Z`);
const G_ADDRESS = /G[A-Z2-7]{55}/;
const C_ADDRESS = /C[A-Z2-7]{55}/;

let h: Harness;
let me: SeededProject;
const peers: SeededProject[] = [];
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const contractId = `C${Array.from({ length: 55 }, () => B32[Math.floor(Math.random() * 32)]).join("")}`;

async function link(p: SeededProject, cats: string[], r: number | null) {
  const rp = randomUUID();
  await h.su.query(
    `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, fetched_at,
       content_sha256, raw, scf_categories, award_round, award_stage)
     VALUES ($1, 'operator', $2, $3, true, now(), sha256(convert_to($2, 'UTF8')), '{}'::jsonb, $4, $5, 't2_testnet')`,
    [rp, `ev-${p.slug}`, `Registry ${p.slug}`, cats, r],
  );
  await h.su.query(
    `INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
     VALUES ($1, $2, '{operator}', 'confirmed')`,
    [p.tenantId, rp],
  );
}

async function wallet(day: string, event: string, network: string, verdict: string, count: number) {
  await h.su.query(
    `INSERT INTO scf.web_event_property_daily (tenant_id, site_id, day, event_name, network, prop_key, prop_value,
       verdict, count)
     VALUES ($1, $2, $3::date, $4, $5, '_total', 'all', $6, $7),
            ($1, $2, $3::date, $4, $5, 'wallet', 'freighter', $6, $7)`,
    [me.tenantId, me.siteId, day, event, network, verdict, count],
  );
}

beforeAll(async () => {
  h = await startHarness();
  me = await seedProject(h, { level: 1 });
  await link(me, ["infrastructure_services"], round);
  // 8 weeks of web data: baseline weeks 20 verified visitors a day, campaign weeks 40.
  for (let d = D("2026-09-07"); d < D("2026-11-02"); d += DAY) {
    const campaign = d >= D("2026-10-05");
    await seedWebDay(h, me, dayOf(d), {
      pvVerified: 100,
      pvRaw: 110,
      visitorsVerified: campaign ? 40 : 20,
      visitorsRaw: campaign ? 44 : 22,
    });
  }
  await wallet("2026-10-06", "wallet_connect", "mainnet", "verified", 25);
  await wallet("2026-10-06", "wallet_connect", "mainnet", "suspect", 2);
  await wallet("2026-10-06", "wallet_connect", "testnet", "verified", 500); // other network: not in the funnel
  await wallet("2026-10-06", "sign_approved", "mainnet", "verified", 3); // under the floor
  // a verified mainnet contract with on-chain days in the baseline and the campaign
  const owner = (
    await h.su.query<{ u: string }>(
      `SELECT created_by::text AS u FROM scf.tenants WHERE tenant_id = $1`,
      [me.tenantId],
    )
  ).rows[0]?.u;
  const ev = (
    await h.su.query<{ id: string }>(
      `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, status, verified_at)
       VALUES ($1, 'stellar_account', $2, '{}'::jsonb, 'valid', now()) RETURNING evidence_id::text AS id`,
      [me.tenantId, stellarKey().account],
    )
  ).rows[0]?.id;
  const ref = (
    await h.su.query<{ r: string }>(
      `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, status, verified_role,
         verified_by_evidence, verified_at, created_by)
       VALUES ($1, $2, 'public', 'verified', 'deployer', $3, now(), $4) RETURNING contract_ref::text AS r`,
      [me.tenantId, contractId, ev, owner],
    )
  ).rows[0]?.r;
  for (const [day, inv, ok, invokers] of [
    ["2026-09-08", 40, 40, 12],
    ["2026-10-06", 120, 118, 30],
    ["2026-10-07", 8, 8, 4],
  ] as const) {
    await h.su.query(
      `INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations,
         distinct_invokers, data_source) VALUES ($1, $2, $3::date, $4, $5, $6, 'ledger_files')`,
      [me.tenantId, ref, day, inv, ok, invokers],
    );
  }
  await h.su.query(
    `UPDATE scf.tenants SET onchain_correlation_enabled = true WHERE tenant_id = $1`,
    [me.tenantId],
  );
  // Peers in the same round (period visitors 15, 30, 60, 2000, 5000) and one under the floor (3). Two of them also in
  // the category, which so has 3 projects: not enough to compare.
  for (const [i, v] of [15, 30, 60, 2000, 5000, 3].entries()) {
    const p = await seedProject(h, { level: 1 });
    peers.push(p);
    await link(p, i < 2 ? ["infrastructure_services"] : [], round);
    await seedWebDay(h, p, "2026-10-12", {
      pvVerified: v,
      pvRaw: v,
      visitorsVerified: v,
      visitorsRaw: v,
    });
  }
  // A level-0 project in the round never counts as a peer.
  const unverified = await seedProject(h, { level: 0 });
  await link(unverified, [], round);
  await seedWebDay(h, unverified, "2026-10-12", {
    pvVerified: 50,
    pvRaw: 50,
    visitorsVerified: 50,
    visitorsRaw: 50,
  });
});
afterAll(async () => {
  await h?.close();
});

const create = (body: Record<string, unknown>) =>
  call(h, {
    method: "POST",
    url: `/v1/tenants/${me.tenantId}/traction-snapshots`,
    cookie: me.cookie,
    body: { schema_version: 3, ...body },
  });

function checkSignature(r: { snapshot: unknown; signature: { sig: string } }): boolean {
  return verify(
    null,
    Buffer.from(canonicalize(r.snapshot), "utf8"),
    createPublicKey(SNAPSHOT_PUBLIC_PEM),
    Buffer.from(r.signature.sig, "base64url"),
  );
}

/** The public document must not carry any address, other project or small cell. */
function assertPrivate(doc: Record<string, unknown>, k: number) {
  const json = JSON.stringify(doc);
  expect(json).not.toMatch(G_ADDRESS);
  expect(json).not.toMatch(C_ADDRESS);
  expect(json).not.toContain(contractId);
  for (const p of peers) {
    expect(json).not.toContain(p.tenantId);
    expect(json).not.toContain(p.slug);
  }
  expect(json).not.toContain(me.tenantId); // the tenant id is internal; the slug is the public name
  expect(json).not.toMatch(/freighter/); // per-wallet values are not in the evidence document
  const funnel = doc.funnel as { daily: Array<Record<string, unknown>> };
  for (const d of funnel.daily)
    for (const [key, v] of Object.entries(d))
      if (key !== "day")
        expect(
          v === null || v === 0 || (typeof v === "number" && v >= k),
          `${d.day} ${key}=${v}`,
        ).toBe(true);
}

describe("traction snapshot v3 — SCF Evidence Link", () => {
  let customId = "";

  it("custom period: signed v3 with the funnel, the cohort position and the evidence link", async () => {
    const r = await create({
      period_start: "2026-10-05T00:00:00Z",
      period_end: "2026-11-02T00:00:00Z",
    });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(checkSignature(body)).toBe(true);
    const s = body.snapshot;
    customId = s.snapshot_id;
    expect(s).toMatchObject({
      schema: "scf-analytics/traction-snapshot/3",
      preset: "custom",
      confidence: { level: "high", reasons: [] },
      links: { evidence: `${h.config.portalOrigin}/evidence/${customId}` },
      wording: { seal: "not sealed" },
      programme: null,
    });
    expect(s.links.verify).toBe(`${h.config.portalOrigin}/verify?snapshot=${customId}`);
    expect(s.funnel.network).toBe("mainnet");
    expect(s.funnel.min_count).toBe(10);
    expect(s.funnel.stages).toEqual([
      { stage: "web_visitors", verified: 28 * 40, raw: 28 * 44 },
      { stage: "wallet_connects", verified: 25, raw: 27 },
      { stage: "signatures", verified: null, raw: null },
      { stage: "onchain_calls", verified: 128, raw: 128 },
    ]);
    const oct6 = s.funnel.daily.find((d: { day: string }) => d.day === "2026-10-06");
    expect(oct6).toMatchObject({
      wallet_connects_verified: 25,
      wallet_connects_raw: 27,
      signatures_verified: null,
      onchain_calls: 120,
      onchain_calls_successful: 118,
    });
    expect(s.funnel.daily).toHaveLength(28);
    expect(s.funnel.daily[0]).toMatchObject({ day: "2026-10-05", onchain_calls: null }); // no complete row
    // round: me (1120) + 5 peers ≥ 10 (15, 30, 60, 2000, 5000); 3 below → 60th percentile of 6
    const pos = s.comparison.positions as Array<Record<string, unknown>>;
    expect(pos).toContainEqual({
      cohort: { kind: "round", id: String(round) },
      metric: "web_visitors_verified",
      status: "shown",
      projects: 6,
      percentile: 60,
    });
    // nobody else in the round has on-chain calls: one project cannot be compared
    expect(pos).toContainEqual(
      expect.objectContaining({
        metric: "onchain_calls",
        cohort: { kind: "round", id: String(round) },
        status: "not_enough_projects",
      }),
    );
    expect(pos).toContainEqual(
      expect.objectContaining({
        cohort: { kind: "category", id: "infrastructure_services" },
        status: "not_enough_projects",
      }),
    );
    expect(s.text).toContain(`Evidence page: ${h.config.portalOrigin}/evidence/${customId}`);
    expect(s.text).toContain(`60th percentile of 6 SCF round ${round} projects measured here`);
    expect(s.text).toContain("not an endorsement");
    expect(s.text).toContain("fewer than 10 signatures");
    assertPrivate(s, 10);
    const stored = await h.su.query<{ v: number; m: string }>(
      `SELECT schema_version AS v, methodology_version AS m FROM scf.traction_snapshots WHERE snapshot_id = $1`,
      [customId],
    );
    expect(stored.rows[0]).toEqual({ v: 3, m: "scf-methodology/1.0.0" });
  });

  it("Growth Hack: campaign vs the same weeks before; refuses periods that are not whole ISO weeks", async () => {
    const bad = await create({
      period_start: "2026-10-06T00:00:00Z",
      period_end: "2026-11-03T00:00:00Z",
      preset: "growth_hack_during",
    });
    expect(bad.statusCode).toBe(400);
    const r = await create({
      period_start: "2026-10-05T00:00:00Z",
      period_end: "2026-11-02T00:00:00Z",
      preset: "growth_hack_during",
    });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json().snapshot.programme;
    expect(p).toMatchObject({
      kind: "growth_hack",
      campaign: { start: "2026-10-05T00:00:00Z", end: "2026-11-02T00:00:00Z", weeks: 4 },
      baseline: { start: "2026-09-07T00:00:00Z", end: "2026-10-05T00:00:00Z", weeks: 4 },
      averages: {
        baseline: {
          onchain_calls: 10,
          active_accounts_min: 3,
          active_accounts_max: 3,
          web_visitors_verified: 140,
        },
        campaign: {
          onchain_calls: 32,
          active_accounts_min: 7.5,
          active_accounts_max: 8.5,
          web_visitors_verified: 280,
        },
        change: { onchain_calls: 22, web_visitors_verified: 140 },
        ratio: { web_visitors_verified: 2 },
      },
      cohort_share: { status: "not_enough_projects", cohort: { kind: "round", id: String(round) } },
    });
    expect(p.weekly).toHaveLength(8);
    expect(p.ambiguities.length).toBeGreaterThanOrEqual(3);
    expect(r.json().snapshot.text).toContain("Growth Hack, campaign vs 4 weeks before");
    assertPrivate(r.json().snapshot, 10);
  });

  it("Public Goods quarter: figures with the previous quarter and the three months", async () => {
    const r = await create({
      period_start: "2026-07-01T00:00:00Z",
      period_end: "2026-10-01T00:00:00Z",
      preset: "pg_renewal_quarter",
    });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json().snapshot.programme;
    expect(p).toMatchObject({
      kind: "public_goods",
      quarter: "2026-Q3",
      previous_quarter: { label: "2026-Q2" },
    });
    const f = Object.fromEntries(p.figures.map((x: { metric: string }) => [x.metric, x]));
    expect(f.web_visitors_verified).toMatchObject({ value: 24 * 20, previous: 0, change: null });
    expect(f.onchain_calls).toMatchObject({ value: 40, previous: 0 });
    expect(p.monthly).toHaveLength(3);
    expect(p.not_measured).toEqual(["uptime", "downloads", "direct_dependents", "pony_factor"]);
    expect(r.json().snapshot.text).toContain("Public Goods quarter 2026-Q3");
    assertPrivate(r.json().snapshot, 10);
  });

  it("the list names schema v3 and the preset; the public copy is the signed document", async () => {
    const list = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${me.tenantId}/traction-snapshots`,
        cookie: me.cookie,
      })
    ).json();
    expect(list.find((x: { snapshot_id: string }) => x.snapshot_id === customId)).toMatchObject({
      schema_version: 3,
      preset: "custom",
      status: "signed",
    });
    const pub = await call(h, { method: "GET", url: `/public/v1/snapshots/${customId}` });
    expect(pub.statusCode).toBe(200);
    expect(checkSignature(pub.json())).toBe(true);
    expect(pub.json().snapshot.schema).toBe("scf-analytics/traction-snapshot/3");
    const listed = await call(h, {
      method: "GET",
      url: `/public/v1/projects/${me.slug}/snapshots`,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().snapshots.map((x: { schema_version: number }) => x.schema_version),
    ).toContain(3);
  });

  it("a v3 snapshot without a registry link says so (no position)", async () => {
    const lone = await seedProject(h, { level: 1 });
    await seedWebDay(h, lone, "2026-10-12", { pvVerified: 500, pvRaw: 500, visitorsVerified: 100 });
    const r = await call(h, {
      method: "POST",
      url: `/v1/tenants/${lone.tenantId}/traction-snapshots`,
      cookie: lone.cookie,
      body: {
        schema_version: 3,
        period_start: "2026-10-12T00:00:00Z",
        period_end: "2026-10-13T00:00:00Z",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().snapshot.comparison).toMatchObject({
      status: "no_registry_link",
      positions: [],
    });
    expect(r.json().snapshot.text).toContain("no confirmed SCF registry link");
  });
});
