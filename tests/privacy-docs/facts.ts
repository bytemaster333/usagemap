// SPDX-License-Identifier: Apache-2.0
// The implementation side of the privacy-documents check (privacy.strategy-docs): read once from the migrated database (columns,
// constraints, `scf.retention_rules()`, settings behaviour) and from the sources and configuration that decide what is
// kept (gateway spool records, Collector allow-list and pipelines, control-plane timeouts, monitoring and backup
// retention). Every reader throws when its anchor is gone, so a refactor surfaces as a failure, not a pass.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

export interface RetentionRule {
  months: number;
  days: number;
  mechanism: string;
  age_expr: string;
}

export interface Facts {
  /** scf.retention_rules() by relation. A relation absent here is kept indefinitely. */
  retention: Record<string, RetentionRule>;
  /** Every column of every table and view of schema scf, as "table.column" (partitions excluded). */
  columns: string[];
  /** CHECK constraint definitions as "table: def". */
  checks: string[];
  /** settings.web_event_retention_days: stored default and the values the database accepts / refuses. */
  ewDefault: number;
  ewAccepted: number[];
  ewRefused: number[];
  /** JSON names of the gateway spool records (services/gateway/internal/spool/records.go). */
  spool: Record<string, string[]>;
  spoolExpiryHours: number;
  forwarderExpiryHours: number;
  eventIdWindowMinutes: number;
  /** Gateway source computes a JA4 transport fingerprint (C-124). */
  gatewayComputesJa4: boolean;
  /** Attribute keys the Collector's sanitise step may emit (proto-level allow-list, union over levels). */
  collectorKeys: string[];
  /** OTLP proto fields allowed in the sanitised output. */
  collectorProtoFields: string[];
  collectorPipelines: string[];
  collectorSanitizeMaxAge: string;
  writerMaxReceiptAgeHours: number;
  sessionTimeoutsMinutes: {
    tenant_user: { idle: number; absolute: number };
    operator: { idle: number; absolute: number };
  };
  oauthStateMinutes: number;
  oauthChallengeInterval: string;
  opKeyDefaultDays: number;
  logsRetention: string;
  prometheusRetention: string;
  pgbackrestRetentionFullDays: number[];
  previousVersionDays: number[];
  /** Production interval between full backups (compose.ha.yaml SCF_BACKUP_FULL_EVERY default), days. */
  backupFullEveryDays: number;
}

// --- database -------------------------------------------------------------------------------------------------------

export interface Db {
  /** Runs SQL as the superuser in database scf; returns stdout (psql -At). Throws on error. */
  sql(statements: string[]): string;
}

export function composeDb(project: string, composeFile: string): Db {
  return {
    sql(statements) {
      const args = [
        "compose",
        "-p",
        project,
        "-f",
        composeFile,
        "exec",
        "-T",
        "pg",
        "psql",
        "-U",
        "postgres",
        "-d",
        "scf",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
      ];
      for (const s of statements) args.push("-c", s);
      return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    },
  };
}

const json = <T>(db: Db, query: string): T =>
  JSON.parse(db.sql([`SELECT coalesce(json_agg(x), '[]'::json) FROM (${query}) x`]).trim()) as T;

function dbFacts(
  db: Db,
): Pick<Facts, "retention" | "columns" | "checks" | "ewDefault" | "ewAccepted" | "ewRefused"> {
  const rules = json<Array<RetentionRule & { relname: string }>>(
    db,
    `SELECT relname, (extract(year FROM keep) * 12 + extract(month FROM keep))::int AS months,
            extract(day FROM keep)::int AS days, mechanism, age_expr FROM scf.retention_rules()`,
  );
  const retention: Record<string, RetentionRule> = {};
  for (const r of rules)
    retention[r.relname] = {
      months: r.months,
      days: r.days,
      mechanism: r.mechanism,
      age_expr: r.age_expr,
    };
  const columns = json<Array<{ c: string }>>(
    db,
    `SELECT c.relname || '.' || a.attname AS c FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'scf' AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition AND a.attnum > 0
        AND NOT a.attisdropped ORDER BY 1`,
  ).map((r) => r.c);
  const checks = json<Array<{ d: string }>>(
    db,
    `SELECT conrelid::regclass::text || ': ' || pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE contype = 'c' AND connamespace = 'scf'::regnamespace ORDER BY 1`,
  ).map((r) => r.d);
  const ewDefault = Number(
    db
      .sql(["SELECT value #>> '{}' FROM scf.settings WHERE key = 'web_event_retention_days'"])
      .trim(),
  );
  const ewAccepted: number[] = [];
  const ewRefused: number[] = [];
  for (const v of [1, 29, 30, 31, 90, 394, 395, 396, 1000]) {
    try {
      db.sql([
        "BEGIN",
        `UPDATE scf.settings SET value = '${v}'::jsonb WHERE key = 'web_event_retention_days'`,
        "ROLLBACK",
      ]);
      ewAccepted.push(v);
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? e);
      if (!/violates check constraint/.test(msg)) throw e;
      ewRefused.push(v);
    }
  }
  return { retention, columns, checks, ewDefault, ewAccepted, ewRefused };
}

