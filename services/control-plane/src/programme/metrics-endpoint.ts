// SPDX-License-Identifier: Apache-2.0
// The per-tenant programme `metrics_endpoint` (ADR-0032, C-14, C-47, C-94; wire-formats §i.1).
//
// Documents are rebuilt hourly by job `public_metrics` (data-model §6.3), which runs in the JOBS service (F16): the
// figures are read and the document written as scf_jobs under each tenant's context with `app.job = public_metrics`
// (migration 0059 gives the job the preferred API views). Reads, here in the control plane:
//   - no Authorization: `scf.public_metrics_document(slug)` — only tenants that switched public stats on;
//   - `Bearer scfa_pub_…`: the share key is verified (HMAC under pepper_pub), then the same definer function with the
//     key's tenant — a key opens its own tenant's document only;
//   - `Bearer scfa_op_…`: verified like `/op/v1`, then `scf.op_metrics_document(slug)` as scf_metrics_ro, which needs
//     `web:read` and `api:read`, honours the tenant restriction and writes the audit row (CR-21, CR-22).
// Anything else — unknown slug, inactive tenant, private document, wrong or revoked key, a key in the URL — is the same
// 404 (no existence oracle). Anonymous answers are `public, max-age=3600`, keyed answers `private`; both carry an ETag.

import { createHash } from "node:crypto";
import type { Database } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { type Peppers, parseKey, verifySecret } from "../keys/keys.ts";
import type { OpKeyAuth } from "../opmetrics/keyauth.ts";
import { REASON_VERDICT } from "../web/reasons.ts";
import { DAY, isoZ, projectInfo, tenantApi, tenantFiltered, tenantWeb } from "./figures.ts";

export const METRICS_SCHEMA = "scf-analytics/metrics-endpoint/1";

/** Builds one tenant's document from the rollups (§i.1); `now` fixes the window (last N complete UTC days). */
export async function buildMetricsDocument(
  jobsDb: Database,
  tenantId: string,
  portalOrigin: string,
  now: number,
): Promise<{ document: Record<string, unknown>; active: boolean }> {
  return jobsDb.tx(
    { tenantId, actorKind: "job", actorId: "public_metrics", job: "public_metrics" },
    async (tx) => {
      const w = await tx.maybeOne<{ v: number }>(
        `SELECT (value #>> '{}')::int AS v FROM scf.settings WHERE key = 'public_metrics_window_days'`,
      );
      const days = Math.max(1, Number(w?.v ?? 30));
      const end = Math.floor(now / DAY) * DAY;
      const start = end - days * DAY;
      const p = await projectInfo(tx, tenantId);
      const web = await tenantWeb(tx, tenantId, start, end);
      const api = await tenantApi(tx, tenantId, start, end);
      const filtered = await tenantFiltered(tx, tenantId, start, end, REASON_VERDICT);
      const byDay = new Map(web.days.map((d) => [d.day, d]));
      const apiByDay = new Map(api.days.map((d) => [d.day, d.requests]));
      const daily: Record<string, unknown>[] = [];
      const apiDaily: Record<string, unknown>[] = [];
      for (let t = start; t < end; t += DAY) {
        const d = byDay.get(t);
        daily.push({
          start: isoZ(t),
          pageviews_verified: d?.pv_v ?? 0,
          pageviews_raw: d?.pv_r ?? 0,
          visitors_sum_verified: d?.vis_v ?? 0,
          visitors_sum_raw: d?.vis_r ?? 0,
        });
        apiDaily.push({ start: isoZ(t), requests: apiByDay.get(t) ?? 0 });
      }
      return {
        active: p.status === "active",
        document: {
          schema: METRICS_SCHEMA,
          project: { slug: p.slug, name: p.name, verification_level: p.verification_level },
          generated_at: isoZ(now),
          window: { start: isoZ(start), end: isoZ(end), days },
          web: {
            verified: web.verified,
            raw: web.raw,
            visit_metrics: web.visit_metrics,
            daily,
            filtered,
          },
          api: {
            label: api.label,
            requests: api.requests,
            error_rate_5xx: api.error_rate_5xx,
            p95_ms: api.p95_ms,
            accuracy_class: api.accuracy_class,
            assurance_level: api.assurance_level,
            onchain_consistent: api.onchain_consistent,
            daily: apiDaily,
          },
          links: { definitions: `${portalOrigin}/docs/metric-definitions/1` },
        },
      };
    },
  );
}

