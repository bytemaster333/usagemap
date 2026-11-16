// SPDX-License-Identifier: Apache-2.0
// Aggregate-only export for the no-successor case (ops.end-of-window-read-only): an operator-run tool that writes every tenant's AGGREGATE
// figures as a documented, versioned bundle — never event-level data.
//
//   node scripts/export-aggregates.ts --out <empty or new directory>
//   (database: SCF_EXPORT_DATABASE_URL — a role that bypasses row-level security, e.g. the backup superuser; the
//    connection runs one READ ONLY, REPEATABLE READ transaction, so the bundle is one consistent snapshot)
//
// Bundle `usagemap-aggregate-export` 1.0.0: one JSON Lines file per table (one object per row, keys in the documented
// column order) and `manifest.json` (format, version, generation time, privacy rules applied, and per file: rows,
// SHA-256, column schema). Contents are chosen by an allow-list of tables AND columns below; anything not listed —
// the engine (Umami) tables, dev events, spool, sessions, users, members, keys, tokens, credentials, audit details —
// is never read. Removed (and purged) tenants and synthetic canary tenants are excluded. Breakdown rows and wallet-event
// counts that would leave the project get the platform's small-count floor (op_min_count / op_round_to, ADR-0027).

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";

export const EXPORT_FORMAT = "usagemap-aggregate-export";
export const EXPORT_VERSION = "1.0.0";

type ColType =
  | "uuid"
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "timestamp"
  | "json"
  | "text[]"
  | "integer[]"
  | "hex";

export interface Column {
  name: string;
  type: ColType;
  description: string;
}

export interface FileSpec {
  file: string;
  description: string;
  columns: Column[];
  /** Selects exactly `columns`, in order, from tenants in `kept` (a CTE every query can use). */
  sql: string;
}

const c = (name: string, type: ColType, description: string): Column => ({
  name,
  type,
  description,
});

/** Tenants whose data is exported: not removed (purged tenants are removed), not synthetic canaries. */
const KEPT = `kept AS (SELECT tenant_id FROM scf.tenants WHERE status <> 'removed' AND NOT is_canary)`;

const WEB_COUNTS = [
  c("pageviews_verified", "integer", "page views that passed the anti-inflation checks"),
  c("pageviews_raw", "integer", "all page views that were not rejected"),
  c(
    "pageviews_unidentified_verified",
    "integer",
    "verified page views without a visitor identifier",
  ),
  c("pageviews_unidentified_raw", "integer", "raw page views without a visitor identifier"),
  c(
    "visitors_verified",
    "integer",
    "unique visitors of the period (no cross-period identity exists)",
  ),
  c("visitors_raw", "integer", "unique visitors of the period, raw"),
];

