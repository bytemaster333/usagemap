// SPDX-License-Identifier: Apache-2.0
// Domain verification end to end on the real database: the HTTP operations (response-validated against the OpenAPI
// document by `call()`), then the `domain_verification` job as scf_jobs with the SSRF-safe verifier pointed at a local
// fake DNS server and a local HTTPS server (data-model §8.4, ADR-0015 L1, C-64).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainVerifier } from "../../src/verify/verifier.ts";
import { DomainVerificationWorker, type Outcome } from "../../src/verify/worker.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";
import {
  FakeDns,
  FakeHttps,
  makeTestPki,
  PUBLIC_V4,
  type TestPki,
} from "../support/verify/fake-net.ts";

let h: Harness;
let dns: FakeDns;
let https: FakeHttps;
let pki: TestPki;
let worker: DomainVerificationWorker;
let wakes = 0;
const rnd = () => randomUUID().slice(0, 8);
const WK_HOST = `wk-${rnd()}.example`;
const META_HOST = `meta-${rnd()}.example`;

interface Ctx {
  cookie: string;
  tenant: string;
  site: string;
}
let a: Ctx;
let b: Ctx;

async function newCtx(): Promise<Ctx> {
  const cookie = await signInGithub(h, newGithubUser());
  const tenant = await createTenant(h, cookie);
  const site = (
    await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/sites`,
      cookie,
      body: { name: "S" },
    })
  ).json().site_id as string;
  return { cookie, tenant, site };
}

async function addDomain(c: Ctx, host: string, site = c.site): Promise<string> {
  const res = await call(h, {
    method: "POST",
    url: `/v1/tenants/${c.tenant}/sites/${site}/domains`,
    cookie: c.cookie,
    body: { host },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().domain_id as string;
}

async function start(c: Ctx, domain: string, method: string, site = c.site) {
  return call(h, {
    method: "POST",
    url: `/v1/tenants/${c.tenant}/sites/${site}/domains/${domain}/verifications`,
    cookie: c.cookie,
    body: { method },
  });
}

async function check(c: Ctx, domain: string, verification: string, site = c.site) {
  return call(h, {
    method: "POST",
    url: `/v1/tenants/${c.tenant}/sites/${site}/domains/${domain}/verifications/${verification}/check`,
    cookie: c.cookie,
  });
}

/** Makes every given verification due and runs one pass of the job. */
async function runJob(...ids: string[]): Promise<Map<string, Outcome>> {
  await h.su.query(
    `UPDATE scf.domain_verifications SET next_check_at = now() - interval '1 second'
      WHERE verification_id = ANY($1::uuid[])`,
    [ids],
  );
  const out = await worker.runOnce();
  expect(out).not.toBeNull();
  return out as Map<string, Outcome>;
}

async function domainRow(tenant: string, domain: string) {
  return (
    await h.su.query(
      `SELECT state, verified_at, grace_until FROM scf.site_domains WHERE tenant_id = $1 AND domain_id = $2`,
      [tenant, domain],
    )
  ).rows[0] as { state: string; verified_at: Date | null; grace_until: Date | null };
}

async function level(c: Ctx): Promise<string> {
  return (await call(h, { method: "GET", url: `/v1/tenants/${c.tenant}`, cookie: c.cookie })).json()
    .verification_level as string;
}

async function auditActions(tenant: string, target: string): Promise<string[]> {
  return (
    await h.su.query<{ action: string }>(
      `SELECT action FROM scf.audit_log WHERE tenant_id = $1 AND target_id = $2 ORDER BY occurred_at, seq`,
      [tenant, target],
    )
  ).rows.map((r) => r.action);
}

beforeAll(async () => {
  pki = makeTestPki([WK_HOST, META_HOST]);
  dns = new FakeDns();
  await dns.start();
  https = new FakeHttps(pki, [WK_HOST, META_HOST]);
  await https.start();
  h = await startHarness({}, { wakeVerifier: () => wakes++ });
  worker = new DomainVerificationWorker(
    h.jobsDb,
    new DomainVerifier({
      dnsServers: [dns.server],
      ca: pki.ca,
      timeoutMs: 2000,
      dial: () => ({ host: "127.0.0.1", port: https.port }),
    }),
    { intervalMs: 3_600_000 },
  );
  a = await newCtx();
  b = await newCtx();
});
afterAll(async () => {
  await worker?.stop();
  await h?.close();
  await https?.stop();
  await dns?.stop();
  pki?.cleanup();
});

describe("domain verification", () => {
  it("DNS TXT: start → instructions → check queued → job verifies; evidence makes the tenant L1", async () => {
    const host = `dns-${rnd()}.example`;
    const domain = await addDomain(a, host);
    const res = await start(a, domain, "dns_txt");
    expect(res.statusCode, res.body).toBe(201);
    const v = res.json();
    expect(v.status).toBe("pending");
    expect(v.token).toMatch(/^[0-9A-Za-z_-]{22}$/);
    expect(v.instructions).toEqual({
      dns_name: `_scf-verify.${host}`,
      dns_value: `scf-verify=${v.token}`,
    });
    const days = (Date.parse(v.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(await level(a)).toBe("L0");

    // Not published yet: the check is only queued (202), and the job records the failure.
    const before = wakes;
    const q = await check(a, domain, v.verification_id);
    expect(q.statusCode, q.body).toBe(202);
    expect(wakes).toBe(before + 1);
    dns.records.set(`_scf-verify.${host}`, "NXDOMAIN");
    expect((await runJob(v.verification_id)).get(v.verification_id)).toBe("DNS_NXDOMAIN");
    expect((await check(a, domain, v.verification_id)).json()).toMatchObject({
      status: "pending",
      last_result_code: "DNS_NXDOMAIN",
    });

    dns.records.set(`_scf-verify.${host}`, { txt: [[`scf-verify=${v.token}`]] });
    expect((await runJob(v.verification_id)).get(v.verification_id)).toBe("OK");
    // The next re-check is in a day (first week).
    const next = await h.su.query<{ hours: number }>(
      `SELECT extract(epoch FROM next_check_at - now()) / 3600 AS hours FROM scf.domain_verifications
        WHERE verification_id = $1`,
      [v.verification_id],
    );
    expect(Number(next.rows[0]?.hours)).toBeGreaterThan(23);
    expect(Number(next.rows[0]?.hours)).toBeLessThan(25);
    const after = (await check(a, domain, v.verification_id)).json();
    expect(after).toMatchObject({ status: "verified", last_result_code: "OK" });
    expect((await domainRow(a.tenant, domain)).state).toBe("verified");
    expect(await level(a)).toBe("L1");
    const ev = await h.su.query(
      `SELECT status FROM scf.verification_evidence WHERE tenant_id = $1 AND kind = 'domain' AND subject = $2`,
      [a.tenant, host],
    );
    expect(ev.rows).toEqual([{ status: "valid" }]);
    expect(await auditActions(a.tenant, domain)).toEqual(
      expect.arrayContaining([
        "domain.verification_started",
        "domain.verification_checked",
        "domain.verified",
      ]),
    );
    // The snapshot/edge sees the host as verified (domain list of the site).
    const site = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${a.tenant}/sites/${a.site}`,
        cookie: a.cookie,
      })
    ).json();
    expect(site.domains.find((d: { domain_id: string }) => d.domain_id === domain).state).toBe(
      "verified",
    );
  });

  it("well-known file and meta tag over HTTPS", async () => {
    dns.records.set(WK_HOST, { a: [PUBLIC_V4] });
    dns.records.set(META_HOST, { a: [PUBLIC_V4] });
    const d1 = await addDomain(a, WK_HOST);
    const d2 = await addDomain(a, META_HOST);
    const v1 = (await start(a, d1, "well_known")).json();
    const v2 = (await start(a, d2, "meta_tag")).json();
    expect(v1.instructions).toEqual({
      url: `https://${WK_HOST}/.well-known/scf-verify.txt`,
      file_body: v1.token,
    });
    expect(v2.instructions).toEqual({
      meta_tag: `<meta name="scf-site-verification" content="${v2.token}">`,
    });
    https.routes.set(WK_HOST, (p) =>
      p === "/.well-known/scf-verify.txt" ? { status: 200, body: v1.token } : { status: 404 },
    );
    https.routes.set(META_HOST, (p) =>
      p === "/"
        ? {
            status: 200,
            body: `<html><head><meta content="${v2.token}" name="scf-site-verification"></head></html>`,
          }
        : { status: 404 },
    );
    const out = await runJob(v1.verification_id, v2.verification_id);
    expect(out.get(v1.verification_id)).toBe("OK");
    expect(out.get(v2.verification_id)).toBe("OK");
  });

  it("a host that resolves to a private address is refused and stays unverified", async () => {
    const host = `evil-${rnd()}.example`;
    dns.records.set(host, { a: ["169.254.169.254"] });
    const d = await addDomain(a, host);
    const v = (await start(a, d, "well_known")).json();
    expect((await runJob(v.verification_id)).get(v.verification_id)).toBe(
      "PRIVATE_ADDRESS_REFUSED",
    );
    expect((await domainRow(a.tenant, d)).state).toBe("unverified");
  });

  it("a second tenant proving a claimed host gets a dispute, a tombstoned host is refused", async () => {
    const host = `shared-${rnd()}.example`;
    const da = await addDomain(a, host);
    const db = await addDomain(b, host);
    const va = (await start(a, da, "dns_txt")).json();
    const vb = (await start(b, db, "dns_txt")).json();
    dns.records.set(`_scf-verify.${host}`, {
      txt: [[`scf-verify=${va.token}`], [`scf-verify=${vb.token}`]],
    });
    expect((await runJob(va.verification_id)).get(va.verification_id)).toBe("OK");
    expect((await runJob(vb.verification_id)).get(vb.verification_id)).toBe(
      "HOST_CLAIMED_ELSEWHERE",
    );
    expect((await domainRow(b.tenant, db)).state).toBe("disputed");
    expect((await check(b, db, vb.verification_id)).json()).toMatchObject({
      status: "failed",
      last_result_code: "HOST_CLAIMED_ELSEWHERE",
    });
    expect(await auditActions(b.tenant, db)).toContain("domain.disputed");
    expect(await level(b)).toBe("L0");

    const tomb = `tomb-${rnd()}.example`;
    await h.su.query(
      `INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason) VALUES ('host', $1, $2, 'test')`,
      [tomb, randomUUID()],
    );
    const dt = await addDomain(b, tomb);
    const vt = (await start(b, dt, "dns_txt")).json();
    dns.records.set(`_scf-verify.${tomb}`, { txt: [[`scf-verify=${vt.token}`]] });
    expect((await runJob(vt.verification_id)).get(vt.verification_id)).toBe("HOST_TOMBSTONED");
    expect((await domainRow(b.tenant, dt)).state).toBe("unverified");
  });

  it("a pending token expires after 7 days; a new start supersedes the pending one", async () => {
    const d = await addDomain(b, `exp-${rnd()}.example`);
    const v1 = (await start(b, d, "dns_txt")).json();
    const v2 = (await start(b, d, "meta_tag")).json();
    expect((await check(b, d, v1.verification_id)).json().status).toBe("expired");
    await h.su.query(
      `UPDATE scf.domain_verifications SET expires_at = now() - interval '1 minute', created_at = now() - interval '8 days'
        WHERE verification_id = $1`,
      [v2.verification_id],
    );
    expect((await runJob(v2.verification_id)).get(v2.verification_id)).toBe("EXPIRED");
    expect((await check(b, d, v2.verification_id)).json().status).toBe("expired");
  });

  it("a verified domain that stops proving gets 14 days of grace, then lapses with its evidence", async () => {
    const c = await newCtx();
    const host = `lapse-${rnd()}.example`;
    const d = await addDomain(c, host);
    const v = (await start(c, d, "dns_txt")).json();
    dns.records.set(`_scf-verify.${host}`, { txt: [[`scf-verify=${v.token}`]] });
    expect((await runJob(v.verification_id)).get(v.verification_id)).toBe("OK");
    expect(await level(c)).toBe("L1");

    dns.records.set(`_scf-verify.${host}`, { txt: [["something-else"]] });
    expect((await runJob(v.verification_id)).get(v.verification_id)).toBe("TOKEN_MISMATCH");
    const grace = await domainRow(c.tenant, d);
    expect(grace.state).toBe("verified");
    const graceDays = ((grace.grace_until as Date).getTime() - Date.now()) / 86_400_000;
    expect(graceDays).toBeGreaterThan(13.9);
    expect(await level(c)).toBe("L1");

    await h.su.query(
      `UPDATE scf.site_domains SET grace_until = now() - interval '1 minute' WHERE tenant_id = $1 AND domain_id = $2`,
      [c.tenant, d],
    );
    expect((await runJob(v.verification_id)).get(v.verification_id)).toBe("TOKEN_MISMATCH");
    expect((await domainRow(c.tenant, d)).state).toBe("lapsed");
    expect((await check(c, d, v.verification_id)).json().status).toBe("lapsed");
    expect(await level(c)).toBe("L0");
    expect(await auditActions(c.tenant, d)).toEqual(expect.arrayContaining(["domain.lapsed"]));
    const ev = await h.su.query(
      `SELECT status FROM scf.verification_evidence WHERE tenant_id = $1 AND subject = $2`,
      [c.tenant, host],
    );
    expect(ev.rows).toEqual([{ status: "lapsed" }]);
  });

  it("only one instance runs a pass at a time", async () => {
    const results = await Promise.all([
      h.jobsDb.tx(
        { tenantId: null, actorKind: "job", actorId: "t", job: "domain_verification" },
        async (tx) => {
          await tx.query(`SELECT pg_advisory_xact_lock($1)`, [0x5c_f0_d0_01]);
          return worker.runOnce();
        },
      ),
    ]);
    expect(results[0]).toBeNull();
  });

  it("foreign, unknown, mismatched and malformed identifiers are the same 404", async () => {
    const own = await addDomain(a, `own-${rnd()}.example`);
    const ownV = (await start(a, own, "dns_txt")).json().verification_id as string;
    const foreignD = await addDomain(b, `for-${rnd()}.example`);
    const foreignV = (await start(b, foreignD, "dns_txt")).json().verification_id as string;
    const otherSite = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${a.tenant}/sites`,
        cookie: a.cookie,
        body: { name: "T" },
      })
    ).json().site_id as string;

    const starts: Array<[string, string]> = [
      [a.site, foreignD],
      [a.site, randomUUID()],
      [a.site, "nope"],
      [otherSite, own], // the domain belongs to another site of the tenant
      [b.site, own],
    ];
    for (const [site, dom] of starts) {
      const r = await start(a, dom, "dns_txt", site);
      expect(r.statusCode, `${site}/${dom}`).toBe(404);
    }
    const checks: Array<[string, string, string]> = [
      [a.site, own, foreignV],
      [a.site, own, randomUUID()],
      [a.site, own, "nope"],
      [a.site, foreignD, foreignV],
      [otherSite, own, ownV],
    ];
    for (const [site, dom, ver] of checks) {
      const r = await check(a, dom, ver, site);
      expect(r.statusCode, `${site}/${dom}/${ver}`).toBe(404);
    }
    // As a stranger, the owner's ids are 404 too (not a member of tenant A).
    const r = await call(h, {
      method: "POST",
      url: `/v1/tenants/${a.tenant}/sites/${a.site}/domains/${own}/verifications/${ownV}/check`,
      cookie: b.cookie,
    });
    expect(r.statusCode).toBe(404);
    // Tenant B's verification is untouched.
    expect((await check(b, foreignD, foreignV)).json().status).toBe("pending");
  });

  it("an archived site cannot start a verification (400)", async () => {
    const c = await newCtx();
    const d = await addDomain(c, `arch-${rnd()}.example`);
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${c.tenant}/sites/${c.site}`,
          cookie: c.cookie,
        })
      ).statusCode,
    ).toBe(204);
    const r = await start(c, d, "dns_txt");
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("validation_failed");
  });

  it("logs contain no token, host body or resolved address", () => {
    expect(h.logs.text).not.toContain(PUBLIC_V4);
    expect(h.logs.text).not.toMatch(/scf-verify=/);
  });
});
