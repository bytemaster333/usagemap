// SPDX-License-Identifier: Apache-2.0
// @ts-check
// Alert mailer (runbook ops/runbooks/alert-email.md): turns one Alertmanager webhook notification (payload version 4)
// into exactly one plain-text e-mail. Pure logic, no Workers imports: worker.js wires it to the `send_email` binding,
// the tests run it in Node and in workerd.
//
// What reaches the mailbox is defence in depth on top of C-26 (alert content never carries visitor data): label and
// annotation values are scrubbed of IP addresses, e-mail addresses, Stellar keys, API keys, bearer tokens, JWTs, long
// opaque strings and URL query strings; labels whose name says they hold such data are dropped to "[redacted]";
// generatorURL/externalURL (PromQL in a query string, internal host names) are never copied. The worker logs counts
// only — never an address, a label value or the token.

/** Largest request body accepted (Alertmanager sends at most `max_alerts` alerts; 50 alerts stay well below). */
export const MAX_BODY_BYTES = 256 * 1024;
/** Alerts listed in one message; the rest are counted ("… and N more"). */
export const MAX_LISTED_ALERTS = 50;
/** Longest label/annotation value kept, in characters. */
export const MAX_VALUE_CHARS = 512;
/** Subject length cap (Cloudflare allows 998; mail clients show far less). */
export const MAX_SUBJECT_CHARS = 200;
/** Shortest bearer secret the worker accepts as configured. */
export const MIN_TOKEN_CHARS = 32;
export const PATH = "/v1/alertmanager";

/**
 * @typedef {{ labels: Record<string, string>, annotations?: Record<string, string>, status: string,
 *   startsAt?: string, endsAt?: string, fingerprint?: string }} Alert
 * @typedef {{ version: string, status: string, receiver: string, groupKey?: string, truncatedAlerts?: number,
 *   groupLabels?: Record<string, string>, commonLabels?: Record<string, string>,
 *   commonAnnotations?: Record<string, string>, alerts: Alert[] }} Notification
 * @typedef {{ send(message: unknown): Promise<unknown> }} SendEmailBinding
 * @typedef {{ ALERT_TOKEN?: string, MAIL_FROM?: string, MAIL_TO?: string, MAIL?: SendEmailBinding }} Env
 * @typedef {(from: string, to: string, raw: string) => unknown} MessageFactory
 * @typedef {{ log(event: Record<string, string | number>): void }} Logger
 */

// --- request handling --------------------------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {MessageFactory} makeMessage builds the runtime's EmailMessage (cloudflare:email) from a raw MIME message
 * @param {Logger} [logger]
 * @returns {Promise<Response>}
 */
export async function handle(request, env, makeMessage, logger = consoleLogger) {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return reply(404, "not_found");
  if (request.method !== "POST") return reply(405, "method_not_allowed", { allow: "POST" });

  const config = readConfig(env);
  if (!config.ok) {
    logger.log({ event: "misconfigured", reason: config.reason });
    return reply(500, "misconfigured");
  }
  if (!(await authorised(request.headers.get("authorization"), config.token))) {
    logger.log({ event: "unauthorised" });
    return reply(401, "unauthorised", { "www-authenticate": 'Bearer realm="alert-mailer"' });
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return reply(415, "unsupported_media_type");

  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === null) return reply(413, "payload_too_large");
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return reply(400, "invalid_json");
  }
  const notification = validateNotification(parsed);
  if (typeof notification === "string")
    return reply(400, "invalid_notification", { detail: notification });

  const raw = buildMessage(notification, {
    from: config.from,
    to: config.to,
    now: new Date(),
    messageId: `${crypto.randomUUID()}@${domainOf(config.from)}`,
  });
  try {
    await config.mail.send(makeMessage(config.from, config.to, raw));
  } catch (err) {
    // The runtime's error code (E_RATE_LIMIT_EXCEEDED, E_RECIPIENT_NOT_ALLOWED, …) only; its message may echo an
    // address. Alertmanager retries on 5xx.
    const code = errorCode(err);
    logger.log({ event: "send_failed", code, alerts: notification.alerts.length });
    return reply(502, "send_failed", { code });
  }
  logger.log({
    event: "sent",
    status: notification.status,
    receiver: scrubValue(notification.receiver),
    alerts: notification.alerts.length,
  });
  return reply(200, "sent", { messages: 1 });
}

