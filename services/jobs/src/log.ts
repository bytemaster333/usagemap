// SPDX-License-Identifier: Apache-2.0
// Structured logs (one JSON object per line on stdout) that cannot carry personal data by construction: field values
// are numbers, booleans or short identifiers (job names, UUIDs, dates, SQLSTATE codes, constraint names). Anything
// else — and anything that looks like an IP address, a URL, a query string, an e-mail address, a Stellar key or a
// free-text database message — is replaced by "{redacted}" before it is written. Errors are logged by class and
// SQLSTATE only, never by message or detail (PostgreSQL puts row values into both).

export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue>;
export type Level = "debug" | "info" | "warn" | "error";

const SAFE = /^[A-Za-z0-9_.:+\-/]{0,96}$/;
const IPV4 = /(^|[^0-9])\d{1,3}(\.\d{1,3}){3}([^0-9]|$)/;
const IPV6ISH = /[0-9a-f]{1,4}:[0-9a-f]{0,4}:/i;
const STELLAR = /[GSMC][A-Z2-7]{55}/;
const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;

/** Returns the value if it is safe to log, otherwise "{redacted}". */
export function safeValue(v: LogValue): LogValue {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (!SAFE.test(v) || IPV4.test(v) || STELLAR.test(v)) return "{redacted}";
  // An ISO timestamp contains colons between digits; anything else with hex groups and colons is treated as IPv6.
  if (IPV6ISH.test(v) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return "{redacted}";
  return v;
}

export interface Logger {
  log(level: Level, event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(
  base: LogFields = {},
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  minLevel: Level = "info",
): Logger {
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const log = (level: Level, event: string, fields: LogFields = {}): void => {
    if (order[level] < order[minLevel]) return;
    const out: Record<string, LogValue> = {
      time: new Date().toISOString(),
      level,
      event: KEY_RE.test(event) ? event : "invalid_event_name",
    };
    for (const [k, v] of Object.entries({ ...base, ...fields })) {
      if (!KEY_RE.test(k) || k === "time" || k === "level" || k === "event") continue;
      out[k] = safeValue(v);
    }
    write(JSON.stringify(out));
  };
  return {
    log,
    debug: (e, f) => log("debug", e, f),
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f),
  };
}

/** Error classification for logs and metrics: never the message. */
export function errorFields(err: unknown): LogFields {
  if (typeof err !== "object" || err === null) return { error_class: "unknown" };
  const e = err as { code?: unknown; constraint?: unknown; name?: unknown; table?: unknown };
  const out: LogFields = {};
  if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
    out.error_class = "postgres";
    out.sqlstate = e.code;
    if (typeof e.constraint === "string") out.constraint = e.constraint;
    if (typeof e.table === "string") out.table = e.table;
    return out;
  }
  if (typeof e.code === "string" && /^E[A-Z]+$/.test(e.code)) {
    out.error_class = "network";
    out.errno = e.code;
    return out;
  }
  if (e.name === "AbortError") return { error_class: "aborted" };
  out.error_class =
    typeof e.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "error";
  return out;
}
