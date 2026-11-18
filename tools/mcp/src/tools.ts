// SPDX-License-Identifier: Apache-2.0
// The read-only tools of the UsageMap MCP server (plan E8), each a thin wrapper over one or a few documented API
// operations (docs/api/operator-metrics.openapi.yaml; the public metrics document of wire-formats §i.1). Nothing here
// writes: the operator API is GET-only and the keys are read-only by design (scopes `registry:read`, `web:read`,
// `api:read`; share keys read one project's public document).

import { ApiClient, ApiError, dayStart, lastDays, redact, UUID_RE } from "./api.ts";
import type { ServerSpec, ToolDef, ToolResult } from "./protocol.ts";

export interface McpConfig {
  baseUrl: string;
  operatorKey?: string | undefined;
  shareKey?: string | undefined;
  fetch?: typeof fetch | undefined;
  now?: () => Date;
  /**
   * `local` (stdio, default): every tool is listed and a missing key is explained in terms of the server's environment.
   * `hosted` (services/mcp, one spec per HTTP request): only the tools the caller's key can use are listed and callable
   * — an operator key by its scopes (`scopes`, from `/op/v1/me`), a share key the public metrics document only.
   */
  mode?: "local" | "hosted";
  /** Scopes of the operator key (hosted mode). */
  scopes?: readonly string[] | undefined;
  /** Passed to the API client (hosted mode: internal http address, forwarded client address, cancellation). */
  allowInsecureHttp?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  userAgent?: string | undefined;
}

/**
 * What each tool needs (hosted mode lists a tool only when the key has it): `op` = operator-key scopes, all required
 * (`null`: not an operator tool); `pub` = usable with a tenant share key. Scopes are those of
 * docs/api/operator-metrics.openapi.yaml; the control plane enforces them again on every call.
 */
export const TOOL_ACCESS: Record<string, { op: readonly string[] | null; pub: boolean }> = {
  list_projects: { op: ["registry:read"], pub: false },
  web_summary: { op: ["web:read"], pub: false },
  api_routes_summary: { op: ["api:read"], pub: false },
  trust_flags: { op: ["web:read"], pub: false },
  evidence_pack: { op: ["registry:read", "web:read", "api:read"], pub: false },
  project_metrics_document: { op: ["web:read", "api:read"], pub: true },
  evidence_links: { op: [], pub: true },
};

/** The tools a key may use in hosted mode. */
export function toolsFor(key: {
  kind: "op" | "pub";
  scopes?: readonly string[] | undefined;
}): ToolDef[] {
  return TOOLS.filter((t) => {
    const a = TOOL_ACCESS[t.name];
    if (!a) return false;
    if (key.kind === "pub") return a.pub;
    return a.op?.every((s) => key.scopes?.includes(s));
  });
}

const RANGE_PROPS = {
  start: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "first UTC day, inclusive (YYYY-MM-DD); default 28 days before end",
  },
  end: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "UTC day after the last day, exclusive (YYYY-MM-DD); default today",
  },
};
const PROJECT_IDS = {
  type: "array",
  items: { type: "string", format: "uuid" },
  maxItems: 500,
  description: "restrict to these project ids (default: every project the key may read)",
};
const MIN_LEVEL = {
  type: "string",
  enum: ["L0", "L1", "L2", "L3"],
  description: "lowest verification level included (API default L1; L0 = unverified projects too)",
};
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_projects",
    title: "List projects",
    description:
      "Projects (tenants) on UsageMap with verification level, SCF award linkage, number of sites and services, and the URL of each project's public metrics document. Needs an operator key with registry:read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 100, description: "filter by name or slug" },
        min_level: MIN_LEVEL,
        scf_awarded: {
          type: "boolean",
          description: "only projects with (true) or without (false) an SCF award",
        },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "web_summary",
    title: "Web summary",
    description:
      "Per-project web totals over a date range: page views, unique visitors (sum of per-site daily uniques), visits, bounce rate, average visit duration and the suspect share. variant=verified (default) counts only events that passed the anti-inflation checks; raw counts all. Needs web:read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...RANGE_PROPS,
        project_ids: PROJECT_IDS,
        variant: { type: "string", enum: ["verified", "raw"], default: "verified" },
        min_level: MIN_LEVEL,
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "api_routes_summary",
    title: "API routes summary",
    description:
      "API usage over a date range grouped by route (default), service or project: request counts, status classes, 5xx error rate, latency percentiles. Routes are normalised (identifiers, Stellar addresses and secrets replaced by placeholders). API figures are self-attested telemetry. Needs api:read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...RANGE_PROPS,
        project_ids: PROJECT_IDS,
        group: { type: "string", enum: ["route", "service", "project"], default: "route" },
        min_level: MIN_LEVEL,
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "trust_flags",
    title: "Trust scores and flags",
    description:
      "Advisory daily web trust scores with their reason codes, the verdict and reason counters of the anti-inflation layer (verified / suspect / rejected and why), and the API assurance level per service. Needs web:read (and api:read for the API part).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...RANGE_PROPS, project_ids: PROJECT_IDS, min_level: MIN_LEVEL },
    },
    annotations: READ_ONLY,
  },
  {
    name: "evidence_pack",
    title: "Evidence pack for one project",
    description:
      "Everything you need to know about one project over a date range, in one answer: the project record, verified and raw web totals, verdict counters, API totals and top routes, trust and API assurance. Needs an operator key with registry:read, web:read and api:read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id"],
      properties: {
        project_id: { type: "string", format: "uuid" },
        ...RANGE_PROPS,
        top_routes: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "project_metrics_document",
    title: "A project's public metrics document",
    description:
      "The programme metrics document of one project (/public/v1/projects/{slug}/metrics.json): the tenant-shared view with web and API figures. Reads it with the configured share key (scfa_pub_…) or, failing that, the operator key.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" } },
    },
    annotations: READ_ONLY,
  },
  {
    name: "evidence_links",
    title: "Evidence links (signed traction snapshots)",
    description:
      "Looks up SCF evidence links: the signed traction snapshots a project issued. With snapshot_id (or link, an evidence/verify URL from which only the snapshot id is taken) it returns that snapshot (its figures, signature, status valid or revoked) and its daily-seal inclusion proof when one exists; with slug it returns the project's append-only list of snapshots. Reads the public endpoints of the configured UsageMap origin only; no key is sent. A seal is tamper-evidence of published numbers, never proof that they are genuine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        snapshot_id: { type: "string", format: "uuid" },
        link: {
          type: "string",
          maxLength: 2048,
          description: "an evidence link such as https://app.usagemap.dev/verify/<snapshot id>",
        },
        slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
      },
    },
    annotations: READ_ONLY,
  },
];

