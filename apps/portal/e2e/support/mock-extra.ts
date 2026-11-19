// SPDX-License-Identifier: Apache-2.0
// Mock control plane, part 2: API analytics, ingest tokens, OpenTelemetry configuration, erasure and the SCF-operator
// console. Rules followed where the portal depends on them: tenant scoping with indistinguishable `404`s (C-87),
// `recent_auth_required` on erasure confirmation (C-87), `step_up_required` on every `x-requires-step-up` operator
// action (C-09) and `forbidden` for `operator_admin` operations called by an `operator`, operator reads written to the
// audit log (operator.global-view-credentials, C-17), at most 5 active ingest tokens (C-21), secrets shown once (wire-formats §k), whole-UTC-day
// operator ranges (C-86) and the CSV variants of the operator reads. Bodies are validated against the OpenAPI document
// by the caller (mock-server.ts).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import {
  API_RESOLUTION,
  apiPoints,
  apiRange,
  DATA_QUALITY_7D,
  HORIZON_PREVIOUS,
  HORIZON_SUMMARY,
  ROUTES,
  RPC_STREAM_WARNING,
  RPC_SUMMARY,
  SEED_WARNING,
  SERVICES,
  STATUS_CODES,
  SURFACES,
  SVC_HORIZON,
  SVC_RPC,
  TENANT_DOCS,
  TOKENS,
} from "../../test/fixtures/api.ts";
import {
  anchorFunnelFixture,
  appEventsFixture,
  emptyPartnerCalls,
  emptyPayments,
  partnerCallsFixture,
  paymentsFixture,
} from "../../test/fixtures/integration-metrics.ts";
import {
  ECO_LATENCY,
  OP_API_KEYS,
  OP_COUNTRY_ROWS,
  OP_PROJECTS,
  OP_SERVICES,
  OP_SETTINGS,
  OP_TOMBSTONES,
  type OpProject,
  PRIVACY,
  T,
} from "../../test/fixtures/operator.ts";
import { otelRecipe, type Stack } from "../../test/fixtures/otel-recipes.ts";
import { emptyStellarClient, stellarClientFixture } from "../../test/fixtures/stellar-client.ts";
import { PRESET_RANGES } from "../../test/fixtures/web.ts";
import { type D1Helpers, type D1State, d1Handlers, type SnapshotRow, seedD1 } from "./mock-d1.ts";
import {
  JWKS,
  metricsDocument,
  signSnapshot,
  snapshotBody,
  TAMPERED_SNAPSHOT,
} from "./mock-programme.ts";

type Json = Record<string, unknown>;
type Tenant = ControlPlane.Tenant;
type TenantRow = Tenant & { members: Map<string, ControlPlane.TenantRole> };

export class MockProblem extends Error {
  readonly status: number;
  readonly code: ControlPlane.ProblemCode;
  readonly title: string;
  readonly extra: Json;
  constructor(status: number, code: ControlPlane.ProblemCode, title: string, extra: Json = {}) {
    super(title);
    this.status = status;
    this.code = code;
    this.title = title;
    this.extra = extra;
  }
}

export interface Answer {
  status: number;
  body?: unknown;
  /** a non-JSON answer (CSV); not validated as JSON */
  type?: string;
}

export interface ExtraCtx {
  tenants(): Map<string, TenantRow>;
  /** complete session → user id + platform role */
  session(req: IncomingMessage): { userId: string; role: "operator" | "operator_admin" | null };
  userDisplay(userId: string): string;
  /** throws 403 recent_auth_required / step_up_required when not fresh */
  requireRecent(req: IncomingMessage): void;
  /** the websites of every tenant (mutable rows) and their API view */
  sites(): Map<string, ControlPlane.Site & { tenantId: string }>;
  siteView(site: ControlPlane.Site & { tenantId: string }): ControlPlane.Site;
}

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
  body: Json;
}) => Answer;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const DAY = 86_400_000;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const b62 = (n: number) => [...randomBytes(n)].map((b) => B62[b % 62]).join("");

const invalid = (pointer: string, detail: string) =>
  new MockProblem(400, "validation_failed", "Validation failed", {
    errors: [{ pointer, detail }],
  });
const notFound = () => new MockProblem(404, "not_found", "Not found");

interface Erasure extends ControlPlane.ErasureRequest {
  tenantId: string;
}

interface ExtraState {
  services: Map<string, ControlPlane.Service & { tenantId: string }>;
  tokens: Map<string, ControlPlane.IngestToken & { tenantId: string }>;
  erasures: Map<string, Erasure>;
  tombstones: ControlPlane.Tombstone[];
  apiKeys: ControlPlane.OperatorApiKey[];
  enrollment: ControlPlane.EnrollmentMode["enrollment_mode"];
  audit: ControlPlane.AuditEntry[];
  /** platform setting multiplicity_mode (C-124) */
  multiplicityMode: "enforce" | "shadow";
  /** traction snapshots; `polls` = list reads left before a pending one is signed (the jobs service, F16) */
  snapshots: SnapshotRow[];
  /** usage, trust and snapshot state (mock-d1.ts) */
  d1: D1State;
  /** share keys (C-14); `secret` is the full key, kept only so the mock can check a Bearer header */
  shareKeys: (ControlPlane.ShareKey & { tenantId: string; secret: string })[];
  /** secret-seed warning acknowledgement time per tenant (2026-11-19 improvements) */
  seedAck: Map<string, string>;
}

/** Adds the operator-only tenants to the shared tenant table and builds the rest of the state. */
export function seedExtra(tenants: Map<string, TenantRow>): ExtraState {
  const add = (
    id: string,
    slug: string,
    name: string,
    status: ControlPlane.TenantStatus,
    level: ControlPlane.VerificationLevel,
    removed = false,
  ) =>
    tenants.set(id, {
      tenant_id: id,
      slug,
      name,
      description: null,
      status,
      status_reason: status === "suspended" ? "Unexplained traffic spike under review" : null,
      verification_level: level,
      created_at: "2026-09-10T12:00:00Z",
      removed_at: removed ? "2026-10-20T10:00:00Z" : null,
      purge_after: removed ? "2026-11-19T10:00:00Z" : null,
      onchain_correlation_enabled: false,
      public_stats_enabled: false,
      members: new Map(),
    });
  add(T.swap, "soroban-swap", "Soroban Swap", "active", "L2");
  add(T.anchor, "anchor-hub", "Anchor Hub", "suspended", "L2");
  add(T.oldWallet, "old-wallet", "Old Wallet", "removed", "L1", true);
  add(T.hobby, "hobby-site", "Hobby Site", "active", "L0");
  const docs = tenants.get(T.docs);
  if (docs) docs.verification_level = "L3";

  const st: ExtraState = {
    services: new Map(SERVICES.map((s) => [s.service_id, { ...s, tenantId: TENANT_DOCS }])),
    tokens: new Map(TOKENS.map((t) => [t.token_id, { ...t, tenantId: TENANT_DOCS }])),
    erasures: new Map(),
    tombstones: OP_TOMBSTONES.map((t) => ({ ...t })),
    apiKeys: OP_API_KEYS.map((k) => ({ ...k })),
    enrollment: "approval_required",
    audit: [],
    multiplicityMode: "enforce",
    shareKeys: [],
    seedAck: new Map(),
    d1: undefined as unknown as D1State, // set below, once the snapshot list exists
    snapshots: [
      {
        tenantId: TENANT_DOCS,
        polls: 0,
        snapshot_id: "d5000000-0000-4000-8000-000000000001",
        period_start: "2026-08-01T00:00:00Z",
        period_end: "2026-11-01T00:00:00Z",
        created_at: "2026-11-02T09:00:00Z",
        revoked_at: null,
        status: "signed",
        verify_url:
          "https://portal.example.invalid/public/v1/snapshots/d5000000-0000-4000-8000-000000000001",
      },
    ],
  };
  const done: Erasure = {
    tenantId: TENANT_DOCS,
    request_id: "e0000000-0000-4000-8000-000000000001",
    site_id: "b0000000-0000-4000-8000-000000000001",
    service_id: null,
    scope: "filtered",
    criteria: {
      start: "2026-08-01T00:00:00Z",
      end: "2026-08-08T00:00:00Z",
      path_pattern: null,
      event_name: null,
      property_key: null,
    },
    selector: { type: "path_pattern", length: 17 },
    selector_redacted_at: "2026-10-01T12:00:00Z",
    status: "completed",
    preview: counts("site"),
    result: counts("site"),
    created_at: "2026-08-05T11:50:00Z",
    confirmed_at: "2026-08-05T11:55:00Z",
    completed_at: "2026-08-05T12:00:00Z",
    backup_expiry_note: "Erased data leaves all backups within 56 days.",
    failure_code: null,
  };
  st.erasures.set(done.request_id, done);
  st.d1 = seedD1(tenants, st.snapshots);
  return st;
}