export interface PublicMetricsLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Job `public_metrics`: every interval (default hourly) and at start, one document per active tenant. */
export class PublicMetricsJob {
  readonly #jobsDb: Database;
  readonly #portalOrigin: string;
  readonly #intervalMs: number;
  readonly #log: PublicMetricsLogger;
  readonly #clock: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;

  readonly #onOutcome: ((o: "success" | "failure") => void) | undefined;

  constructor(
    jobsDb: Database,
    opts: {
      portalOrigin: string;
      intervalMs: number;
      log: PublicMetricsLogger;
      now?: () => number;
      onOutcome?: (o: "success" | "failure") => void;
    },
  ) {
    this.#onOutcome = opts.onOutcome;
    this.#jobsDb = jobsDb;
    this.#portalOrigin = opts.portalOrigin;
    this.#intervalMs = opts.intervalMs;
    this.#log = opts.log;
    this.#clock = opts.now ?? Date.now;
  }

  async start(): Promise<void> {
    void this.trigger();
    this.#timer = setInterval(() => void this.trigger(), this.#intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.#running;
  }

  /** Runs one pass unless one is running; resolves to the number of documents written. */
  trigger(): Promise<number> {
    if (!this.#running)
      this.#running = this.runOnce()
        .then((n) => {
          this.#onOutcome?.("success");
          return n;
        })
        .catch((err: unknown) => {
          this.#onOutcome?.("failure");
          this.#log.error(
            { err: err instanceof Error ? err.message : "error" },
            "public_metrics failed",
          );
          return 0;
        })
        .finally(() => {
          this.#running = undefined;
        });
    return this.#running;
  }

  async runOnce(): Promise<number> {
    const now = this.#clock();
    // Cross-tenant read of the work list (named job, no tenant context, data-model §6.3).
    const tenants = await this.#jobsDb.tx(
      { tenantId: null, actorKind: "job", actorId: "public_metrics", job: "public_metrics" },
      (tx) =>
        tx.query<{ tenant_id: string }>(
          `SELECT tenant_id::text AS tenant_id FROM scf.tenants
            WHERE status = 'active' AND purged_at IS NULL AND NOT is_canary ORDER BY tenant_id`,
        ),
    );
    let n = 0;
    for (const { tenant_id } of tenants) {
      try {
        const { document, active } = await buildMetricsDocument(
          this.#jobsDb,
          tenant_id,
          this.#portalOrigin,
          now,
        );
        if (!active) continue;
        await this.#jobsDb.tx(
          {
            tenantId: tenant_id,
            actorKind: "job",
            actorId: "public_metrics",
            job: "public_metrics",
          },
          (tx) =>
            tx.query(
              `INSERT INTO scf.public_metrics_documents (tenant_id, document, generated_at) VALUES ($1, $2, $3)
               ON CONFLICT (tenant_id) DO UPDATE SET document = EXCLUDED.document, generated_at = EXCLUDED.generated_at`,
              [tenant_id, JSON.stringify(document), new Date(now)],
            ),
        );
        n++;
      } catch (err) {
        this.#log.error(
          { tenant: tenant_id, err: err instanceof Error ? err.message : "error" },
          "public_metrics: tenant failed",
        );
      }
    }
    this.#log.info({ documents: n }, "public_metrics");
    return n;
  }
}

function etagOf(body: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 27)}"`;
}

