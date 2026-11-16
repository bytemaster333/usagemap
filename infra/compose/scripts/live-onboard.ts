// SPDX-License-Identifier: Apache-2.0
// Onboards the operator's OWN project on a deployed stack through the public API, exactly as a tenant would
// (docs/guides/tenant-onboarding.md): SEP-53 sign-in with the operator's key, tenant, sites, declared domains verified
// by DNS TXT records at the DNS provider (Cloudflare API), an API service and an ingest token. Idempotent: what exists
// is reused. Used for dogfooding (the landing page measures itself), the canary site of the probes and the OTLP smoke.
// No demo or fake project is created here — tools/demo-seed refuses deployed stacks on purpose.
//
//   node infra/compose/scripts/live-onboard.ts --portal https://app.usagemap.dev --phrase-file <secret file> \
//     --cf-token-file <file> --cf-zone <zone id> --canary-host app.usagemap.dev [--journey-seed-file <file>] --out <dir>
//
// Plan (fixed): tenant `usagemap` "UsageMap"; site "usagemap.dev" (strict profile) with domain usagemap.dev; site
// "canary" (strict profile) with domain --canary-host (the probes' page origin = the portal host; probe traffic only);
// API services `smoke-remote` and `scf-probe`, each with an ingest token limited to it; with --journey-seed-file, the
// synthetic journey member (C-93, the seed the stack's probe signs in with) joins the tenant as `viewer` through an
// invitation, as a colleague would. Writes <out>/onboard.json (ids and public site keys, no secret) and
// <out>/ingest-token (0600, the token — shown once by the API).

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, HttpError } from "../../../tools/demo-seed/src/api.ts";
import {
  decodeStrKey,
  demoKey,
  encodeStrKey,
  VERSION,
} from "../../../tools/demo-seed/src/stellar.ts";

const { values } = parseArgs({
  options: {
    portal: { type: "string" },
    "phrase-file": { type: "string" },
    "cf-token-file": { type: "string" },
    "cf-zone": { type: "string" },
    "canary-host": { type: "string" },
    "journey-seed-file": { type: "string" },
    out: { type: "string" },
  },
});
const need = (k: keyof typeof values): string => {
  const v = values[k];
  if (!v) {
    process.stderr.write(`--${k} is required\n`);
    process.exit(2);
  }
  return v;
};
const portal = need("portal");
const phrase = readFileSync(need("phrase-file"), "utf8").trim();
if (phrase.length < 32) throw new Error("the owner phrase must have at least 32 characters");
const cfToken = readFileSync(need("cf-token-file"), "utf8").trim();
const cfZone = need("cf-zone");
const out = need("out");
const canaryHost = need("canary-host");

/** A signer from an S… secret seed (StrKey version 18 << 3), for the journey member. */
function seedKey(seedStr: string) {
  const { version, payload } = decodeStrKey(seedStr);
  if (version !== 18 << 3) throw new Error("not a Stellar secret seed");
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), payload]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return {
    account: encodeStrKey(VERSION.account, Buffer.from(jwk.x, "base64url")),
    privateKey,
    signMessage: (m: string) =>
      sign(
        null,
        createHash("sha256").update(`Stellar Signed Message:\n${m}`, "utf8").digest(),
        privateKey,
      ).toString("base64"),
  };
}

const key = demoKey(phrase, "usagemap-owner"); // the operator's own key (secret phrase), never a demo phrase
const api = new ApiClient(portal);
const log = (m: string) => process.stdout.write(`${m}\n`);

interface Tenant {
  tenant_id: string;
  slug: string;
}
interface Domain {
  domain_id: string;
  host: string;
  state?: string;
  verified_at?: string | null;
}
interface Site {
  site_id: string;
  site_key: string;
  name: string;
  domains?: Domain[];
}
interface Verification {
  verification_id: string;
  status: string;
  token: string;
  instructions?: unknown;
}
const list = <T>(r: unknown): T[] =>
  Array.isArray(r)
    ? (r as T[])
    : ((r as { items?: T[]; data?: T[] }).items ?? (r as { data?: T[] }).data ?? []);

