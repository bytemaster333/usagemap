// SPDX-License-Identifier: Apache-2.0
// Stellar site features and the Registered Footprint (C-135, C-136, C-137) against the real database: dev/preview origins and debug
// mode (wire-formats §a.8), the counter record's `props` and `dev` parts (§d.3, §l), the first-event panel, the wallet
// funnel (§a.3.1), the Registered Footprint (data-model §12.1) with its operator view and conflict resolution, the SCF
// cohorts (§i.4) on both operator surfaces, traction snapshot v2 with its public series list (§i.3.2–§i.3.4) and the
// public seal reads (§m.2). Every call() validates the response against the OpenAPI document and checks the audit row.

import { createPublicKey, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sep53Digest } from "../../src/auth/stellar.ts";
import { canonicalize } from "../../src/programme/jcs.ts";
import { TESTNET_NOTICE } from "../../src/programme/seal-network.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  operatorSession,
  SNAPSHOT_PUBLIC_PEM,
  signInGithub,
  startHarness,
  stellarKey,
  uniqueSlug,
} from "../support/harness.ts";
import {
  callMetrics,
  createOperatorKey,
  type SeededProject,
  seedProject,
  seedWebDay,
} from "../support/op-seed.ts";

const addFormats = addFormatsModule as unknown as (a: Ajv2020) => Ajv2020;
const wire = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "..", "docs", "contracts", "wire-formats.md"),
  "utf8",
);
function contractSchema(name: string): Record<string, unknown> {
  for (const block of wire.matchAll(/```json\n([\s\S]*?)```/g)) {
    const text = block[1] as string;
    if (text.includes(`"$id"`) && text.includes(name))
      return JSON.parse(text.replace(/<domain-a>/g, "domain-a.invalid"));
  }
  throw new Error(`schema ${name} not found in wire-formats.md`);
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateV2 = ajv.compile(contractSchema("traction-snapshot-2.json"));

const NODE = "edge-d1";
const today = () => new Date().toISOString().slice(0, 10);
const contractId = () =>
  `C${Array.from({ length: 55 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)]).join("")}`;

let h: Harness;
let owner = "";
let tenant = "";
let site = "";
let otherOwner = "";
let otherTenant = "";
let otherSite = "";

async function newSite(cookie: string, t: string, body: Record<string, unknown> = {}) {
  const r = await call(h, {
    method: "POST",
    url: `/v1/tenants/${t}/sites`,
    cookie,
    body: { name: "S", ...body },
  });
  return r;
}

function counterRecord(extra: Record<string, unknown>) {
  const day = today();
  return {
    rv: 1,
    type: "counter",
    record_id: randomUUID(),
    node_id: NODE,
    period_start_ms: Date.now() - 60_000,
    period_end_ms: Date.now(),
    web: [],
    otlp: [],
    tokens: [],
    spool: {
      boot_id: randomUUID(),
      day,
      fsynced: 0,
      acked_stored: 0,
      acked_engine_bot: 0,
      acked_engine_rejected: 0,
      expired_72h: 0,
      queued: 0,
    },
    ...extra,
  };
}

/** What job contract_verification writes for a verified contract (a stellar_account evidence of the tenant). */
async function markVerified(tenantId: string, refs: string[], conflict = false): Promise<void> {
  const ev = (
    await h.su.query<{ id: string }>(
      `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, status, verified_at)
       VALUES ($1, 'stellar_account', $2, '{}'::jsonb, 'valid', now()) RETURNING evidence_id::text AS id`,
      [tenantId, stellarKey().account],
    )
  ).rows[0]?.id;
  await h.su.query(
    `UPDATE scf.declared_contracts SET status = 'verified', verified_role = 'deployer', verified_by_evidence = $2,
            verified_at = now(), conflict_since = CASE WHEN $4 THEN now() END
      WHERE tenant_id = $1 AND contract_ref = ANY($3::uuid[])`,
    [tenantId, ev, refs, conflict],
  );
}

async function postCounters(body: unknown) {
  const res = await h.internal.inject({
    method: "POST",
    url: "/internal/v1/edge/counters",
    headers: { "x-scf-edge-node": NODE, "content-type": "application/json" },
    payload: body as object,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  site = (await newSite(owner, tenant)).json().site_id;
  otherOwner = await signInGithub(h, newGithubUser());
  otherTenant = await createTenant(h, otherOwner);
  otherSite = (await newSite(otherOwner, otherTenant)).json().site_id;
});
afterAll(async () => {
  await h?.close();
});

// ------------------------------------------------------------------------------------------------ dev origins

describe("dev/preview origins and debug mode (§a.8)", () => {
  it("accepts the grammar on create and update and shows the list on the site", async () => {
    const r = await newSite(owner, tenant, { dev_origins: ["localhost", "myapp-*.vercel.app"] });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      dev_origins: ["localhost", "myapp-*.vercel.app"],
      debug_until: null,
    });
    const u = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${tenant}/sites/${r.json().site_id}`,
      cookie: owner,
      body: { dev_origins: ["127.0.0.1", "staging.example.org"] },
    });
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json().dev_origins).toEqual(["127.0.0.1", "staging.example.org"]);
  });

  it("refuses a bare wildcard above a public suffix and short wildcard labels unless the rest is verified", async () => {
    for (const o of ["*.vercel.app", "*.pages.dev", "ab*.example.org", "*.preview.mine.example"]) {
      const r = await call(h, {
        method: "PATCH",
        url: `/v1/tenants/${tenant}/sites/${site}`,
        cookie: owner,
        body: { dev_origins: [o] },
      });
      expect(r.statusCode, o).toBe(400);
      expect(r.json().errors[0].pointer).toBe("/dev_origins/0");
    }
    // grammar and size are refused by the contract's schema
    for (const list of [
      ["Example.org"],
      ["x.org:3000"],
      Array.from({ length: 11 }, (_, i) => `h${i}.example`),
    ]) {
      const r = await call(h, {
        method: "PATCH",
        url: `/v1/tenants/${tenant}/sites/${site}`,
        cookie: owner,
        body: { dev_origins: list },
      });
      expect(r.statusCode).toBe(400);
    }
    // once the tenant has verified mine.example, a bare wildcard under it is accepted
    const d = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/sites/${site}/domains`,
      cookie: owner,
      body: { host: "mine.example" },
    });
    await h.su.query(
      `UPDATE scf.site_domains SET state = 'verified', verified_at = now() WHERE domain_id = $1`,
      [d.json().domain_id],
    );
    const ok = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${tenant}/sites/${site}`,
      cookie: owner,
      body: { dev_origins: ["*.preview.mine.example"] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("switches debug mode on for at most 24 hours (audited) and off again", async () => {
    const before = Date.now();
    const on = await call(h, {
      method: "PUT",
      url: `/v1/tenants/${tenant}/sites/${site}/debug-mode`,
      cookie: owner,
      body: { enabled: true, duration_minutes: 30 },
    });
    expect(on.statusCode, on.body).toBe(200);
    const until = Date.parse(on.json().debug_until);
    expect(until - before).toBeGreaterThan(29 * 60_000);
    expect(until - before).toBeLessThan(31 * 60_000);
    const audit = await h.su.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM scf.audit_log WHERE action = 'site.debug_mode_set' AND target_id = $1 ORDER BY seq DESC LIMIT 1`,
      [site],
    );
    expect(audit.rows[0]?.details).toMatchObject({ enabled: true, minutes: 30 });
    const view = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}`,
      cookie: owner,
    });
    expect(view.json().debug_until).toBe(on.json().debug_until);
    for (const body of [
      { enabled: true, duration_minutes: 1441 },
      { enabled: false, duration_minutes: 5 },
      {},
    ]) {
      const r = await call(h, {
        method: "PUT",
        url: `/v1/tenants/${tenant}/sites/${site}/debug-mode`,
        cookie: owner,
        body,
      });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const off = await call(h, {
      method: "PUT",
      url: `/v1/tenants/${tenant}/sites/${site}/debug-mode`,
      cookie: owner,
      body: { enabled: false },
    });
    expect(off.json()).toEqual({ site_id: site, debug_until: null });
  });
});

// ------------------------------------------------------------------------------------------------ counter parts

describe("counter record props and dev (§d.3, §l) and the first-event panel", () => {
  it("stores dev events (another tenant's site dropped), newest first, trimmed to 100 per site", async () => {
    const t0 = Date.now() - 10 * 60_000;
    const entry = (i: number, s = site, t = tenant) => ({
      tenant_id: t,
      site_id: s,
      received_at_ms: t0 + i * 1000,
      kind: i % 2 ? "custom" : "pageview",
      name: i % 2 ? "signup" : "pageview",
      path: `/p/${i}`,
      would_be: "suspect",
      reason: "proof_missing",
    });
    for (let batch = 0; batch < 6; batch++)
      await postCounters(
        counterRecord({
          dev: [
            ...Array.from({ length: 20 }, (_, i) => entry(batch * 20 + i)),
            entry(999, otherSite, tenant), // a site of another tenant under this tenant: dropped
          ],
        }),
      );
    // old events (> 24 h) are not stored
    await postCounters(
      counterRecord({ dev: [{ ...entry(0), received_at_ms: Date.now() - 25 * 3_600_000 }] }),
    );
    const n = await h.su.query<{ site_id: string; n: number }>(
      `SELECT site_id::text, count(*)::int AS n FROM scf.web_dev_events WHERE tenant_id = ANY($1::uuid[]) GROUP BY 1`,
      [[tenant, otherTenant]],
    );
    expect(n.rows).toEqual([{ site_id: site, n: 100 }]);
    const r = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/dev-events`,
      cookie: owner,
    });
    expect(r.statusCode).toBe(200);
    const ev = r.json().events;
    expect(ev).toHaveLength(100);
    expect(ev[0]).toEqual({
      received_at: new Date(t0 + 119_000).toISOString(),
      kind: "custom",
      event_name: "signup",
      path: "/p/119",
      would_be_verdict: "suspect",
      reason: "proof_missing",
    });
    expect(ev[99].path).toBe("/p/20"); // the 20 oldest were trimmed
    // privacy: only kind, name, normalised path, time, would-be verdict and reason are kept
    const cols = await h.su.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'scf' AND table_name = 'web_dev_events'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual([
      "event_id",
      "event_name",
      "kind",
      "path_class",
      "reason",
      "received_at",
      "site_id",
      "tenant_id",
      "would_be_verdict",
    ]);
    // the other tenant sees none of them, and cannot read this site's panel
    const foreign = await call(h, {
      method: "GET",
      url: `/v1/tenants/${otherTenant}/sites/${otherSite}/dev-events`,
      cookie: otherOwner,
    });
    expect(foreign.json().events).toEqual([]);
    const cross = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/dev-events`,
      cookie: otherOwner,
    });
    expect(cross.statusCode).toBe(404);
  });

  it("applies props once into the property rollup; drops values outside the closed lists and foreign sites", async () => {
    const day = today();
    const p = (
      event: string,
      key: string,
      value: string,
      count: number,
      extra: Record<string, unknown> = {},
    ) => ({
      tenant_id: tenant,
      site_id: site,
      day,
      event,
      network: "mainnet",
      key,
      value,
      verdict: "verified",
      count,
      ...extra,
    });
    const rec = counterRecord({
      props: [
        p("wallet_connect", "_total", "all", 3),
        p("wallet_connect", "wallet", "freighter", 2),
        p("wallet_connect", "wallet", "xbull", 1),
        p("wallet_connect", "connect_kind", "new", 3),
        p("wallet_connect", "_total", "all", 2, { verdict: "suspect" }),
        p("wallet_connect", "_total", "all", 4, { network: "testnet" }),
        p("sign_approved", "_total", "all", 2),
        p("tx_submitted", "_total", "all", 2),
        p("tx_submitted", "result_class", "success", 1),
        p("tx_submitted", "result_class", "failed", 1),
        p("wallet_connect", "wallet", "not_a_wallet", 5), // outside the closed list: dropped
        p("wallet_connect", "_total", "all", 7, { site_id: otherSite }), // another tenant's site: dropped
      ],
    });
    await postCounters(rec);
    await postCounters(rec); // a duplicate is not applied again
    const rows = await h.su.query<{ n: string }>(
      `SELECT sum(count)::text AS n FROM scf.web_event_property_daily WHERE tenant_id = $1`,
      [tenant],
    );
    expect(Number(rows.rows[0]?.n)).toBe(3 + 2 + 1 + 3 + 2 + 4 + 2 + 2 + 1 + 1);
    const foreign = await h.su.query(
      `SELECT 1 FROM scf.web_event_property_daily WHERE site_id = $1`,
      [otherSite],
    );
    expect(foreign.rowCount).toBe(0);
  });

  it("serves the wallet funnel exactly (tenant self-view), by network and variant", async () => {
    const start = `${today()}T00:00:00Z`;
    const end = new Date(Date.parse(start) + 86_400_000).toISOString().replace(".000Z", "Z");
    const url = (q: string) =>
      `/v1/tenants/${tenant}/sites/${site}/web/wallet-funnel?start=${start}&end=${end}${q}`;
    const main = await call(h, { method: "GET", url: url(""), cookie: owner });
    expect(main.statusCode, main.body).toBe(200);
    const b = main.json();
    expect(b).toMatchObject({
      network: "mainnet",
      variant: "verified",
      schema: "scf-stellar-events/1",
    });
    const connect = b.steps.find((s: { event: string }) => s.event === "wallet_connect");
    // counts below op_min_count (10) are exact in the tenant's own view
    expect(connect).toEqual({
      event: "wallet_connect",
      count: 3,
      by_wallet: { freighter: 2, xbull: 1 },
      by_property: { connect_kind: { new: 3 } },
    });
    expect(b.daily).toEqual([
      { day: today(), wallet_connect: 3, sign_approved: 2, tx_submitted_success: 1 },
    ]);
    const raw = await call(h, { method: "GET", url: url("&variant=raw"), cookie: owner });
    expect(
      raw.json().steps.find((s: { event: string }) => s.event === "wallet_connect").count,
    ).toBe(5);
    const test = await call(h, { method: "GET", url: url("&network=testnet"), cookie: owner });
    expect(
      test.json().steps.find((s: { event: string }) => s.event === "wallet_connect").count,
    ).toBe(4);
    const all = await call(h, {
      method: "GET",
      url: url("&network=all&variant=raw"),
      cookie: owner,
    });
    expect(
      all.json().steps.find((s: { event: string }) => s.event === "wallet_connect").count,
    ).toBe(9);
    const viewer = await call(h, { method: "GET", url: url(""), cookie: otherOwner });
    expect(viewer.statusCode).toBe(404);
    const backwards = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/wallet-funnel?start=${end}&end=${start}`,
      cookie: owner,
    });
    expect(backwards.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------------------------------------------ footprint

describe("Registered Footprint (data-model §12.1, C-137 scope)", () => {
  let item = "";
  let cid = "";

  it("starts as missing; none_declared through the tenant update", async () => {
    const t = await call(h, {
      method: "GET",
      url: `/v1/tenants/${otherTenant}`,
      cookie: otherOwner,
    });
    expect(t.json()).toMatchObject({
      footprint_status: "missing",
      footprint_none_declared: false,
      seal_enabled: false,
    });
    const u = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${otherTenant}`,
      cookie: otherOwner,
      body: { footprint_none_declared: true },
    });
    expect(u.json().footprint_status).toBe("none_declared");
  });

  it("declares a contract (claimed, mainnet), refuses a duplicate (409) and other kinds (422)", async () => {
    cid = contractId();
    const r = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie: owner,
      body: { kind: "contract", subject: cid, network: "mainnet", label: "core" },
    });
    expect(r.statusCode, r.body).toBe(201);
    item = r.json().item_id;
    expect(r.json()).toMatchObject({
      kind: "contract",
      subject: cid,
      network: "mainnet",
      status: "claimed",
      verification_method: null,
      conflict_since: null,
    });
    const dup = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie: owner,
      // `public` is the deprecated alias of `mainnet` (C-138): the same contract, so a duplicate
      body: { kind: "contract", subject: cid, network: "public" },
    });
    expect(dup.statusCode).toBe(409);
    // 422 for other kinds (C-137, documented on addFootprintItem by C-138)
    const acct = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie: owner,
      body: { kind: "issuing_account", subject: stellarKey().account, network: "mainnet" },
    });
    expect(acct.statusCode).toBe(422);
    expect(acct.json().code).toBe("unprocessable");
    const wrong = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie: owner,
      body: { kind: "contract", subject: stellarKey().account, network: "public" },
    });
    expect(wrong.statusCode).toBe(400);
    // the same contract row is visible through listContracts, and the enrolment step is `claimed`
    const contracts = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/contracts`,
      cookie: owner,
    });
    expect(contracts.json().map((c: { contract_ref: string }) => c.contract_ref)).toContain(item);
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${tenant}`, cookie: owner })).json()
        .footprint_status,
    ).toBe("claimed");
    // nothing about accounts is stored for a refused kind
    const fi = await h.su.query(`SELECT 1 FROM scf.footprint_items WHERE tenant_id = $1`, [tenant]);
    expect(fi.rowCount).toBe(0);
  });

  it("queues a contract for deployer_admin_match (202); other methods and challenges are 400", async () => {
    const v = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${item}/verify`,
      cookie: owner,
      body: { method: "deployer_admin_match" },
    });
    expect(v.statusCode, v.body).toBe(202);
    const due = await h.su.query<{ due: boolean }>(
      `SELECT next_check_at <= now() AS due FROM scf.declared_contracts WHERE contract_ref = $1`,
      [item],
    );
    expect(due.rows[0]?.due).toBe(true);
    const sc = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${item}/verify`,
      cookie: owner,
      body: { method: "signed_challenge", signature: `${"A".repeat(86)}==` },
    });
    expect(sc.statusCode).toBe(400);
    const ch = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${item}/challenge`,
      cookie: owner,
    });
    expect(ch.statusCode).toBe(400);
    // a verified contract makes the enrolment step `verified`
    await markVerified(tenant, [item]);
    const list = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie: owner,
    });
    expect(list.json()).toEqual([
      expect.objectContaining({
        item_id: item,
        status: "verified",
        verification_method: "deployer_admin_match",
      }),
    ]);
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${tenant}`, cookie: owner })).json()
        .footprint_status,
    ).toBe("verified");
  });

  it("signed_challenge for an account item: one-time SEP-53 message, L2 signer rule, single use", async () => {
    // Accounts cannot be declared through the API yet; the row is put in place as the database would hold it.
    const key = stellarKey();
    const userId = (await call(h, { method: "GET", url: "/v1/me", cookie: owner })).json().user_id;
    const acct = (
      await h.su.query<{ item_id: string }>(
        `INSERT INTO scf.footprint_items (tenant_id, kind, subject, network, created_by)
         VALUES ($1, 'app_account', $2, 'testnet', $3) RETURNING item_id::text`,
        [tenant, key.account, userId],
      )
    ).rows[0]?.item_id as string;
    h.horizon.accounts.set(key.account, { weight: 1, mediumThreshold: 1 });
    const ch = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${acct}/challenge`,
      cookie: owner,
    });
    expect(ch.statusCode, ch.body).toBe(200);
    expect(ch.json().message).toContain(key.account);
    const stored = await h.su.query<{ challenge_hash: Buffer }>(
      `SELECT challenge_hash FROM scf.footprint_items WHERE item_id = $1`,
      [acct],
    );
    expect(stored.rows[0]?.challenge_hash.equals(sep53Digest(ch.json().message))).toBe(true);
    const good = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${acct}/verify`,
      cookie: owner,
      body: { method: "signed_challenge", signature: key.signMessage(ch.json().message) },
    });
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json()).toMatchObject({
      status: "verified",
      verification_method: "signed_challenge",
    });
    expect(h.horizon.networks.get(key.account)).toBe("testnet");
    // a reused signature finds no challenge
    const again = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${acct}/verify`,
      cookie: owner,
      body: { method: "signed_challenge", signature: key.signMessage(ch.json().message) },
    });
    expect(again.statusCode).toBe(400);
    // a wrong signer is rejected (signature_invalid)
    const ch2 = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${acct}/challenge`,
      cookie: owner,
    });
    const bad = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${acct}/verify`,
      cookie: owner,
      body: { method: "signed_challenge", signature: stellarKey().signMessage(ch2.json().message) },
    });
    expect(bad.json()).toMatchObject({ status: "rejected", rejected_reason: "signature_invalid" });
    // removal hides it; the retention rule deletes it later
    const rm = await call(h, {
      method: "DELETE",
      url: `/v1/tenants/${tenant}/footprint/${acct}`,
      cookie: owner,
    });
    expect(rm.statusCode).toBe(204);
    const list = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie: owner,
    });
    expect(list.json().map((x: { item_id: string }) => x.item_id)).not.toContain(acct);
  });

  it("another tenant cannot read, verify or remove this tenant's items", async () => {
    for (const [m, path, body] of [
      ["GET", `/v1/tenants/${tenant}/footprint`, undefined],
      ["DELETE", `/v1/tenants/${tenant}/footprint/${item}`, undefined],
      [
        "POST",
        `/v1/tenants/${tenant}/footprint/${item}/verify`,
        { method: "deployer_admin_match" },
      ],
      ["DELETE", `/v1/tenants/${otherTenant}/footprint/${item}`, undefined],
      [
        "POST",
        `/v1/tenants/${otherTenant}/footprint/${item}/verify`,
        { method: "deployer_admin_match" },
      ],
    ] as const) {
      const r = await call(h, {
        method: m,
        url: path,
        cookie: otherOwner,
        ...(body ? { body } : {}),
      });
      expect(r.statusCode, `${m} ${path}`).toBe(404);
    }
    const mine = await call(h, {
      method: "GET",
      url: `/v1/tenants/${otherTenant}/footprint`,
      cookie: otherOwner,
    });
    expect(mine.json()).toEqual([]);
  });

  it("operator view (audited) and conflict resolution by an operator_admin: 204, then 409; unknown 404", async () => {
    // the same contract verified for a second tenant: both flagged (job contract_verification's rule)
    const twin = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${otherTenant}/footprint`,
        cookie: otherOwner,
        body: { kind: "contract", subject: cid, network: "public" },
      })
    ).json().item_id as string;
    await markVerified(tenant, [item], true);
    await markVerified(otherTenant, [twin], true);
    const op = await operatorSession(h, "operator");
    // OperatorFootprintItem = allOf(FootprintItem, {tenant_id}) cannot validate while FootprintItem is closed
    // (additionalProperties: false): a contract defect, reported. Checked here against FootprintItem + tenant_id.
    const view = await h.app.inject({
      method: "GET",
      url: `/v1/operator/tenants/${tenant}/footprint`,
      headers: { cookie: op.cookie },
    });
    for (const row of view.json() as Array<Record<string, unknown>>) {
      const { tenant_id, ...rest } = row;
      expect(tenant_id).toBe(tenant);
      expect(h.openapi.validateResponse("listFootprint", 200, "application/json", [rest])).toEqual(
        [],
      );
    }
    const audited = await h.su.query(
      `SELECT 1 FROM scf.audit_log WHERE action = 'operator.read.op_footprint' AND request_id = $1`,
      [String(view.headers["x-request-id"])],
    );
    expect(audited.rowCount).toBe(1);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toEqual([
      expect.objectContaining({
        tenant_id: tenant,
        item_id: item,
        status: "verified",
        subject: cid,
      }),
    ]);
    expect(view.json()[0].conflict_since).not.toBeNull();
    const filtered = await call(h, {
      method: "GET",
      url: `/v1/operator/tenants/${tenant}/footprint?status=rejected`,
      cookie: op.cookie,
    });
    expect(filtered.json()).toEqual([]);
    const admin = await operatorSession(h, "operator_admin");
    const reject = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${otherTenant}/footprint/${twin}/reject-conflict`,
      cookie: admin.cookie,
    });
    expect(reject.statusCode, reject.body).toBe(204);
    const rows = await h.su.query<{
      contract_ref: string;
      status: string;
      rejected_reason: string | null;
      due: boolean;
    }>(
      `SELECT contract_ref::text, status, rejected_reason, next_check_at IS NOT NULL AS due
         FROM scf.declared_contracts WHERE contract_ref = ANY($1::uuid[]) ORDER BY contract_ref = $2`,
      [[item, twin], item],
    );
    expect(rows.rows).toEqual([
      {
        contract_ref: twin,
        status: "rejected",
        rejected_reason: "claimed_by_other_tenant",
        due: false,
      },
      { contract_ref: item, status: "verified", rejected_reason: null, due: true },
    ]);
    const tenantSees = await call(h, {
      method: "GET",
      url: `/v1/tenants/${otherTenant}/footprint`,
      cookie: otherOwner,
    });
    expect(tenantSees.json()[0]).toMatchObject({
      status: "rejected",
      rejected_reason: "claimed_by_other_tenant",
    });
    const again = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${otherTenant}/footprint/${twin}/reject-conflict`,
      cookie: admin.cookie,
    });
    expect(again.statusCode).toBe(409);
    const unknown = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${tenant}/footprint/${randomUUID()}/reject-conflict`,
      cookie: admin.cookie,
    });
    expect(unknown.statusCode).toBe(404);
    // the item of tenant A named under tenant B is not found either
    const crossed = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${otherTenant}/footprint/${item}/reject-conflict`,
      cookie: admin.cookie,
    });
    expect(crossed.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------ cohorts

describe("SCF cohorts (§i.4): floors on both operator surfaces", () => {
  const round = 100 + Math.floor(Math.random() * 800);
  const projects: SeededProject[] = [];

  beforeAll(async () => {
    // 5 projects in round R (one shown cohort), 2 in round R+1 (suppressed). Web figures: 4 projects with 3 page
    // views each, one with 0 → R sums to 12 verified (≥ 10), visitors 4 × 1 = 4 (< 10: withheld).
    for (let i = 0; i < 7; i++) {
      const p = await seedProject(h);
      projects.push(p);
      const rp = randomUUID();
      await h.su.query(
        `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, fetched_at,
           content_sha256, raw, scf_categories, award_round, award_stage)
         VALUES ($1, 'operator', $2, $3, true, now(), sha256(convert_to($2, 'UTF8')), '{}'::jsonb, $4, $5, 't1_mvp')`,
        [
          rp,
          `src-${p.slug}`,
          `Registry ${p.slug}`,
          ["developer_tooling"],
          i < 5 ? round : round + 1,
        ],
      );
      await h.su.query(
        `INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
         VALUES ($1, $2, '{operator}', 'confirmed')`,
        [p.tenantId, rp],
      );
      if (i < 4)
        await seedWebDay(h, p, "2026-10-05", { pvVerified: 3, pvRaw: 4, visitorsVerified: 1 });
    }
  });

  const q = (by: string) => `start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z&by=${by}`;

  it("console: a cohort under 5 tenants is suppressed; a figure under op_min_count is null (audited)", async () => {
    const op = await operatorSession(h, "operator");
    const r = await call(h, {
      method: "GET",
      url: `/v1/operator/cohorts?${q("round")}`,
      cookie: op.cookie,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ by: "round", min_tenants: 5 });
    const mine = r
      .json()
      .cohorts.filter((c: { cohort: string }) => [`${round}`, `${round + 1}`].includes(c.cohort));
    expect(mine).toEqual([
      {
        cohort: `${round}`,
        tenant_count: 5,
        pageviews_verified: 12,
        pageviews_raw: 16,
        visitors_sum_verified: null,
        tenants_with_onchain: 0,
        onchain_invocations: null,
        onchain_successful_invocations: null,
        suppressed: false,
      },
      {
        cohort: `${round + 1}`,
        tenant_count: null,
        pageviews_verified: null,
        pageviews_raw: null,
        visitors_sum_verified: null,
        tenants_with_onchain: null,
        onchain_invocations: null,
        onchain_successful_invocations: null,
        suppressed: true,
      },
    ]);
    const bad = await call(h, {
      method: "GET",
      url: `/v1/operator/cohorts?${q("nope")}`,
      cookie: op.cookie,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("operator key (/op/v1/cohorts, web:read): same floors, CohortPage shape", async () => {
    const admin = (await operatorSession(h, "operator_admin")).cookie;
    const { key } = await createOperatorKey(h, admin, { scopes: ["web:read"] });
    const r = await callMetrics(h, key, `/op/v1/cohorts?${q("award_stage")}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ by: "award_stage", min_projects: 5, next_cursor: null });
    const stage = r.json().data.find((c: { cohort: string }) => c.cohort === "t1_mvp");
    expect(stage.suppressed).toBe(false);
    expect(stage.project_count).toBeGreaterThanOrEqual(7);
    const audit = await h.su.query(
      `SELECT 1 FROM scf.audit_log WHERE action = 'operator.read.op_cohorts' AND request_id = $1`,
      [String(r.headers["x-request-id"])],
    );
    expect(audit.rowCount).toBe(1);
    const { key: apiKey } = await createOperatorKey(h, admin, { scopes: ["api:read"] });
    expect((await callMetrics(h, apiKey, `/op/v1/cohorts?${q("round")}`)).statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------ snapshots v2

describe("traction snapshot v2, the public series list and the seal (§i.3.2–§i.3.4, §m.2)", () => {
  let slug = "";
  let snapOwner = "";
  let snapTenant = "";
  const ids: string[] = [];
  const shas: string[] = [];

  beforeAll(async () => {
    snapOwner = await signInGithub(h, newGithubUser());
    slug = uniqueSlug("snap");
    snapTenant = await createTenant(h, snapOwner, slug);
    await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${snapTenant}`,
      cookie: snapOwner,
      body: { seal_enabled: true },
    });
  });

  const create = (body: Record<string, unknown>) =>
    call(h, {
      method: "POST",
      url: `/v1/tenants/${snapTenant}/traction-snapshots`,
      cookie: snapOwner,
      body,
    });

  it("creates v2 by default: closed v2 schema, series 1 then 2 with the previous hash, signed, pasteable text", async () => {
    for (const body of [
      {
        period_start: "2026-07-01T00:00:00Z",
        period_end: "2026-10-01T00:00:00Z",
        preset: "pg_renewal_quarter",
      },
      { period_start: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z" },
    ]) {
      const r = await create(body);
      expect(r.statusCode, r.body).toBe(201);
      const { snapshot, signature } = r.json();
      expect(validateV2(snapshot), JSON.stringify(validateV2.errors)).toBe(true);
      const ok = verify(
        null,
        Buffer.from(canonicalize(snapshot), "utf8"),
        createPublicKey(SNAPSHOT_PUBLIC_PEM),
        Buffer.from(signature.sig, "base64url"),
      );
      expect(ok).toBe(true);
      ids.push(snapshot.snapshot_id);
      shas.push(
        (
          await h.su.query<{ s: string }>(
            `SELECT encode(canonical_sha256, 'hex') AS s FROM scf.traction_snapshots WHERE snapshot_id = $1`,
            [snapshot.snapshot_id],
          )
        ).rows[0]?.s as string,
      );
    }
    const first = await call(h, {
      method: "GET",
      url: `/public/v1/snapshots/${ids[0]}`,
      cookie: undefined,
    });
    expect(first.json().snapshot).toMatchObject({
      schema: "scf-analytics/traction-snapshot/2",
      series: { seq: 1, previous_sha256: null },
      preset: "pg_renewal_quarter",
      period: { days: 92 },
      seal: {
        enabled: true,
        network: "testnet",
        proof_url: `https://portal.test/public/v1/snapshots/${ids[0]}/seal`,
      },
      methodology: { version: "scf-methodology/1.0.0" },
      links: { public_list: `https://portal.test/public/v1/projects/${slug}/snapshots` },
      api: expect.objectContaining({ label: "self-attested telemetry" }),
      onchain: null,
      confidence: { level: "insufficient", reasons: [] },
    });
    expect(first.json().snapshot.text).toContain("Snapshot 1 of this project");
    expect(first.json().snapshot.text).toContain("Public Goods renewal quarter");
    const second = (await call(h, { method: "GET", url: `/public/v1/snapshots/${ids[1]}` })).json()
      .snapshot;
    expect(second.series).toEqual({ seq: 2, previous_sha256: shas[0] });
    expect(second.preset).toBe("custom");
    expect(second.web.weekly[0]).toMatchObject({ start: "2026-09-28T00:00:00Z", days: 4 });
    const stored = await h.su.query<{ m: string; v: number }>(
      `SELECT methodology_version AS m, schema_version AS v FROM scf.traction_snapshots WHERE snapshot_id = $1`,
      [ids[1]],
    );
    expect(stored.rows[0]).toEqual({ m: "scf-methodology/1.0.0", v: 2 });
  });

  it("refuses a preset with v1 and a pg_renewal_quarter that is not a calendar quarter; v1 still works", async () => {
    expect(
      (
        await create({
          period_start: "2026-10-01T00:00:00Z",
          period_end: "2026-11-01T00:00:00Z",
          schema_version: 1,
          preset: "custom",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await create({
          period_start: "2026-08-01T00:00:00Z",
          period_end: "2026-11-01T00:00:00Z",
          preset: "pg_renewal_quarter",
        })
      ).statusCode,
    ).toBe(400);
    const v1 = await create({
      period_start: "2026-10-01T00:00:00Z",
      period_end: "2026-11-01T00:00:00Z",
      schema_version: 1,
    });
    expect(v1.statusCode, v1.body).toBe(201);
    expect(v1.json().snapshot.schema).toBe("scf-analytics/traction-snapshot/1");
    ids.push(v1.json().snapshot.snapshot_id);
  });

  it("lists every signed snapshot in series order with previous hashes, revoked ones included (public)", async () => {
    const rev = await call(h, {
      method: "POST",
      url: `/v1/tenants/${snapTenant}/traction-snapshots/${ids[0]}/revoke`,
      cookie: snapOwner,
      body: { reason: "superseded" },
    });
    expect([204, 200]).toContain(rev.statusCode);
    const r = await call(h, { method: "GET", url: `/public/v1/projects/${slug}/snapshots` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("public, max-age=300");
    const s = r.json().snapshots;
    expect(s.map((x: { seq: number }) => x.seq)).toEqual([1, 2, 3]);
    expect(s.map((x: { snapshot_id: string }) => x.snapshot_id)).toEqual(ids);
    expect(s[0]).toMatchObject({
      previous_sha256: null,
      status: "revoked",
      preset: "pg_renewal_quarter",
      schema_version: 2,
    });
    expect(s[1].previous_sha256).toBe(s[0].sha256);
    expect(s[2]).toMatchObject({ previous_sha256: s[1].sha256, schema_version: 1, preset: null });
    expect(s[1].sha256).toBe(shas[1]);
    // unknown slugs and tenants without a listed snapshot look the same
    expect(
      (await call(h, { method: "GET", url: `/public/v1/projects/no-such-${slug}/snapshots` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(h, { method: "GET", url: `/public/v1/projects/${uniqueSlug()}/snapshots` }))
        .statusCode,
    ).toBe(404);
  });

  it("serves seal days and a snapshot's proof from final leaves only, naming the network and the testnet notice", async () => {
    const hex = (b: string) => Buffer.from(b.repeat(64).slice(0, 64), "hex");
    // the snapshot's leaf first: provisional (no day row) → no proof
    await h.su.query(
      `INSERT INTO scf.seal_leaves (tenant_id, snapshot_id, network, day, leaf_index, salt, leaf_hash, audit_path)
       VALUES ($1, $2, 'testnet', '2026-11-02', 2, $3, $4, ARRAY[$5::bytea, $6::bytea])`,
      [snapTenant, ids[1], hex("a"), hex("b"), hex("c"), hex("d")],
    );
    expect(
      (await call(h, { method: "GET", url: `/public/v1/snapshots/${ids[1]}/seal` })).statusCode,
    ).toBe(404);
    await h.su.query(
      `INSERT INTO scf.seal_days (network, day, segment, prev_root, audit_anchor_sha256, leaf_count, head_path, root,
                                  status, source_account, tx_hash, ledger, confirmed_at)
       VALUES ('testnet', '2026-11-02', 1, $1, $2, 3, ARRAY[$3::bytea], $4, 'confirmed', $5, $6, 123456, now())`,
      [Buffer.alloc(32), hex("e"), hex("f"), hex("1"), stellarKey().account, hex("2")],
    );
    const p = await call(h, { method: "GET", url: `/public/v1/snapshots/${ids[1]}/seal` });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().proofs).toHaveLength(1);
    expect(p.json().proofs[0]).toMatchObject({
      schema: "scf-analytics/seal-proof/1",
      network: { name: "testnet", durable: false, notice: TESTNET_NOTICE },
      snapshot_id: ids[1],
      snapshot_sha256: shas[1],
      day: "2026-11-02",
      segment: 1,
      leaf_index: 2,
      leaf_count: 3,
      audit_path: ["c".repeat(64), "d".repeat(64)],
      head_path: ["f".repeat(64)],
      root: "1".repeat(64),
      prev_root: "0".repeat(64),
      status: "confirmed",
      tx_hash: "2".repeat(64),
      ledger: 123456,
      explorer_url: `https://stellar.expert/explorer/testnet/tx/${"2".repeat(64)}`,
      statement:
        "Tamper-evidence of a published snapshot. It does not show that the numbers are genuine.",
    });
    const days = await call(h, {
      method: "GET",
      url: "/public/v1/seals?start=2026-11-01T00:00:00Z&end=2026-11-03T00:00:00Z",
    });
    expect(days.statusCode, days.body).toBe(200);
    expect(days.json().network.name).toBe("testnet");
    expect(days.json().days).toEqual([
      expect.objectContaining({ day: "2026-11-02", head_path: ["f".repeat(64)], segment: 1 }),
    ]);
    const day = await call(h, { method: "GET", url: "/public/v1/seals/2026-11-02" });
    expect(day.json().seal.root).toBe("1".repeat(64));
    expect((await call(h, { method: "GET", url: "/public/v1/seals/2026-11-03" })).statusCode).toBe(
      404,
    );
    expect(
      (await call(h, { method: "GET", url: `/public/v1/snapshots/${randomUUID()}/seal` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(h, {
          method: "GET",
          url: "/public/v1/seals?start=2025-01-01T00:00:00Z&end=2026-11-03T00:00:00Z",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("seal leaves are tenant data: another tenant's context sees none of them", async () => {
    const seen = await h.db.tx(
      { tenantId: otherTenant, actorKind: "system", actorId: "iso-test", requestId: "iso-seal" },
      (tx) => tx.query(`SELECT 1 FROM scf.seal_leaves`),
    );
    expect(seen).toEqual([]);
    const own = await h.db.tx(
      { tenantId: snapTenant, actorKind: "system", actorId: "iso-test", requestId: "iso-seal" },
      (tx) => tx.query(`SELECT 1 FROM scf.seal_leaves`),
    );
    expect(own).toHaveLength(1);
  });
});