function counts(kind: "site" | "service"): ControlPlane.ErasureCounts {
  return kind === "site"
    ? {
        website_events: 120,
        event_data_rows: 0,
        sessions_orphaned: 3,
        breakdown_rows: 4,
        api_routes: 0,
        api_metric_rows: 0,
        aggregate_days: ["2026-09-14", "2026-09-15"],
      }
    : {
        website_events: 0,
        event_data_rows: 0,
        sessions_orphaned: 0,
        breakdown_rows: 0,
        api_routes: 2,
        api_metric_rows: 1440,
        aggregate_days: ["2026-09-14"],
      };
}

/** Splits `total` over `n` days so that the parts add up exactly to it. */
function spread(total: number, n: number, d: number): number {
  const base = Math.floor(total / n);
  return base + (d < total - base * n ? 1 : 0);
}

const LEVELS = ["L0", "L1", "L2", "L3", "L4"];

export function extraHandlers(ctx: ExtraCtx, state: () => ExtraState): Record<string, Handler> {
  const tenantOf = (req: IncomingMessage, tenantId: string): TenantRow => {
    const { userId } = ctx.session(req);
    const t = ctx.tenants().get(tenantId);
    if (!t?.members.has(userId)) throw notFound();
    return t;
  };
  const serviceOf = (req: IncomingMessage, tenantId: string, serviceId: string) => {
    tenantOf(req, tenantId);
    const s = state().services.get(serviceId);
    if (!s || s.tenantId !== tenantId) throw notFound();
    return s;
  };
  const serviceView = (s: ControlPlane.Service & { tenantId: string }): ControlPlane.Service => {
    const { tenantId: _t, ...rest } = s;
    return rest;
  };
  const tokenView = (t: ControlPlane.IngestToken & { tenantId: string }) => {
    const { tenantId: _t, ...rest } = t;
    return rest;
  };
  const erasureView = (e: Erasure): ControlPlane.ErasureRequest => {
    const { tenantId: _t, ...rest } = e;
    return rest;
  };

  /** Tenant API ranges: presets from the shared fixture table; custom = any RFC 3339 UTC pair. */
  const apiRangeOf = (q: URLSearchParams, serviceId: string) => {
    const range = q.get("range") ?? "30d";
    let start: string;
    let end: string;
    if (range === "custom") {
      start = q.get("start") ?? "";
      end = q.get("end") ?? "";
      if (!/Z$/.test(start) || Number.isNaN(Date.parse(start)))
        throw invalid("/start", "RFC 3339 UTC");
      if (!/Z$/.test(end) || Number.isNaN(Date.parse(end))) throw invalid("/end", "RFC 3339 UTC");
      if (Date.parse(end) <= Date.parse(start)) throw invalid("/end", "must be after start");
    } else {
      const p = PRESET_RANGES[range];
      if (!p) throw invalid("/range", "unknown preset");
      start = p.start;
      end = p.end;
    }
    const resolution = API_RESOLUTION[range] ?? "1d";
    const extra: Partial<ControlPlane.ApiRangeEcho> =
      serviceId === SVC_RPC
        ? {
            stream_group: { kind: "mixed", warning: RPC_STREAM_WARNING },
            sampled_lower_bound: false,
          }
        : { stream_group: { kind: "sdk_stable", warning: null }, sampled_lower_bound: false };
    return { range, echo: apiRange(start, end, resolution, extra) };
  };

  const summaryFor = (serviceId: string, range: string, route: string | null) => {
    if (route !== null) {
      const row = (ROUTES[serviceId] ?? []).find((r) => r.route === route);
      if (!row) throw notFound();
      const s5 = Math.round(row.requests * (row.error_rate_5xx ?? 0));
      const s4 = Math.round(row.requests * 0.04);
      return {
        requests: row.requests,
        error_rate_5xx: row.error_rate_5xx ?? null,
        error_rate_4xx: s4 / row.requests,
        status: { s2xx: row.requests - s5 - s4, s3xx: 0, s4xx: s4, s5xx: s5, unknown: 0 },
        latency: row.latency,
      };
    }
    if (serviceId === SVC_RPC) return RPC_SUMMARY;
    if (serviceId === SVC_HORIZON) return range === "custom" ? HORIZON_PREVIOUS : HORIZON_SUMMARY;
    return {
      requests: 0,
      error_rate_5xx: null,
      error_rate_4xx: null,
      status: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, unknown: 0 },
      latency: { p50_ms: null, p95_ms: null, p99_ms: null, mean_ms: null, accuracy_class: null },
    };
  };

  // --- SCF operator ---
  const operator = (req: IncomingMessage, admin = false) => {
    const s = ctx.session(req);
    if (!s.role) throw new MockProblem(403, "forbidden", "SCF operators only");
    if (admin && s.role !== "operator_admin")
      throw new MockProblem(403, "forbidden", "Needs the operator_admin role");
    return s;
  };
  const multiplicitySetting = (): ControlPlane.Setting => ({
    key: "multiplicity_mode",
    value: state().multiplicityMode,
    description: "enforce | shadow (C-124)",
    public: true,
    updated_at: "2026-11-13T00:00:00Z",
  });
  const stepUp = (req: IncomingMessage, admin = false) => {
    const s = operator(req, admin);
    ctx.requireRecent(req);
    return s;
  };
  const audit = (
    req: IncomingMessage,
    action: ControlPlane.AuditAction,
    target: { type: string; id: string } | null,
    details: Json = {},
  ) => {
    const s = ctx.session(req);
    const log = state().audit;
    const prev = log.at(-1)?.row_hash ?? "0".repeat(64);
    const entry: ControlPlane.AuditEntry = {
      chain_id: "00000000-0000-4000-8000-000000000000", // the platform chain
      seq: log.length + 1,
      occurred_at: iso(Date.now()),
      actor_kind: s.role ? "scf_operator" : "user",
      actor_id: null,
      actor_display: ctx.userDisplay(s.userId),
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      outcome: "success",
      details,
      row_hash: "",
      prev_hash: prev,
    };
    entry.row_hash = createHash("sha256")
      .update(prev + JSON.stringify({ ...entry, row_hash: "" }))
      .digest("hex");
    log.push(entry);
  };

  /** Whole UTC days only (OpenAPI dayStart/dayEnd); ≤ 3 660 days. */
  const days = (q: URLSearchParams): string[] => {
    const midnight = /^\d{4}-\d{2}-\d{2}T00:00:00Z$/;
    const s = q.get("start") ?? "";
    const e = q.get("end") ?? "";
    if (!midnight.test(s)) throw invalid("/start", "midnight UTC");
    if (!midnight.test(e)) throw invalid("/end", "midnight UTC");
    const a = Date.parse(s);
    const b = Date.parse(e);
    if (b <= a || (b - a) / DAY > 3660) throw invalid("/end", "after start, at most 3 660 days");
    const out: string[] = [];
    for (let t = a; t < b; t += DAY) out.push(iso(t).slice(0, 10));
    return out;
  };

  const ids = (q: URLSearchParams, name = "tenant_ids") =>
    (q.get(name) ?? "").split(",").filter((x) => x !== "");

  /** The web projects a filter selects (min level default L1; removed tenants never). */
  const selectProjects = (q: URLSearchParams): OpProject[] => {
    const minLevel = LEVELS.indexOf(q.get("min_level") ?? "L1");
    const only = ids(q);
    const awarded = q.get("scf_awarded");
    const band = q.get("trust_band");
    return OP_PROJECTS.filter((p) => {
      const t = ctx.tenants().get(p.tenant_id);
      if (!t || t.status === "removed") return false;
      if (LEVELS.indexOf(p.verification_level) < minLevel) return false;
      if (only.length > 0 && !only.includes(p.tenant_id)) return false;
      if (awarded === "true" && p.scf_awarded !== true) return false;
      if (awarded === "false" && p.scf_awarded !== false) return false;
      if (band) {
        const s = p.trust_score_28d;
        const b = s === null ? "unscored" : s >= 80 ? "high" : s >= 50 ? "medium" : "low";
        if (b !== band) return false;
      }
      return true;
    });
  };
  const webCells = (p: OpProject, variant: string): ControlPlane.OpWebCells =>
    variant === "raw" ? { ...p.verified, ...p.raw } : p.verified;

  /** Per-day cells of a set of projects: counts spread exactly; rates and durations weighted per day. */
  const webDays = (
    list: OpProject[],
    variant: string,
    dayList: string[],
  ): ControlPlane.OpWebDay[] =>
    dayList.map((day, d) => {
      const n = dayList.length;
      let pv = 0;
      let un = 0;
      let vis = 0;
      let visits = 0;
      let bounces = 0;
      let durW = 0;
      let suspW = 0;
      for (const p of list) {
        const c = webCells(p, variant);
        const pvd = spread(c.pageviews, n, d);
        const vd = spread(c.visits, n, d);
        pv += pvd;
        un += spread(c.pageviews_unidentified, n, d);
        vis += spread(c.visitors_sum, n, d);
        visits += vd;
        bounces += spread(c.bounces, n, d);
        durW += (c.avg_visit_duration_s ?? 0) * vd;
        suspW += (c.suspect_pageview_share ?? 0) * pvd;
      }
      return {
        day,
        all_final: d < n - 1,
        pageviews: pv,
        pageviews_unidentified: un,
        visitors_sum: vis,
        visits,
        bounces,
        bounce_rate_pct: visits === 0 ? null : (bounces / visits) * 100,
        avg_visit_duration_s: visits === 0 ? null : durW / visits,
        suspect_pageview_share: pv === 0 ? null : suspW / pv,
      };
    });

  const selectServices = (q: URLSearchParams) => {
    const allowed = new Set(selectProjectsAnyData(q).map((p) => p.tenant_id));
    return OP_SERVICES.filter((s) => allowed.has(s.tenant_id));
  };
  /** Same tenant filter as the web views, but every non-removed tenant is a candidate (API-only tenants included). */
  const selectProjectsAnyData = (q: URLSearchParams) => selectProjects(q);

  const apiDays = (svcs: typeof OP_SERVICES, dayList: string[]): ControlPlane.OpApiDay[] =>
    dayList.map((day, d) => {
      const n = dayList.length;
      const sum = (f: (c: ControlPlane.OpApiCells) => number) =>
        svcs.reduce((a, s) => a + spread(f(s.cells), n, d), 0);
      const requests = sum((c) => c.requests);
      const s5xx = sum((c) => c.s5xx ?? 0);
      const single = svcs.length === 1 ? svcs[0]?.cells : undefined;
      const lat = single ?? { ...ECO_LATENCY, accuracy_class: "explicit15" as const };
      return {
        day,
        requests,
        s2xx: sum((c) => c.s2xx ?? 0),
        s3xx: sum((c) => c.s3xx ?? 0),
        s4xx: sum((c) => c.s4xx ?? 0),
        s5xx,
        unknown: sum((c) => c.unknown ?? 0),
        error_rate_5xx: requests === 0 ? null : s5xx / requests,
        mean_ms: requests === 0 ? null : (lat.mean_ms ?? null),
        p50_ms: requests === 0 ? null : lat.p50_ms,
        p95_ms: requests === 0 ? null : lat.p95_ms,
        p99_ms: requests === 0 ? null : lat.p99_ms,
        accuracy_class: requests === 0 ? null : lat.accuracy_class,
      };
    });

  const wantsCsv = (req: IncomingMessage) => (req.headers.accept ?? "").startsWith("text/csv");
  const csv = (header: string[], rows: (string | number | null | undefined)[][]): Answer => ({
    status: 200,
    type: "text/csv; charset=utf-8",
    body: `${[header, ...rows].map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v))).join(",")).join("\n")}\n`,
  });

  const opTenantRow = (t: TenantRow): ControlPlane.OperatorTenantRow => {
    const p = OP_PROJECTS.find((x) => x.tenant_id === t.tenant_id);
    return {
      tenant_id: t.tenant_id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      created_at: t.created_at,
      verification_level: t.verification_level,
      scf_awarded: p?.scf_awarded ?? null,
      registry_project_ids: p?.scf_awarded
        ? [`c1000000-0000-4000-8000-${t.tenant_id.slice(-12)}`]
        : [],
      site_count: t.tenant_id === T.docs ? 2 : t.tenant_id === T.oldWallet ? 1 : 1,
      service_count: OP_SERVICES.filter((s) => s.tenant_id === t.tenant_id).length,
    };
  };
  const tenantForOp = (id: string) => {
    const t = ctx.tenants().get(id);
    if (!t) throw notFound();
    return t;
  };
  const tenantView = (t: TenantRow): Tenant => {
    const { members: _m, ...rest } = t;
    return rest;
  };

  const base: Record<string, Handler> = {
    // ---------------- tenant: services ----------------
    listServices: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      return {
        status: 200,
        body: [...state().services.values()]
          .filter((s) => s.tenantId === p.tenantId)
          .map(serviceView),
      };
    },
    createService: ({ req, p, body }) => {
      tenantOf(req, p.tenantId as string);
      const name = String(body.service_name ?? "");
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name))
        throw invalid("/service_name", "lower-case letters, digits, '.', '_' and '-'");
      if (
        [...state().services.values()].some(
          (s) => s.tenantId === p.tenantId && s.service_name === name,
        )
      )
        throw new MockProblem(409, "conflict", "Conflict");
      const s: ControlPlane.Service & { tenantId: string } = {
        tenantId: p.tenantId as string,
        service_id: randomUUID(),
        service_name: name,
        display_name: typeof body.display_name === "string" ? body.display_name : null,
        declared_base_url:
          typeof body.declared_base_url === "string" ? body.declared_base_url : null,
        read_only_api: body.read_only_api === true,
        rpc_method_dimension: body.rpc_method_dimension === true,
        registration: "portal",
        status: "active",
        registered_at: iso(Date.now()),
        stream_groups: [],
        multiple_groups_warning: false,
      };
      state().services.set(s.service_id, s);
      return { status: 201, body: serviceView(s) };
    },
    getService: ({ req, p }) => ({
      status: 200,
      body: serviceView(serviceOf(req, p.tenantId as string, p.serviceId as string)),
    }),
    updateService: ({ req, p, body }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      if ("display_name" in body) s.display_name = (body.display_name as string | null) ?? null;
      if (body.status === "active" || body.status === "archived") s.status = body.status;
      if (typeof body.slo_target_pct === "number") {
        const v = body.slo_target_pct;
        if (v < 90 || v > 99.999) throw new MockProblem(400, "validation_failed", "out of range");
        s.slo_target_pct = v;
      }
      return { status: 200, body: serviceView(s) };
    },
    getOtelConfig: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const stack = q.get("stack") as Stack | "python" | null;
      const known: Stack[] = [
        "collector",
        "node",
        "nextjs",
        "fastapi",
        "go",
        "rust",
        "java",
        "dotnet",
      ];
      if (stack === "python") {
        return {
          status: 200,
          body: otelRecipe("fastapi", {
            endpoint: "https://otlp.example.invalid",
            serviceName: s.service_name,
          }),
        };
      }
      if (!stack || !known.includes(stack)) throw invalid("/stack", "unsupported stack");
      return {
        status: 200,
        body: otelRecipe(stack, {
          endpoint: "https://otlp.example.invalid",
          serviceName: s.service_name,
        }),
      };
    },
    getServiceDataQuality: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const range = q.get("range") ?? "7d";
      const k = (c: number) => (range === "24h" ? Math.floor(c / 7) : range === "30d" ? c * 4 : c);
      const end = "2026-11-13T00:00:00Z";
      const start =
        range === "24h"
          ? "2026-11-12T00:00:00Z"
          : range === "30d"
            ? "2026-10-14T00:00:00Z"
            : "2026-11-06T00:00:00Z";
      return {
        status: 200,
        body: {
          start,
          end,
          reasons: (DATA_QUALITY_7D[s.service_id] ?? []).map((r) => ({
            reason: r.reason,
            count: k(r.count),
          })),
        },
      };
    },
    // ---------------- tenant: secret-seed leak warning ----------------
    getSecretSeedWarning: ({ req, p }) => {
      const t = tenantOf(req, p.tenantId as string);
      const acked = state().seedAck.get(t.tenant_id) ?? null;
      const body: ControlPlane.SecretSeedWarning =
        t.tenant_id === TENANT_DOCS && !acked
          ? SEED_WARNING
          : { count: 0, since: null, last_seen: null, acknowledged_at: acked, services: [] };
      return { status: 200, body };
    },
    acknowledgeSecretSeedWarning: ({ req, p }) => {
      const t = tenantOf(req, p.tenantId as string);
      const role = t.members.get(ctx.session(req).userId);
      if (role !== "owner" && role !== "admin")
        throw new MockProblem(403, "forbidden", "Needs the admin role");
      const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      state().seedAck.set(t.tenant_id, at);
      const body: ControlPlane.SecretSeedWarning = {
        count: 0,
        since: null,
        last_seen: null,
        acknowledged_at: at,
        services: [],
      };
      return { status: 200, body };
    },
    // ---------------- tenant: API analytics ----------------
    getApiSummary: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { range, echo } = apiRangeOf(q, s.service_id);
      return {
        status: 200,
        body: { range: echo, ...summaryFor(s.service_id, range, q.get("route")) },
      };
    },
    getApiTimeseries: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { echo } = apiRangeOf(q, s.service_id);
      const res = q.get("resolution");
      if (res && res !== "auto") echo.resolution = res as "1m" | "1h" | "1d";
      const points = apiPoints(echo.start, echo.end, echo.resolution, s.service_id);
      const known = s.service_id === SVC_HORIZON || s.service_id === SVC_RPC;
      return {
        status: 200,
        body: {
          range: echo,
          points: known ? points : [],
          accuracy_class: known
            ? summaryFor(s.service_id, "7d", null).latency.accuracy_class
            : null,
        },
      };
    },
    getApiStatusCodes: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { range, echo } = apiRangeOf(q, s.service_id);
      const sum = summaryFor(s.service_id, range, q.get("route"));
      const codes =
        q.get("route") !== null || range === "custom" ? [] : (STATUS_CODES[s.service_id] ?? []);
      return { status: 200, body: { range: echo, classes: sum.status, codes } };
    },
    listApiRoutes: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { echo } = apiRangeOf(q, s.service_id);
      const sort = q.get("sort") ?? "-requests";
      const desc = sort.startsWith("-");
      const key = desc ? sort.slice(1) : sort;
      const rows = [...(ROUTES[s.service_id] ?? [])];
      const val = (r: ControlPlane.ApiRouteRow): number | string =>
        key === "route"
          ? r.route
          : key === "error_rate_5xx"
            ? (r.error_rate_5xx ?? -1)
            : key === "p95_ms"
              ? (r.latency.p95_ms ?? -1)
              : r.requests;
      rows.sort((a, b) => {
        const x = val(a);
        const y = val(b);
        const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
        return desc ? -c : c;
      });
      return { status: 200, body: { range: echo, items: rows, next_cursor: null } };
    },
    getApiSurfaces: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { echo } = apiRangeOf(q, s.service_id);
      return {
        status: 200,
        body: {
          range: echo,
          mapping_version: "stellar-surfaces/1.0.0",
          surfaces: SURFACES[s.service_id] ?? [],
        },
      };
    },
    // Stellar SDK client metrics (C-153; FAKE figures for the Horizon proxy, empty elsewhere)
    getStellarClientMetrics: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { echo } = apiRangeOf(q, s.service_id);
      const range = {
        start: echo.start,
        end: echo.end,
        resolution: echo.resolution,
        label: echo.label,
      };
      const body =
        s.service_id === SVC_HORIZON ? stellarClientFixture(range) : emptyStellarClient(range);
      return { status: 200, body };
    },
    // Integration client metrics and app events (FAKE figures for the Horizon proxy / every tenant)
    getPartnerCalls: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { echo } = apiRangeOf(q, s.service_id);
      const range = {
        start: echo.start,
        end: echo.end,
        resolution: "1d" as const,
        label: echo.label,
      };
      const body =
        s.service_id === SVC_HORIZON ? partnerCallsFixture(range) : emptyPartnerCalls(range);
      return { status: 200, body };
    },
    getPaymentEvents: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      const { echo } = apiRangeOf(q, s.service_id);
      const range = {
        start: echo.start,
        end: echo.end,
        resolution: "1d" as const,
        label: echo.label,
      };
      const body = s.service_id === SVC_HORIZON ? paymentsFixture(range) : emptyPayments(range);
      return { status: 200, body };
    },
    getAnchorFunnel: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      const end = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000);
      const start = new Date(end.getTime() - 30 * 86_400_000);
      const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
      const range = {
        start: iso(start),
        end: iso(end),
        resolution: "1d" as const,
        label: "self-attested telemetry" as const,
      };
      return { status: 200, body: anchorFunnelFixture(range) };
    },
    getAppEvents: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      const end = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000);
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const range = {
        start: day(new Date(end.getTime() - 30 * 86_400_000)),
        end: day(end),
        label: "self-attested (app events are not verified)" as const,
      };
      return { status: 200, body: appEventsFixture(range) };
    },
    exportApiRoutes: ({ req, p, q }) => {
      const s = serviceOf(req, p.tenantId as string, p.serviceId as string);
      apiRangeOf(q, s.service_id);
      const head =
        "route,rpc_method,surface,surface_group,rules_version,requests,requests_5xx,error_rate_5xx,p50_ms,p95_ms,p99_ms,accuracy_class";
      const lines = (ROUTES[s.service_id] ?? []).map((r) =>
        [
          r.route,
          r.rpc_method ?? "",
          "",
          "",
          r.rules_version ?? "",
          r.requests,
          Math.round((r.error_rate_5xx ?? 0) * r.requests),
          r.error_rate_5xx ?? "",
          r.latency.p50_ms ?? "",
          r.latency.p95_ms ?? "",
          r.latency.p99_ms ?? "",
          r.latency.accuracy_class ?? "",
        ].join(","),
      );
      return {
        status: 200,
        body: `${[head, ...lines].join("\r\n")}\r\n`,
        type: "text/csv; charset=utf-8",
      };
    },
    // ---------------- tenant: ingest tokens ----------------
    listIngestTokens: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      return {
        status: 200,
        body: [...state().tokens.values()].filter((t) => t.tenantId === p.tenantId).map(tokenView),
      };
    },
    createIngestToken: ({ req, p, body }) => {
      tenantOf(req, p.tenantId as string);
      ctx.requireRecent(req);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (label === "" || label.length > 100) throw invalid("/label", "1–100 characters");
      const active = [...state().tokens.values()].filter(
        (t) => t.tenantId === p.tenantId && !t.revoked_at,
      );
      if (active.length >= 5)
        throw new MockProblem(409, "quota_exceeded", "At most 5 active ingest tokens per project");
      const id = b62(12);
      const secret = b62(27);
      const crc = b62(6);
      const t = {
        tenantId: p.tenantId as string,
        token_id: id,
        display: `scfa_ing_${id}_…${secret.slice(-4)}`,
        label,
        allowed_service_names: Array.isArray(body.allowed_service_names)
          ? (body.allowed_service_names as string[])
          : null,
        created_at: iso(Date.now()),
        expires_at: (body.expires_at as string | null | undefined) ?? null,
        last_used_at: null,
        revoked_at: null,
        rotation_reminder: false,
      };
      state().tokens.set(id, t);
      return { status: 201, body: { ...tokenView(t), token: `scfa_ing_${id}_${secret}${crc}` } };
    },
    revokeIngestToken: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      ctx.requireRecent(req);
      const t = state().tokens.get(p.tokenId as string);
      if (!t || t.tenantId !== p.tenantId) throw notFound();
      t.revoked_at = iso(Date.now());
      return { status: 204 };
    },
    // ---------------- tenant: erasure ----------------
    listErasureRequests: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      const items = [...state().erasures.values()]
        .filter((e) => e.tenantId === p.tenantId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(erasureView);
      return { status: 200, body: { items, next_cursor: null } };
    },
    createErasureRequest: ({ req, p, body }) => {
      tenantOf(req, p.tenantId as string);
      const c = (body.criteria ?? {}) as Json;
      const scope = (body.scope as ControlPlane.ErasureRequest["scope"] | undefined) ?? "filtered";
      const siteId = typeof body.site_id === "string" ? body.site_id : null;
      const serviceId = typeof body.service_id === "string" ? body.service_id : null;
      if (scope === "filtered" && (siteId === null) === (serviceId === null))
        throw invalid("/site_id", "exactly one of site_id and service_id");
      if (serviceId && !state().services.has(serviceId)) throw notFound();
      const start = String(c.start ?? "");
      const end = String(c.end ?? "");
      if (Number.isNaN(Date.parse(start))) throw invalid("/criteria/start", "date-time");
      if (Number.isNaN(Date.parse(end)) || Date.parse(end) <= Date.parse(start))
        throw invalid("/criteria/end", "after start");
      const sel = (["path_pattern", "event_name", "property_key"] as const).filter(
        (k) => typeof c[k] === "string" && c[k] !== "",
      );
      if (sel.length > 1) throw invalid("/criteria", "at most one selector");
      if (sel[0] === "property_key" && !siteId)
        throw invalid("/criteria/property_key", "sites only");
      const selector = sel[0] ? { type: sel[0], length: String(c[sel[0]]).length } : null;
      const e: Erasure = {
        tenantId: p.tenantId as string,
        request_id: randomUUID(),
        site_id: siteId,
        service_id: serviceId,
        scope,
        criteria: {
          start,
          end,
          path_pattern: (c.path_pattern as string | undefined) ?? null,
          event_name: (c.event_name as string | undefined) ?? null,
          property_key: (c.property_key as string | undefined) ?? null,
        },
        selector,
        selector_redacted_at: null,
        status: "previewing",
        preview: null,
        result: null,
        created_at: iso(Date.now()),
        confirmed_at: null,
        completed_at: null,
        backup_expiry_note: "Erased data leaves all backups within 56 days.",
        failure_code: null,
      };
      state().erasures.set(e.request_id, e);
      return { status: 202, body: erasureView(e) };
    },
    getErasureRequest: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      const e = state().erasures.get(p.requestId as string);
      if (!e || e.tenantId !== p.tenantId) throw notFound();
      // The job advances one step per poll: previewing → previewed, running → completed.
      if (e.status === "previewing") {
        e.status = "previewed";
        e.preview = counts(e.service_id ? "service" : "site");
      } else if (e.status === "running") {
        e.status = "completed";
        e.result = e.preview ?? null;
        e.completed_at = iso(Date.now());
      }
      return { status: 200, body: erasureView(e) };
    },
    confirmErasureRequest: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      ctx.requireRecent(req);
      const e = state().erasures.get(p.requestId as string);
      if (!e || e.tenantId !== p.tenantId) throw notFound();
      if (e.status !== "previewed")
        throw new MockProblem(409, "conflict", "Only a previewed request can be confirmed");
      e.status = "running";
      e.confirmed_at = iso(Date.now());
      return { status: 202, body: erasureView(e) };
    },
    cancelErasureRequest: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      const e = state().erasures.get(p.requestId as string);
      if (!e || e.tenantId !== p.tenantId) throw notFound();
      if (e.status !== "previewing" && e.status !== "previewed")
        throw new MockProblem(409, "conflict", "Only an unconfirmed request can be cancelled");
      e.status = "cancelled";
      return { status: 200, body: erasureView(e) };
    },
    // ---------------- operator: tenants ----------------
    operatorListTenants: ({ req, q }) => {
      operator(req);
      const statuses = (q.get("status") ?? "active,suspended").split(",");
      const min = LEVELS.indexOf(q.get("min_level") ?? "L0");
      const text = (q.get("q") ?? "").toLowerCase();
      const sort = q.get("sort") ?? "name";
      const items = [...ctx.tenants().values()]
        .filter((t) => statuses.includes(t.status))
        .filter((t) => LEVELS.indexOf(t.verification_level) >= min)
        .filter((t) => !text || t.name.toLowerCase().includes(text) || t.slug.includes(text))
        .sort((a, b) => {
          if (sort === "name") return a.name.localeCompare(b.name);
          if (sort.endsWith("verification_level")) {
            const c = a.verification_level.localeCompare(b.verification_level);
            return sort.startsWith("-") ? -c : c;
          }
          const c = a.created_at.localeCompare(b.created_at);
          return sort.startsWith("-") ? -c : c;
        })
        .map(opTenantRow);
      audit(req, "operator.read.op_projects", null, { count: items.length });
      return { status: 200, body: { items, next_cursor: null } };
    },
    operatorGetTenant: ({ req, p }) => {
      operator(req);
      const t = tenantForOp(p.tenantId as string);
      audit(req, "operator.read.op_tenant_detail", { type: "tenant", id: t.tenant_id });
      return {
        status: 200,
        body: {
          tenant: tenantView(t),
          members: [...t.members.entries()].map(([userId, role]) => ({
            user_id: "c0000000-0000-4000-8000-000000000001",
            display_name: ctx.userDisplay(userId),
            role,
            added_at: "2026-09-01T12:00:00Z",
          })),
          sites: [...ctx.sites().values()]
            .filter((x) => x.tenantId === t.tenant_id)
            .map(ctx.siteView),
          services: [...state().services.values()]
            .filter((s) => s.tenantId === t.tenant_id)
            .map(serviceView),
          evidence:
            t.tenant_id === T.docs
              ? [
                  {
                    evidence_id: "e1000000-0000-4000-8000-000000000001",
                    kind: "domain",
                    subject: "docs.stellar-docs.example",
                    status: "valid",
                    verified_at: "2026-09-02T09:00:00Z",
                    last_checked_at: "2026-11-12T00:00:00Z",
                  },
                ]
              : [],
          registry_links: [],
          ingest_tokens: [...state().tokens.values()]
            .filter((x) => x.tenantId === t.tenant_id)
            .map(tokenView),
          annotations: [],
        },
      };
    },
    operatorTransitionTenant: ({ req, p, body }) => {
      stepUp(req);
      const t = tenantForOp(p.tenantId as string);
      const reason = String(body.reason ?? "");
      if (reason.trim().length < 3) throw invalid("/reason", "required");
      const next =
        body.action === "approve" && t.status === "pending"
          ? "active"
          : body.action === "suspend" && t.status === "active"
            ? "suspended"
            : body.action === "reinstate" && t.status === "suspended"
              ? "active"
              : null;
      if (!next) throw new MockProblem(409, "conflict", "Invalid transition");
      t.status = next;
      t.status_reason = body.action === "suspend" ? reason : null;
      audit(
        req,
        body.action === "approve"
          ? "tenant.approved"
          : body.action === "suspend"
            ? "tenant.suspended"
            : "tenant.reinstated",
        { type: "tenant", id: t.tenant_id },
      );
      return { status: 200, body: tenantView(t) };
    },
    operatorRemoveTenant: ({ req, p, body }) => {
      stepUp(req, true);
      const t = tenantForOp(p.tenantId as string);
      if (String(body.reason ?? "").trim().length < 3) throw invalid("/reason", "required");
      if (t.status === "removed") throw new MockProblem(409, "conflict", "Already removed");
      const now = Date.now();
      t.status = "removed";
      t.removed_at = iso(now);
      t.purge_after = iso(now + 30 * DAY);
      state().tombstones.push({
        tombstone_id: randomUUID(),
        kind: "github_user",
        subject: `${t.slug}-owner`,
        tenant_id: t.tenant_id,
        reason: String(body.reason),
        created_at: iso(now),
        lifted_at: null,
      });
      audit(req, "tenant.removed", { type: "tenant", id: t.tenant_id });
      return { status: 200, body: tenantView(t) };
    },
    operatorRestoreTenant: ({ req, p }) => {
      stepUp(req, true);
      const t = tenantForOp(p.tenantId as string);
      if (t.status !== "removed") throw new MockProblem(409, "conflict", "Not removed");
      t.status = "suspended";
      t.removed_at = null;
      t.purge_after = null;
      audit(req, "tenant.restored", { type: "tenant", id: t.tenant_id });
      return { status: 200, body: tenantView(t) };
    },
    operatorPurgeTenant: ({ req, p }) => {
      stepUp(req, true);
      const t = tenantForOp(p.tenantId as string);
      if (t.status !== "removed") throw new MockProblem(409, "conflict", "Only removed tenants");
      t.purge_after = iso(Date.now());
      audit(req, "tenant.purge_requested", { type: "tenant", id: t.tenant_id });
      return { status: 200, body: tenantView(t) };
    },
    operatorListTombstones: ({ req }) => {
      operator(req, true);
      audit(req, "operator.read.tombstones", null);
      return { status: 200, body: { items: state().tombstones, next_cursor: null } };
    },
    operatorLiftTombstone: ({ req, p }) => {
      stepUp(req, true);
      const t = state().tombstones.find((x) => x.tombstone_id === p.tombstoneId);
      if (!t) throw notFound();
      if (t.lifted_at) throw new MockProblem(409, "conflict", "Already lifted");
      t.lifted_at = iso(Date.now());
      audit(req, "operator.tombstone_lifted", { type: "tombstone", id: t.tombstone_id });
      return { status: 204 };
    },
    operatorGetSettings: ({ req }) => {
      operator(req);
      return { status: 200, body: [...OP_SETTINGS, multiplicitySetting()] };
    },
    operatorUpdateSetting: ({ req, p, body }) => {
      stepUp(req, true);
      if (p.key !== "multiplicity_mode") throw notFound();
      if (body.value !== "enforce" && body.value !== "shadow")
        throw new MockProblem(422, "unprocessable", "value not allowed for this setting");
      state().multiplicityMode = body.value;
      audit(req, "settings.updated", { type: "setting", id: "multiplicity_mode" });
      return { status: 200, body: multiplicitySetting() };
    },
    operatorSetSiteMultiplicityMode: ({ req, p, body }) => {
      stepUp(req, true);
      tenantForOp(p.tenantId as string);
      const site = ctx.sites().get(p.siteId as string);
      if (!site || site.tenantId !== p.tenantId) throw notFound();
      const mode = body.multiplicity_mode;
      if (mode !== null && mode !== "enforce" && mode !== "shadow")
        throw invalid("/multiplicity_mode", "enforce, shadow or null");
      Object.assign(site, { multiplicity_mode: mode });
      audit(req, "site.multiplicity_mode_set", { type: "site", id: site.site_id }, { to: mode });
      return {
        status: 200,
        body: {
          site_id: site.site_id,
          multiplicity_mode: mode,
          effective_multiplicity_mode: mode ?? state().multiplicityMode,
        },
      };
    },
    // --- traction snapshots (tenant admin; signed by the jobs service, so 202 pending first) ---
    listTractionSnapshots: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      const rows = state().snapshots.filter((x) => x.tenantId === p.tenantId);
      for (const x of rows) {
        if (x.status === "pending" && --x.polls <= 0) x.status = "signed";
      }
      return {
        status: 200,
        body: rows.map(({ tenantId: _t, polls: _p, ...rest }) => rest),
      };
    },
    createTractionSnapshot: ({ req, p, body }) => {
      tenantOf(req, p.tenantId as string);
      const start = String(body.period_start ?? "");
      const end = String(body.period_end ?? "");
      if (!(start < end)) throw invalid("/period_end", "must be after period_start");
      const id = randomUUID();
      const verify_url = `https://portal.example.invalid/public/v1/snapshots/${id}`;
      state().snapshots.unshift({
        tenantId: p.tenantId as string,
        polls: 2,
        snapshot_id: id,
        period_start: start,
        period_end: end,
        created_at: iso(Date.now()),
        revoked_at: null,
        status: "pending",
        verify_url,
      });
      return { status: 202, body: { snapshot_id: id, status: "pending", verify_url } };
    },
    // --- sharing: public statistics switch and share keys (C-14, C-70; recent sign-in C-129) ---
    updateTenant: ({ req, p, body }) => {
      const t = tenantOf(req, p.tenantId as string);
      if (typeof body.public_stats_enabled === "boolean")
        t.public_stats_enabled = body.public_stats_enabled;
      if (typeof body.name === "string" && body.name.trim() !== "") t.name = body.name.trim();
      const { members: _m, ...view } = t;
      return { status: 200, body: view };
    },
    listShareKeys: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      return {
        status: 200,
        body: state()
          .shareKeys.filter((k) => k.tenantId === p.tenantId)
          .map(({ tenantId: _t, secret: _s, ...rest }) => rest),
      };
    },
    createShareKey: ({ req, p, body }) => {
      tenantOf(req, p.tenantId as string);
      ctx.requireRecent(req);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (label === "" || label.length > 100) throw invalid("/label", "1–100 characters");
      const expires = (body.expires_at as string | null | undefined) ?? null;
      if (expires && Date.parse(expires) <= Date.now())
        throw invalid("/expires_at", "must be in the future");
      const id = b62(12);
      const secret = `scfa_pub_${id}_${b62(33)}`;
      const k = {
        tenantId: p.tenantId as string,
        secret,
        key_id: id,
        display: `scfa_pub_${id}_…${secret.slice(-4)}`,
        label,
        created_at: iso(Date.now()),
        expires_at: expires,
        last_used_at: null,
        revoked_at: null,
      };
      state().shareKeys.unshift(k);
      const { tenantId: _t, secret: _s, ...view } = k;
      return { status: 201, body: { ...view, key: secret } };
    },
    revokeShareKey: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      ctx.requireRecent(req);
      const k = state().shareKeys.find((x) => x.key_id === p.keyId && x.tenantId === p.tenantId);
      if (!k) throw notFound();
      k.revoked_at ??= iso(Date.now());
      return { status: 204 };
    },
    // --- public programme outputs (no session; 404 is the only refusal, C-94) ---
    getMetricsEndpoint: ({ req, p }) => {
      const t = [...ctx.tenants().values()].find((x) => x.slug === p.slug);
      if (t?.status !== "active") throw notFound();
      if (!t.public_stats_enabled) {
        const auth = req.headers.authorization ?? "";
        const m = /^Bearer (scfa_pub_\S+)$/.exec(auth);
        const k = m
          ? state().shareKeys.find(
              (x) =>
                x.tenantId === t.tenant_id &&
                x.secret === m[1] &&
                !x.revoked_at &&
                (!x.expires_at || Date.parse(x.expires_at) > Date.now()),
            )
          : undefined;
        if (!k) throw notFound();
        k.last_used_at = iso(Date.now());
      }
      return { status: 200, body: metricsDocument(t) };
    },
    getPublicSnapshot: ({ p }) => {
      const id = p.snapshotId as string;
      const docs = ctx.tenants().get(TENANT_DOCS) as TenantRow;
      if (id === TAMPERED_SNAPSHOT) {
        const signed = signSnapshot(
          snapshotBody(
            id,
            docs,
            "2026-08-01T00:00:00Z",
            "2026-11-01T00:00:00Z",
            "2026-11-02T09:00:00Z",
          ),
        );
        // Altered after signing: one more verified page view than SCF signed.
        const web = signed.snapshot.web as { verified: { pageviews: number } };
        web.verified.pageviews += 1;
        return { status: 200, body: { ...signed, status: "valid", revoked_at: null } };
      }
      const x = state().snapshots.find((y) => y.snapshot_id === id && y.status === "signed");
      const t = x ? ctx.tenants().get(x.tenantId) : undefined;
      if (!x || !t || (t.status !== "active" && t.status !== "suspended")) throw notFound();
      const signed = signSnapshot(snapshotBody(id, t, x.period_start, x.period_end, x.created_at));
      return {
        status: 200,
        body: { ...signed, status: x.revoked_at ? "revoked" : "valid", revoked_at: x.revoked_at },
      };
    },
    getSnapshotKeys: () => ({ status: 200, body: JWKS }),
    revokeTractionSnapshot: ({ req, p }) => {
      tenantOf(req, p.tenantId as string);
      const x = state().snapshots.find(
        (y) => y.snapshot_id === p.snapshotId && y.tenantId === p.tenantId,
      );
      if (!x) throw notFound();
      x.revoked_at = iso(Date.now());
      return { status: 204 };
    },
    operatorGetEnrollmentMode: ({ req }) => {
      operator(req);
      return { status: 200, body: { enrollment_mode: state().enrollment } };
    },
    operatorSetEnrollmentMode: ({ req, body }) => {
      stepUp(req, true);
      if (body.enrollment_mode !== "open" && body.enrollment_mode !== "approval_required")
        throw invalid("/enrollment_mode", "open or approval_required");
      state().enrollment = body.enrollment_mode;
      audit(req, "settings.updated", { type: "setting", id: "enrollment_mode" });
      return { status: 200, body: { enrollment_mode: state().enrollment } };
    },
    // ---------------- operator: web ----------------
    operatorWebSummary: ({ req, q }) => {
      operator(req);
      const dl = days(q);
      const variant = q.get("variant") ?? "verified";
      const d = webDays(selectProjects(q), variant, dl);
      audit(req, "operator.read.op_web_metrics", null, { group: "all" });
      if (wantsCsv(req))
        return csv(
          ["day", "pageviews", "visitors_sum", "visits", "bounces"],
          d.map((x) => [x.day, x.pageviews, x.visitors_sum, x.visits, x.bounces]),
        );
      return { status: 200, body: { privacy: PRIVACY, variant, days: d } };
    },
    operatorWebProjects: ({ req, q }) => {
      operator(req);
      days(q);
      const variant = q.get("variant") ?? "verified";
      const min = Number(q.get("min_pageviews") ?? 0);
      const sort = q.get("sort") ?? "-pageviews";
      const desc = sort.startsWith("-");
      const key = (desc ? sort.slice(1) : sort) as keyof ControlPlane.OpWebProjectRow;
      const rows: ControlPlane.OpWebProjectRow[] = selectProjects(q)
        .map((p) => ({
          tenant_id: p.tenant_id,
          slug: p.slug,
          name: p.name,
          verification_level: p.verification_level,
          trust_score_28d: p.trust_score_28d,
          scf_awarded: p.scf_awarded,
          ...webCells(p, variant),
        }))
        .filter((r) => r.pageviews >= min)
        .sort((a: ControlPlane.OpWebProjectRow, b: ControlPlane.OpWebProjectRow) => {
          if (key === "name") return a.name.localeCompare(b.name);
          const x = (a[key] as number | null) ?? -1;
          const y = (b[key] as number | null) ?? -1;
          return desc ? y - x : x - y;
        });
      audit(req, "operator.read.op_web_metrics", null, { group: "tenant" });
      if (wantsCsv(req))
        return csv(
          [
            "tenant_id",
            "slug",
            "pageviews",
            "visitors_sum",
            "visits",
            "bounce_rate_pct",
            "avg_visit_duration_s",
          ],
          rows.map((r) => [
            r.tenant_id,
            r.slug,
            r.pageviews,
            r.visitors_sum,
            r.visits,
            r.bounce_rate_pct,
            r.avg_visit_duration_s,
          ]),
        );
      return { status: 200, body: { items: rows, next_cursor: null, privacy: PRIVACY } };
    },
    operatorWebCompare: ({ req, q }) => {
      operator(req);
      const dl = days(q);
      const list = ids(q);
      if (list.length < 2 || list.length > 10) throw invalid("/tenant_ids", "2–10 projects");
      const variant = q.get("variant") ?? "verified";
      const series = list.map((id) => {
        const p = OP_PROJECTS.find((x) => x.tenant_id === id);
        if (!p) throw notFound();
        return { tenant_id: id, slug: p.slug, days: webDays([p], variant, dl) };
      });
      audit(req, "operator.read.op_web_metrics", null, { group: "compare" });
      if (wantsCsv(req))
        return csv(
          ["tenant_id", "slug", "day", "pageviews", "visitors_sum", "visits"],
          series.flatMap((s) =>
            s.days.map((d) => [s.tenant_id, s.slug, d.day, d.pageviews, d.visitors_sum, d.visits]),
          ),
        );
      return { status: 200, body: { privacy: PRIVACY, series } };
    },
    operatorWebBreakdown: ({ req, q }) => {
      operator(req);
      days(q);
      const allowed = new Set(selectProjects(q).map((p) => p.tenant_id));
      const dimension = q.get("dimension") ?? "country";
      const rows =
        dimension === "country" ? OP_COUNTRY_ROWS.filter((r) => allowed.has(r.tenant_id)) : [];
      audit(req, "operator.read.op_web_breakdown", null, { dimension });
      return { status: 200, body: { privacy: PRIVACY, dimension, rows } };
    },
    // ---------------- operator: API ----------------
    operatorApiSummary: ({ req, q }) => {
      operator(req);
      const dl = days(q);
      const d = apiDays(selectServices(q), dl);
      audit(req, "operator.read.op_api_metrics", null, { group: "all" });
      if (wantsCsv(req))
        return csv(
          ["day", "requests", "s5xx", "p50_ms", "p95_ms", "p99_ms", "accuracy_class"],
          d.map((x) => [x.day, x.requests, x.s5xx, x.p50_ms, x.p95_ms, x.p99_ms, x.accuracy_class]),
        );
      return {
        status: 200,
        body: { privacy: PRIVACY, label: "self-attested telemetry", days: d },
      };
    },
    operatorApiServices: ({ req, q }) => {
      operator(req);
      const n = days(q).length;
      const min = Number(q.get("min_requests") ?? 0);
      const sort = q.get("sort") ?? "-requests";
      const desc = sort.startsWith("-");
      const key = desc ? sort.slice(1) : sort;
      const rows: ControlPlane.OpApiServiceRow[] = selectServices(q)
        .map((s) => {
          const p = OP_PROJECTS.find((x) => x.tenant_id === s.tenant_id) as OpProject;
          return {
            tenant_id: s.tenant_id,
            slug: p.slug,
            service_id: s.service_id,
            service_name: s.service_name,
            verification_level: p.verification_level,
            assurance_level: s.assurance_level,
            onchain_badge: s.onchain_badge,
            active_days: Math.min(n, Math.round((s.active_days_30 * Math.min(n, 30)) / 30)),
            ...s.cells,
          };
        })
        .filter((r) => r.requests >= min)
        .sort((a, b) => {
          if (key === "name") return a.service_name.localeCompare(b.service_name);
          const v = (r: ControlPlane.OpApiServiceRow) =>
            key === "error_rate_5xx"
              ? (r.error_rate_5xx ?? -1)
              : key === "p95_ms"
                ? (r.p95_ms ?? -1)
                : key === "active_days"
                  ? (r.active_days ?? 0)
                  : r.requests;
          return desc ? v(b) - v(a) : v(a) - v(b);
        });
      audit(req, "operator.read.op_api_metrics", null, { group: "service" });
      if (wantsCsv(req))
        return csv(
          [
            "tenant_id",
            "slug",
            "service_name",
            "requests",
            "error_rate_5xx",
            "p50_ms",
            "p95_ms",
            "p99_ms",
            "accuracy_class",
          ],
          rows.map((r) => [
            r.tenant_id,
            r.slug,
            r.service_name,
            r.requests,
            r.error_rate_5xx,
            r.p50_ms,
            r.p95_ms,
            r.p99_ms,
            r.accuracy_class,
          ]),
        );
      return {
        status: 200,
        body: {
          items: rows,
          next_cursor: null,
          privacy: PRIVACY,
          label: "self-attested telemetry",
        },
      };
    },
    operatorApiCompare: ({ req, q }) => {
      operator(req);
      const dl = days(q);
      const list = ids(q);
      if (list.length < 2 || list.length > 10) throw invalid("/tenant_ids", "2–10 projects");
      const series = list.map((id) => {
        const p = OP_PROJECTS.find((x) => x.tenant_id === id);
        if (!p) throw notFound();
        return {
          tenant_id: id,
          slug: p.slug,
          days: apiDays(
            OP_SERVICES.filter((s) => s.tenant_id === id),
            dl,
          ),
        };
      });
      audit(req, "operator.read.op_api_metrics", null, { group: "compare" });
      if (wantsCsv(req))
        return csv(
          ["tenant_id", "slug", "day", "requests", "s5xx", "p95_ms"],
          series.flatMap((s) =>
            s.days.map((d) => [s.tenant_id, s.slug, d.day, d.requests, d.s5xx, d.p95_ms]),
          ),
        );
      return { status: 200, body: { privacy: PRIVACY, label: "self-attested telemetry", series } };
    },
    operatorApiRoutes: ({ req, q }) => {
      operator(req);
      days(q);
      const tenantId = q.get("tenant_id") ?? "";
      tenantForOp(tenantId);
      const svcId = q.get("service_id");
      const svcs = OP_SERVICES.filter(
        (s) => s.tenant_id === tenantId && (!svcId || s.service_id === svcId),
      );
      if (svcId && svcs.length === 0) throw notFound();
      const items: ControlPlane.OpApiRouteRow[] = svcs.flatMap((s) =>
        (ROUTES[s.service_id] ?? []).map((r) => {
          const s5 = Math.round(r.requests * (r.error_rate_5xx ?? 0));
          return {
            service_id: s.service_id,
            route: r.route,
            rpc_method: r.rpc_method ?? null,
            requests: r.requests,
            s2xx: r.requests - s5,
            s5xx: s5,
            error_rate_5xx: r.error_rate_5xx ?? null,
            mean_ms: null,
            p50_ms: r.latency.p50_ms,
            p95_ms: r.latency.p95_ms,
            p99_ms: r.latency.p99_ms,
            accuracy_class: r.latency.accuracy_class,
          };
        }),
      );
      audit(
        req,
        "operator.read.op_api_metrics",
        { type: "tenant", id: tenantId },
        { group: "route" },
      );
      return { status: 200, body: { items, next_cursor: null, privacy: PRIVACY } };
    },
    // ---------------- operator: audit and keys ----------------
    operatorListAudit: ({ req, q }) => {
      operator(req);
      const prefix = q.get("action_prefix") ?? "";
      const tenant = q.get("tenant_id");
      const items = [...state().audit, ...seedAudit()]
        .filter((e) => e.action.startsWith(prefix))
        .filter((e) => !tenant || e.target_id === tenant)
        // like the control plane: oldest first, paged with a cursor; pages of at most 5 here so the portal's
        // cursor walk is exercised with few rows
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
      const from = Number(q.get("cursor") ?? 0) || 0;
      const size = Math.min(Number(q.get("limit") ?? 50) || 50, 5);
      const page = items.slice(from, from + size);
      const next = from + size < items.length ? String(from + size) : null;
      audit(req, "operator.read.op_audit_list", null);
      return { status: 200, body: { items: page, next_cursor: next } };
    },
    operatorListErasureRequests: ({ req, q }) => {
      operator(req);
      const statuses = (q.get("status") ?? "").split(",").filter((x) => x !== "");
      const tenant = q.get("tenant_id");
      const items: ControlPlane.OperatorErasureRequest[] = [...state().erasures.values()]
        .filter((e) => statuses.length === 0 || statuses.includes(e.status))
        .filter((e) => !tenant || e.tenantId === tenant)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((e) => ({
          tenant_id: e.tenantId,
          slug: ctx.tenants().get(e.tenantId)?.slug ?? "unknown",
          request_id: e.request_id,
          scope: e.scope,
          site_id: e.site_id ?? null,
          service_id: e.service_id ?? null,
          start: e.criteria.start,
          end: e.criteria.end,
          selector_type: e.selector?.type ?? null,
          selector_redacted: e.selector_redacted_at !== null,
          status: e.status,
          created_at: e.created_at,
          confirmed_at: e.confirmed_at ?? null,
          completed_at: e.completed_at ?? null,
          failure_code: null,
          counts: e.result ?? e.preview ?? null,
        }));
      audit(req, "operator.read.op_erasure_requests", null);
      return { status: 200, body: { items, next_cursor: null } };
    },
    operatorListApiKeys: ({ req }) => {
      operator(req);
      return { status: 200, body: state().apiKeys };
    },
    operatorCreateApiKey: ({ req, body }) => {
      const s = stepUp(req, true);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label) throw invalid("/label", "required");
      const scopes = Array.isArray(body.scopes)
        ? (body.scopes as ControlPlane.OperatorApiKey["scopes"])
        : [];
      if (scopes.length === 0) throw invalid("/scopes", "at least one scope");
      const daysValid = Number(body.expires_in_days ?? 90);
      if (!(daysValid >= 1 && daysValid <= 365)) throw invalid("/expires_in_days", "1–365");
      const id = b62(12);
      const secret = b62(27);
      const k: ControlPlane.OperatorApiKey = {
        key_id: id,
        display: `scfa_op_${id}_…${secret.slice(-4)}`,
        label,
        scopes,
        tenant_restriction: Array.isArray(body.tenant_restriction)
          ? (body.tenant_restriction as string[])
          : null,
        rate_limit_per_min: Number(body.rate_limit_per_min ?? 60),
        created_by: s.userId.length === 36 ? s.userId : "c0000000-0000-4000-8000-000000000003",
        created_at: iso(Date.now()),
        expires_at: iso(Date.now() + daysValid * DAY),
        last_used_at: null,
        revoked_at: null,
        flagged_for_review: false,
      };
      state().apiKeys.push(k);
      audit(req, "api_key.created", { type: "api_key", id });
      return { status: 201, body: { ...k, key: `scfa_op_${id}_${secret}${b62(6)}` } };
    },
    operatorRevokeApiKey: ({ req, p, body }) => {
      stepUp(req, true);
      if (String(body.reason ?? "").trim().length < 3) throw invalid("/reason", "required");
      const k = state().apiKeys.find((x) => x.key_id === p.keyId);
      if (!k) throw notFound();
      if (k.revoked_at) throw new MockProblem(409, "conflict", "Already revoked");
      k.revoked_at = iso(Date.now());
      audit(req, "api_key.revoked", { type: "api_key", id: k.key_id });
      return { status: 204 };
    },
  };
  const helpers: D1Helpers = {
    tenants: () => ctx.tenants(),
    sites: () => ctx.sites(),
    services: () => state().services,
    tenantOf,
    operator: (req) => operator(req),
    audit,
    snapshots: () => state().snapshots,
    d1: () => state().d1,
    v1PublicSnapshot: base.getPublicSnapshot as Handler,
    notFound,
    invalid,
    problem: (status, code, detail) => new MockProblem(status, code, detail),
  };
  return { ...base, ...d1Handlers(helpers) };
}

/** Historic audit rows (tenant erasure lifecycle; C-88: types and counts only, never the selector). */
function seedAudit(): ControlPlane.AuditEntry[] {
  const row = (
    seq: number,
    at: string,
    action: ControlPlane.AuditAction,
    details: Json,
  ): ControlPlane.AuditEntry => ({
    chain_id: T.docs,
    seq,
    occurred_at: at,
    actor_kind: action === "erasure.completed" ? "system" : "user",
    actor_id: null,
    actor_display: action === "erasure.completed" ? null : "octo-dev",
    action,
    target_type: "erasure_request",
    target_id: T.docs,
    outcome: "success",
    details,
    row_hash: createHash("sha256").update(`${seq}${action}`).digest("hex"),
    prev_hash: createHash("sha256")
      .update(`${seq - 1}`)
      .digest("hex"),
  });
  return [
    row(41, "2026-08-05T11:50:00Z", "erasure.requested", {
      selector_type: "path_pattern",
      selector_length: 17,
    }),
    row(42, "2026-08-05T11:55:00Z", "erasure.confirmed", { website_events: 120 }),
    row(43, "2026-08-05T12:00:00Z", "erasure.completed", {
      website_events: 120,
      sessions_orphaned: 3,
    }),
  ];
}
