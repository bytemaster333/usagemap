// SPDX-License-Identifier: Apache-2.0
// Acceptance (ADR-0008 L7, ADR-0028, C-44, CR-35; operator.web-global-view and operator.web-compare trust parts, trust.verified-vs-raw, operator.api-fair-comparison): job trust_scoring writes
// web_trust_scores for 1- and 28-day windows from the stored aggregates only (web_daily_totals, web_edge_counters,
// web_daily_breakdowns), reproduces the documented example E2 on real rows, writes NULL + insufficient_data below
// op_min_count, is idempotent, and writes only under each tenant's context.

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb } from "../../src/db.ts";
import { ONCHAIN_BADGE_SQL, runTrustScoring } from "../../src/jobs/trust-scoring.ts";
import { addDays, utcDay } from "../../src/schedule.ts";
import { capture, jobsDb, type SeededSite, seedSite, superClient } from "../support/harness.ts";

let su: pg.Pool;
let db: ScfDb;
let A: SeededSite;
let B: SeededSite;
let H: SeededSite;
const D = addDays(utcDay(new Date()), -1);

async function totals(s: SeededSite, day: string, raw: number, ver: number) {
  await su.query(
    `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
       pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
       total_duration_s, events_raw, is_final, engine_version)
     VALUES ($1, $2, $3::date, $4, $5, 0, 0, 0, 0, 0, 0, 0, $5, true, 'umami/3.5.0')`,
    [s.tenantId, s.siteId, day, ver, raw],
  );
}

async function counters(s: SeededSite, day: string, c: Record<string, Record<string, number>>) {
  for (const [counter, labels] of Object.entries(c)) {
    for (const [label, n] of Object.entries(labels)) {
      await su.query(
        `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count) VALUES ($1, $2, $3::date, $4, $5, $6)`,
        [s.tenantId, s.siteId, day, counter, label, n],
      );
    }
  }
}

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  A = await seedSite(su);
  B = await seedSite(su);
  await totals(A, D, 1000, 400);
  await counters(A, D, {
    verdict: { verified: 400, suspect: 500, rejected: 100 },
    asn_class: { eyeball_fixed: 700, datacenter: 300 },
    multiplicity: { one: 825, high: 175 },
    client_signal: { webdriver: 450 },
    pow_latency: { lt100ms: 275, "100_300ms": 725 },
  });
  await totals(B, D, 9, 9);
  // Burstiness (migration 0057): 60 of the day's 100 page views in one UTC hour; another day's hour is ignored.
  H = await seedSite(su);
  await totals(H, D, 100, 100);
  const hour = async (iso: string, n: number) =>
    su.query(
      `INSERT INTO scf.web_hourly_totals (tenant_id, site_id, hour_start, pageviews_verified, pageviews_raw,
         pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, events_raw)
       VALUES ($1, $2, $3::timestamptz, $4, $4, 0, 0, 0, 0, $4)`,
      [H.tenantId, H.siteId, iso, n],
    );
  await hour(`${D}T10:00:00Z`, 60);
  for (const h of ["00", "01", "02", "03"]) await hour(`${D}T${h}:00:00Z`, 10);
  await hour(`${addDays(D, 1)}T00:00:00Z`, 5000);
  await hour(`${addDays(D, -1)}T23:00:00Z`, 5000);
});

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
});