export const FILES: FileSpec[] = [
  {
    file: "tenants.jsonl",
    description: "Projects (tenants) whose figures are in this bundle",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("slug", "text", "public short name"),
      c("name", "text", "project name"),
      c("status", "text", "pending | active | suspended"),
      c("created_at", "timestamp", "creation time (UTC)"),
      c("public_stats_enabled", "boolean", "whether the project published its metrics_endpoint"),
      c("onchain_correlation_enabled", "boolean", "whether on-chain correlation was on"),
    ],
    sql: `SELECT t.tenant_id, t.slug, t.name, t.status::text, t.created_at, t.public_stats_enabled,
                 t.onchain_correlation_enabled
            FROM scf.tenants t JOIN kept USING (tenant_id) ORDER BY t.tenant_id`,
  },
  {
    file: "sites.jsonl",
    description: "Websites of the projects",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("site_id", "uuid", "website id"),
      c("name", "text", "website name"),
      c("tracker_profile", "text", "standard | strict"),
      c("status", "text", "active | archived"),
      c("created_at", "timestamp", "creation time (UTC)"),
      c("archived_at", "timestamp", "archive time, or null"),
    ],
    sql: `SELECT s.tenant_id, s.site_id, s.name, s.tracker_profile::text, s.status, s.created_at, s.archived_at
            FROM scf.sites s JOIN kept USING (tenant_id) WHERE s.status <> 'purging'
           ORDER BY s.tenant_id, s.site_id`,
  },
  {
    file: "api_services.jsonl",
    description: "API services of the projects",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("service_id", "uuid", "service id"),
      c("service_name", "text", "OpenTelemetry service.name"),
      c("display_name", "text", "display name, or null"),
      c("registration", "text", "portal | auto"),
      c("status", "text", "active | archived"),
      c("registered_at", "timestamp", "registration time (UTC)"),
    ],
    sql: `SELECT a.tenant_id, a.service_id, a.service_name, a.display_name, a.registration, a.status, a.registered_at
            FROM scf.api_services a JOIN kept USING (tenant_id) ORDER BY a.tenant_id, a.service_id`,
  },
  {
    file: "declared_contracts.jsonl",
    description:
      "Soroban contracts the projects declared (public ledger identifiers; key of onchain_daily)",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("contract_ref", "uuid", "reference used by onchain_daily"),
      c("contract_id", "text", "contract address (C…)"),
      c("network", "text", "public | testnet"),
      c("status", "text", "declared | verified"),
      c("verified_role", "text", "deployer | admin, or null"),
      c("removed_at", "timestamp", "removal time, or null"),
    ],
    sql: `SELECT d.tenant_id, d.contract_ref, d.contract_id, d.network, d.status, d.verified_role, d.removed_at
            FROM scf.declared_contracts d JOIN kept USING (tenant_id) ORDER BY d.tenant_id, d.contract_ref`,
  },
  {
    file: "web_daily_totals.jsonl",
    description: "Web totals per website and UTC day (exact)",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("site_id", "uuid", "website id"),
      c("day", "date", "UTC day"),
      ...WEB_COUNTS,
      c("visits", "integer", "visits"),
      c("bounces", "integer", "single-page visits"),
      c("total_duration_s", "integer", "summed visit duration in seconds"),
      c("events_raw", "integer", "all engine events"),
      c("is_final", "boolean", "whether the day is final"),
      c("engine_version", "text", "engine that produced the figures"),
    ],
    sql: `SELECT w.tenant_id, w.site_id, w.day, w.pageviews_verified, w.pageviews_raw, w.pageviews_unidentified_verified,
                 w.pageviews_unidentified_raw, w.visitors_verified, w.visitors_raw, w.visits, w.bounces,
                 w.total_duration_s, w.events_raw, w.is_final, w.engine_version
            FROM scf.web_daily_totals w JOIN kept USING (tenant_id) ORDER BY w.tenant_id, w.site_id, w.day`,
  },
  {
    file: "web_hourly_totals.jsonl",
    description: "Web totals per website and UTC hour (exact)",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("site_id", "uuid", "website id"),
      c("hour_start", "timestamp", "start of the UTC hour"),
      ...WEB_COUNTS,
      c("events_raw", "integer", "all engine events"),
    ],
    sql: `SELECT w.tenant_id, w.site_id, w.hour_start, w.pageviews_verified, w.pageviews_raw,
                 w.pageviews_unidentified_verified, w.pageviews_unidentified_raw, w.visitors_verified, w.visitors_raw,
                 w.events_raw
            FROM scf.web_hourly_totals w JOIN kept USING (tenant_id) ORDER BY w.tenant_id, w.site_id, w.hour_start`,
  },
  {
    file: "web_daily_breakdowns.jsonl",
    description:
      "Top values per website, UTC day and dimension (paths are normalised, never with query strings). Small-count floor applied per row: a row whose visitors (events for the event dimension) are below op_min_count is omitted; counts are rounded to op_round_to",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("site_id", "uuid", "website id"),
      c("day", "date", "UTC day"),
      c("variant", "text", "verified | raw"),
      c("dimension", "text", "referrer | country | device | browser | os | path | event"),
      c("value", "text", "the dimension's value"),
      c("visitors", "integer", "visitors, rounded; null for the event dimension"),
      c("pageviews", "integer", "page views, rounded"),
      c("visits", "integer", "visits (raw variant only), rounded"),
      c("events", "integer", "events (event dimension only), rounded"),
    ],
    sql: `SELECT b.tenant_id, b.site_id, b.day, b.variant::text, b.dimension::text, b.value,
                 scf.op_count(b.visitors), scf.op_count(b.pageviews), scf.op_count(b.visits), scf.op_count(b.events)
            FROM scf.web_daily_breakdowns b JOIN kept USING (tenant_id)
           WHERE scf.op_count(CASE WHEN b.dimension = 'event' THEN b.events ELSE b.visitors END) IS NOT NULL
           ORDER BY b.tenant_id, b.site_id, b.day, b.variant, b.dimension, b.value`,
  },
  {
    file: "web_wallet_events_daily.jsonl",
    description:
      "Stellar wallet-event counts per website, UTC day, event, network and property value (closed vocabulary). A count below op_min_count is omitted",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("site_id", "uuid", "website id"),
      c("day", "date", "UTC day"),
      c("event_name", "text", "event of the closed Stellar vocabulary"),
      c("network", "text", "Stellar network"),
      c("prop_key", "text", "property"),
      c("prop_value", "text", "property value (closed vocabulary)"),
      c("verdict", "text", "verified | suspect"),
      c("count", "integer", "events"),
    ],
    sql: `SELECT e.tenant_id, e.site_id, e.day, e.event_name, e.network, e.prop_key, e.prop_value, e.verdict, e.count
            FROM scf.web_event_property_daily e JOIN kept USING (tenant_id)
           WHERE e.count >= scf.setting_int('op_min_count')
           ORDER BY e.tenant_id, e.site_id, e.day, e.event_name, e.network, e.prop_key, e.prop_value, e.verdict`,
  },
  {
    file: "web_trust_scores.jsonl",
    description: "Advisory trust scores per website and day (algorithm version stated per row)",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("site_id", "uuid", "website id"),
      c("day", "date", "UTC day"),
      c("window_days", "integer", "1 or 28"),
      c("score", "integer", "0–100, or null (not enough data)"),
      c("components", "json", "component inputs and penalties"),
      c("reason_codes", "text[]", "reason codes"),
      c("algorithm_version", "text", "e.g. trust/1.0.0"),
    ],
    sql: `SELECT s.tenant_id, s.site_id, s.day, s.window_days, s.score, s.components, s.reason_codes, s.algorithm_version
            FROM scf.web_trust_scores s JOIN kept USING (tenant_id)
           ORDER BY s.tenant_id, s.site_id, s.day, s.window_days`,
  },
  {
    file: "api_routes.jsonl",
    description: "Normalised API route templates (key of the API metric files)",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("route_id", "integer", "route id"),
      c("service_id", "uuid", "service id"),
      c("route", "text", "route template"),
      c("rpc_method", "text", "JSON-RPC method, or null"),
      c("rules_version", "text", "path-normalisation rules version"),
    ],
    sql: `SELECT r.tenant_id, r.route_id, r.service_id, r.route, r.rpc_method, r.rules_version
            FROM scf.api_routes r JOIN kept USING (tenant_id) ORDER BY r.tenant_id, r.route_id`,
  },
  ...(["1h", "1d"] as const).map(
    (res): FileSpec => ({
      file: `api_metrics_${res}.jsonl`,
      description: `Self-attested API telemetry per ${res === "1h" ? "UTC hour" : "UTC day"}, route, method, status class and source (latency histogram included)`,
      columns: [
        c("tenant_id", "uuid", "project id"),
        c("service_id", "uuid", "service id"),
        c("route_id", "integer", "route id (api_routes.jsonl)"),
        c("method", "integer", "HTTP method code (data-model §8.6)"),
        c("status_code", "integer", "HTTP status, 0 = unknown"),
        c("source", "text", "metric source"),
        c("stream_group_id", "integer", "stream group"),
        c("bucket_start", "timestamp", "bucket start (UTC)"),
        c("request_count", "integer", "requests"),
        c("duration_sum", "number", "summed duration in seconds"),
        c("duration_min", "number", "minimum duration in seconds, or null"),
        c("duration_max", "number", "maximum duration in seconds, or null"),
        c("hist_kind", "text", "explicit15 | exp3"),
        c("hist", "integer[]", "histogram bucket counts"),
        c("hist_quality", "integer", "0 exact, 1 approximate, 2 coarse"),
      ],
      sql: `SELECT m.tenant_id, m.service_id, m.route_id, m.method, m.status_code, m.source::text, m.stream_group_id,
                   m.bucket_start, m.request_count, m.duration_sum, m.duration_min, m.duration_max, m.hist_kind::text,
                   m.hist, m.hist_quality
              FROM scf.api_metrics_${res} m JOIN kept USING (tenant_id)
             ORDER BY m.tenant_id, m.service_id, m.bucket_start, m.route_id, m.method, m.status_code, m.source,
                      m.stream_group_id`,
    }),
  ),
  {
    file: "api_service_assurance.jsonl",
    description: "API assurance level per service and day",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("service_id", "uuid", "service id"),
      c("day", "date", "UTC day"),
      c("level", "integer", "0–2 (A0–A2)"),
      c("onchain_badge", "text", "on-chain consistency badge"),
      c("reason_codes", "text[]", "reason codes"),
    ],
    sql: `SELECT a.tenant_id, a.service_id, a.day, a.level, a.onchain_badge, a.reason_codes
            FROM scf.api_service_assurance a JOIN kept USING (tenant_id) ORDER BY a.tenant_id, a.service_id, a.day`,
  },
  {
    file: "onchain_daily.jsonl",
    description:
      "On-chain figures per verified contract and UTC day (invoker addresses are never stored)",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("contract_ref", "uuid", "declared_contracts.jsonl reference"),
      c("day", "date", "UTC day"),
      c("invocations", "integer", "top-level invocations"),
      c("successful_invocations", "integer", "invocations in successful transactions"),
      c("distinct_invokers", "integer", "distinct invokers of the day"),
      c("data_source", "text", "ledger_files | hubble"),
    ],
    sql: `SELECT o.tenant_id, o.contract_ref, o.day, o.invocations, o.successful_invocations, o.distinct_invokers,
                 o.data_source
            FROM scf.onchain_daily o JOIN kept USING (tenant_id) ORDER BY o.tenant_id, o.contract_ref, o.day`,
  },
  {
    file: "traction_snapshots.jsonl",
    description:
      "Signed traction snapshots (wire-formats §i.3); verifiable offline with the published snapshot keys",
    columns: [
      c("tenant_id", "uuid", "project id"),
      c("snapshot_id", "uuid", "snapshot id"),
      c("created_at", "timestamp", "signing time"),
      c("period_start", "timestamp", "period start (inclusive)"),
      c("period_end", "timestamp", "period end (exclusive)"),
      c("document", "json", "the signed document"),
      c("canonical_sha256", "hex", "SHA-256 of the canonical JSON"),
      c("signature", "hex", "Ed25519 signature"),
      c("kid", "text", "signing key id"),
      c("revoked_at", "timestamp", "revocation time, or null"),
    ],
    sql: `SELECT s.tenant_id, s.snapshot_id, s.created_at, s.period_start, s.period_end, s.document,
                 encode(s.canonical_sha256, 'hex'), encode(s.signature, 'hex'), s.kid, s.revoked_at
            FROM scf.traction_snapshots s JOIN kept USING (tenant_id) ORDER BY s.tenant_id, s.snapshot_id`,
  },
];

