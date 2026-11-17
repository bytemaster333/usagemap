// SPDX-License-Identifier: Apache-2.0
// Control-plane API client for the suites: signs in like a tenant user (SEP-53 with a real Ed25519 test wallet; the
// stack's stand-in Horizon answers "unfunded account", so the master key alone is enough), sends the CSRF pair the
// portal sends (Origin = portal origin, X-SCF-Request: 1), and wraps the operations the suites use.

import type { StackEnv } from "./env.ts";
import { type Res, request } from "./http.ts";
import { TestWallet } from "./stellar.ts";

export class ApiError extends Error {
  readonly op: string;
  readonly res: Res;
  constructor(op: string, res: Res) {
    super(`${op}: ${res.status} ${res.body.slice(0, 400)}`);
    this.op = op;
    this.res = res;
  }
}

export interface Site {
  site_id: string;
  site_key: string;
  tracker_profile: string;
  [k: string]: unknown;
}

export class ControlPlane {
  cookie = "";
  readonly wallet = new TestWallet();

  readonly env: StackEnv;
  constructor(env: StackEnv) {
    this.env = env;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    expect: number[] = [200, 201, 204],
  ): Promise<Res> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== "GET") {
      headers.origin = this.env.portalUrl;
      headers["x-scf-request"] = "1";
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await request(`${this.env.controlPlaneUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 30_000,
    });
    if (!expect.includes(res.status)) throw new ApiError(`${method} ${path}`, res);
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown, expect?: number[]): Promise<T> {
    const r = await this.call(method, path, body, expect);
    return (r.body ? JSON.parse(r.body) : undefined) as T;
  }

  /** SEP-53 sign-in; keeps the session cookie. Returns the user id. */
  async signIn(): Promise<string> {
    const ch = await this.json<{ challenge_id: string; message: string }>(
      "POST",
      "/v1/auth/stellar/challenge",
      { account: this.wallet.account, method: "sep53" },
    );
    const res = await this.call("POST", "/v1/auth/stellar/verify", {
      challenge_id: ch.challenge_id,
      signature: this.wallet.signMessage(ch.message),
    });
    const set = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const c = set.find(
      (s) => s.startsWith("__Host-scf_session=") && !s.startsWith("__Host-scf_session=;"),
    );
    if (!c) throw new Error("sign-in: no session cookie");
    this.cookie = c.split(";")[0] as string;
    return (JSON.parse(res.body) as { user_id: string }).user_id;
  }

  async createTenant(slug: string): Promise<{ tenant_id: string; status: string }> {
    return this.json("POST", "/v1/tenants", { slug, name: `e2e ${slug}` });
  }

  async createSite(
    tenantId: string,
    name: string,
    opts: Record<string, unknown> = {},
  ): Promise<Site> {
    return this.json("POST", `/v1/tenants/${tenantId}/sites`, { name, ...opts });
  }

  async getSite(tenantId: string, siteId: string): Promise<Site> {
    return this.json("GET", `/v1/tenants/${tenantId}/sites/${siteId}`);
  }

  async addDomain(tenantId: string, siteId: string, host: string): Promise<{ domain_id: string }> {
    return this.json("POST", `/v1/tenants/${tenantId}/sites/${siteId}/domains`, { host });
  }

  async setAnonymousReports(tenantId: string, siteId: string, on: boolean): Promise<void> {
    await this.call("PUT", `/v1/tenants/${tenantId}/sites/${siteId}/anonymous-reports`, {
      anonymous_reports: on,
    });
  }

  webStats(tenantId: string, siteId: string, q = "range=24h"): Promise<WebStats> {
    return this.json("GET", `/v1/tenants/${tenantId}/sites/${siteId}/web/stats?${q}`);
  }

  webBreakdown(
    tenantId: string,
    siteId: string,
    dimension: string,
    q = "range=24h&variant=verified",
  ): Promise<WebBreakdown> {
    return this.json(
      "GET",
      `/v1/tenants/${tenantId}/sites/${siteId}/web/breakdown?dimension=${dimension}&limit=100&${q}`,
    );
  }

  installation(tenantId: string, siteId: string): Promise<InstallationCheck> {
    return this.json("GET", `/v1/tenants/${tenantId}/sites/${siteId}/installation?range=24h`);
  }
}

export interface WebTotals {
  pageviews: number;
  pageviews_unidentified?: number;
  visitors: number;
}
export interface WebStats {
  range: { start: string; end: string; source: string; anonymized?: boolean };
  verified?: WebTotals;
  raw?: WebTotals;
  visit_metrics: {
    visits: number;
    bounces: number;
    bounce_rate_pct: number | null;
    avg_visit_duration_s: number | null;
    suspect_pageview_share: number | null;
  };
}
export interface BreakdownRow {
  value: string;
  is_other: boolean;
  visitors: number | null;
  pageviews: number | null;
  events: number | null;
}
export interface WebBreakdown {
  dimension: string;
  verified?: BreakdownRow[];
  raw?: BreakdownRow[];
}
export interface InstallationCheck {
  verdicts: { verified: number; suspect: number; rejected: number };
  reasons: { code: string; verdict: string; count: number }[];
  drops?: { label: string; count: number }[];
  tracker_version_seen?: string | null;
  /** C-129: the version seen is below the newest active release */
  outdated_tracker?: boolean;
  /** C-124: effective multiplicity mode and the events left unchanged in shadow mode */
  multiplicity: { mode: "enforce" | "shadow"; source: "site" | "platform"; high_shadow: number };
}

/** Count of a reason code in an installation check (0 when absent). */
export function reasonCount(c: InstallationCheck, code: string): number {
  return c.reasons.filter((r) => r.code === code).reduce((a, r) => a + r.count, 0);
}