// --- sources --------------------------------------------------------------------------------------------------------

function must(text: string, re: RegExp, where: string): RegExpExecArray {
  const m = re.exec(text);
  if (!m) throw new Error(`implementation anchor ${re} not found in ${where}`);
  return m;
}

/** JSON field names of each struct in a Go file. */
export function goJsonTags(src: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of src.matchAll(/type (\w+) struct \{([\s\S]*?)\n\}/g)) {
    const tags = [...(m[2] as string).matchAll(/`json:"([^",]+)/g)].map((t) => t[1] as string);
    if (tags.length > 0) out[m[1] as string] = tags;
  }
  return out;
}

/** String constants of the Go files of a package directory (non-test). */
function goConsts(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(join(ROOT, dir))) {
    if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
    for (const m of read(join(dir, f)).matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm))
      out.set(m[1] as string, m[2] as string);
  }
  return out;
}

const SANITIZE = "collector/processor/scfsanitizeprocessor";

function collectorFacts(): Pick<
  Facts,
  "collectorKeys" | "collectorProtoFields" | "collectorPipelines" | "collectorSanitizeMaxAge"
> {
  const t = read(`${SANITIZE}/protoallow_test.go`);
  const block = must(
    t,
    /var allowedKeys = map\[attrLevel\]map\[string\]bool\{([\s\S]*?)\n\}/,
    `${SANITIZE}/protoallow_test.go`,
  )[1] as string;
  const consts = goConsts(SANITIZE);
  const keys = new Set<string>();
  for (const m of block.matchAll(/(\w+): true/g)) {
    const v = consts.get(m[1] as string);
    if (v === undefined)
      throw new Error(`allowedKeys names ${m[1]}, which is not a string constant of ${SANITIZE}`);
    keys.add(v);
  }
  const protoFields = [
    ...new Set([...t.matchAll(/name: *"([a-z_]+)"/g)].map((m) => m[1] as string)),
  ];
  const cfg = read("collector/config/collector.yaml");
  const pipes = must(
    cfg,
    /\n {2}pipelines:\n([\s\S]*)$/,
    "collector/config/collector.yaml",
  )[1] as string;
  const pipelines = [...pipes.matchAll(/^ {4}([a-z_/]+):\s*$/gm)].map((m) => m[1] as string);
  const maxAge = must(
    cfg,
    /scfsanitize:\n(?:\s+\w+: .*\n)*?\s+max_age: (\S+)/,
    "collector.yaml scfsanitize",
  )[1] as string;
  return {
    collectorKeys: [...keys].sort(),
    collectorProtoFields: protoFields,
    collectorPipelines: pipelines,
    collectorSanitizeMaxAge: maxAge,
  };
}

function gatewayFacts(): Pick<
  Facts,
  | "spool"
  | "spoolExpiryHours"
  | "forwarderExpiryHours"
  | "eventIdWindowMinutes"
  | "gatewayComputesJa4"
> {
  const spool = goJsonTags(read("services/gateway/internal/spool/records.go"));
  if (!spool.EventRecord)
    throw new Error("services/gateway/internal/spool/records.go: no EventRecord struct");
  const sp = read("services/gateway/internal/spool/spool.go");
  const fw = read("services/gateway/internal/forwarder/forwarder.go");
  const srv = read("services/gateway/internal/ingest/server.go");
  const transport = readdirSync(join(ROOT, "services/gateway/internal/transport"))
    .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
    .map((f) => read(join("services/gateway/internal/transport", f)))
    .join("\n");
  return {
    spool,
    spoolExpiryHours: Number(
      must(sp, /o\.Expiry = (\d+) \* time\.Hour/, "spool.go default Expiry")[1],
    ),
    forwarderExpiryHours: Number(
      must(fw, /f\.Expiry = (\d+) \* time\.Hour/, "forwarder.go Expiry")[1],
    ),
    eventIdWindowMinutes: Number(
      must(
        srv,
        /s\.eventIDs = limits\.NewTTLSet\((\d+)\*time\.Minute/,
        "ingest/server.go eventIDs",
      )[1],
    ),
    gatewayComputesJa4: /func ja4\(/.test(transport),
  };
}

function controlPlaneFacts(): Pick<
  Facts,
  "sessionTimeoutsMinutes" | "oauthStateMinutes" | "oauthChallengeInterval" | "opKeyDefaultDays"
> {
  const s = read("services/control-plane/src/auth/sessions.ts");
  const unit = { MIN: 1, HOUR: 60, DAY: 1440 } as const;
  const dur = (kind: string, which: "idle" | "absolute") => {
    const m = must(
      s,
      new RegExp(
        `${kind}: \\{ idle: (\\d+) \\* (MIN|HOUR|DAY), absolute: (\\d+) \\* (MIN|HOUR|DAY) \\}`,
      ),
      `sessions.ts TIMEOUTS.${kind}`,
    );
    return which === "idle"
      ? Number(m[1]) * unit[m[2] as keyof typeof unit]
      : Number(m[3]) * unit[m[4] as keyof typeof unit];
  };
  const gh = read("services/control-plane/src/auth/github.ts");
  const ops = read("services/control-plane/src/operator/handlers.ts");
  return {
    sessionTimeoutsMinutes: {
      tenant_user: { idle: dur("tenant_user", "idle"), absolute: dur("tenant_user", "absolute") },
      operator: { idle: dur("operator", "idle"), absolute: dur("operator", "absolute") },
    },
    oauthStateMinutes: Number(
      must(gh, /const STATE_TTL_MS = (\d+) \* 60_000;/, "github.ts STATE_TTL_MS")[1],
    ),
    oauthChallengeInterval: must(
      gh,
      /'github_oauth', \$1, \$2, \$3, now\(\) \+ interval '([^']+)'/,
      "github.ts auth challenge",
    )[1] as string,
    opKeyDefaultDays: Number(
      must(
        ops,
        /const days = b\.expires_in_days \?\? (\d+);/,
        "operator/handlers.ts key expiry default",
      )[1],
    ),
  };
}

function opsFacts(): Pick<
  Facts,
  | "logsRetention"
  | "prometheusRetention"
  | "pgbackrestRetentionFullDays"
  | "previousVersionDays"
  | "writerMaxReceiptAgeHours"
  | "backupFullEveryDays"
> {
  const mon = read("infra/compose/compose.monitoring.yaml");
  const pgb = [
    "infra/ansible/roles/compose_stack/templates/pgbackrest.conf.j2",
    "infra/ansible/roles/postgres/templates/pgbackrest.conf.j2",
  ];
  const tf = [
    "infra/opentofu/modules/azure-lean/variables.tf",
    "infra/opentofu/modules/azure-platform/variables.tf",
  ];
  return {
    logsRetention: must(
      mon,
      /-retentionPeriod=(\S+)/,
      "compose.monitoring.yaml VictoriaLogs",
    )[1] as string,
    prometheusRetention: must(
      mon,
      /--storage\.tsdb\.retention\.time=(\S+)/,
      "compose.monitoring.yaml Prometheus",
    )[1] as string,
    pgbackrestRetentionFullDays: pgb.map((f) =>
      Number(must(read(f), /retention-full=(\d+)/, f)[1]),
    ),
    previousVersionDays: tf.map((f) =>
      Number(
        must(
          read(f),
          /variable "backup_previous_version_days" \{[\s\S]*?default\s*=\s*(\d+)/,
          f,
        )[1],
      ),
    ),
    backupFullEveryDays:
      Number(
        must(
          read("infra/compose/compose.ha.yaml"),
          /SCF_BACKUP_FULL_EVERY: \$\{SCF_BACKUP_FULL_EVERY:-(\d+)\}/,
          "compose.ha.yaml SCF_BACKUP_FULL_EVERY",
        )[1],
      ) / 86400,
    writerMaxReceiptAgeHours: Number(
      must(
        read("services/metrics-writer/internal/batch/batch.go"),
        /MaxReceiptAge = (\d+) \* time\.Hour/,
        "metrics-writer batch.go",
      )[1],
    ),
  };
}

export function gatherFacts(db: Db): Facts {
  return {
    ...dbFacts(db),
    ...collectorFacts(),
    ...gatewayFacts(),
    ...controlPlaneFacts(),
    ...opsFacts(),
  };
}
