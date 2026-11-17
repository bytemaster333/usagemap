// SPDX-License-Identifier: Apache-2.0
// Acceptance: retention deletes exactly what the policy says (data-model §14, §16.2) — in `scf` through
// scf.retention_apply() one tenant at a time under that tenant's context (F1, C-103), erasure selectors redacted after
// finished_at + 56 days (C-88, C-112), and in `umami` per site on main and twin websites after the site's effective
// retention (default 90 days, C-54), in batches, as scf_umami_maint; one audit row with counts per pruned tenant.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  STELLAR_ACCOUNT_QUERIES,
  type StellarAccountSets,
  scan,
  stellarAccountAllowList,
} from "../../../../tests/lib/privacy-scan.ts";
import type { ScfDb, UmamiDb } from "../../src/db.ts";
import {
  applyScfRules,
  PRUNE_ORDER,
  pruneUmami,
  purgeUnprovenFootprint,
  redactErasureSelectors,
  SCF_BATCH,
  UMAMI_BATCH,
  UMAMI_TABLES,
} from "../../src/jobs/retention.ts";
import {
  capture,
  jobsDb,
  type SeededSite,
  seedSite,
  superClient,
  umamiMaint,
} from "../support/harness.ts";

let su: pg.Pool;
let um: pg.Pool;
let db: ScfDb;
let maint: UmamiDb;
let A: SeededSite;
let B: SeededSite;

beforeAll(async () => {
  su = superClient("scf");
  um = superClient("umami");
  db = jobsDb();
  maint = umamiMaint();
  A = await seedSite(su, { twin: true });
  B = await seedSite(su, { retentionDays: 30 });
});

afterAll(async () => {
  await su?.end();
  await um?.end();
  await db?.pool.end();
  await maint?.pool.end();
});

const count = async (pool: pg.Pool, sql: string, params: unknown[] = []) =>
  Number((await pool.query<{ n: string }>(sql, params)).rows[0]?.n);

