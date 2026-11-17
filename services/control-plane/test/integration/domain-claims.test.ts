// SPDX-License-Identifier: Apache-2.0
// Host claims and domain evidence across tenants (data-model §8.4, C-19): removing a domain lapses its evidence and frees the host; a lapsed domain frees the host; a second
// tenant proving a claimed host puts BOTH in `disputed`, and the operator's `keep` hands the host to exactly one tenant
// (never two `verified` declarations of one host in different tenants); a verification pass holds no transaction
// while it checks the network.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainVerifier } from "../../src/verify/verifier.ts";
import {
  DomainVerificationWorker,
  type Outcome,
  type WorkerLogger,
} from "../../src/verify/worker.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  operatorSession,
  signInGithub,
  startHarness,
} from "../support/harness.ts";
import { FakeDns, FakeHttps, makeTestPki, type TestPki } from "../support/verify/fake-net.ts";

let h: Harness;
let dns: FakeDns;
let https: FakeHttps;
let pki: TestPki;
let verifier: DomainVerifier;
let worker: DomainVerificationWorker;
const rnd = () => randomUUID().slice(0, 8);

interface Ctx {
  cookie: string;
  tenant: string;
  site: string;
}

async function newCtx(): Promise<Ctx> {
  const cookie = await signInGithub(h, newGithubUser());
  const tenant = await createTenant(h, cookie);
  return { cookie, tenant, site: await newSite({ cookie, tenant, site: "" }) };
}