class InputError extends Error {}

/** `null` for a 404 (an absent public object), the error otherwise. */
function notFound(e: unknown): null {
  if (e instanceof ApiError && e.status === 404) return null;
  throw e;
}

function str(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new InputError(`${k} must be a string`);
  return v;
}

function range(a: Record<string, unknown>, now: Date): { start: string; end: string } {
  const end = str(a, "end") ?? lastDays(0, now).end;
  const start =
    str(a, "start") ??
    new Date(Date.parse(`${end}T00:00:00Z`) - 28 * 86_400_000).toISOString().slice(0, 10);
  let s: string;
  let e: string;
  try {
    s = dayStart(start);
    e = dayStart(end);
  } catch (err) {
    throw new InputError((err as Error).message);
  }
  if (Date.parse(e) <= Date.parse(s))
    throw new InputError("end must be after start (end is exclusive)");
  return { start: s, end: e };
}

function projectIds(a: Record<string, unknown>): string[] | undefined {
  const v = a.project_ids ?? (a.project_id !== undefined ? [a.project_id] : undefined);
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    v.length > 500 ||
    !v.every((x) => typeof x === "string" && UUID_RE.test(x))
  )
    throw new InputError("project ids must be UUIDs (at most 500)");
  return v as string[];
}

function oneOf(a: Record<string, unknown>, k: string, allowed: string[]): string | undefined {
  const v = str(a, k);
  if (v !== undefined && !allowed.includes(v))
    throw new InputError(`${k} must be one of ${allowed.join(", ")}`);
  return v;
}

function int(a: Record<string, unknown>, k: string, min: number, max: number, d: number): number {
  const v = a[k];
  if (v === undefined || v === null) return d;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new InputError(`${k} must be an integer between ${min} and ${max}`);
  return v;
}

function result(summary: string, data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: redact(`${summary}\n${JSON.stringify(data)}`) }],
    structuredContent: JSON.parse(redact(JSON.stringify(data))),
  };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: redact(message) }], isError: true };
}

interface Page<R> {
  data: R[];
  next_cursor?: string | null;
  privacy?: unknown;
  meta?: unknown;
}

