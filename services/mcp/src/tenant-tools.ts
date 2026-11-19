// SPDX-License-Identifier: Apache-2.0
// The read-only tools of a TENANT OAuth grant (hosted only): one project's own analytics, read with the delegated
// control-plane token through the tenant API a viewer of that project uses in the portal
// (docs/api/control-plane.openapi.yaml; the control plane allows a delegated token only the GET operations of
// services/control-plane/src/oauth/principal.ts OAUTH_TENANT_READ_OPS, and only for the grant's tenant). The tenant id
// is never an input: every path is built from the grant, so a tool cannot even name another project. Site and service
// ids are path segments validated as UUIDs; the control plane answers 404 for any id that is not the tenant's.

import { ApiClient, ApiError, UUID_RE } from "../../../tools/mcp/src/api.ts";
import type { ServerSpec, ToolDef, ToolResult } from "../../../tools/mcp/src/protocol.ts";

export interface TenantToolsConfig {
  baseUrl: string;
  token: string;
  tenantId: string;
  /** Called when the control plane refuses the delegated token (grant revoked): the caller drops its cache. */
  onUnauthorized?: (() => void) | undefined;
  fetch?: typeof fetch | undefined;
  allowInsecureHttp?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  userAgent?: string | undefined;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const RANGE = {
  type: "string",
  enum: ["24h", "7d", "30d", "90d", "12m", "all"],
  default: "30d",
  description: "time range ending now",
};
const SITE_ID = { type: "string", format: "uuid", description: "a site id from project_overview" };
const SERVICE_ID = {
  type: "string",
  format: "uuid",
  description: "an API service id from project_overview",
};
const DAY = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const TENANT_TOOLS: ToolDef[] = [
  {
    name: "project_overview",
    title: "Project overview",
    description:
      "The project this connection was granted for: its record, verification level and evidence, websites (site ids) and API services (service ids). Start here.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "web_stats",
    title: "Website summary",
    description:
      "Page views, unique visitors, visits, bounce rate and visit duration of one website. variant=verified counts only events that passed the anti-inflation checks; raw counts all; both returns both.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["site_id"],
      properties: {
        site_id: SITE_ID,
        range: RANGE,
        variant: { type: "string", enum: ["verified", "raw", "both"], default: "both" },
        compare: { type: "string", enum: ["none", "previous"], default: "none" },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "web_timeseries",
    title: "Website time series",
    description:
      "Page views, visitors and visits of one website over time (hour, day or month buckets).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["site_id"],
      properties: {
        site_id: SITE_ID,
        range: RANGE,
        variant: { type: "string", enum: ["verified", "raw", "both"], default: "verified" },
        unit: { type: "string", enum: ["hour", "day", "month"] },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "web_breakdown",
    title: "Website breakdown",
    description:
      "Top values of one dimension of a website's traffic: referrer, country, device, browser, os, path or event. Small counts are suppressed and figures rounded by the platform's privacy rules.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["site_id", "dimension"],
      properties: {
        site_id: SITE_ID,
        dimension: {
          type: "string",
          enum: ["referrer", "country", "device", "browser", "os", "path", "event"],
        },
        range: RANGE,
        variant: { type: "string", enum: ["verified", "raw", "both"], default: "verified" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "wallet_funnel",
    title: "Wallet funnel",
    description:
      "Stellar wallet funnel of one website (connect attempts, connections, failures, transactions signed and submitted) by wallet type, over UTC days.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["site_id"],
      properties: {
        site_id: SITE_ID,
        start: { ...DAY, description: "first UTC day (default 28 days before end)" },
        end: { ...DAY, description: "UTC day after the last day (default today)" },
        network: {
          type: "string",
          enum: ["mainnet", "testnet", "futurenet", "local", "all"],
          default: "mainnet",
        },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "api_summary",
    title: "API summary",
    description:
      "Request volume, status classes, error rate and latency percentiles of one API service, with its top routes (normalised: identifiers and Stellar addresses replaced by placeholders). API figures are self-attested telemetry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["service_id"],
      properties: {
        service_id: SERVICE_ID,
        range: RANGE,
        top_routes: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "api_stellar_surfaces",
    title: "Stellar surfaces of an API",
    description:
      "Requests of one API service grouped by Stellar surface (Horizon resources, Stellar RPC methods, SEP endpoints), and the service's own calls to Stellar RPC and Horizon when the SDK hook reports them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["service_id"],
      properties: { service_id: SERVICE_ID, range: RANGE },
    },
    annotations: READ_ONLY,
  },
  {
    name: "trust_scores",
    title: "Website trust scores",
    description:
      "Advisory daily trust scores of one website with reason codes and explanations (not counts).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["site_id"],
      properties: {
        site_id: SITE_ID,
        start: { ...DAY, description: "first UTC day (default 28 days before end)" },
        end: { ...DAY, description: "UTC day after the last day (default today)" },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "traction_snapshots",
    title: "Signed traction snapshots",
    description:
      "The project's signed traction snapshots (SCF evidence links) with their status and verify URLs.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: READ_ONLY,
  },
];

class InputError extends Error {}

function text(summary: string, data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function id(a: Record<string, unknown>, name: string): string {
  const v = a[name];
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new InputError(`${name} must be a UUID`);
  return v.toLowerCase();
}

function oneOf<T extends string>(
  a: Record<string, unknown>,
  name: string,
  values: readonly T[],
  d?: T,
): T | undefined {
  const v = a[name];
  if (v === undefined || v === null) return d;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v))
    throw new InputError(`${name} must be one of ${values.join(", ")}`);
  return v as T;
}

function int(
  a: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  d: number,
): number {
  const v = a[name];
  if (v === undefined || v === null) return d;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new InputError(`${name} must be an integer between ${min} and ${max}`);
  return v;
}

const RANGES = ["24h", "7d", "30d", "90d", "12m", "all"] as const;
const VARIANTS = ["verified", "raw", "both"] as const;

/** UTC day window [start, end) as RFC 3339 midnights; default the last 28 days. */
function days(a: Record<string, unknown>): { start: string; end: string } {
  const read = (n: string) => {
    const v = a[n];
    if (v === undefined || v === null) return undefined;
    if (
      typeof v !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    )
      throw new InputError(`${n} must be a UTC day YYYY-MM-DD`);
    return v;
  };
  const today = new Date().toISOString().slice(0, 10);
  const end =
    read("end") ??
    new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const start =
    read("start") ??
    new Date(Date.parse(`${end}T00:00:00Z`) - 28 * 86_400_000).toISOString().slice(0, 10);
  if (start >= end) throw new InputError("start must be before end");
  return { start: `${start}T00:00:00Z`, end: `${end}T00:00:00Z` };
}

export function createTenantSpec(cfg: TenantToolsConfig, version: string): ServerSpec {
  const api = new ApiClient({
    baseUrl: cfg.baseUrl,
    key: cfg.token,
    fetch: cfg.fetch,
    userAgent: cfg.userAgent ?? "usagemap-mcp-hosted/1",
    allowInsecureHttp: cfg.allowInsecureHttp,
    headers: cfg.headers,
    signal: cfg.signal,
    timeoutMs: 30_000,
  });
  const t = `/v1/tenants/${cfg.tenantId}`;

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<ToolResult>> = {
    async project_overview() {
      const [tenant, sites, services, verification] = await Promise.all([
        api.get<Record<string, unknown>>(t),
        api.get<unknown>(`${t}/sites`),
        api.get<unknown>(`${t}/services`),
        api.get<unknown>(`${t}/verification`),
      ]);
      return text(`Project ${String(tenant.name ?? tenant.slug ?? "")}.`, {
        tenant,
        sites,
        services,
        verification,
      });
    },
    async web_stats(a) {
      const site = id(a, "site_id");
      const r = await api.get<unknown>(`${t}/sites/${site}/web/stats`, {
        range: oneOf(a, "range", RANGES, "30d"),
        variant: oneOf(a, "variant", VARIANTS, "both"),
        compare: oneOf(a, "compare", ["none", "previous"] as const, "none"),
      });
      return text("Website summary.", r);
    },
    async web_timeseries(a) {
      const site = id(a, "site_id");
      const r = await api.get<unknown>(`${t}/sites/${site}/web/timeseries`, {
        range: oneOf(a, "range", RANGES, "30d"),
        variant: oneOf(a, "variant", VARIANTS, "verified"),
        unit: oneOf(a, "unit", ["hour", "day", "month"] as const),
      });
      return text("Website time series.", r);
    },
    async web_breakdown(a) {
      const site = id(a, "site_id");
      const dimension = oneOf(a, "dimension", [
        "referrer",
        "country",
        "device",
        "browser",
        "os",
        "path",
        "event",
      ] as const);
      if (!dimension) throw new InputError("dimension is required");
      const r = await api.get<unknown>(`${t}/sites/${site}/web/breakdown`, {
        range: oneOf(a, "range", RANGES, "30d"),
        variant: oneOf(a, "variant", VARIANTS, "verified"),
        dimension,
        limit: int(a, "limit", 1, 100, 20),
      });
      return text(`Website breakdown by ${dimension}.`, r);
    },
    async wallet_funnel(a) {
      const site = id(a, "site_id");
      const { start, end } = days(a);
      const r = await api.get<unknown>(`${t}/sites/${site}/web/wallet-funnel`, {
        start,
        end,
        network: oneOf(
          a,
          "network",
          ["mainnet", "testnet", "futurenet", "local", "all"] as const,
          "mainnet",
        ),
      });
      return text(`Wallet funnel ${start} – ${end} (end exclusive).`, r);
    },
    async api_summary(a) {
      const svc = id(a, "service_id");
      const range = oneOf(a, "range", RANGES, "30d");
      const [summary, routes] = await Promise.all([
        api.get<unknown>(`${t}/services/${svc}/api/summary`, { range }),
        api.get<unknown>(`${t}/services/${svc}/api/routes`, {
          range,
          sort: "-requests",
          limit: int(a, "top_routes", 1, 200, 20),
        }),
      ]);
      return text("API summary (self-attested telemetry).", { summary, top_routes: routes });
    },
    async api_stellar_surfaces(a) {
      const svc = id(a, "service_id");
      const range = oneOf(a, "range", RANGES, "30d");
      const [surfaces, client] = await Promise.all([
        api.get<unknown>(`${t}/services/${svc}/api/surfaces`, { range }),
        api.get<unknown>(`${t}/services/${svc}/stellar-client`, { range }).catch((e) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }),
      ]);
      return text("Stellar surfaces of the API.", { surfaces, stellar_client: client });
    },
    async trust_scores(a) {
      const site = id(a, "site_id");
      const { start, end } = days(a);
      const r = await api.get<unknown>(`${t}/sites/${site}/trust-scores`, { start, end });
      return text("Advisory trust scores (not counts).", r);
    },
    async traction_snapshots() {
      return text("Signed traction snapshots.", await api.get<unknown>(`${t}/traction-snapshots`));
    },
  };

  return {
    name: "usagemap-mcp",
    version,
    instructions: `Read-only access to one UsageMap project: its websites' traffic (verified = passed the anti-inflation checks), wallet funnel, API usage (self-attested telemetry) and trust scores (advisory). Call project_overview first to learn the site and service ids.`,
    tools: TENANT_TOOLS,
    async call(name, args) {
      const h = handlers[name];
      if (!h) return failure(`unknown tool ${name}`);
      try {
        return await h(args);
      } catch (e) {
        if (e instanceof InputError) return failure(`invalid input: ${e.message}`);
        if (e instanceof ApiError && e.status === 401) cfg.onUnauthorized?.();
        if (e instanceof ApiError)
          return failure(
            e.status === 404
              ? "not found (404): the id does not belong to this project"
              : e.status === 401
                ? "the authorization has expired or was revoked (401): reconnect the app"
                : e.status === 403
                  ? "not available with this connection (403)"
                  : e.message,
          );
        throw e;
      }
    },
  };
}
