// SPDX-License-Identifier: Apache-2.0
// Tenant lifecycle by SCF operators (C-08, C-09, C-64, C-91, C-94; data-model §8.3, §11), enrollment mode (ADR-0015,
// C-19), enrollment tombstones (C-64, C-70), the operator tenant list, the tenant audit log, the installation check
// (C-39) and the tracker snippet (ADR-0004, C-55, C-100).
//
// Every status change by an SCF operator goes through `scf.op_tenant_transition()` (a SECURITY DEFINER function that
// authorises, audits and notifies the edge in the same transaction); the edge refuses ingest for a suspended or
// removed tenant at the next snapshot (≤ 60 s, C-06). Operators never read tenant tables directly (C-17): the
// `Tenant` echo after a transition is read in the same transaction under that tenant's context as `system`.

import type { Tx } from "../db/database.ts";
import { pgCode } from "../db/database.ts";
import { tenantView } from "../domain/tenants.ts";
import { type Handler, invalidateReadOnlyMode, type RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { registryFactsByTenant } from "../operator/common.ts";
import {
  selectTrackerVersion,
  type TrackerRegistry,
  trackerOutdated,
  trackerVersionSeen,
} from "../tracker.ts";
import { REASON_VERDICT } from "../web/reasons.ts";

export interface LifecycleDeps {
  tracker: TrackerRegistry;
  noticeTextUrl: string | undefined;
  now?: () => number;
}

const DAY = 86_400_000;

/** Maps the errors of the op_* functions to problems: unknown/purged tenant 404, invalid transition 409. */
function opError(err: unknown): never {
  const code = pgCode(err);
  if (code === "P0002") throw new ApiError("not_found");
  if (code === "22023")
    throw new ApiError("conflict", "this transition is not possible from the tenant's status");
  if (code === "42501") throw new ApiError("forbidden");
  throw err;
}

/** Reads the tenant back after an operator action, as `system` under that tenant (no extra audit row). */
async function echoTenant(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
  await tx.switchContext({ tenantId, actorKind: "system", actorId: "operator-action-echo" });
  return tenantView(tx, tenantId);
}

function encodeCursor(v: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
}

function decodeCursor(c: unknown): Record<string, unknown> | null {
  if (typeof c !== "string" || c.length === 0) return null;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ApiError("validation_failed", "invalid cursor", {
    errors: [{ pointer: "/cursor", detail: "invalid cursor" }],
  });
}

function htmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function lifecycleHandlers(deps: LifecycleDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  // ----------------------------------------------------------------------------------- operator transitions

  async function transition(
    ctx: RequestContext,
    action: string,
    reason: string,
    reasonCode: string | null = null,
  ) {
    const tenantId = ctx.params.tenantId as string;
    const body = await ctx.tx(async (tx) => {
      try {
        // K1 (0087): the removal reason code is stored with the tenant and audited by the function itself.
        await tx.query(`SELECT scf.op_tenant_transition($1::uuid, $2, $3, $4)`, [
          tenantId,
          action,
          reason,
          reasonCode,
        ]);
      } catch (err) {
        opError(err);
      }
      return echoTenant(tx, tenantId);
    });
    return { status: 200, body };
  }

  const operatorTransitionTenant: Handler = async (ctx) => {
    const b = ctx.body as { action: "approve" | "suspend" | "reinstate"; reason: string };
    return transition(ctx, b.action, b.reason);
  };
  const operatorRemoveTenant: Handler = async (ctx) => {
    const b = ctx.body as { reason: string; reason_code?: string };
    return transition(ctx, "remove", b.reason, b.reason_code ?? null);
  };
  const operatorRestoreTenant: Handler = async (ctx) =>
    transition(ctx, "restore", (ctx.body as { reason: string }).reason);
  const operatorPurgeTenant: Handler = async (ctx) =>
    transition(ctx, "purge_now", (ctx.body as { reason: string }).reason);

  /** C-91/C-94: every `active` tenant at one of the levels moves to `pending`, one audited transition each. */
  const operatorRequireReapproval: Handler = async (ctx) => {
    const b = ctx.body as { levels: string[]; reason: string };
    const levels = b.levels.map((l) => Number(l.slice(1)));
    const moved = await ctx.tx(async (tx) => {
      const rows = await tx.query<{ tenant_id: string; verification_level: number }>(
        `SELECT tenant_id, verification_level FROM scf.op_projects(0::smallint, '{active}'::scf.tenant_status[], NULL)`,
      );
      const ids = rows
        .filter((r) => levels.includes(Number(r.verification_level)))
        .map((r) => r.tenant_id)
        .sort();
      for (const id of ids) {
        try {
          await tx.query(`SELECT scf.op_tenant_transition($1::uuid, 'require_reapproval', $2)`, [
            id,
            b.reason,
          ]);
        } catch (err) {
          opError(err);
        }
      }
      return ids;
    });
    return { status: 200, body: { moved_count: moved.length, tenant_ids: moved } };
  };

  const operatorListTenants: Handler = async (ctx) => {
    const q = ctx.query as {
      status?: string[];
      min_level?: string;
      q?: string;
      sort?: string;
      cursor?: string;
      limit?: number;
    };
    const statuses = q.status && q.status.length > 0 ? q.status : ["active", "suspended"];
    const minLevel = q.min_level ? Number(q.min_level.slice(1)) : 0;
    const limit = Number(q.limit ?? 50);
    const offset = Number(decodeCursor(q.cursor)?.o ?? 0);
    if (!Number.isInteger(offset) || offset < 0)
      throw new ApiError("validation_failed", "invalid cursor", {
        errors: [{ pointer: "/cursor", detail: "invalid cursor" }],
      });
    const sort = q.sort ?? "name";
    const order: Record<string, string> = {
      name: "name, tenant_id",
      created_at: "created_at, tenant_id",
      "-created_at": "created_at DESC, tenant_id",
      verification_level: "verification_level, name, tenant_id",
      "-verification_level": "verification_level DESC, name, tenant_id",
    };
    const { rows, registry } = await ctx.tx(async (tx) => {
      const rows = await tx.query<{
        tenant_id: string;
        slug: string;
        name: string;
        status: string;
        created_at: Date;
        verification_level: number;
        scf_awarded: boolean | null;
        registry_project_ids: string[] | null;
        site_count: string;
        service_count: string;
      }>(
        `SELECT tenant_id, slug, name, status::text AS status, created_at, verification_level, scf_awarded,
                registry_project_ids::text[] AS registry_project_ids, site_count::text, service_count::text
           FROM scf.op_projects($1::smallint, $2::scf.tenant_status[], $3)
          ORDER BY ${order[sort] ?? order.name} LIMIT $4 OFFSET $5`,
        [minLevel, statuses, q.q ?? null, limit + 1, offset],
      );
      // K1: the public registry facts of the confirmed links (global table, not tenant data).
      const registry = await registryFactsByTenant(
        tx,
        rows.map((r) => ({ tenantId: r.tenant_id, ids: r.registry_project_ids ?? [] })),
      );
      return { rows, registry };
    });
    const items = rows.slice(0, limit).map((r) => ({
      tenant_id: r.tenant_id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      created_at: r.created_at.toISOString(),
      verification_level: `L${Number(r.verification_level)}`,
      scf_awarded: r.scf_awarded,
      registry_project_ids: r.registry_project_ids ?? [],
      registry_link: registry.get(r.tenant_id) ?? null,
      site_count: Number(r.site_count),
      service_count: Number(r.service_count),
    }));
    return {
      status: 200,
      body: {
        items,
        next_cursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null,
      },
    };
  };

  // ----------------------------------------------------------------------------------- tombstones (C-64, C-70)

  const operatorListTombstones: Handler = async (ctx) => {
    const limit = Number(ctx.query.limit ?? 50);
    const after = decodeCursor(ctx.query.cursor);
    const afterId = typeof after?.id === "string" ? after.id : null;
    const rows = await ctx.tx(async (tx) => {
      // The read itself is audited (operator.read.tombstones) in the same transaction.
      await tx.audit({ action: "operator.read.tombstones", details: { limit } });
      return tx.query<{
        tombstone_id: string;
        kind: string;
        subject: string;
        tenant_id: string;
        reason: string | null;
        created_at: Date;
        lifted_at: Date | null;
      }>(
        `SELECT tombstone_id, kind, subject, tenant_id, reason, created_at, lifted_at
           FROM scf.enrollment_tombstones
          WHERE ($1::uuid IS NULL OR tombstone_id > $1::uuid)
          ORDER BY tombstone_id LIMIT $2`,
        [afterId, limit + 1],
      );
    });
    const items = rows.slice(0, limit).map((r) => ({
      ...r,
      created_at: r.created_at.toISOString(),
      lifted_at: r.lifted_at?.toISOString() ?? null,
    }));
    return {
      status: 200,
      body: {
        items,
        next_cursor:
          rows.length > limit ? encodeCursor({ id: items[items.length - 1]?.tombstone_id }) : null,
      },
    };
  };

  const operatorLiftTombstone: Handler = async (ctx) => {
    await ctx.tx(async (tx) => {
      try {
        await tx.query(`SELECT scf.op_lift_tombstone($1::uuid)`, [ctx.params.tombstoneId]);
      } catch (err) {
        opError(err);
      }
    });
    return { status: 204 };
  };

  // ----------------------------------------------------------------------------------- settings

  interface SettingRow extends Record<string, unknown> {
    key: string;
    value: unknown;
    description: string;
    public: boolean;
    updated_at: Date | null;
  }
  const settingView = (r: SettingRow) => ({
    key: r.key,
    value: r.value,
    description: r.description,
    public: r.public,
    ...(r.updated_at ? { updated_at: r.updated_at.toISOString() } : {}),
  });

  const operatorGetSettings: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      tx.query<SettingRow>(
        `SELECT key, value, COALESCE(description, '') AS description, public, updated_at FROM scf.settings ORDER BY key`,
      ),
    );
    return { status: 200, body: rows.map(settingView) };
  };

  async function updateSetting(
    tx: Tx,
    key: string,
    value: unknown,
    by: string | null,
  ): Promise<SettingRow> {
    const cur = await tx.maybeOne<SettingRow>(
      `SELECT key, value, COALESCE(description, '') AS description, public, updated_at FROM scf.settings WHERE key = $1`,
      [key],
    );
    if (!cur) throw new ApiError("not_found");
    if (!settingValueAllowed(key, value))
      throw new ApiError("unprocessable", "value not allowed for this setting");
    // The settings_write policy requires the audit row of this transaction first (audited_in_tx).
    await tx.audit({
      action: "settings.updated",
      targetType: "setting",
      targetId: key,
      details: { key, from: cur.value, to: value },
    });
    try {
      return await tx.one<SettingRow>(
        `UPDATE scf.settings SET value = $2::jsonb, updated_at = now(), updated_by = $3
          WHERE key = $1
          RETURNING key, value, COALESCE(description, '') AS description, public, updated_at`,
        [key, JSON.stringify(value), by],
      );
    } catch (err) {
      const code = pgCode(err);
      if (code === "23514" || code === "22P02" || code === "22023")
        throw new ApiError("unprocessable", "value not allowed for this setting");
      throw err;
    }
  }

  const operatorUpdateSetting: Handler = async (ctx) => {
    const key = ctx.params.key as string;
    const value = (ctx.body as { value: unknown }).value;
    const row = await ctx.tx(async (tx) => {
      const r = await updateSetting(tx, key, value, ctx.session?.userId ?? null);
      await tx.notify("scf_edge");
      return r;
    });
    if (key === "read_only_mode") invalidateReadOnlyMode();
    return { status: 200, body: settingView(row) };
  };

  const operatorGetEnrollmentMode: Handler = async (ctx) => {
    const r = await ctx.tx((tx) =>
      tx.one<{ mode: string }>(
        `SELECT value #>> '{}' AS mode FROM scf.settings WHERE key = 'enrollment_mode'`,
      ),
    );
    return { status: 200, body: { enrollment_mode: r.mode } };
  };

  /** Switching affects new enrollments only (C-19); existing tenants move only through re-approval (C-91). */
  const operatorSetEnrollmentMode: Handler = async (ctx) => {
    const mode = (ctx.body as { enrollment_mode: string }).enrollment_mode;
    const r = await ctx.tx((tx) =>
      updateSetting(tx, "enrollment_mode", mode, ctx.session?.userId ?? null),
    );
    return { status: 200, body: { enrollment_mode: r.value } };
  };

  // ----------------------------------------------------------------------------------- tenant audit log

  const listTenantAudit: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const q = ctx.query as { start?: string; end?: string; action_prefix?: string; limit?: number };
    const limit = Number(q.limit ?? 50);
    const after = decodeCursor(ctx.query.cursor);
    const afterSeq =
      after && typeof after.s === "string" && /^\d{1,18}$/.test(after.s) ? after.s : null;
    if (after && afterSeq === null)
      throw new ApiError("validation_failed", "invalid cursor", {
        errors: [{ pointer: "/cursor", detail: "invalid cursor" }],
      });
    const rows = await ctx.tx((tx) =>
      tx.query<{
        chain_id: string;
        seq: string;
        occurred_at: Date;
        actor_kind: string;
        actor_id: string | null;
        actor_display: string | null;
        action: string;
        target_type: string | null;
        target_id: string | null;
        outcome: string;
        details: Record<string, unknown>;
        row_hash: Buffer;
        prev_hash: Buffer;
      }>(
        // Newest first; the chain is this tenant's (chain_id = tenant_id), so seq orders it.
        `SELECT a.chain_id, a.seq::text AS seq, a.occurred_at, a.actor_kind, a.actor_id,
                CASE WHEN a.actor_kind IN ('user', 'operator') THEN u.display_name END AS actor_display,
                a.action, a.target_type, a.target_id, a.outcome, a.details, a.row_hash, a.prev_hash
           FROM scf.audit_log a
           LEFT JOIN scf.users u ON a.actor_kind IN ('user', 'operator') AND u.user_id::text = a.actor_id
          WHERE a.tenant_id = $1 AND a.chain_id = $1
            AND ($2::timestamptz IS NULL OR a.occurred_at >= $2) AND ($3::timestamptz IS NULL OR a.occurred_at < $3)
            AND ($4::text IS NULL OR a.action LIKE $4 || '%')
            AND ($5::bigint IS NULL OR a.seq < $5)
          ORDER BY a.seq DESC LIMIT $6`,
        [tenantId, q.start ?? null, q.end ?? null, q.action_prefix ?? null, afterSeq, limit + 1],
      ),
    );
    const items = rows.slice(0, limit).map((r) => ({
      chain_id: r.chain_id,
      seq: Number(r.seq),
      occurred_at: r.occurred_at.toISOString(),
      actor_kind: r.actor_kind,
      actor_id: r.actor_id,
      actor_display: r.actor_display,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      outcome: r.outcome,
      details: r.details,
      row_hash: r.row_hash.toString("hex"),
      prev_hash: r.prev_hash.toString("hex"),
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      status: 200,
      body: { items, next_cursor: last ? encodeCursor({ s: last.seq }) : null },
    };
  };

  // ----------------------------------------------------------------------------------- installation check (C-39)

  const getInstallationCheck: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const now = clock();
    const today = Math.floor(now / DAY) * DAY;
    const range = (ctx.query.range as string | undefined) ?? "7d";
    // The counters are per UTC day: 24h covers yesterday and today, 7d/30d end with today.
    const days = range === "24h" ? 2 : range === "30d" ? 30 : 7;
    const start = today - (days - 1) * DAY;
    const end = today + DAY;
    const { site, rows } = await ctx.tx(async (tx) => {
      // C-124: the site's override, else the platform setting, else enforce (wire-formats §b.4)
      const site = await tx.maybeOne<{ own: string | null; platform: string | null }>(
        `SELECT s.multiplicity_mode AS own,
                (SELECT value #>> '{}' FROM scf.settings WHERE key = 'multiplicity_mode') AS platform
           FROM scf.sites s WHERE s.tenant_id = $1 AND s.site_id = $2`,
        [tenantId, siteId],
      );
      if (!site) throw new ApiError("not_found");
      const rows = await tx.query<{ counter: string; label: string; n: string }>(
        `SELECT counter, label, sum(count)::text AS n FROM scf.web_edge_counters
          WHERE tenant_id = $1 AND site_id = $2 AND day >= $3::date AND day < $4::date
          GROUP BY counter, label ORDER BY counter, label`,
        [
          tenantId,
          siteId,
          new Date(start).toISOString().slice(0, 10),
          new Date(end).toISOString().slice(0, 10),
        ],
      );
      return { site, rows };
    });
    const verdicts = { verified: 0, suspect: 0, rejected: 0 };
    const reasons: Array<{
      code: string;
      verdict: "suspect" | "rejected" | "counter";
      count: number;
    }> = [];
    const drops: Array<{ label: string; count: number }> = [];
    let kit = 0;
    let highShadow = 0;
    const versionRows: Array<{ label: string; count: number }> = [];
    for (const r of rows) {
      const n = Number(r.n);
      if (r.counter === "verdict" && r.label in verdicts)
        verdicts[r.label as keyof typeof verdicts] = n;
      else if (r.counter === "reason")
        reasons.push({ code: r.label, verdict: REASON_VERDICT[r.label] ?? "counter", count: n });
      else if (r.counter === "drop") drops.push({ label: r.label, count: n });
      else if (r.counter === "kit_present_pageviews") kit += n;
      else if (r.counter === "multiplicity" && r.label === "high_shadow") highShadow += n;
      else if (r.counter === "tracker_version") versionRows.push({ label: r.label, count: n });
    }
    const seen = trackerVersionSeen(versionRows);
    const own = site.own === "enforce" || site.own === "shadow" ? site.own : null;
    reasons.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
    drops.sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
    return {
      status: 200,
      body: {
        site_id: siteId,
        start: new Date(start).toISOString().replace(".000Z", "Z"),
        end: new Date(end).toISOString().replace(".000Z", "Z"),
        // web counter tracker_version (C-129, data-model §8.9): the version with the most events in the range
        tracker_version_seen: seen,
        outdated_tracker: trackerOutdated(seen, deps.tracker.versions()),
        verdicts,
        reasons,
        drops,
        kit_present_pageviews: kit,
        multiplicity: {
          mode: own ?? (site.platform === "shadow" ? "shadow" : "enforce"),
          source: own ? "site" : "platform",
          high_shadow: highShadow,
        },
      },
    };
  };

  // ----------------------------------------------------------------------------------- snippet (SRI, both profiles)

  const getSnippet: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const format = (ctx.query.format as string | undefined) ?? "html";
    const site = await ctx.tx(async (tx) => {
      const s = await tx.maybeOne<{ site_key: string; tracker_profile: "standard" | "strict" }>(
        `SELECT site_key, tracker_profile::text AS tracker_profile FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`,
        [tenantId, siteId],
      );
      if (!s) throw new ApiError("not_found");
      return s;
    });
    const versions = deps.tracker.versions();
    const wanted = ctx.query.version as string | undefined;
    const v = selectTrackerVersion(versions, wanted);
    if (!v)
      throw new ApiError("validation_failed", "no active tracker version", {
        errors: [{ pointer: "/version", detail: "not an active tracker version" }],
      });
    const file = v.files.find((f) => f.profile === site.tracker_profile);
    const origin = deps.tracker.hosts(v.version)[0];
    if (!file || !origin) throw new ApiError("unavailable", "the tracker release is incomplete");
    const src = `${origin}${file.url}`;
    const key = htmlAttr(site.site_key);
    const tag = (consent: boolean) =>
      [
        "<script",
        `  src="${htmlAttr(src)}"`,
        `  integrity="${htmlAttr(file.integrity)}"`,
        '  crossorigin="anonymous"',
        `  data-site="${key}"`,
        ...(consent ? ['  data-consent="required"'] : []),
        "  defer",
        "></script>",
      ].join("\n");
    const pkg =
      site.tracker_profile === "strict" ? "@usagemap/tracker/strict" : "@usagemap/tracker";
    const init = `init({ site: "${site.site_key}" })`;
    let code: string;
    switch (format) {
      case "consent_html":
        code = [
          "<script>",
          "  // Calls made before the tracker has loaded are queued and replayed in order.",
          "  window.scf = window.scf || [];",
          "</script>",
          tag(true),
          "<script>",
          "  // Call these from your consent tool. Nothing is sent before grantConsent() (C-55).",
          "  function onAnalyticsConsentGiven() {",
          '    Array.isArray(window.scf) ? window.scf.push(["grantConsent"]) : window.scf.grantConsent();',
          "  }",
          "  function onAnalyticsConsentWithdrawn() {",
          '    Array.isArray(window.scf) ? window.scf.push(["revokeConsent"]) : window.scf.revokeConsent();',
          "  }",
          "</script>",
        ].join("\n");
        break;
      case "npm":
      case "vite":
        code = [
          `// pnpm add --save-exact @usagemap/tracker@${v.version}`,
          `import { init } from "${pkg}";`,
          "",
          `const scf = ${init};`,
          'scf?.track("signup", { plan: "free" }); // optional custom event',
        ].join("\n");
        break;
      case "nextjs":
        code = [
          `// pnpm add --save-exact @usagemap/tracker@${v.version}`,
          "// app/analytics.tsx — render <Analytics /> once in the root layout",
          '"use client";',
          'import { useEffect } from "react";',
          `import { init } from "${pkg}";`,
          "",
          "export function Analytics() {",
          "  useEffect(() => {",
          `    ${init};`,
          "  }, []);",
          "  return null;",
          "}",
        ].join("\n");
        break;
      case "astro":
        code = [
          "---",
          "// src/layouts/Layout.astro — inside <head>",
          "---",
          tag(false).replace("<script", "<script is:inline"),
        ].join("\n");
        break;
      case "angular":
        code = [
          `// pnpm add --save-exact @usagemap/tracker@${v.version}`,
          "// src/main.ts",
          `import { init } from "${pkg}";`,
          "",
          `${init};`,
        ].join("\n");
        break;
      default:
        code = tag(false);
    }
    const html = format === "html" || format === "consent_html" || format === "astro";
    return {
      status: 200,
      body: {
        format,
        version: v.version,
        ...(html ? { integrity: file.integrity } : {}),
        code,
        ...(deps.noticeTextUrl ? { notice_text_url: deps.noticeTextUrl } : {}),
      },
    };
  };

  return {
    operatorTransitionTenant,
    operatorRemoveTenant,
    operatorRestoreTenant,
    operatorPurgeTenant,
    operatorRequireReapproval,
    operatorListTenants,
    operatorListTombstones,
    operatorLiftTombstone,
    operatorGetSettings,
    operatorUpdateSetting,
    operatorGetEnrollmentMode,
    operatorSetEnrollmentMode,
    listTenantAudit,
    getInstallationCheck,
    getSnippet,
  };
}

/**
 * Value rules the application enforces before the database's CHECK constraints: the privacy floor
 * (ADR-0027, C-51, C-95) must stay an integer in a sane range — `op_min_count` 0 would switch suppression off, and a
 * `*_round_to` of 0 or a non-integer would break every breakdown — and `read_only_mode` (ops.end-of-window-read-only) has a fixed shape.
 */
const INT_RANGES: Record<string, readonly [number, number]> = {
  op_min_count: [5, 1000],
  op_round_to: [1, 100],
  tenant_min_count: [5, 1000],
  tenant_round_to: [1, 100],
};

export function settingValueAllowed(key: string, value: unknown): boolean {
  const range = INT_RANGES[key];
  if (range)
    return (
      Number.isInteger(value) && (value as number) >= range[0] && (value as number) <= range[1]
    );
  if (key === "read_only_mode") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const o = value as Record<string, unknown>;
    return (
      Object.keys(o).length === 2 &&
      typeof o.enabled === "boolean" &&
      (o.ingest === "accept" || o.ingest === "pause")
    );
  }
  return true;
}