describe("retention in scf", () => {
  it("deletes exactly the expired rows of every tenant, in batches, and keeps the rest", async () => {
    // api_ingest_ledger (7 days): A has SCF_BATCH + 5 expired rows (several batches), B one; both keep a fresh one
    await su.query(
      `INSERT INTO scf.api_ingest_ledger (tenant_id, batch_key, points, received_at)
       SELECT $1, sha256(convert_to('a-old-' || g, 'UTF8')), 1, now() - interval '7 days 1 minute'
         FROM generate_series(1, $2::int) g`,
      [A.tenantId, SCF_BATCH + 5],
    );
    await su.query(
      `INSERT INTO scf.api_ingest_ledger (tenant_id, batch_key, points, received_at) VALUES
         ($1, sha256('b-old'::bytea), 1, now() - interval '8 days'),
         ($1, sha256('b-new'::bytea), 1, now() - interval '6 days 23 hours'),
         ($2, sha256('a-new'::bytea), 1, now() - interval '1 hour')`,
      [B.tenantId, A.tenantId],
    );
    // web_edge_counters (25 months after the end of the day)
    await su.query(
      `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count) VALUES
         ($1, $2, (now() AT TIME ZONE 'UTC')::date - interval '26 months', 'verdict', 'verified', 1),
         ($1, $2, (now() AT TIME ZONE 'UTC')::date - interval '24 months', 'verdict', 'verified', 1),
         ($3, $4, (now() AT TIME ZONE 'UTC')::date - interval '30 months', 'verdict', 'suspect', 1)`,
      [A.tenantId, A.siteId, B.tenantId, B.siteId],
    );
    // a global table: auth_challenges (1 day after expiry)
    await su.query(
      `INSERT INTO scf.auth_challenges (kind, secret_hash, created_at, expires_at) VALUES
         ('github_oauth', sha256('wsg-old'::bytea), now() - interval '2 days', now() - interval '2 days' + interval '10 minutes'),
         ('github_oauth', sha256('wsg-new'::bytea), now() - interval '1 hour', now() - interval '50 minutes')`,
    );

    const cap = capture();
    const out = await applyScfRules(db, "retention", cap.ctx());
    expect(out.api_ingest_ledger).toBeGreaterThanOrEqual(SCF_BATCH + 6);
    expect(
      await count(
        su,
        "SELECT count(*) n FROM scf.api_ingest_ledger WHERE received_at < now() - interval '7 days'",
      ),
    ).toBe(0);
    expect(
      await count(su, "SELECT count(*) n FROM scf.api_ingest_ledger WHERE tenant_id = ANY($1)", [
        [A.tenantId, B.tenantId],
      ]),
    ).toBe(2);
    expect(
      await count(su, "SELECT count(*) n FROM scf.web_edge_counters WHERE site_id = ANY($1)", [
        [A.siteId, B.siteId],
      ]),
    ).toBe(1);
    expect(
      await count(
        su,
        "SELECT count(*) n FROM scf.auth_challenges WHERE secret_hash IN (sha256('wsg-old'::bytea), sha256('wsg-new'::bytea))",
      ),
    ).toBe(1);
    // the job's own lines say what happened, without data
    expect(cap.lines.some((l) => l.includes('"event":"retention_scf_done"'))).toBe(true);
  });

  it("deletes dev events after 24 hours and unproven footprint items after 30 days (C-136, C-137)", async () => {
    // web_dev_events: 24 hours after receipt.
    await su.query(
      `INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict)
       VALUES ($1, $2, now() - interval '24 hours 1 minute', 'pageview', 'pageview', '/old', 'verified'),
              ($1, $2, now() - interval '23 hours 59 minutes', 'pageview', 'pageview', '/new', 'verified'),
              ($3, $4, now() - interval '3 days', 'stellar', 'wallet_connect', '/b', 'suspect')`,
      [A.tenantId, A.siteId, B.tenantId, B.siteId],
    );
    // footprint_items (30 days, scf.retention_rules()): rejected (since the last check), removed (since removal), claimed
    // and never verified (since the claim); a verified item is kept however old it is. WASM hashes follow the 30-day
    // rule only; ACCOUNT items that are rejected or removed go at once (purgeUnprovenFootprint, next test).
    const w = (n: number) => `${"ab".repeat(31)}0${n}`;
    const g = (n: number) => `G${"A".repeat(54)}${"ABCDEFGHIJ"[n]}`;
    await su.query(
      `INSERT INTO scf.footprint_items (tenant_id, kind, subject, network, status, rejected_reason, last_checked_at,
                                        created_by, created_at, removed_at, verification_method, verified_at)
       VALUES ($1, 'wasm_hash', $3, 'mainnet', 'rejected', 'not_deployer_or_admin', now() - interval '31 days',
               $2, now() - interval '40 days', NULL, NULL, NULL),
              ($1, 'wasm_hash', $4, 'mainnet', 'rejected', 'not_deployer_or_admin', now() - interval '29 days',
               $2, now() - interval '40 days', NULL, NULL, NULL),
              ($1, 'app_account', $5, 'testnet', 'claimed', NULL, NULL, $2, now() - interval '31 days', NULL, NULL, NULL),
              ($1, 'app_account', $6, 'testnet', 'claimed', NULL, NULL, $2, now() - interval '29 days', NULL, NULL, NULL),
              ($1, 'wasm_hash', $7, 'mainnet', 'claimed', NULL, NULL, $2, now() - interval '20 days',
               now() - interval '31 days', NULL, NULL),
              ($1, 'issuing_account', $8, 'mainnet', 'verified', NULL, NULL, $2, now() - interval '400 days', NULL,
               'sep1_accounts', now() - interval '400 days')`,
      [A.tenantId, A.userId, w(0), w(1), g(2), g(3), w(4), g(5)],
    );
    const cap = capture();
    const out = await applyScfRules(db, "retention", cap.ctx());
    expect(out.web_dev_events).toBe(2);
    expect(out.footprint_items).toBe(3);
    const dev = await su.query<{ path_class: string }>(
      "SELECT path_class FROM scf.web_dev_events WHERE site_id = ANY($1)",
      [[A.siteId, B.siteId]],
    );
    expect(dev.rows.map((r) => r.path_class)).toEqual(["/new"]);
    const kept = await su.query<{ subject: string }>(
      "SELECT subject FROM scf.footprint_items WHERE tenant_id = $1 ORDER BY subject",
      [A.tenantId],
    );
    expect(kept.rows.map((r) => r.subject).sort()).toEqual([g(3), g(5), w(1)].sort());
    await su.query("DELETE FROM scf.footprint_items WHERE tenant_id = $1", [A.tenantId]);
  });

  it("a rejected or removed footprint account is deleted at the next run, and the privacy scanner agrees", async () => {
    const T = await seedSite(su);
    const g = (n: number) => `G${"B".repeat(54)}${"ABCDEFGHIJ"[n]}`;
    // fresh rows: rejected 1 minute ago, removed 1 minute ago (verified before), an open claim, a verified account, a
    // claim older than 30 days, and a rejected WASM hash (not an account: the 30-day rule applies)
    await su.query(
      `INSERT INTO scf.footprint_items (tenant_id, kind, subject, network, status, rejected_reason, last_checked_at,
                                        created_by, created_at, removed_at, verification_method, verified_at)
       VALUES ($1, 'issuing_account', $3, 'mainnet', 'rejected', 'not_listed_in_toml', now() - interval '1 minute',
               $2, now() - interval '2 days', NULL, NULL, NULL),
              ($1, 'app_account', $4, 'mainnet', 'verified', NULL, NULL, $2, now() - interval '9 days',
               now() - interval '1 minute', 'signed_challenge', now() - interval '8 days'),
              ($1, 'app_account', $5, 'testnet', 'claimed', NULL, NULL, $2, now() - interval '1 day', NULL, NULL, NULL),
              ($1, 'issuing_account', $6, 'mainnet', 'verified', NULL, NULL, $2, now() - interval '3 days', NULL,
               'sep1_accounts', now() - interval '3 days'),
              ($1, 'app_account', $7, 'testnet', 'claimed', NULL, NULL, $2, now() - interval '31 days', NULL, NULL, NULL),
              ($1, 'wasm_hash', $8, 'mainnet', 'rejected', 'not_deployer_or_admin', now() - interval '1 minute',
               $2, now() - interval '2 days', NULL, NULL, NULL)`,
      [T.tenantId, T.userId, g(0), g(1), g(2), g(3), g(4), "cd".repeat(32)],
    );
    // Before the job runs, the scanner finds the unproven accounts (rejected, removed, the expired claim).
    const scanNow = async () => {
      const sets = {} as StellarAccountSets;
      for (const k of Object.keys(STELLAR_ACCOUNT_QUERIES) as (keyof StellarAccountSets)[])
        sets[k] = (
          await su.query<{ s: string }>(`SELECT x AS s FROM (${STELLAR_ACCOUNT_QUERIES[k]}) q(x)`)
        ).rows.map((r) => r.s);
      const stored = await su.query<{ subject: string }>(
        "SELECT subject FROM scf.footprint_items WHERE tenant_id = $1 ORDER BY subject",
        [T.tenantId],
      );
      return scan(
        [{ source: "pg_dump:scf", text: stored.rows.map((r) => r.subject).join("\n") }],
        [],
        stellarAccountAllowList(sets),
      ).findings.map((f) => f.masked);
    };
    expect((await scanNow()).length).toBe(3);

    const cap = capture();
    await purgeUnprovenFootprint(db, cap.ctx());
    await applyScfRules(db, "retention", cap.ctx());
    const kept = await su.query<{ subject: string }>(
      "SELECT subject FROM scf.footprint_items WHERE tenant_id = $1 ORDER BY subject",
      [T.tenantId],
    );
    expect(kept.rows.map((r) => r.subject).sort()).toEqual(["cd".repeat(32), g(2), g(3)].sort());
    // After it, the scanner finds nothing: what the job keeps is exactly what the scanner allows.
    expect(await scanNow()).toEqual([]);
    expect(cap.lines.some((l) => l.includes('"event":"footprint_unproven_deleted"'))).toBe(true);
  });

  it("stream_gc applies only its own rules", async () => {
    const cap = capture();
    const out = await applyScfRules(db, "stream_gc", cap.ctx());
    // 0080 adds the client-metric stream state (stellar-otel) to stream_gc, idle 7 days like api_stream_state;
    // 0085 the integration stream's state (partner, payments, anchors), the same 7 days.
    expect(Object.keys(out).sort()).toEqual([
      "api_route_day",
      "api_stream_state",
      "integration_stream_state",
      "stellar_client_stream_state",
    ]);
  });

  it("redacts erasure selectors 56 days after the request finished, with an audit row and no literal", async () => {
    const oldId = randomUUID();
    const newId = randomUUID();
    await su.query(
      `INSERT INTO scf.erasure_requests (tenant_id, request_id, site_id, criteria, requested_by, status, finished_at)
       VALUES ($1, $2, $3, '{"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","path_pattern":"/secret/*"}',
               $4, 'completed', now() - interval '57 days'),
              ($1, $5, $3, '{"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","event_name":"signup"}',
               $4, 'completed', now() - interval '55 days')`,
      [A.tenantId, oldId, A.siteId, A.userId, newId],
    );
    const cap = capture();
    expect(await redactErasureSelectors(db, cap.ctx())).toBe(1);
    const { rows } = await su.query(
      `SELECT request_id, criteria, selector_redacted_at IS NOT NULL AS redacted FROM scf.erasure_requests
        WHERE tenant_id = $1 ORDER BY finished_at`,
      [A.tenantId],
    );
    expect(rows).toEqual([
      {
        request_id: oldId,
        redacted: true,
        criteria: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-02-01T00:00:00Z",
          selector: { type: "path_pattern", length: 9 },
        },
      },
      {
        request_id: newId,
        redacted: false,
        criteria: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-02-01T00:00:00Z",
          event_name: "signup",
        },
      },
    ]);
    const audit = await su.query(
      `SELECT actor_kind, actor_id, details::text FROM scf.audit_log
        WHERE tenant_id = $1 AND action = 'erasure.selector_redacted'`,
      [A.tenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_kind: "job", actor_id: "retention" });
    expect(audit.rows[0].details).not.toContain("/secret/");
  });
});

