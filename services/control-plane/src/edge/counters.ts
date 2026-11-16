// SPDX-License-Identifier: Apache-2.0
// Edge counter delivery (wire-formats §d.3, §d.4, §l; C-39, C-76). The forwarder posts each spool counter record; the
// control plane verifies that `node_id` is the caller's node, applies the record exactly once and answers 200
// (also for a duplicate). Idempotency is per part: each tenant's share is applied in its own transaction under that
// tenant's context (§l: "one transaction per tenant") together with a ledger row whose id is derived from
// (record_id, tenant_id); the spool-accounting part uses the record_id itself. A part that is already in the ledger is
// skipped, so a retry after a partial failure applies exactly the missing parts.

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { applyRpc, RPC_PART_SCHEMA, type RpcRow } from "../browser-rpc/cells.ts";
import type { Database, Tx } from "../db/database.ts";
import { toFieldErrors } from "../http/openapi.ts";
import { ApiError } from "../http/problem.ts";
import { derivedUuid } from "../util/ids.ts";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/** counter-record-1 (wire-formats §d.3), verbatim. */
export const COUNTER_RECORD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "rv",
    "type",
    "record_id",
    "node_id",
    "period_start_ms",
    "period_end_ms",
    "web",
    "otlp",
    "tokens",
    "spool",
  ],
  properties: {
    rv: { const: 1 },
    type: { const: "counter" },
    record_id: { type: "string", format: "uuid" },
    node_id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,31}$" },
    period_start_ms: { type: "integer" },
    period_end_ms: { type: "integer" },
    web: {
      type: "array",
      maxItems: 100000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "site_id", "day", "counter", "label", "count"],
        properties: {
          tenant_id: { type: "string", format: "uuid" },
          site_id: { type: "string", format: "uuid" },
          day: { type: "string", format: "date" },
          counter: {
            enum: [
              "verdict",
              "reason",
              "asn_class",
              "client_signal",
              "pow_latency",
              "multiplicity",
              "identifier",
              "kit_present_pageviews",
              "drop",
              "tracker_version",
            ],
          },
          label: { type: "string", pattern: "^[a-z0-9_]{1,40}$" },
          count: { type: "integer", minimum: 1 },
        },
      },
    },
    otlp: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "day", "reason", "count"],
        properties: {
          tenant_id: { type: "string", format: "uuid" },
          day: { type: "string", format: "date" },
          reason: {
            enum: [
              "rate_limited",
              "payload_too_large",
              "logs_rejected",
              "tenant_pending",
              "tenant_suspended",
              "token_expired",
            ],
          },
          count: { type: "integer", minimum: 1 },
        },
      },
    },
    tokens: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["token_id", "tenant_id", "last_used_ms"],
        properties: {
          token_id: { type: "string", pattern: "^[0-9A-Za-z]{12}$" },
          tenant_id: { type: "string", format: "uuid" },
          last_used_ms: { type: "integer" },
        },
      },
    },
    spool: { $ref: "#/$defs/spoolAccounting" },
    props: {
      type: "array",
      maxItems: 100000,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "tenant_id",
          "site_id",
          "day",
          "event",
          "network",
          "key",
          "value",
          "verdict",
          "count",
        ],
        properties: {
          tenant_id: { type: "string", format: "uuid" },
          site_id: { type: "string", format: "uuid" },
          day: { type: "string", format: "date" },
          event: {
            enum: [
              "wallet_modal_opened",
              "wallet_modal_closed",
              "wallet_selected",
              "wallet_connect",
              "wallet_disconnect",
              "sign_requested",
              "sign_approved",
              "sign_rejected",
              "tx_submitted",
              "smart_wallet_created",
              "passkey_used",
              "wallet_connect_failed",
              "walletconnect_session",
              "walletconnect_request",
            ],
          },
          network: { enum: ["mainnet", "testnet", "futurenet", "local", "unknown"] },
          key: {
            enum: [
              "_total",
              "wallet",
              "connect_kind",
              "sign_kind",
              "error_class",
              "result_class",
              "duration",
              "outcome",
              "passkey_op",
              "failure_reason",
              "wallet_context",
              "wc_state",
              "wc_method",
            ],
          },
          value: { type: "string", pattern: "^[a-z0-9_]{1,32}$" },
          verdict: { enum: ["verified", "suspect"] },
          count: { type: "integer", minimum: 1 },
        },
      },
    },
    dev: {
      type: "array",
      maxItems: 20000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "site_id", "received_at_ms", "kind", "name", "path", "would_be"],
        properties: {
          tenant_id: { type: "string", format: "uuid" },
          site_id: { type: "string", format: "uuid" },
          received_at_ms: { type: "integer" },
          kind: { enum: ["pageview", "custom", "stellar"] },
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$" },
          path: { type: "string", maxLength: 200, pattern: "^/[^?#\\s]*$" },
          would_be: { enum: ["verified", "suspect", "rejected"] },
          reason: { type: ["string", "null"], pattern: "^[a-z0-9_]{1,40}$" },
        },
      },
    },
    // Self-attested app events (wire-formats §a.9, migration 0084) → app_event_daily; optional.
    app: {
      type: "array",
      maxItems: 100000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "site_id", "day", "platform", "event", "key", "value", "count"],
        properties: {
          tenant_id: { type: "string", format: "uuid" },
          site_id: { type: "string", format: "uuid" },
          day: { type: "string", format: "date" },
          platform: { enum: ["ios", "android", "web"] },
          event: {
            type: "string",
            pattern: "^(_session|_dropped|[A-Za-z0-9][A-Za-z0-9_.:-]{0,49})$",
          },
          key: { type: "string", pattern: "^(_total|[a-z][a-z0-9_]{0,31})$" },
          value: { type: "string", minLength: 1, maxLength: 64 },
          count: { type: "integer", minimum: 1 },
        },
      },
    },
    // Browser Stellar RPC/Horizon aggregate (tracker 1.2.0, wire-formats §a.3.2, migration 0086) →
    // web_rpc_client_daily; optional, sent only when counter_features has "rpc".
    rpc: RPC_PART_SCHEMA,
  },
  $defs: {
    spoolAccounting: {
      type: "object",
      additionalProperties: false,
      required: [
        "boot_id",
        "day",
        "fsynced",
        "acked_stored",
        "acked_engine_bot",
        "acked_engine_rejected",
        "expired_72h",
        "queued",
      ],
      properties: {
        boot_id: { type: "string", format: "uuid" },
        day: { type: "string", format: "date" },
        fsynced: { type: "integer", minimum: 0 },
        acked_stored: { type: "integer", minimum: 0 },
        acked_engine_bot: { type: "integer", minimum: 0 },
        acked_engine_rejected: { type: "integer", minimum: 0 },
        expired_72h: { type: "integer", minimum: 0 },
        queued: { type: "integer", minimum: 0 },
        queued_at_day_start: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

export interface CounterRecord {
  rv: 1;
  type: "counter";
  record_id: string;
  node_id: string;
  period_start_ms: number;
  period_end_ms: number;
  web: Array<{
    tenant_id: string;
    site_id: string;
    day: string;
    counter: string;
    label: string;
    count: number;
  }>;
  otlp: Array<{ tenant_id: string; day: string; reason: string; count: number }>;
  tokens: Array<{ token_id: string; tenant_id: string; last_used_ms: number }>;
  spool: {
    boot_id: string;
    day: string;
    fsynced: number;
    acked_stored: number;
    acked_engine_bot: number;
    acked_engine_rejected: number;
    expired_72h: number;
    queued: number;
    queued_at_day_start?: number;
  };
  /** C-136: Stellar event schema v1 property counts (§a.3.1) → web_event_property_daily; optional. */
  props?: PropRow[];
  /** C-136: events of dev requests (§a.8) → web_dev_events (newest dev_event_buffer_size per site); optional. */
  dev?: DevEntry[];
  /** Self-attested app events (§a.9) → app_event_daily; optional. */
  app?: AppRow[];
  /** Browser Stellar RPC/Horizon aggregate cells (§a.3.2) → web_rpc_client_daily; optional. */
  rpc?: RpcRow[];
}

export interface AppRow {
  tenant_id: string;
  site_id: string;
  day: string;
  platform: "ios" | "android" | "web";
  event: string;
  key: string;
  value: string;
  count: number;
}

export interface PropRow {
  tenant_id: string;
  site_id: string;
  day: string;
  event: string;
  network: string;
  key: string;
  value: string;
  verdict: "verified" | "suspect";
  count: number;
}

export interface DevEntry {
  tenant_id: string;
  site_id: string;
  received_at_ms: number;
  kind: "pageview" | "custom" | "stellar";
  name: string;
  path: string;
  would_be: "verified" | "suspect" | "rejected";
  reason?: string | null;
}

/**
 * Closed value list per property key (wire-formats §a.3.1; the database checks the same lists,
 * `web_event_property_daily_value`). A row outside them is dropped and counted, never a failed record.
 */
export const PROP_VALUES: Record<string, ReadonlySet<string>> = {
  _total: new Set(["all"]),
  wallet: new Set([
    "freighter",
    "albedo",
    "xbull",
    "lobstr",
    "hana",
    "hot",
    "rabet",
    "walletconnect",
    "ledger",
    "trezor",
    "fordefi",
    "klever",
    "onekey",
    "bitget",
    "cactuslink",
    "dcent",
    "scopuly",
    "metamask",
    "ghostsig",
    "passkey",
    "privy",
    "injected_other",
    "unknown",
  ]),
  connect_kind: new Set(["new", "restored"]),
  sign_kind: new Set(["tx", "auth_entry", "message", "tx_submit"]),
  error_class: new Set([
    "user_rejected",
    "invalid_request",
    "external_service",
    "internal",
    "timeout",
    "unsupported",
    "unknown",
  ]),
  result_class: new Set(["success", "failed", "pending", "try_again_later", "error"]),
  duration: new Set(["lt5s", "5_30s", "gt30s"]),
  outcome: new Set(["connected", "dismissed", "error"]),
  passkey_op: new Set(["register", "authenticate", "sign"]),
  // tracker 1.2.0 (migration 0086)
  failure_reason: new Set([
    "user_rejected",
    "wallet_not_installed",
    "wallet_locked",
    "network_mismatch",
    "timeout",
    "error_other",
  ]),
  wallet_context: new Set([
    "none",
    "varial_inapp",
    "dcent_inapp",
    "scopuly_inapp",
    "other_inapp",
    "unknown",
  ]),
  wc_state: new Set(["proposed", "approved", "rejected"]),
  wc_method: new Set(["sign_xdr", "sign_submit_xdr", "sign_message", "sign_auth_entry"]),
};

/** Dev events older than this are not stored (the buffer keeps at most 24 hours, data-model §12.1). */
const DEV_MAX_AGE_MS = 24 * 3_600_000;
const DEFAULT_DEV_BUFFER = 100;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(COUNTER_RECORD_SCHEMA);

export function parseCounterRecord(body: unknown): CounterRecord {
  if (!validate(body))
    throw new ApiError("validation_failed", undefined, {
      errors: toFieldErrors(validate.errors, ""),
    });
  return body as unknown as CounterRecord;
}

const ZERO = "00000000-0000-0000-0000-000000000000";

/**
 * `props` rows (C-136) → `web_event_property_daily`, `count = count + EXCLUDED.count`; rows of sites not belonging to
 * the tenant, and values outside the closed lists, are dropped and counted (returned).
 */
async function applyProps(tx: Tx, tenantId: string, rows: PropRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const valid = rows.filter((p) => PROP_VALUES[p.key]?.has(p.value) === true);
  let skipped = rows.length - valid.length;
  if (valid.length === 0) return skipped;
  const groups = new Map<string, number>();
  for (const p of valid) {
    const k = [p.site_id, p.day, p.event, p.network, p.key, p.value, p.verdict].join("|");
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const inserted = await tx.query<{
    site_id: string;
    day: string;
    event_name: string;
    network: string;
    prop_key: string;
    prop_value: string;
    verdict: string;
  }>(
    `WITH input AS (
       SELECT * FROM unnest($2::uuid[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                            $9::bigint[]) AS x(site_id, day, event_name, network, prop_key, prop_value, verdict, count)
     ), agg AS (
       SELECT site_id, day, event_name, network, prop_key, prop_value, verdict, sum(count) AS count
         FROM input GROUP BY 1, 2, 3, 4, 5, 6, 7
     )
     INSERT INTO scf.web_event_property_daily AS c
            (tenant_id, site_id, day, event_name, network, prop_key, prop_value, verdict, count)
     SELECT $1, a.site_id, a.day, a.event_name, a.network, a.prop_key, a.prop_value, a.verdict, a.count FROM agg a
       JOIN scf.sites s ON s.tenant_id = $1 AND s.site_id = a.site_id
     ON CONFLICT (tenant_id, site_id, day, event_name, network, prop_key, prop_value, verdict)
       DO UPDATE SET count = c.count + EXCLUDED.count
     RETURNING c.site_id::text AS site_id, c.day::text AS day, c.event_name, c.network, c.prop_key, c.prop_value,
               c.verdict`,
    [
      tenantId,
      valid.map((p) => p.site_id),
      valid.map((p) => p.day),
      valid.map((p) => p.event),
      valid.map((p) => p.network),
      valid.map((p) => p.key),
      valid.map((p) => p.value),
      valid.map((p) => p.verdict),
      valid.map((p) => p.count),
    ],
  );
  for (const r of inserted)
    groups.delete(
      [r.site_id, r.day, r.event_name, r.network, r.prop_key, r.prop_value, r.verdict].join("|"),
    );
  for (const n of groups.values()) skipped += n;
  return skipped;
}

/** The per-cell rule of app_event_daily (migration 0084, constraint app_event_daily_cell), checked before the insert. */
export function appCellOk(r: Pick<AppRow, "event" | "key" | "value">): boolean {
  const token = /^[a-z][a-z0-9_]{0,31}$/;
  if (r.event === "_session") {
    switch (r.key) {
      case "_total":
        return r.value === "all";
      case "app_version":
        return /^[0-9]{1,6}(\.[0-9]{1,6}){0,3}$/.test(r.value);
      case "sdk_version":
        return /^[a-z][a-z0-9-]{0,23}\/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(r.value);
      case "tma_platform":
        return ["android", "ios", "macos", "desktop", "web", "other"].includes(r.value);
      default:
        return false;
    }
  }
  if (r.event === "_dropped")
    return (
      r.key === "reason" && ["unsafe", "value_shape", "stale", "cardinality"].includes(r.value)
    );
  if (r.key === "_total") return r.value === "all";
  return token.test(r.key) && token.test(r.value);
}

/**
 * `app` rows (§a.9) → `app_event_daily` (self-attested), `count = count + EXCLUDED.count`; rows of sites not belonging
 * to the tenant and cells outside the table's rule are dropped and counted (returned), never a failed record.
 */
async function applyApp(tx: Tx, tenantId: string, rows: AppRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const valid = rows.filter(appCellOk);
  let skipped = rows.length - valid.length;
  if (valid.length === 0) return skipped;
  const groups = new Map<string, number>();
  for (const r of valid) {
    const k = [r.site_id, r.day, r.platform, r.event, r.key, r.value].join("|");
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const inserted = await tx.query<{
    site_id: string;
    day: string;
    platform: string;
    event_name: string;
    prop_key: string;
    prop_value: string;
  }>(
    `WITH input AS (
       SELECT * FROM unnest($2::uuid[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[])
                AS x(site_id, day, platform, event_name, prop_key, prop_value, count)
     ), agg AS (
       SELECT site_id, day, platform, event_name, prop_key, prop_value, sum(count) AS count FROM input GROUP BY 1, 2, 3, 4, 5, 6
     )
     INSERT INTO scf.app_event_daily AS c (tenant_id, site_id, day, platform, event_name, prop_key, prop_value, count)
     SELECT $1, a.site_id, a.day, a.platform, a.event_name, a.prop_key, a.prop_value, a.count FROM agg a
       JOIN scf.sites s ON s.tenant_id = $1 AND s.site_id = a.site_id
     ON CONFLICT (tenant_id, site_id, day, platform, event_name, prop_key, prop_value)
       DO UPDATE SET count = c.count + EXCLUDED.count
     RETURNING c.site_id::text AS site_id, c.day::text AS day, c.platform, c.event_name, c.prop_key, c.prop_value`,
    [
      tenantId,
      valid.map((r) => r.site_id),
      valid.map((r) => r.day),
      valid.map((r) => r.platform),
      valid.map((r) => r.event),
      valid.map((r) => r.key),
      valid.map((r) => r.value),
      valid.map((r) => r.count),
    ],
  );
  for (const r of inserted)
    groups.delete([r.site_id, r.day, r.platform, r.event_name, r.prop_key, r.prop_value].join("|"));
  for (const n of groups.values()) skipped += n;
  return skipped;
}

/**
 * `dev` entries (C-136) → `web_dev_events`, then each touched site is trimmed to the newest `dev_event_buffer_size`
 * rows. Entries of sites not belonging to the tenant are dropped and counted (returned), like `web` rows; entries
 * older than 24 hours (a long-spooled record) are not stored.
 */
async function applyDev(
  tx: Tx,
  tenantId: string,
  rows: DevEntry[],
  periodEndMs: number,
): Promise<number> {
  if (rows.length === 0) return 0;
  const minMs = Math.max(Date.now(), periodEndMs) - DEV_MAX_AGE_MS;
  const fresh = rows.filter((d) => d.received_at_ms > minMs);
  let skipped = 0;
  if (fresh.length > 0) {
    const ins = await tx.query<{ site_id: string }>(
      `INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict,
                                       reason)
       SELECT $1, x.site_id, to_timestamp(x.ms / 1000.0), x.kind, x.name, x.path, x.would_be, x.reason
         FROM unnest($2::uuid[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
                AS x(site_id, ms, kind, name, path, would_be, reason)
         JOIN scf.sites s ON s.tenant_id = $1 AND s.site_id = x.site_id
       RETURNING site_id::text AS site_id`,
      [
        tenantId,
        fresh.map((d) => d.site_id),
        fresh.map((d) => d.received_at_ms),
        fresh.map((d) => d.kind),
        fresh.map((d) => d.name),
        fresh.map((d) => d.path),
        fresh.map((d) => d.would_be),
        fresh.map((d) => d.reason ?? null),
      ],
    );
    skipped += fresh.length - ins.length;
    const sites = [...new Set(ins.map((r) => r.site_id))];
    if (sites.length > 0)
      await tx.query(
        `DELETE FROM scf.web_dev_events d
          USING (SELECT e.site_id, e.event_id,
                        row_number() OVER (PARTITION BY e.site_id ORDER BY e.received_at DESC, e.event_id DESC) AS rn
                   FROM scf.web_dev_events e WHERE e.tenant_id = $1 AND e.site_id = ANY ($2::uuid[])) r
          WHERE d.tenant_id = $1 AND d.site_id = r.site_id AND d.event_id = r.event_id
            AND r.rn > COALESCE((SELECT (value #>> '{}')::int FROM scf.settings WHERE key = 'dev_event_buffer_size'), $3)`,
        [tenantId, sites, DEFAULT_DEV_BUFFER],
      );
  }
  return skipped;
}

export interface ApplyResult {
  duplicate: boolean;
  appliedParts: number;
  skippedRows: number;
}

/**
 * Applies a validated record. Token entries carry the tenant the edge learned from the snapshot (§d.3, C-113); each
 * is applied in that tenant's transaction, so an entry naming the wrong tenant matches no row. A `boot_id` different
 * from the stored `last_boot_id` of the node's day counts as a restart (migration 0051), whichever control-plane
 * process applies the record.
 */
export async function applyCounterRecord(
  db: Database,
  rec: CounterRecord,
  requestId: string,
): Promise<ApplyResult> {
  // Latest use per (tenant, token).
  const tokenMs = new Map<string, Map<string, number>>();
  for (const t of rec.tokens) {
    const m = tokenMs.get(t.tenant_id) ?? new Map<string, number>();
    m.set(t.token_id, Math.max(m.get(t.token_id) ?? 0, t.last_used_ms));
    tokenMs.set(t.tenant_id, m);
  }
  let skipped = 0;
  const props = rec.props ?? [];
  const dev = rec.dev ?? [];
  const app = rec.app ?? [];
  const rpc = rec.rpc ?? [];
  const tenants = new Set<string>([
    ...rec.web.map((w) => w.tenant_id),
    ...rec.otlp.map((o) => o.tenant_id),
    ...tokenMs.keys(),
    ...props.map((p) => p.tenant_id),
    ...dev.map((d) => d.tenant_id),
    ...app.map((a) => a.tenant_id),
    ...rpc.map((r) => r.tenant_id),
  ]);
  let applied = 0;

  for (const tenantId of [...tenants].sort()) {
    const partId = derivedUuid("scf-counter-part", rec.record_id, tenantId);
    const n = await db.tx(
      { tenantId, actorKind: "system", actorId: rec.node_id, requestId },
      async (tx) => {
        const fresh = await tx.maybeOne(
          `INSERT INTO scf.edge_report_ledger (node_id, record_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING record_id`,
          [rec.node_id, partId],
        );
        if (!fresh) return -1;
        const exists = await tx.maybeOne(`SELECT 1 FROM scf.tenants WHERE tenant_id = $1`, [
          tenantId,
        ]);
        let skip = 0;
        if (!exists) {
          skip +=
            rec.web.filter((w) => w.tenant_id === tenantId).length +
            rec.otlp.filter((o) => o.tenant_id === tenantId).length +
            props.filter((p) => p.tenant_id === tenantId).length +
            dev.filter((d) => d.tenant_id === tenantId).length +
            app.filter((a) => a.tenant_id === tenantId).length +
            rpc.filter((r) => r.tenant_id === tenantId).length;
          return skip;
        }
        const web = rec.web.filter((w) => w.tenant_id === tenantId);
        if (web.length > 0) {
          // Rows of sites that do not belong to this tenant (or no longer exist) are dropped by the join.
          const r = await tx.query<{ n: number }>(
            `WITH input AS (
             SELECT * FROM unnest($2::uuid[], $3::date[], $4::text[], $5::text[], $6::bigint[]) AS x(site_id, day, counter, label, count)
           ), agg AS (
             SELECT site_id, day, counter, label, sum(count) AS count FROM input GROUP BY 1, 2, 3, 4
           ), ins AS (
             INSERT INTO scf.web_edge_counters AS c (tenant_id, site_id, day, counter, label, count)
             SELECT $1, a.site_id, a.day, a.counter, a.label, a.count FROM agg a
               JOIN scf.sites s ON s.tenant_id = $1 AND s.site_id = a.site_id
             ON CONFLICT (tenant_id, site_id, day, counter, label) DO UPDATE SET count = c.count + EXCLUDED.count
             RETURNING 1
           ) SELECT count(*)::int AS n FROM ins`,
            [
              tenantId,
              web.map((w) => w.site_id),
              web.map((w) => w.day),
              web.map((w) => w.counter),
              web.map((w) => w.label),
              web.map((w) => w.count),
            ],
          );
          const groups = new Set(web.map((w) => `${w.site_id}|${w.day}|${w.counter}|${w.label}`))
            .size;
          skip += groups - (r[0]?.n ?? 0);
        }
        const otlp = rec.otlp.filter((o) => o.tenant_id === tenantId);
        if (otlp.length > 0) {
          await tx.query(
            `INSERT INTO scf.api_ingest_counters AS c (tenant_id, day, service_id, reason, count)
           SELECT $1, day, $2::uuid, reason, sum(count) FROM unnest($3::date[], $4::text[], $5::bigint[]) AS x(day, reason, count)
            GROUP BY day, reason
           ON CONFLICT (tenant_id, day, service_id, reason) DO UPDATE SET count = c.count + EXCLUDED.count`,
            [
              tenantId,
              ZERO,
              otlp.map((o) => o.day),
              otlp.map((o) => o.reason),
              otlp.map((o) => o.count),
            ],
          );
        }
        const tokens = tokenMs.get(tenantId) ?? new Map<string, number>();
        const tokenIds = [...tokens.keys()];
        if (tokenIds.length > 0) {
          // last_used_at: at most one update per token per minute (§l).
          await tx.query(
            `UPDATE scf.ingest_tokens i SET last_used_at = to_timestamp(x.ms / 1000.0)
             FROM unnest($2::text[], $3::bigint[]) AS x(token_id, ms)
            WHERE i.tenant_id = $1 AND i.token_id = x.token_id
              AND (i.last_used_at IS NULL OR i.last_used_at < to_timestamp(x.ms / 1000.0) - interval '1 minute')`,
            [tenantId, tokenIds, tokenIds.map((t) => tokens.get(t) ?? 0)],
          );
        }
        skip += await applyProps(
          tx,
          tenantId,
          props.filter((p) => p.tenant_id === tenantId),
        );
        skip += await applyDev(
          tx,
          tenantId,
          dev.filter((d) => d.tenant_id === tenantId),
          rec.period_end_ms,
        );
        skip += await applyApp(
          tx,
          tenantId,
          app.filter((a) => a.tenant_id === tenantId),
        );
        skip += await applyRpc(
          tx,
          tenantId,
          rpc.filter((r) => r.tenant_id === tenantId),
        );
        return skip;
      },
    );
    if (n >= 0) {
      applied++;
      skipped += n;
    }
  }

  const s = rec.spool;
  const globalApplied = await db.tx(
    { tenantId: null, actorKind: "system", actorId: rec.node_id, requestId },
    async (tx) => {
      const fresh = await tx.maybeOne(
        `INSERT INTO scf.edge_report_ledger (node_id, record_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING record_id`,
        [rec.node_id, rec.record_id],
      );
      if (!fresh) return false;
      await tx.query(
        // A boot_id other than the stored last_boot_id is a restart — unless the record is older than the latest one
        // applied (a retry of an earlier boot's record from the spool), which neither counts nor moves last_boot_id.
        `INSERT INTO scf.edge_spool_accounting AS a (node_id, day, queued_start, fsynced, acked_stored, acked_engine_bot,
                                                  acked_engine_rejected, expired_72h, queued_end, last_period_end, restarts,
                                                  last_boot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0), 0, $11)
       ON CONFLICT (node_id, day) DO UPDATE SET
         queued_start = COALESCE(a.queued_start, EXCLUDED.queued_start),
         fsynced = a.fsynced + EXCLUDED.fsynced,
         acked_stored = a.acked_stored + EXCLUDED.acked_stored,
         acked_engine_bot = a.acked_engine_bot + EXCLUDED.acked_engine_bot,
         acked_engine_rejected = a.acked_engine_rejected + EXCLUDED.acked_engine_rejected,
         expired_72h = a.expired_72h + EXCLUDED.expired_72h,
         queued_end = CASE WHEN a.last_period_end IS NULL OR EXCLUDED.last_period_end >= a.last_period_end
                           THEN EXCLUDED.queued_end ELSE a.queued_end END,
         last_period_end = GREATEST(a.last_period_end, EXCLUDED.last_period_end),
         restarts = a.restarts + CASE
           WHEN a.last_boot_id IS DISTINCT FROM EXCLUDED.last_boot_id AND a.last_boot_id IS NOT NULL
            AND (a.last_period_end IS NULL OR EXCLUDED.last_period_end >= a.last_period_end) THEN 1 ELSE 0 END,
         last_boot_id = CASE WHEN a.last_period_end IS NULL OR EXCLUDED.last_period_end >= a.last_period_end
                             THEN EXCLUDED.last_boot_id ELSE a.last_boot_id END`,
        [
          rec.node_id,
          s.day,
          s.queued_at_day_start ?? null,
          s.fsynced,
          s.acked_stored,
          s.acked_engine_bot,
          s.acked_engine_rejected,
          s.expired_72h,
          s.queued,
          rec.period_end_ms,
          s.boot_id,
        ],
      );
      return true;
    },
  );
  return {
    duplicate: applied === 0 && !globalApplied,
    appliedParts: applied + (globalApplied ? 1 : 0),
    skippedRows: skipped,
  };
}
