// SPDX-License-Identifier: Apache-2.0
// Tenant/site fixtures created through the real control-plane API (sign-in, tenant, sites, domains, settings), with
// two steps done as the database superuser because they cannot happen offline and are not what is under test:
//   - enrollment mode `open` (an SCF operator decision; the operator path needs a passkey ceremony), and
//   - marking the declared domains verified (DNS/HTTP verification needs a public DNS name — ADR-0015).
// Umami websites are provisioned by the control plane's own reconcile worker through the engine proxy, and the site
// reaches the gateway through the signed snapshot — both real. `waitForGateway` proves the latter.

import type { Compose } from "./compose.ts";
import { ControlPlane, type Site } from "./cp-client.ts";
import type { StackEnv } from "./env.ts";
import { browserHeaders, GatewayClient, type GatewayTarget } from "./gateway-client.ts";

export interface SiteSpec {
  key: string;
  host: string;
  verified?: boolean;
  anonymousReports?: boolean;
  opts?: Record<string, unknown>;
}

export interface FixtureSite extends Site {
  host: string;
  origin: string;
  /** Whether the fixture marked the domain verified (the gateway must see that before traffic is sent). */
  verified: boolean;
}

export interface Fixture {
  cp: ControlPlane;
  userId: string;
  tenantId: string;
  sites: Record<string, FixtureSite>;
}

export function gatewayTarget(env: StackEnv): GatewayTarget {
  return {
    url: env.gatewayUrl,
    servername: env.ingestHosts[0] as string,
    caFile: env.gatewayCaFile,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openEnrollment(compose: Compose): Promise<void> {
  await compose.sql(
    "scf",
    `UPDATE scf.settings SET value = '"open"'::jsonb WHERE key = 'enrollment_mode'`,
  );
}

export async function createFixture(
  env: StackEnv,
  compose: Compose,
  slug: string,
  specs: SiteSpec[],
): Promise<Fixture> {
  await openEnrollment(compose);
  const cp = new ControlPlane(env);
  const userId = await cp.signIn();
  const tenant = await cp.createTenant(slug);
  if (tenant.status !== "active") throw new Error(`tenant status ${tenant.status}, want active`);
  const sites: Record<string, FixtureSite> = {};
  for (const s of specs) {
    const site = await cp.createSite(tenant.tenant_id, s.key, s.opts ?? {});
    await cp.addDomain(tenant.tenant_id, site.site_id, s.host);
    if (s.anonymousReports === false)
      await cp.setAnonymousReports(tenant.tenant_id, site.site_id, false);
    sites[s.key] = {
      ...site,
      host: s.host,
      origin: `https://${s.host}`,
      verified: s.verified !== false,
    };
  }
  const verified = specs.filter((s) => s.verified !== false).map((s) => sites[s.key]?.site_id);
  if (verified.length > 0) {
    await compose.sql(
      "scf",
      `UPDATE scf.site_domains SET state = 'verified', verified_at = now()
        WHERE site_id IN (${verified.map((id) => `'${id}'`).join(",")}); NOTIFY scf_edge;`,
    );
  }
  return { cp, userId, tenantId: tenant.tenant_id, sites };
}

/**
 * Waits until every site is in the gateway's snapshot (challenge answered 200) and its Umami websites exist
 * (main website id set; a twin, which only identifier-free sites get, provisioned).
 */
export async function waitForGateway(
  env: StackEnv,
  compose: Compose,
  sites: FixtureSite[],
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const s of sites) {
    const gw = new GatewayClient(gatewayTarget(env), browserHeaders(s.origin));
    for (;;) {
      const provisioned = await compose.scalar(
        "scf",
        `SELECT count(*) FROM scf.sites WHERE site_id = '${s.site_id}' AND umami_website_id IS NOT NULL
            AND (umami_twin_website_id IS NULL OR twin_provisioned_at IS NOT NULL)`,
      );
      const ch = await gw.challenge(s.site_key, s.tracker_profile).catch(() => ({ status: 0 }));
      if (
        provisioned === "1" &&
        ch.status === 200 &&
        (!s.verified || (await snapshotVerified(compose, s)))
      )
        break;
      if (Date.now() > deadline)
        throw new Error(
          `site ${s.site_id} not ready: provisioned=${provisioned} challenge=${ch.status}`,
        );
      await sleep(1000);
    }
  }
}

/** Waits until `fn` returns true (polling), or throws with the last observed value. */
export async function eventually<T>(
  what: string,
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 60_000,
  everyMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    try {
      last = await fn();
      if (ok(last)) return last;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
    if (Date.now() > deadline)
      throw new Error(`${what}: timed out; last value ${JSON.stringify(last)?.slice(0, 600)}`);
    await sleep(everyMs);
  }
}

/** True when the gateway's current snapshot (its state volume) lists the site's domain as verified. */
/**
 * Sets a site's multiplicity mode (C-124) as the superuser and waits until the gateway's stored snapshot carries it.
 * The operator path (operatorSetSiteMultiplicityMode) needs an operator_admin passkey step-up, which a headless suite
 * cannot do; it is covered by the control plane's integration tests. Returns once the edge applies the mode.
 */
export async function setMultiplicityMode(
  compose: Compose,
  s: FixtureSite,
  mode: "enforce" | "shadow" | null,
  timeoutMs = 60_000,
): Promise<void> {
  if (mode !== null && mode !== "enforce" && mode !== "shadow") throw new Error(`bad mode ${mode}`);
  await compose.sql(
    "scf",
    `UPDATE scf.sites SET multiplicity_mode = ${mode === null ? "NULL" : `'${mode}'`}
      WHERE site_id = '${s.site_id}'; NOTIFY scf_edge;`,
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await snapshotSite(compose, s.site_id))?.multiplicity_mode === mode) return;
    if (Date.now() > deadline)
      throw new Error(`gateway snapshot has no multiplicity_mode=${mode} for ${s.site_id}`);
    await sleep(1000);
  }
}

/** The site's entry in the gateway's stored snapshot (volume `gwstate`), or undefined. */
async function snapshotSite(
  compose: Compose,
  siteId: string,
): Promise<{ multiplicity_mode?: string | null } | undefined> {
  try {
    const env = JSON.parse(await compose.volumeFile("gwstate", "snapshot.json")) as {
      payload: string;
    };
    const p = JSON.parse(Buffer.from(env.payload, "base64url").toString("utf8")) as {
      sites?: { site_id: string; multiplicity_mode?: string | null }[];
    };
    return p.sites?.find((x) => x.site_id === siteId);
  } catch {
    return undefined;
  }
}

async function snapshotVerified(compose: Compose, s: FixtureSite): Promise<boolean> {
  try {
    const env = JSON.parse(await compose.volumeFile("gwstate", "snapshot.json")) as {
      payload: string;
    };
    const p = JSON.parse(Buffer.from(env.payload, "base64url").toString("utf8")) as {
      sites?: { site_id: string; domains?: { host: string; verified: boolean }[] }[];
    };
    const site = p.sites?.find((x) => x.site_id === s.site_id);
    return !!site?.domains?.some((d) => d.host === s.host && d.verified);
  } catch {
    return false;
  }
}