async function cf(method: string, path: string, body?: unknown): Promise<{ result: unknown }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZone}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json()) as { success: boolean; result: unknown; errors: unknown };
  if (!j.success) throw new Error(`cloudflare ${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j;
}

async function ensureTxt(name: string, content: string): Promise<void> {
  const r = (await cf("GET", `/dns_records?type=TXT&name=${encodeURIComponent(name)}`)).result as {
    id: string;
    content: string;
  }[];
  for (const rec of r)
    if (rec.content.replace(/^"|"$/g, "") !== content) await cf("DELETE", `/dns_records/${rec.id}`);
  if (!r.some((rec) => rec.content.replace(/^"|"$/g, "") === content))
    await cf("POST", "/dns_records", {
      type: "TXT",
      name,
      content,
      ttl: 60,
      comment: "usagemap domain verification",
    });
}

async function main(): Promise<void> {
  await api.signIn(key);
  log(`signed in as ${key.account}`);

  let tenant = list<Tenant>(await api.call("GET", "/v1/me/tenants")).find(
    (t) => t.slug === "usagemap",
  );
  if (!tenant) {
    tenant = await api.call<Tenant>("POST", "/v1/tenants", {
      slug: "usagemap",
      name: "UsageMap",
      description:
        "The operator's own project: the usagemap.dev site measured by its own tracker, and the canary site of the probes.",
    });
    log(`tenant created ${tenant.tenant_id}`);
  }
  const T = `/v1/tenants/${tenant.tenant_id}`;

  const sites: Record<string, Site> = {};
  for (const [name, host] of [
    ["usagemap.dev", "usagemap.dev"],
    ["canary", canaryHost],
  ] as const) {
    let site = list<Site>(await api.call("GET", `${T}/sites`)).find((s) => s.name === name);
    if (!site) {
      site = await api.call<Site>("POST", `${T}/sites`, {
        name,
        tracker_profile: "strict",
        visitor_id: "off",
      });
      log(`site created ${name} ${site.site_id}`);
    }
    const S = `${T}/sites/${site.site_id}`;
    let dom = list<Domain>(await api.call("GET", `${S}/domains`)).find((d) => d.host === host);
    if (!dom)
      dom = await api.call<Domain>("POST", `${S}/domains`, { host, include_subdomains: false });
    if (dom.state !== "verified" && !dom.verified_at) {
      const v = await api.call<Verification>(
        "POST",
        `${S}/domains/${dom.domain_id}/verifications`,
        { method: "dns_txt" },
      );
      await ensureTxt(`_scf-verify.${host}`, `scf-verify=${v.token}`);
      let ok = false;
      for (let i = 0; i < 20 && !ok; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        try {
          const c = await api.call<Verification>(
            "POST",
            `${S}/domains/${dom.domain_id}/verifications/${v.verification_id}/check`,
          );
          ok = c.status === "verified";
          log(`verification ${host}: ${c.status}`);
        } catch (e) {
          log(`verification ${host}: ${e instanceof HttpError ? e.message : String(e)}`);
        }
      }
      if (!ok) throw new Error(`domain ${host} not verified`);
    }
    sites[name] = (await api.call<Site>("GET", S)) ?? site;
  }

  // Two API services, each with an ingest token limited to it: `smoke-remote` (the remote smoke test) and `scf-probe`
  // (the probes' OTLP canary, ops/internal/probes). Tokens are shown once by the API and written 0600.
  const services = list<{ service_name: string; service_id: string }>(
    await api.call("GET", `${T}/services`),
  );
  for (const [svcName, display, file] of [
    ["smoke-remote", "Live smoke test (OTLP)", "ingest-token"],
    ["scf-probe", "Probe OTLP canary", "probe-otlp-token"],
  ] as const) {
    if (!services.some((s) => s.service_name === svcName))
      await api.call("POST", `${T}/services`, { service_name: svcName, display_name: display });
    const tokenFile = join(out, file);
    if (existsSync(tokenFile)) continue;
    const tok = await api.call<Record<string, unknown>>("POST", `${T}/ingest-tokens`, {
      label: svcName,
      allowed_service_names: [svcName],
    });
    const secret = tok.token;
    if (typeof secret !== "string" || !/^scfa_ing_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/.test(secret))
      throw new Error("the ingest token response carries no token (IngestTokenCreated.token)");
    writeFileSync(tokenFile, `${secret}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    log(`ingest token for ${svcName} written`);
  }
  let journeyAccount: string | null = null;
  if (values["journey-seed-file"]) {
    const jk = seedKey(readFileSync(values["journey-seed-file"], "utf8").trim());
    journeyAccount = jk.account;
    const member = new ApiClient(portal);
    await member.signIn(jk as Parameters<ApiClient["signIn"]>[0]);
    const mine = list<Tenant>(await member.call("GET", "/v1/me/tenants"));
    if (!mine.some((t) => t.tenant_id === tenant.tenant_id)) {
      const inv = await api.call<{ code: string }>("POST", `${T}/invitations`, {
        role: "viewer",
        note: "synthetic journey member of the probes (C-93)",
        expires_in_hours: 1,
      });
      await member.call("POST", "/v1/invitations/accept", { code: inv.code });
      log(`journey member ${jk.account} joined as viewer`);
    }
  }
  const summary = {
    journey_account: journeyAccount,
    account: key.account,
    tenant_id: tenant.tenant_id,
    sites: Object.fromEntries(
      Object.entries(sites).map(([n, s]) => [n, { site_id: s.site_id, site_key: s.site_key }]),
    ),
  };
  writeFileSync(join(out, "onboard.json"), `${JSON.stringify(summary, null, 2)}\n`);
  log(JSON.stringify(summary));
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