export interface ManifestFile {
  name: string;
  description: string;
  rows: number;
  bytes: number;
  sha256: string;
  columns: Column[];
}

export interface Manifest {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  generated_at: string;
  source: { database: string; server_version: string; consistency: string };
  privacy: {
    event_level_data: false;
    min_count: number;
    round_to: number;
    rules: string[];
  };
  excluded: string[];
  files: ManifestFile[];
}

/** `date` stays the database's text (YYYY-MM-DD): no local time zone can shift a UTC day. */
const RAW_DATES = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === 1082
      ? (v: string) => v
      : pg.types.getTypeParser(oid, format ?? "text")) as typeof pg.types.getTypeParser,
};

function toJsonValue(type: ColType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "integer": {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) return String(v);
      return n;
    }
    case "number":
      return Number(v);
    case "date":
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    case "timestamp":
      return v instanceof Date ? v.toISOString() : String(v);
    case "integer[]":
      return (v as unknown[]).map((x) => Number(x));
    default:
      return v;
  }
}

/**
 * Writes the bundle into `outDir` (created; must be empty) from `client`, which must be connected as a role that
 * bypasses row-level security. Returns the manifest (also written as manifest.json).
 */
export async function exportAggregates(
  client: pg.ClientBase,
  outDir: string,
  now: () => Date = () => new Date(),
): Promise<Manifest> {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) throw new Error(`output directory ${outDir} is not empty`);
  const role = await client.query<{ ok: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`,
  );
  // Row-level security would silently hide rows: an export through a restricted role would look complete but not be.
  if (!role.rows[0]?.ok)
    throw new Error("the export role must bypass row-level security (superuser or BYPASSRLS)");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const meta = await client.query<{
      db: string;
      v: string;
      k: number;
      r: number;
    }>(
      `SELECT current_database() AS db, current_setting('server_version') AS v,
              scf.setting_int('op_min_count') AS k, scf.setting_int('op_round_to') AS r`,
    );
    const m = meta.rows[0] as { db: string; v: string; k: number; r: number };
    const files: ManifestFile[] = [];
    for (const spec of FILES) {
      const path = join(outDir, spec.file);
      const fd = openSync(path, "wx", 0o600);
      const hash = createHash("sha256");
      let rows = 0;
      let bytes = 0;
      try {
        await client.query(`DECLARE scf_export NO SCROLL CURSOR FOR WITH ${KEPT} ${spec.sql}`);
        for (;;) {
          const batch = await client.query({
            text: "FETCH 5000 FROM scf_export",
            rowMode: "array",
            types: RAW_DATES,
          });
          if (batch.rows.length === 0) break;
          if (batch.fields.length !== spec.columns.length)
            throw new Error(
              `${spec.file}: query returns ${batch.fields.length} columns, schema has ${spec.columns.length}`,
            );
          let chunk = "";
          for (const r of batch.rows as unknown[][]) {
            const o: Record<string, unknown> = {};
            spec.columns.forEach((col, i) => {
              o[col.name] = toJsonValue(col.type, r[i]);
            });
            chunk += `${JSON.stringify(o)}\n`;
            rows++;
          }
          const buf = Buffer.from(chunk, "utf8");
          hash.update(buf);
          bytes += buf.length;
          writeSync(fd, buf);
        }
        await client.query("CLOSE scf_export");
      } finally {
        closeSync(fd);
      }
      files.push({
        name: spec.file,
        description: spec.description,
        rows,
        bytes,
        sha256: hash.digest("hex"),
        columns: spec.columns,
      });
    }
    await client.query("COMMIT");
    const manifest: Manifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      generated_at: now().toISOString(),
      source: {
        database: m.db,
        server_version: m.v,
        consistency: "one REPEATABLE READ, READ ONLY transaction (all files are one snapshot)",
      },
      privacy: {
        event_level_data: false,
        min_count: Number(m.k),
        round_to: Number(m.r),
        rules: [
          "aggregates only: no engine (Umami) tables, no individual events, sessions, visitors, IP addresses, user agents, query strings or page titles",
          "web_daily_breakdowns: a row below min_count (visitors; events for the event dimension) is omitted, counts are rounded to round_to",
          "web_wallet_events_daily: a count below min_count is omitted",
          "no people: no user accounts, members, e-mail or wallet addresses of end users, no credentials, keys or tokens",
        ],
      },
      excluded: ["removed and purged tenants", "synthetic canary tenants", "websites being purged"],
      files,
    };
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return manifest;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const url = process.env.SCF_EXPORT_DATABASE_URL;
  if (!values.out || !url) {
    process.stderr.write(
      "usage: SCF_EXPORT_DATABASE_URL=postgres://… node scripts/export-aggregates.ts --out <new directory>\n",
    );
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url, application_name: "scf-aggregate-export" });
  await client.connect();
  try {
    const m = await exportAggregates(client, values.out);
    for (const f of m.files)
      process.stdout.write(`${f.name}\t${f.rows} rows\tsha256 ${f.sha256}\n`);
    process.stdout.write(`manifest.json\t${EXPORT_FORMAT} ${EXPORT_VERSION}\n`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`export failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