/** @type {Logger} */
const consoleLogger = { log: (event) => console.log(JSON.stringify(event)) };

/**
 * @param {number} status
 * @param {string} result
 * @param {Record<string, string | number>} [extra] JSON fields, or for 401/405 the response header
 */
function reply(status, result, extra = {}) {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  /** @type {Record<string, string | number>} */
  const fields = { result };
  for (const [k, v] of Object.entries(extra)) {
    if (k === "allow" || k === "www-authenticate") headers.set(k, String(v));
    else fields[k] = v;
  }
  return new Response(JSON.stringify(fields), { status, headers });
}

/** @param {unknown} err */
function errorCode(err) {
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? code
    : err instanceof TypeError
      ? "TYPE_ERROR"
      : "UNKNOWN";
}

/**
 * @param {Env} env
 * @returns {{ ok: true, token: string, from: string, to: string, mail: SendEmailBinding } | { ok: false, reason: string }}
 */
export function readConfig(env) {
  const token = env.ALERT_TOKEN ?? "";
  const from = (env.MAIL_FROM ?? "").trim();
  const to = (env.MAIL_TO ?? "").trim();
  if (token.length < MIN_TOKEN_CHARS) return { ok: false, reason: "ALERT_TOKEN" };
  if (!isAddress(from)) return { ok: false, reason: "MAIL_FROM" };
  if (!isAddress(to)) return { ok: false, reason: "MAIL_TO" };
  if (!env.MAIL || typeof env.MAIL.send !== "function") return { ok: false, reason: "MAIL" };
  return { ok: true, token, from, to, mail: env.MAIL };
}

/** A plain addr-spec without display name, comments, quotes or whitespace (no header injection possible). */
export function isAddress(/** @type {string} */ s) {
  return (
    s.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
      s,
    )
  );
}

/** @param {string} address */
function domainOf(address) {
  return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * Constant-time comparison of SHA-256 digests (equal length whatever the inputs).
 * @param {string | null} header
 * @param {string} token
 */
export async function authorised(header, token) {
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(header ?? "");
  const presented = match?.[1] ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = presented.length === 0 ? 1 : 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Reads the body as text, or null when it exceeds `limit` bytes (checked on the declared length and while reading).
 * @param {Request} request
 * @param {number} limit
 */
async function readLimited(request, limit) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// --- payload validation ------------------------------------------------------------------------------------------

/** @param {unknown} v */
function isStringMap(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(/** @type {object} */ (v)).every((x) => typeof x === "string")
  );
}

/**
 * Checks the Alertmanager webhook payload (version 4). Returns the notification or a short reason.
 * @param {unknown} v
 * @returns {Notification | string}
 */
export function validateNotification(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "not an object";
  const n = /** @type {Record<string, unknown>} */ (v);
  if (n.version !== "4") return "version must be 4";
  if (n.status !== "firing" && n.status !== "resolved") return "status";
  if (typeof n.receiver !== "string" || n.receiver.length === 0) return "receiver";
  if (!Array.isArray(n.alerts) || n.alerts.length === 0 || n.alerts.length > 1000) return "alerts";
  for (const key of ["groupLabels", "commonLabels", "commonAnnotations"]) {
    if (n[key] !== undefined && !isStringMap(n[key])) return key;
  }
  if (n.truncatedAlerts !== undefined && typeof n.truncatedAlerts !== "number")
    return "truncatedAlerts";
  for (const a of n.alerts) {
    if (a === null || typeof a !== "object") return "alert";
    const alert = /** @type {Record<string, unknown>} */ (a);
    if (!isStringMap(alert.labels)) return "alert.labels";
    if (alert.annotations !== undefined && !isStringMap(alert.annotations))
      return "alert.annotations";
    if (alert.status !== "firing" && alert.status !== "resolved") return "alert.status";
    for (const k of ["startsAt", "endsAt", "fingerprint"]) {
      if (alert[k] !== undefined && typeof alert[k] !== "string") return `alert.${k}`;
    }
  }
  return /** @type {Notification} */ (/** @type {unknown} */ (n));
}

// --- scrubbing ---------------------------------------------------------------------------------------------------

/** Name parts that say a label holds personal data or a secret; such labels are shown as "[redacted]". */
const SENSITIVE_NAME_PARTS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "pass",
  "pwd",
  "credential",
  "credentials",
  "auth",
  "authorization",
  "cookie",
  "session",
  "seed",
  "key",
  "apikey",
  "email",
  "mail",
  "ip",
  "ipv4",
  "ipv6",
  "addr",
  "address",
  "ua",
  "useragent",
  "agent",
  "wallet",
  "account",
  "query",
  "querystring",
  "title",
  "user",
  "username",
  "visitor",
  "phone",
]);
/** Names kept although a part matches (our own, non-personal label names). */
const SAFE_NAMES = new Set(["api_key_anomaly", "key_type", "monitor_id"]);