describe("retention in umami (event-level data, C-54)", () => {
  const DAY = 86_400_000;
  const orphanWebsite = randomUUID();
  let now: Date;

  async function event(
    website: string,
    session: string,
    at: Date,
    withData = false,
  ): Promise<string> {
    const id = randomUUID();
    await um.query(
      `INSERT INTO public.website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, tag)
       VALUES ($1, $2, $3, $4, $5, '/', 1, 'v')`,
      [id, website, session, randomUUID(), at],
    );
    if (withData) {
      await um.query(
        `INSERT INTO public.event_data (event_data_id, website_id, website_event_id, data_key, string_value, data_type, created_at)
         VALUES ($1, $2, $3, 'k', 'x', 1, $4)`,
        [randomUUID(), website, id, at],
      );
    }
    return id;
  }

  async function session(website: string, at: Date): Promise<string> {
    const id = randomUUID();
    await um.query(
      `INSERT INTO public.session (session_id, website_id, browser, os, device, country, created_at)
       VALUES ($1, $2, 'chrome', 'Linux', 'desktop', 'DE', $3)`,
      [id, website, at],
    );
    await um.query(
      `INSERT INTO public.session_data (session_data_id, website_id, session_id, data_key, string_value, data_type, created_at)
       VALUES ($1, $2, $3, 'k', 'x', 1, $4)`,
      [randomUUID(), website, id, at],
    );
    await um.query(
      `INSERT INTO public.session_link (website_id, session_id, distinct_id, created_at) VALUES ($1, $2, $3, $4)`,
      [website, id, `d-${id.slice(0, 8)}`, at],
    );
    return id;
  }

  const ago = (days: number, sec = 0) => new Date(now.getTime() - days * DAY + sec * 1000);

  it("prunes each website after the site's effective retention, exactly at the cutoff, on main and twin", async () => {
    now = new Date();
    const twin = A.twinId as string;
    // A (90 days, platform default): an old session with only old events (goes entirely), an old session that still
    // has a recent event (stays), a recent session; the twin likewise; UMAMI_BATCH + 7 old events (several batches)
    const sOld = await session(A.umamiId, ago(95));
    await event(A.umamiId, sOld, ago(90, -1), true); // 1 s older than the cutoff → deleted
    const sMixed = await session(A.umamiId, ago(92));
    await event(A.umamiId, sMixed, ago(92), true);
    await event(A.umamiId, sMixed, ago(90, 60), true); // 60 s inside the window → kept
    const sNew = await session(A.umamiId, ago(1));
    await event(A.umamiId, sNew, ago(1));
    await um.query(
      `INSERT INTO public.website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type)
       SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), $3, '/bulk', 1 FROM generate_series(1, $4::int)`,
      [A.umamiId, sOld, ago(120), UMAMI_BATCH + 7],
    );
    const tOld = await session(twin, ago(100));
    await event(twin, tOld, ago(100));
    const tNew = await session(twin, ago(10));
    await event(twin, tNew, ago(10));
    // B (site retention 30 days): 31-day-old data goes, 29-day-old stays
    const bOld = await session(B.umamiId, ago(31));
    await event(B.umamiId, bOld, ago(31), true);
    const bNew = await session(B.umamiId, ago(29));
    await event(B.umamiId, bNew, ago(29), true);
    // a website that belongs to no site is never touched
    const oSess = await session(orphanWebsite, ago(300));
    await event(orphanWebsite, oSess, ago(300));

    const cap = capture();
    const res = await pruneUmami(db, maint, cap.ctx({ now }));

    const ev = (w: string) =>
      count(um, "SELECT count(*) n FROM public.website_event WHERE website_id = $1", [w]);
    const ses = (w: string) =>
      count(um, "SELECT count(*) n FROM public.session WHERE website_id = $1", [w]);
    const ed = (w: string) =>
      count(um, "SELECT count(*) n FROM public.event_data WHERE website_id = $1", [w]);
    const sd = (w: string) =>
      count(um, "SELECT count(*) n FROM public.session_data WHERE website_id = $1", [w]);
    const sl = (w: string) =>
      count(um, "SELECT count(*) n FROM public.session_link WHERE website_id = $1", [w]);
    // A main: kept = sMixed's recent event + sNew's event; sessions sMixed (has an event left) + sNew
    expect(await ev(A.umamiId)).toBe(2);
    expect(await ed(A.umamiId)).toBe(1);
    expect(
      (
        await um.query(
          "SELECT session_id FROM public.session WHERE website_id = $1 ORDER BY created_at",
          [A.umamiId],
        )
      ).rows.map((r) => r.session_id),
    ).toEqual([sMixed, sNew]);
    // session_data/session_link: defensive delete by cutoff (only the recent session's rows remain)
    expect(await sd(A.umamiId)).toBe(1);
    expect(await sl(A.umamiId)).toBe(1);
    // twin: same rules
    expect(await ev(twin)).toBe(1);
    expect(await ses(twin)).toBe(1);
    // B: 30 days
    expect(await ev(B.umamiId)).toBe(1);
    expect(await ed(B.umamiId)).toBe(1);
    expect(await ses(B.umamiId)).toBe(1);
    // untouched
    expect(await ev(orphanWebsite)).toBe(1);
    expect(await ses(orphanWebsite)).toBe(1);

    const a = res.get(A.tenantId);
    expect(a).toMatchObject({
      website_event: UMAMI_BATCH + 7 + 2 + 1,
      event_data: 2,
      session: 2,
      session_data: 3,
      session_link: 3,
      sites: 1,
    });
    expect(res.get(B.tenantId)).toMatchObject({
      website_event: 1,
      event_data: 1,
      session: 1,
      sites: 1,
    });
    // one audit row per pruned tenant, counts only
    const audit = await su.query(
      `SELECT tenant_id, actor_id, details FROM scf.audit_log WHERE action = 'retention.umami_pruned'
        AND tenant_id = ANY ($1) ORDER BY tenant_id`,
      [[A.tenantId, B.tenantId]],
    );
    expect(audit.rows).toHaveLength(2);
    for (const r of audit.rows) {
      expect(r.actor_id).toBe("retention");
      expect(Object.keys(r.details).sort()).toEqual(
        [
          "event_data",
          "revenue",
          "session",
          "session_data",
          "session_link",
          "sites",
          "website_event",
        ].sort(),
      );
    }

    // second run: nothing left to delete, no new audit row
    const again = await pruneUmami(db, maint, cap.ctx({ now }));
    expect(again.size).toBe(0);
  });

  it("prunes Umami's revenue rows with the events, on main and twin", async () => {
    const R = await seedSite(su, { twin: true });
    now = new Date();
    const twin = R.twinId as string;
    const revenue = async (website: string, sess: string, at: Date) => {
      const ev = await event(website, sess, at);
      await um.query(
        `INSERT INTO public.revenue (revenue_id, website_id, session_id, event_id, event_name, currency, revenue, created_at)
         VALUES ($1, $2, $3, $4, 'signup', 'USD', 9, $5)`,
        [randomUUID(), website, sess, ev, at],
      );
    };
    const sOld = await session(R.umamiId, ago(91));
    await revenue(R.umamiId, sOld, ago(91));
    const sNew = await session(R.umamiId, ago(2));
    await revenue(R.umamiId, sNew, ago(2));
    const tOld = await session(twin, ago(100));
    await revenue(twin, tOld, ago(100));
    const rev = (w: string) =>
      count(um, "SELECT count(*) n FROM public.revenue WHERE website_id = $1", [w]);
    expect(await rev(R.umamiId)).toBe(2);
    const cap = capture();
    const res = await pruneUmami(db, maint, cap.ctx({ now }));
    expect(await rev(R.umamiId)).toBe(1);
    expect(await rev(twin)).toBe(0);
    expect(res.get(R.tenantId)).toMatchObject({ revenue: 2, website_event: 2, session: 2 });
  });

  it("every Umami table with website_id and created_at is pruned, configuration or unreachable (contract)", async () => {
    const { rows } = await um.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name IN ('website_id', 'created_at')
        GROUP BY c.table_name HAVING count(*) = 2 ORDER BY 1`,
    );
    const known = new Set<string>([
      ...UMAMI_TABLES.pruned,
      ...UMAMI_TABLES.configuration,
      ...UMAMI_TABLES.unreachable,
    ]);
    const tables = rows.map((r) => r.table_name);
    expect(tables.filter((t) => !known.has(t))).toEqual([]);
    for (const t of PRUNE_ORDER) expect(tables).toContain(t);
    // the tables the proxy never lets the engine write stay empty after this whole suite (sends included)
    for (const t of UMAMI_TABLES.unreachable) {
      if (!tables.includes(t)) continue;
      expect(await count(um, `SELECT count(*) n FROM public.${t}`), t).toBe(0);
    }
  });

  it("follows a change of the platform setting (shorter retention applies at the next run)", async () => {
    const C = await seedSite(su);
    now = new Date();
    const s = await session(C.umamiId, ago(50));
    await event(C.umamiId, s, ago(50));
    const cap = capture();
    await pruneUmami(db, maint, cap.ctx({ now }));
    expect(
      await count(um, "SELECT count(*) n FROM public.website_event WHERE website_id = $1", [
        C.umamiId,
      ]),
    ).toBe(1);
    await su.query(`UPDATE scf.settings SET value = '45' WHERE key = 'web_event_retention_days'`);
    try {
      await pruneUmami(db, maint, cap.ctx({ now }));
      expect(
        await count(um, "SELECT count(*) n FROM public.website_event WHERE website_id = $1", [
          C.umamiId,
        ]),
      ).toBe(0);
    } finally {
      await su.query(`UPDATE scf.settings SET value = '90' WHERE key = 'web_event_retention_days'`);
    }
  });

  it("scf_umami_maint can delete but not read event contents or write", async () => {
    await expect(
      maint.query("SELECT url_query FROM public.website_event LIMIT 1"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      maint.exec(`UPDATE public.website_event SET url_path = '/x' WHERE false`),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