describe("trust_scoring", () => {
  it("scores sites from aggregates (example E2), writes NULL below the minimum count, idempotent", async () => {
    const cap = capture();
    const r = await runTrustScoring(db, D, cap.ctx());
    expect(r.ecoPercentiles).toBe(false); // fewer than 20 active tenants
    const rows = await su.query(
      `SELECT site_id, window_days, score, reason_codes, decision_rate::float8 AS dr, algorithm_version, components
         FROM scf.web_trust_scores WHERE site_id = ANY ($1::uuid[]) AND day = $2::date ORDER BY site_id, window_days`,
      [[A.siteId, B.siteId], D],
    );
    const a1 = rows.rows.find((x) => x.site_id === A.siteId && x.window_days === 1);
    expect(a1).toMatchObject({ score: 50, dr: 0.6, algorithm_version: "trust/1.0.0" });
    expect(a1?.reason_codes).toEqual([
      "proof_coverage_low",
      "network_datacenter_share_high",
      "multiplicity_share_high",
      "engagement_low",
      "pow_latency_implausible",
    ]);
    expect(rows.rows.find((x) => x.site_id === A.siteId && x.window_days === 28)).toMatchObject({
      score: 50,
    });
    const b1 = rows.rows.find((x) => x.site_id === B.siteId && x.window_days === 1);
    expect(b1).toMatchObject({ score: null, reason_codes: ["insufficient_data"], components: {} });

    const before = await su.query("SELECT count(*) AS n FROM scf.web_trust_scores");
    await runTrustScoring(db, D, cap.ctx());
    const after = await su.query("SELECT count(*) AS n FROM scf.web_trust_scores");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("scores burstiness from web_hourly_totals of the day only (example E6 on real rows)", async () => {
    await runTrustScoring(db, D, capture().ctx());
    const r = await su.query(
      `SELECT score, reason_codes, components FROM scf.web_trust_scores
        WHERE site_id = $1 AND day = $2::date AND window_days = 1`,
      [H.siteId, D],
    );
    expect(r.rows[0]).toMatchObject({ score: 93, reason_codes: ["burstiness_high"] });
    expect(r.rows[0]?.components.temporal).toMatchObject({ value: 0.6, p: 0.7 });
  });

  it("A3 counts only verified contracts of this network without a conflict (C-137)", async () => {
    const T = await seedSite(su);
    const c = (n: number) => `C${"A".repeat(54)}${"ABCDEFGH"[n]}`;
    const ev = await su.query<{ evidence_id: string }>(
      `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, status)
       VALUES ($1, 'stellar_account', $2, 'valid') RETURNING evidence_id`,
      [T.tenantId, `G${"T".repeat(55)}`],
    );
    const insert = async (id: string, network: string, conflict: boolean) => {
      const r = await su.query<{ contract_ref: string }>(
        `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by, status, verified_role,
                                            verified_by_evidence, verified_at, verification_method, conflict_since)
         VALUES ($1, $2, $3, $4, 'verified', 'deployer', $6, now(), 'deployer_admin_match',
                 CASE WHEN $5 THEN now() END)
         RETURNING contract_ref`,
        [T.tenantId, id, network, T.userId, conflict, ev.rows[0]?.evidence_id],
      );
      const ref = r.rows[0]?.contract_ref as string;
      await su.query(
        `INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations,
                                        distinct_invokers, data_source)
         VALUES ($1, $2, $3::date, 10, 7, 3, 'ledger_files')`,
        [T.tenantId, ref, D],
      );
    };
    await insert(c(0), "public", false); // counts
    await insert(c(1), "public", true); // conflicted: counted nowhere
    await insert(c(2), "testnet", false); // another network
    const rows = await db.tx("trust_scoring", null, (tx) =>
      tx.query<{ tenant_id: string; verified: number; rows: number; ok: number }>(
        `SELECT * FROM (${ONCHAIN_BADGE_SQL}) q WHERE q.tenant_id = $3`,
        [D, "public", T.tenantId],
      ),
    );
    expect(rows).toEqual([
      expect.objectContaining({ tenant_id: T.tenantId, verified: 1, rows: 1, ok: 7 }),
    ]);
    const testnet = await db.tx("trust_scoring", null, (tx) =>
      tx.query<{ verified: number }>(
        `SELECT * FROM (${ONCHAIN_BADGE_SQL}) q WHERE q.tenant_id = $3`,
        [D, "testnet", T.tenantId],
      ),
    );
    expect(testnet.map((r) => r.verified)).toEqual([1]);
  });

  it("cannot write a score for another tenant (F1 backstop)", async () => {
    await expect(
      db.tx("trust_scoring", A.tenantId, (tx) =>
        tx.exec(
          `INSERT INTO scf.web_trust_scores (tenant_id, site_id, day, window_days, components, algorithm_version)
           VALUES ($1, $2, $3::date, 1, '{}', 'x')`,
          [B.tenantId, B.siteId, D],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