export function createServer(cfg: McpConfig, version = "1.0.0"): ServerSpec {
  const now = cfg.now ?? (() => new Date());
  const hosted = cfg.mode === "hosted";
  const client = (key: string | undefined) =>
    new ApiClient({
      baseUrl: cfg.baseUrl,
      key,
      fetch: cfg.fetch,
      userAgent: cfg.userAgent ?? "usagemap-mcp/1",
      allowInsecureHttp: cfg.allowInsecureHttp,
      headers: cfg.headers,
      signal: cfg.signal,
    });
  const op = client(cfg.operatorKey);
  const anon = client(undefined);
  const pub = client(cfg.shareKey ?? cfg.operatorKey);
  const needOp = () => {
    if (!cfg.operatorKey)
      throw new InputError(
        hosted
          ? "this tool needs an SCF-operator API key (scfa_op_…) as the Bearer token"
          : "no operator API key configured: set USAGEMAP_OPERATOR_KEY_FILE (a file holding a scfa_op_… key) and restart the server",
      );
  };

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<ToolResult>> = {
    async list_projects(a) {
      needOp();
      const r = await op.get<Page<Record<string, unknown>>>("/op/v1/projects", {
        q: str(a, "query"),
        min_level: oneOf(a, "min_level", ["L0", "L1", "L2", "L3"]),
        scf_awarded: typeof a.scf_awarded === "boolean" ? a.scf_awarded : undefined,
        limit: int(a, "limit", 1, 1000, 100),
      });
      return result(`${r.data.length} project(s)${r.next_cursor ? " (more available)" : ""}.`, r);
    },
    async web_summary(a) {
      needOp();
      const { start, end } = range(a, now());
      const r = await op.get<Page<Record<string, unknown>>>("/op/v1/web/summary", {
        start,
        end,
        project_ids: projectIds(a),
        variant: oneOf(a, "variant", ["verified", "raw"]) ?? "verified",
        min_level: oneOf(a, "min_level", ["L0", "L1", "L2", "L3"]),
      });
      return result(
        `Web summary ${start} – ${end} (end exclusive), ${r.data.length} project row(s).`,
        r,
      );
    },
    async api_routes_summary(a) {
      needOp();
      const { start, end } = range(a, now());
      const r = await op.get<Page<Record<string, unknown>>>("/op/v1/api/summary", {
        start,
        end,
        project_ids: projectIds(a),
        group: oneOf(a, "group", ["route", "service", "project"]) ?? "route",
        min_level: oneOf(a, "min_level", ["L0", "L1", "L2", "L3"]),
        limit: int(a, "limit", 1, 1000, 100),
        sort: "-requests",
      });
      return result(
        `API summary ${start} – ${end} (end exclusive), ${r.data.length} row(s). API figures are self-attested telemetry.`,
        r,
      );
    },
    async trust_flags(a) {
      needOp();
      const { start, end } = range(a, now());
      const q = {
        start,
        end,
        project_ids: projectIds(a),
        min_level: oneOf(a, "min_level", ["L0", "L1", "L2", "L3"]),
      };
      const [trust, verdicts, assurance] = await Promise.all([
        op.all<Record<string, unknown>>("/op/v1/trust/web", q),
        op.all<{ project_id: string; counter: string; label: string; count: number }>(
          "/op/v1/web/verdicts",
          q,
        ),
        op
          .all<Record<string, unknown>>("/op/v1/trust/api-assurance", q)
          .catch((e: unknown) =>
            e instanceof ApiError && e.status === 403 ? null : Promise.reject(e),
          ),
      ]);
      return result(`Trust ${start} – ${end} (end exclusive). Trust scores are advisory.`, {
        web_trust: trust,
        verdict_totals: sumVerdicts(verdicts),
        api_assurance: assurance ?? "not readable with this key (api:read missing)",
      });
    },
    async evidence_pack(a) {
      needOp();
      const ids = projectIds(a) as string[];
      const id = ids[0] as string;
      const { start, end } = range(a, now());
      const q = { start, end, project_ids: [id], min_level: "L0" };
      const [project, verified, raw, verdicts, api, routes, trust, assurance] = await Promise.all([
        op.get<Record<string, unknown>>(`/op/v1/projects/${id}`),
        op.get<Page<Record<string, unknown>>>("/op/v1/web/summary", { ...q, variant: "verified" }),
        op.get<Page<Record<string, unknown>>>("/op/v1/web/summary", { ...q, variant: "raw" }),
        op.all<{ project_id: string; counter: string; label: string; count: number }>(
          "/op/v1/web/verdicts",
          q,
        ),
        op.get<Page<Record<string, unknown>>>("/op/v1/api/summary", { ...q, group: "project" }),
        op.get<Page<Record<string, unknown>>>("/op/v1/api/summary", {
          ...q,
          group: "route",
          sort: "-requests",
          limit: int(a, "top_routes", 1, 100, 20),
        }),
        op.all<Record<string, unknown>>("/op/v1/trust/web", q),
        op.all<Record<string, unknown>>("/op/v1/trust/api-assurance", q),
      ]);
      const pack = {
        generated_at: now().toISOString(),
        source: op.origin,
        range: { start, end, end_exclusive: true },
        project,
        web: {
          verified: verified.data[0] ?? null,
          raw: raw.data[0] ?? null,
          verdicts: sumVerdicts(verdicts),
        },
        api: {
          totals: api.data[0] ?? null,
          top_routes: routes.data,
          label: "self-attested telemetry",
        },
        trust: {
          web: trust,
          api_assurance: assurance,
          note: "trust scores are advisory, not counts",
        },
        privacy: verified.privacy ?? null,
      };
      return result(`Evidence pack for project ${id}, ${start} – ${end} (end exclusive).`, pack);
    },
    async project_metrics_document(a) {
      const slug = str(a, "slug") ?? "";
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug))
        throw new InputError("slug must be a project slug");
      if (!cfg.shareKey && !cfg.operatorKey)
        throw new InputError(
          hosted
            ? "this tool needs a tenant share key (scfa_pub_…) or an operator key as the Bearer token"
            : "no share key (USAGEMAP_SHARE_KEY_FILE) or operator key configured",
        );
      const r = await pub.get<Record<string, unknown>>(`/public/v1/projects/${slug}/metrics.json`);
      return result(`Public metrics document of ${slug}.`, r);
    },
    async evidence_links(a) {
      const given = [a.snapshot_id, a.link, a.slug].filter((v) => v !== undefined && v !== null);
      if (given.length !== 1) throw new InputError("give exactly one of snapshot_id, link or slug");
      const slug = str(a, "slug");
      if (slug !== undefined) {
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug))
          throw new InputError("slug must be a project slug");
        const list = await anon
          .get<Record<string, unknown>>(`/public/v1/projects/${slug}/snapshots`, {}, false)
          .catch(notFound);
        if (!list)
          return failure(
            `no published snapshots for ${slug} (404: unknown slug or none issued yet)`,
          );
        const n = Array.isArray(list.snapshots) ? list.snapshots.length : 0;
        return result(
          `${n} traction snapshot(s) of ${slug}, in series order (revoked ones included).`,
          list,
        );
      }
      const raw = str(a, "snapshot_id") ?? str(a, "link") ?? "";
      const id =
        (a.snapshot_id !== undefined
          ? raw
          : /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(raw)?.[0]) ?? "";
      if (!UUID_RE.test(id)) throw new InputError("no snapshot id (a UUID) in the input");
      const sid = id.toLowerCase();
      const [snapshot, seal] = await Promise.all([
        anon.get<Record<string, unknown>>(`/public/v1/snapshots/${sid}`, {}, false).catch(notFound),
        anon
          .get<Record<string, unknown>>(`/public/v1/snapshots/${sid}/seal`, {}, false)
          .catch(notFound),
      ]);
      if (!snapshot)
        return failure(`no snapshot ${sid} (404: unknown id, or the project is no longer active)`);
      return result(
        `Traction snapshot ${sid}: status ${String(snapshot.status ?? "unknown")}; seal ${seal ? "included" : "not sealed (yet) or the project did not opt in"}. Verify it yourself at ${anon.origin}/verify/${sid}.`,
        { snapshot, seal: seal ?? null, verify_url: `${anon.origin}/verify/${sid}` },
      );
    },
  };

  const listed: ToolDef[] = hosted
    ? cfg.operatorKey
      ? toolsFor({ kind: "op", scopes: cfg.scopes })
      : cfg.shareKey
        ? toolsFor({ kind: "pub" })
        : []
    : TOOLS;

  return {
    name: "usagemap-mcp",
    version,
    instructions:
      "Read-only access to UsageMap web and API analytics for Stellar ecosystem projects. Use list_projects to find project ids, then web_summary, api_routes_summary, trust_flags or evidence_pack. Date ranges are UTC days, start inclusive and end exclusive. Verified web figures exclude events that failed the anti-inflation checks; API figures are self-attested telemetry; trust scores are advisory.",
    tools: listed,
    async call(name, args) {
      const h = listed.some((t) => t.name === name) ? handlers[name] : undefined;
      if (!h) return failure(`unknown tool ${name}`);
      try {
        return await h(args);
      } catch (e) {
        if (e instanceof InputError) return failure(`invalid input: ${e.message}`);
        if (e instanceof ApiError)
          return failure(
            e.status === 401
              ? "the API refused the key (401): it is wrong, revoked or expired"
              : e.status === 404 && name === "project_metrics_document"
                ? "no metrics document for this slug with this key (404): the slug is unknown, the project is not public, or the key belongs to another project"
                : e.status === 403
                  ? `the key lacks the scope or project access for this call (403): ${e.message}`
                  : e.message,
          );
        throw e;
      }
    },
  };
}

export function sumVerdicts(rows: { counter: string; label: string; count: number }[]): {
  verdict: Record<string, number>;
  reason: Record<string, number>;
} {
  const out = { verdict: {} as Record<string, number>, reason: {} as Record<string, number> };
  for (const r of rows) {
    const t =
      r.counter === "verdict" ? out.verdict : r.counter === "reason" ? out.reason : undefined;
    if (t) t[r.label] = (t[r.label] ?? 0) + Number(r.count);
  }
  return out;
}