export function metricsEndpointHandlers(deps: {
  peppers: Peppers;
  opKeys: OpKeyAuth;
  metricsDb: Database | undefined;
}): Record<string, Handler> {
  const getMetricsEndpoint: Handler = async (ctx) => {
    const slug = ctx.params.slug as string;
    // A key in the URL is a leaked key (wire-formats §k): never accepted, and the answer says nothing.
    const q = JSON.stringify(ctx.query);
    if (/scfa_(op|ing|pub)_/.test(q)) {
      await deps.opKeys.revokeExposed(q, ctx.requestId); // an operator key there is revoked (C-119)
      throw new ApiError("not_found");
    }
    const auth = ctx.header("authorization");
    let doc: unknown = null;
    let keyed = false;
    if (auth === undefined) {
      doc = await ctx.tx(
        async (tx) =>
          (
            await tx.maybeOne<{ d: unknown }>(`SELECT scf.public_metrics_document($1, NULL) AS d`, [
              slug,
            ])
          )?.d ?? null,
        { tenantId: null, actorKind: "anonymous", actorId: null },
      );
    } else {
      keyed = true;
      const m = /^Bearer (scfa_(pub|op)_[0-9A-Za-z_]+)$/.exec(auth);
      if (!m) throw new ApiError("not_found");
      if (m[2] === "pub") {
        const parsed = parseKey(m[1] as string, "pub");
        if (!parsed.ok) throw new ApiError("not_found");
        doc = await ctx.tx(
          async (tx) => {
            const k = await tx.maybeOne<{
              tenant_id: string;
              secret_hash: Buffer;
              pepper_version: number;
              usable: boolean;
            }>(
              `SELECT tenant_id::text AS tenant_id, secret_hash, pepper_version, usable FROM scf.lookup_share_key($1)`,
              [parsed.key.id],
            );
            if (
              !k?.usable ||
              !verifySecret(deps.peppers.pub, k.pepper_version, parsed.key.secret, k.secret_hash)
            )
              return null;
            const d =
              (
                await tx.maybeOne<{ d: unknown }>(
                  `SELECT scf.public_metrics_document($1, $2::uuid) AS d`,
                  [slug, k.tenant_id],
                )
              )?.d ?? null;
            // last_used_at at most once a minute, under the key's tenant (system actor: pub_key has no tenant rights).
            await tx.switchContext({
              tenantId: k.tenant_id,
              actorKind: "system",
              actorId: "share_key",
            });
            await tx.query(
              `UPDATE scf.share_keys SET last_used_at = now()
                WHERE tenant_id = $1 AND key_id = $2 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
              [k.tenant_id, parsed.key.id],
            );
            return d;
          },
          { tenantId: null, actorKind: "anonymous", actorId: null },
        );
      } else {
        const db = deps.metricsDb;
        if (!db) throw new ApiError("not_found");
        let key: Awaited<ReturnType<OpKeyAuth["authenticate"]>>["key"];
        try {
          key = (await deps.opKeys.authenticate(auth, ctx.requestId)).key;
        } catch {
          throw new ApiError("not_found");
        }
        if (!(key.scopes.includes("web:read") && key.scopes.includes("api:read")))
          throw new ApiError("not_found");
        doc = await db.tx(
          {
            tenantId: null,
            actorKind: "op_key",
            actorId: key.key_id,
            keyScopes: key.scopes,
            keyTenants: key.tenant_restriction,
            requestId: ctx.requestId,
          },
          async (tx) =>
            (await tx.maybeOne<{ d: unknown }>(`SELECT scf.op_metrics_document($1) AS d`, [slug]))
              ?.d ?? null,
        );
      }
    }
    if (!doc) throw new ApiError("not_found");
    const etag = etagOf(doc);
    const headers: Record<string, string> = {
      etag,
      "cache-control": keyed ? "private, max-age=300" : "public, max-age=3600",
      vary: "Authorization",
    };
    const inm = ctx.header("if-none-match");
    if (inm?.split(",").some((t) => t.trim() === etag)) return { status: 304, headers };
    return { status: 200, body: doc, headers };
  };
  return { getMetricsEndpoint };
}