/** @param {string} name */
export function isSensitiveName(name) {
  const lower = name.toLowerCase();
  if (SAFE_NAMES.has(lower)) return false;
  if (lower.replace(/[^a-z]/g, "").includes("useragent")) return true;
  return lower.split(/[^a-z0-9]+/).some((part) => SENSITIVE_NAME_PARTS.has(part));
}

/** @type {Array<[RegExp, string | ((m: string) => string)]>} */
const VALUE_RULES = [
  // URL query strings and fragments (never stored or sent, C-26): keep scheme, host and path.
  [/\b((?:https?|wss?):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1"],
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [token]"],
  // key=value / key: value pairs whose key names a credential or session.
  [
    /\b(cookie|session|session_?id|sid|token|secret|password|passwd|pwd|api_?key|auth)([=:])\s*[^\s"',;&]+/gi,
    "$1$2[redacted]",
  ],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[token]"],
  [/\bscfa_[A-Za-z0-9_-]+/g, "[api-key]"],
  [/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]"],
  // Stellar strkeys: account (G), secret seed (S), muxed account (M).
  [/\b[GS][A-Z2-7]{55}\b/g, "[stellar-key]"],
  [/\bM[A-Z2-7]{68}\b/g, "[stellar-key]"],
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, "[ip]"],
  [/(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}/g, (m) => (looksLikeIPv6(m) ? "[ip]" : m)],
  // Long opaque strings with letters and digits (keys, hashes of secrets, session ids); words and paths stay.
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (looksOpaque(m) ? "[redacted]" : m)],
];

/** Hex digests, base64 keys, session ids: many digits, or mixed case with digits. @param {string} s */
function looksOpaque(s) {
  const digits = s.replace(/\D/g, "").length;
  return digits >= 6 || (/[A-Z]/.test(s) && /[a-z]/.test(s) && digits > 0);
}

/** @param {string} s */
function looksLikeIPv6(s) {
  const groups = s.split(":");
  if (s.includes("::")) return groups.some((g) => /[0-9A-Fa-f]/.test(g)) || s === "::";
  return (
    groups.length >= 4 &&
    groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g)) &&
    /[A-Fa-f]|\d{3,}/.test(s)
  );
}

/**
 * One label/annotation value as it may appear in an e-mail: control characters removed, sensitive patterns replaced,
 * length capped.
 * @param {string} value
 */
export function scrubValue(value) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
  let s = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  for (const [re, rep] of VALUE_RULES) s = s.replace(re, /** @type {string} */ (rep));
  if (s.length > MAX_VALUE_CHARS) s = `${s.slice(0, MAX_VALUE_CHARS - 1)}…`;
  return s;
}

/**
 * @param {Record<string, string> | undefined} map
 * @returns {Array<[string, string]>}
 */