async function newSite(c: Ctx): Promise<string> {
  const res = await call(h, {
    method: "POST",
    url: `/v1/tenants/${c.tenant}/sites`,
    cookie: c.cookie,
    body: { name: "S" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().site_id as string;
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

async function removeDomain(c: Ctx, domain: string, site = c.site): Promise<void> {
  const res = await call(h, {
    method: "DELETE",
    url: `/v1/tenants/${c.tenant}/sites/${site}/domains/${domain}`,
    cookie: c.cookie,
  });
  expect(res.statusCode, res.body).toBe(204);
}

/** Starts a DNS TXT verification, publishes its token and runs the job once; returns the outcome. */
async function verify(c: Ctx, domain: string, host: string, site = c.site) {
  const res = await call(h, {
    method: "POST",
    url: `/v1/tenants/${c.tenant}/sites/${site}/domains/${domain}/verifications`,
    cookie: c.cookie,
    body: { method: "dns_txt" },
  });
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json() as { verification_id: string; token: string };
  const prev = dns.records.get(`_scf-verify.${host}`);
  const txt = prev && typeof prev === "object" ? (prev.txt ?? []) : [];
  dns.records.set(`_scf-verify.${host}`, { txt: [...txt, [`scf-verify=${v.token}`]] });
  return {
    id: v.verification_id,
    outcome: (await runJob(v.verification_id)).get(v.verification_id),
  };
}

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

async function stateOf(tenant: string, domain: string): Promise<string | undefined> {
  return (
    await h.su.query<{ state: string }>(
      `SELECT state FROM scf.site_domains WHERE tenant_id = $1 AND domain_id = $2`,
      [tenant, domain],
    )
  ).rows[0]?.state;
}

async function claimOf(
  host: string,
): Promise<{ tenant_id: string; domain_id: string } | undefined> {
  return (
    await h.su.query<{ tenant_id: string; domain_id: string }>(
      `SELECT tenant_id::text, domain_id::text FROM scf.host_claims WHERE host = $1`,
      [host],
    )
  ).rows[0];
}

async function evidenceOf(tenant: string, host: string): Promise<string | undefined> {
  return (
    await h.su.query<{ status: string }>(
      `SELECT status FROM scf.verification_evidence WHERE tenant_id = $1 AND kind = 'domain' AND subject = $2`,
      [tenant, host],
    )
  ).rows[0]?.status;
}

async function tenantActions(tenant: string): Promise<string[]> {
  return (
    await h.su.query<{ action: string }>(
      `SELECT action FROM scf.audit_log WHERE tenant_id = $1 ORDER BY occurred_at, seq`,
      [tenant],
    )
  ).rows.map((r) => r.action);
}

/** Tenants holding the host `verified` (the edge snapshot's notion of verified traffic). */
async function verifiedTenants(host: string): Promise<string[]> {
  return (
    await h.su.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM scf.site_domains WHERE host = $1 AND state = 'verified'`,
      [host],
    )
  ).rows.map((r) => r.tenant_id);
}

async function lapse(c: Ctx, domain: string, verification: string, host: string): Promise<void> {
  dns.records.set(`_scf-verify.${host}`, { txt: [["something-else"]] });
  expect((await runJob(verification)).get(verification)).toBe("TOKEN_MISMATCH");
  await h.su.query(
    `UPDATE scf.site_domains SET grace_until = now() - interval '1 minute' WHERE tenant_id = $1 AND domain_id = $2`,
    [c.tenant, domain],
  );
  expect((await runJob(verification)).get(verification)).toBe("TOKEN_MISMATCH");
  expect(await stateOf(c.tenant, domain)).toBe("lapsed");
}

beforeAll(async () => {
  pki = makeTestPki(["tls-unused.example"]);
  dns = new FakeDns();
  await dns.start();
  https = new FakeHttps(pki, ["tls-unused.example"]);
  await https.start();
  h = await startHarness({}, { wakeVerifier: () => {} });
  verifier = new DomainVerifier({
    dnsServers: [dns.server],
    ca: pki.ca,
    timeoutMs: 2000,
    dial: () => ({ host: "127.0.0.1", port: https.port }),
  });
  worker = new DomainVerificationWorker(h.jobsDb, verifier, { intervalMs: 3_600_000 });
});
afterAll(async () => {
  await worker?.stop();
  await h?.close();
  await https?.stop();
  await dns?.stop();
  pki?.cleanup();
});

describe("removing a verified domain (#4)", () => {
  it("lapses the tenant's domain evidence, frees the host and lets another tenant verify it", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const host = `rm-${rnd()}.example`;
    const da = await addDomain(a, host);
    expect((await verify(a, da, host)).outcome).toBe("OK");
    expect(await evidenceOf(a.tenant, host)).toBe("valid");

    await removeDomain(a, da);
    expect(await evidenceOf(a.tenant, host)).toBe("lapsed");
    expect(await claimOf(host)).toBeUndefined();
    expect(await tenantActions(a.tenant)).toContain("verification.evidence_lapsed");
    const lvl = await call(h, { method: "GET", url: `/v1/tenants/${a.tenant}`, cookie: a.cookie });
    expect(lvl.json().verification_level).toBe("L0");

    const db = await addDomain(b, host);
    expect((await verify(b, db, host)).outcome).toBe("OK");
    expect(await verifiedTenants(host)).toEqual([b.tenant]);
    expect(await evidenceOf(b.tenant, host)).toBe("valid");
  });

  it("keeps the evidence and the claim while another site of the tenant still has the host verified", async () => {
    const a = await newCtx();
    const site2 = await newSite(a);
    const host = `rm2-${rnd()}.example`;
    const d1 = await addDomain(a, host);
    const d2 = await addDomain(a, host, site2);
    expect((await verify(a, d1, host)).outcome).toBe("OK");
    expect((await verify(a, d2, host, site2)).outcome).toBe("OK");

    await removeDomain(a, d1);
    expect(await evidenceOf(a.tenant, host)).toBe("valid");
    expect(await claimOf(host)).toEqual({ tenant_id: a.tenant, domain_id: d2 });
    expect(await tenantActions(a.tenant)).not.toContain("verification.evidence_lapsed");
  });

  it("does not leave the claim with an unverified declaration of the same tenant", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const site2 = await newSite(a);
    const host = `rm3-${rnd()}.example`;
    const d1 = await addDomain(a, host);
    await addDomain(a, host, site2); // declared, never verified
    expect((await verify(a, d1, host)).outcome).toBe("OK");

    await removeDomain(a, d1);
    expect(await claimOf(host)).toBeUndefined();
    expect(await evidenceOf(a.tenant, host)).toBe("lapsed");
    const db = await addDomain(b, host);
    expect((await verify(b, db, host)).outcome).toBe("OK");
  });
});

describe("a lapsed domain (#5)", () => {
  it("releases the host claim so the new owner of the domain can verify it", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const host = `lapse-${rnd()}.example`;
    const da = await addDomain(a, host);
    const va = await verify(a, da, host);
    expect(va.outcome).toBe("OK");
    await lapse(a, da, va.id, host);
    expect(await claimOf(host)).toBeUndefined();
    expect(await evidenceOf(a.tenant, host)).toBe("lapsed");

    const db = await addDomain(b, host);
    expect((await verify(b, db, host)).outcome).toBe("OK");
    expect(await claimOf(host)).toEqual({ tenant_id: b.tenant, domain_id: db });
    expect(await verifiedTenants(host)).toEqual([b.tenant]);
  });

  it("a claim still held by a lapsed declaration (written before this fix) does not block another tenant", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const host = `legacy-${rnd()}.example`;
    const da = await addDomain(a, host);
    expect((await verify(a, da, host)).outcome).toBe("OK");
    // the state an earlier release left behind: lapsed domain, claim kept (C-117 "a lapsed domain keeps its claim")
    // (the database's own claim release, migration 0069, did not exist then: bypass its triggers to rebuild that state)
    const legacy = await h.su.connect();
    try {
      await legacy.query("BEGIN");
      await legacy.query("SET LOCAL session_replication_role = replica");
      await legacy.query(
        `UPDATE scf.site_domains SET state = 'lapsed', lapsed_at = now() WHERE tenant_id = $1 AND domain_id = $2`,
        [a.tenant, da],
      );
      await legacy.query("COMMIT");
    } finally {
      legacy.release();
    }
    expect(await claimOf(host)).toMatchObject({ tenant_id: a.tenant });
    const db = await addDomain(b, host);
    expect((await verify(b, db, host)).outcome).toBe("OK");
    expect(await claimOf(host)).toEqual({ tenant_id: b.tenant, domain_id: db });
  });
});

describe("disputes (#6)", () => {
  it("a second tenant proving a claimed host puts both in dispute; `keep` hands the host to one tenant only", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const host = `dispute-${rnd()}.example`;
    const da = await addDomain(a, host);
    const va = await verify(a, da, host);
    expect(va.outcome).toBe("OK");
    const db = await addDomain(b, host);
    expect((await verify(b, db, host)).outcome).toBe("HOST_CLAIMED_ELSEWHERE");

    expect(await stateOf(b.tenant, db)).toBe("disputed");
    expect(await stateOf(a.tenant, da)).toBe("disputed");
    expect(await verifiedTenants(host)).toEqual([]);

    // A's daily re-check succeeds: the domain stays disputed until an operator decides.
    expect((await runJob(va.id)).get(va.id)).toBe("OK");
    expect(await stateOf(a.tenant, da)).toBe("disputed");
    expect(await verifiedTenants(host)).toEqual([]);

    const op = await operatorSession(h, "operator_admin");
    const keep = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${b.tenant}/domains/${db}/dispute-resolution`,
      cookie: op.cookie,
      body: { decision: "keep" },
    });
    expect(keep.statusCode, keep.body).toBe(204);
    expect(await stateOf(b.tenant, db)).toBe("verified");
    expect(await stateOf(a.tenant, da)).toBe("unverified");
    expect(await claimOf(host)).toEqual({ tenant_id: b.tenant, domain_id: db });
    expect(await verifiedTenants(host)).toEqual([b.tenant]);
    expect(await evidenceOf(b.tenant, host)).toBe("valid");
    expect(await evidenceOf(a.tenant, host)).toBe("lapsed");

    // A's next re-check cannot take the host back: its verification is closed and the domain stays unverified.
    expect((await worker.runOnce())?.get(va.id)).toBeUndefined();
    expect(await verifiedTenants(host)).toEqual([b.tenant]);
  });

  it("`release` leaves the host to the tenant that holds the claim", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const host = `release-${rnd()}.example`;
    const da = await addDomain(a, host);
    expect((await verify(a, da, host)).outcome).toBe("OK");
    const db = await addDomain(b, host);
    expect((await verify(b, db, host)).outcome).toBe("HOST_CLAIMED_ELSEWHERE");

    const op = await operatorSession(h, "operator_admin");
    const rel = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${b.tenant}/domains/${db}/dispute-resolution`,
      cookie: op.cookie,
      body: { decision: "release" },
    });
    expect(rel.statusCode, rel.body).toBe(204);
    expect(await stateOf(b.tenant, db)).toBe("unverified");
    expect(await stateOf(a.tenant, da)).toBe("verified");
    expect(await claimOf(host)).toEqual({ tenant_id: a.tenant, domain_id: da });
    expect(await verifiedTenants(host)).toEqual([a.tenant]);
  });
});

describe("a verification pass (#27)", () => {
  it("holds no transaction while it checks the network, and a second instance does not re-check its items", async () => {
    const a = await newCtx();
    const host = `pass-${rnd()}.example`;
    const da = await addDomain(a, host);
    const res = await call(h, {
      method: "POST",
      url: `/v1/tenants/${a.tenant}/sites/${a.site}/domains/${da}/verifications`,
      cookie: a.cookie,
      body: { method: "dns_txt" },
    });
    const v = res.json() as { verification_id: string; token: string };
    dns.records.set(`_scf-verify.${host}`, { txt: [[`scf-verify=${v.token}`]] });
    await h.su.query(
      `UPDATE scf.domain_verifications SET next_check_at = now() - interval '1 second' WHERE verification_id = $1`,
      [v.verification_id],
    );

    const second = new DomainVerificationWorker(h.jobsDb, verifier, { intervalMs: 3_600_000 });
    let idleInTx = -1;
    let inner: Map<string, Outcome> | null | undefined;
    let calls = 0;
    const log: WorkerLogger = { info: () => {}, error: () => {} };
    const probing = new DomainVerificationWorker(
      h.jobsDb,
      {
        verify: async (method, hst, token) => {
          calls++;
          if (hst === host) {
            idleInTx = Number(
              (
                await h.su.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM pg_stat_activity
                    WHERE usename = 'scf_jobs' AND state LIKE 'idle in transaction%'`,
                )
              ).rows[0]?.n,
            );
            inner = await second.runOnce();
          }
          return verifier.verify(method, hst, token);
        },
      },
      { intervalMs: 3_600_000, log },
    );
    const out = await probing.runOnce();
    expect(out?.get(v.verification_id)).toBe("OK");
    expect(calls).toBeGreaterThan(0);
    expect(idleInTx).toBe(0);
    // the second instance got the job lock (no transaction is held) but found the item already taken
    expect(inner).not.toBeNull();
    expect(inner?.has(v.verification_id)).toBe(false);
    expect(await stateOf(a.tenant, da)).toBe("verified");
    await second.stop();
    await probing.stop();
  });
});