export function scrubMap(map) {
  return Object.entries(map ?? {})
    .map(
      ([k, v]) =>
        /** @type {[string, string]} */ ([
          scrubName(k),
          isSensitiveName(k) ? "[redacted]" : scrubValue(v),
        ]),
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** @param {string} name */
function scrubName(name) {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

// --- message -----------------------------------------------------------------------------------------------------

/**
 * The subject line, e.g. "[UsageMap FIRING:2] critical IngestBurnRate (maintainers-critical)".
 * @param {Notification} n
 */
export function subjectOf(n) {
  const firing = n.alerts.filter((a) => a.status === "firing").length;
  const state = n.status === "firing" ? `FIRING:${firing}` : "RESOLVED";
  const common = Object.fromEntries(scrubMap(n.commonLabels));
  const group = Object.fromEntries(scrubMap(n.groupLabels));
  const name =
    common.alertname ?? group.alertname ?? (n.alerts.length > 1 ? "several alerts" : "alert");
  const severity = common.severity ?? group.severity;
  const parts = [`[UsageMap ${state}]`, severity, name, `(${scrubValue(n.receiver)})`].filter(
    Boolean,
  );
  const subject = parts.join(" ").replace(/\s+/g, " ");
  return subject.length > MAX_SUBJECT_CHARS
    ? `${subject.slice(0, MAX_SUBJECT_CHARS - 1)}…`
    : subject;
}

/**
 * The plain-text body.
 * @param {Notification} n
 */
export function bodyOf(n) {
  const firing = n.alerts.filter((a) => a.status === "firing").length;
  const resolved = n.alerts.length - firing;
  const lines = [
    `Status:   ${n.status} (${firing} firing, ${resolved} resolved)`,
    `Receiver: ${scrubValue(n.receiver)}`,
    `Group:    ${
      scrubMap(n.groupLabels)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(none)"
    }`,
    "",
  ];
  const listed = n.alerts.slice(0, MAX_LISTED_ALERTS);
  listed.forEach((a, i) => {
    const labels = scrubMap(a.labels);
    const ann = Object.fromEntries(scrubMap(a.annotations));
    const name = labels.find(([k]) => k === "alertname")?.[1] ?? "alert";
    const severity = labels.find(([k]) => k === "severity")?.[1] ?? "";
    lines.push(`[${i + 1}] ${a.status.toUpperCase()}  ${name}${severity ? `  (${severity})` : ""}`);
    if (ann.summary) lines.push(`    Summary:     ${ann.summary}`);
    if (ann.description) lines.push(`    Description: ${ann.description}`);
    if (ann.runbook_url) lines.push(`    Runbook:     ${ann.runbook_url}`);
    if (a.startsAt) lines.push(`    Started:     ${scrubValue(a.startsAt)}`);
    if (a.status === "resolved" && a.endsAt) lines.push(`    Ended:       ${scrubValue(a.endsAt)}`);
    const rest = labels.filter(([k]) => k !== "alertname" && k !== "severity");
    if (rest.length) lines.push(`    Labels:      ${rest.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    for (const [k, v] of Object.entries(ann)) {
      if (k !== "summary" && k !== "description" && k !== "runbook_url")
        lines.push(`    ${k}: ${v}`);
    }
    lines.push("");
  });
  const more = n.alerts.length - listed.length + (n.truncatedAlerts ?? 0);
  if (more > 0) lines.push(`… and ${more} more alert(s) in this group (see Alertmanager).`, "");
  lines.push(
    "--",
    "Sent by the UsageMap alert mailer for Alertmanager. Inspect or silence on the host:",
    "ssh -L 9093:127.0.0.1:9093 <host>, then http://127.0.0.1:9093 (runbook ops/runbooks/alert-email.md).",
  );
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * The complete RFC 5322 message: CRLF line endings, UTF-8 text in base64 (76-character lines), RFC 2047 subject
 * when it is not plain ASCII, Message-ID and Date set (a raw EmailMessage without Message-ID is refused), marked as
 * automatically generated (RFC 3834) so that no auto-responder answers it.
 * @param {Notification} n
 * @param {{ from: string, to: string, now: Date, messageId: string }} opts
 */
export function buildMessage(n, opts) {
  if (!isAddress(opts.from) || !isAddress(opts.to)) throw new TypeError("invalid address");
  if (!/^[A-Za-z0-9.-]+@[A-Za-z0-9.-]+$/.test(opts.messageId))
    throw new TypeError("invalid message id");
  const headers = [
    `From: UsageMap alerts <${opts.from}>`,
    `To: <${opts.to}>`,
    `Subject: ${encodeHeader(subjectOf(n))}`,
    `Date: ${rfc5322Date(opts.now)}`,
    `Message-ID: <${opts.messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${wrap(base64(bodyOf(n)), 76)}\r\n`;
}

/** @param {string} s */
export function encodeHeader(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // RFC 2047 encoded-words of at most 75 characters each, split on character boundaries.
  const words = [];
  let chunk = "";
  for (const ch of s) {
    if (new TextEncoder().encode(chunk + ch).length > 45) {
      words.push(`=?UTF-8?B?${base64(chunk)}?=`);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return words.join("\r\n ");
}

/** @param {Date} d */
export function rfc5322Date(d) {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/** @param {string} s */
function base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * @param {string} s
 * @param {number} width
 */
function wrap(s, width) {
  const out = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out.join("\r\n");
}
