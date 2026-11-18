// SPDX-License-Identifier: Apache-2.0
// privacy.strategy-docs: every checkable claim of docs/privacy/data-inventory.md, next to where the implementation decides it.
// A claim is either a pair (`doc` reads the value the document states, `impl` the value the code/schema has; the test
// requires them equal) or a `check` that returns violations (empty = consistent). Both sides throw when their anchor
// (row, column, phrase, constant, rule) is gone — drift on either side fails the suite.

import type { Facts } from "./facts.ts";
import {
  cell,
  type Duration,
  fmtDuration,
  type Inventory,
  parseDuration,
  pick,
  row,
} from "./inventory.ts";

export interface Claim {
  id: string;
  /** What the document says, in a few words. */
  claim: string;
  /** Where the implementation decides it. */
  source: string;
  doc?: (inv: Inventory) => unknown;
  impl?: (f: Facts) => unknown;
  check?: (inv: Inventory, f: Facts) => string[];
}

const ruleDuration = (f: Facts, rel: string): string => {
  const r = f.retention[rel];
  return r === undefined
    ? "indefinite"
    : fmtDuration({ months: r.months, days: r.days, minutes: 0 });
};
const dur = (s: string): string => fmtDuration(parseDuration(s));
const hours = (h: number): string =>
  fmtDuration({ months: 0, days: h / 24, minutes: 0 } as Duration);
const goDuration = (s: string): string => {
  const m = /^(\d+)(h|d)$/.exec(s);
  if (!m) throw new Error(`unexpected Go/flag duration ${s}`);
  return m[2] === "h" ? dur(`${m[1]} h`) : dur(`${m[1]} days`);
};

// --- the spool record and the Collector output, field by field ------------------------------------------------------

/** Each JSON field of the gateway's spool event record → the data-inventory row (§1 or §2) that documents it, or
 *  `technical:` with the reason it carries no visitor data. A new field without an entry fails. */
type RowRef = { section: number; row: RegExp };
export const SPOOL_EVENT_FIELDS: Record<string, RowRef | RowRef[] | `technical: ${string}`> = {
  rv: "technical: record format version",
  type: "technical: record kind (event | counter)",
  record_id: "technical: random id of the record (de-duplication), not derived from the visitor",
  node_id: "technical: edge node name",
  segment: "technical: spool segment number",
  offset: "technical: offset in the segment",
  tenant_id: "technical: tenant (organisation) id",
  site_id: "technical: site id",
  target: "technical: main or twin Umami website",
  umami_website_id: "technical: Umami website id",
  kind: "technical: pageview | custom | wallet",
  received_at_ms: { section: 1, row: /^Receipt timestamp/ },
  tag: { section: 1, row: /^Verdict tag/ },
  surrogate: { section: 1, row: /^Surrogate/ },
  // hex SHA-256 of a domain tag, the site id and the per-event random id (never the id itself; wire-formats §c.2, C-140)
  event_key: { section: 1, row: /^Event de-duplication key/ },
  country: { section: 1, row: /^Country/ },
  // the synthetic UA encodes browser family + major, OS family and device class (Umami parses them from it)
  ua: [
    { section: 1, row: /^Synthetic reduced UA string/ },
    { section: 1, row: /^Browser family \+ major/ },
  ],
  hostname: { section: 1, row: /^Hostname/ },
  url: { section: 1, row: /^Page path/ },
  referrer_host: { section: 1, row: /^Referrer host — standard/ },
  screen: { section: 1, row: /^Screen-width class/ },
  language: { section: 1, row: /^Primary language subtag/ },
  name: { section: 1, row: /^Custom-event name/ },
  data: { section: 1, row: /^Custom-event properties/ },
};

/** Counter records (per-site counters, OTLP drop counters, token last-use, spool accounting): only aggregate counts and
 *  ids — no field may name a visitor property. */
const COUNTER_FIELDS_ALLOWED = new Set([
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
  "tenant_id",
  "site_id",
  "day",
  "counter",
  "label",
  "count",
  "reason",
  "token_id",
  "last_used_ms",
  "boot_id",
  "fsynced",
  "acked_stored",
  "acked_engine_bot",
  "acked_engine_rejected",
  "expired_72h",
  "queued",
  "queued_at_day_start",
]);

/** The optional counter-record parts of C-136/C-137 (wire-formats §d.3), each with the JSON names it may carry and
 *  the data-inventory row that must document where it lands. `props` holds counts keyed by closed lists only (event,
 *  network, property key/value — checked by the database, data-model §12.1); `dev` holds dev-origin events without
 *  any visitor identifier, IP, User-Agent, referrer, country, property value or origin host (§a.8); `app` and `rpc`
 *  hold per-site daily counts of enum cells (§a.9, §a.3.2). */
const COUNTER_PARTS: Record<string, { struct: string; fields: string[]; documented: RegExp }> = {
  props: {
    struct: "PropCounter",
    fields: ["tenant_id", "site_id", "day", "event", "network", "key", "value", "verdict", "count"],
    documented: /web_event_property_daily/,
  },
  dev: {
    struct: "DevEvent",
    fields: [
      "tenant_id",
      "site_id",
      "received_at_ms",
      "kind",
      "name",
      "path",
      "would_be",
      "reason",
    ],
    documented: /web_dev_events/,
  },
  // `app` (wire-formats §a.9, migration 0084): self-attested daily counts of enum-token cells — no session id, device
  // id, address, User-Agent or timestamp finer than the day.
  app: {
    struct: "AppCounter",
    fields: ["tenant_id", "site_id", "day", "platform", "event", "key", "value", "count"],
    documented: /app_event_daily/,
  },
  // `rpc` (wire-formats §a.3.2, migration 0086): browser Stellar RPC / Horizon call counts by closed cell — no visitor
  // key, session, path, time of call, URL or address.
  rpc: {
    struct: "RPCCounter",
    fields: [
      "tenant_id",
      "site_id",
      "day",
      "api",
      "operation",
      "network",
      "outcome",
      "latency",
      "verdict",
      "count",
    ],
    documented: /web_rpc_client_daily/,
  },
};

/** Each attribute key the Collector's sanitise step may emit → the §3 row that documents it, the legend, or
 *  `technical:`. A key the allow-list gains without an entry fails. */
export const COLLECTOR_KEYS: Record<
  string,
  { section: number; row: RegExp; mentions: string } | { legend: string } | `technical: ${string}`
> = {
  "scf.tenant.id": { section: 3, row: /^tenant\.id/, mentions: "tenant.id" },
  "scf.received_at_unix_nano": { legend: "scf.received_at_unix_nano" },
  "scf.tenant.level": { section: 4, row: /^Tenant name, sites/, mentions: "verification level" },
  "scf.stream.instance": {
    section: 3,
    row: /^service\.instance\.id/,
    mentions: "service.instance.id",
  },
  "service.name": { section: 3, row: /^service\.name/, mentions: "service.name" },
  "service.namespace": { section: 3, row: /^service\.name/, mentions: "namespace" },
  "deployment.environment.name": { section: 3, row: /^service\.name/, mentions: "environment" },
  "service.instance.id": {
    section: 3,
    row: /^service\.instance\.id/,
    mentions: "service.instance.id",
  },
  "scf.route": { section: 3, row: /^http\.route/, mentions: "Normalised route" },
  "scf.rules_version": { section: 3, row: /^http\.route/, mentions: "rule-set version" },
  "http.request.method": { section: 3, row: /^Method, status code/, mentions: "Method" },
  "http.response.status_code": { section: 3, row: /^Method, status code/, mentions: "status code" },
  "rpc.method": { section: 3, row: /^rpc\.method/, mentions: "rpc.method" },
  "rpc.system": { section: 3, row: /^rpc\.method/, mentions: "rpc.system" },
  "rpc.system.name": { section: 3, row: /^rpc\.method/, mentions: "rpc.system" },
  "otel.metric.overflow":
    "technical: boolean set by the tenant's SDK when its own cardinality limit overflowed; no request data",
  "scf.reason":
    "technical: drop reason of the tenant-visible scf.ingest.dropped counter (closed set)",
  "scf.marker":
    "technical: internal marker span carrying drop counts inside the Collector; never leaves it",
  "scf.dropped_count": "technical: number of dropped items (count)",
  // Stellar client metrics (C-153, scfsanitize stellar.go): closed value sets, one §3 row.
  ...Object.fromEntries(
    [
      "stellar.network",
      "stellar.tx.via",
      "stellar.tx.status",
      "stellar.tx.result_class",
      "stellar.sim.outcome",
      "stellar.sim.error_class",
      "error.type",
      "rpc.status_code",
      "url.template",
    ].map((k) => [k, { section: 3, row: /^Stellar client metrics/, mentions: k }]),
  ),
  // Integration client metrics (wire-formats §f.5 steps 4b–4d, scfsanitize partner.go / payments.go / anchors.go;
  // stored in integration_metrics_*, migration 0085): one §3 row per metric set. stellar.network and error.type are
  // shared with the Stellar client metrics above.
  ...Object.fromEntries(
    ["stellar.partner", "stellar.partner.operation", "stellar.partner.outcome"].map((k) => [
      k,
      { section: 3, row: /^Partner API call metrics/, mentions: k },
    ]),
  ),
  ...Object.fromEntries(
    [
      "payment.protocol",
      "payment.stage",
      "payment.network",
      "payment.scheme",
      "payment.method",
      "payment.intent",
      "payment.asset",
      "payment.amount_bucket",
      "payment.reason_class",
    ].map((k) => [k, { section: 3, row: /^Agent-payment events/, mentions: k }]),
  ),
  ...Object.fromEntries(
    [
      "stellar.sep",
      "stellar.anchor.step",
      "stellar.anchor.outcome",
      "stellar.anchor.event",
      "stellar.anchor.kind",
      "stellar.anchor.status",
      "stellar.anchor.status_from",
      "stellar.anchor.home_domain",
      "stellar.anchor.client",
    ].map((k) => [k, { section: 3, row: /^Anchor metrics/, mentions: k }]),
  ),
};

/** Column names that would store what §8 / the "never stored" rows exclude. Each pattern names the §8 bullet (or §1–§3
 *  row) it enforces; `allow` lists columns that match by name but hold something else, with the reason. */
export const FORBIDDEN_COLUMNS: Array<{
  pattern: RegExp;
  doc: RegExp;
  why: string;
  allow?: Record<string, string>;
}> = [
  {
    pattern: /(^|_)(ip|ip_address|ipaddr|client_addr|peer_addr|remote_addr|subnet)($|_)/,
    doc: /^IP addresses \(full or truncated\)/,
    why: "IP addresses",
  },
  {
    pattern: /(^|_)(region|city|latitude|longitude|geo)($|_)/,
    doc: /IP-derived region, city or coordinates/,
    why: "IP-derived location",
  },
  {
    pattern: /(user_agent|(^|_)ua($|_)|raw_ua|client_hint)/,
    doc: /^Raw User-Agent strings/,
    why: "raw User-Agent",
  },
  {
    pattern: /(ja4|fingerprint|tls_hash)/,
    doc: /^Raw User-Agent strings; high-entropy client hints; TLS fingerprints/,
    why: "fingerprints",
  },
  {
    pattern: /(query|fragment|utm_|gclid|fbclid|msclkid|ttclid|li_fat_id|twclid)/,
    doc: /^Query strings, URL fragments/,
    why: "query strings / click ids",
  },
  { pattern: /title/, doc: /^Page titles/, why: "page titles" },
  {
    pattern: /(cookie|header|local_storage|session_data|session_link|distinct_id)/,
    doc: /^Cookies, localStorage/,
    why: "cookies / storage / Umami identify data",
  },
  {
    pattern:
      /(seed|mnemonic|private_key|(^|_)xdr($|_)|memo|tx_hash|transaction_hash|balance|amount|wallet_address)/,
    doc: /^Stellar account keys \(G\/M\)/,
    why: "Stellar secrets / wallet data",
    allow: {
      "seal_days.tx_hash":
        "the hash of the PLATFORM's own daily-seal transaction (MEMO_HASH, wire-formats §m.2, C-136): published by the platform's sealing account, never a transaction of an end user",
      "tenants.seed_warning_ack_at":
        "the time a tenant admin acknowledged the secret-seed leak warning (C-148): a timestamp only; no seed or any part of one is ever stored, only per-day counts of redactions",
      "tenants.seed_warning_ack_baseline":
        "the redaction COUNT at acknowledgement (C-148), so that only new redactions raise the banner again: an integer, never a seed or any part of one",
    },
  },
  {
    pattern: /(^|_)(secret|password|api_key|token)$/,
    doc: /./,
    why: "plaintext credentials (tokens, keys, Umami credentials are stored as hashes or ciphertext only)",
    allow: {
      "domain_verifications.token":
        "the public DNS TXT / HTTP file value a tenant publishes to prove control of a domain; not a credential",
    },
  },
  {
    pattern: /signature/,
    doc: /signatures/,
    why: "wallet signatures",
    allow: {
      "traction_snapshots.signature":
        "the platform's own Ed25519 signature over a traction snapshot (C-121), not a wallet signature",
    },
  },
];

const SPOOL_RELEVANT = (where: string) => /\bspool\b/.test(where);

export const CLAIMS: Claim[] = [
  // ---- retention (scf.retention_rules(); relations without a rule are kept indefinitely) --------------------------
  {
    id: "RET-api-1m",
    claim: "§3 http.route: 1-min rows 35 d",
    source: "scf.retention_rules() api_metrics_1m",
    doc: (inv) =>
      dur(
        pick(cell(row(inv, 3, /^http\.route/), "Retention"), /1-min (\d+ ?\w+)/, "1-min retention"),
      ),
    impl: (f) => ruleDuration(f, "api_metrics_1m"),
  },
  {
    id: "RET-api-1h",
    claim: "§3 http.route: 1-h rows 25 mo",
    source: "scf.retention_rules() api_metrics_1h",
    doc: (inv) =>
      dur(pick(cell(row(inv, 3, /^http\.route/), "Retention"), /1-h (\d+ ?\w+)/, "1-h retention")),
    impl: (f) => ruleDuration(f, "api_metrics_1h"),
  },
  {
    id: "RET-api-1d",
    claim: "§3 http.route: 1-d rows indefinitely",
    source: "no retention rule for api_metrics_1d",
    doc: (inv) =>
      dur(
        pick(cell(row(inv, 3, /^http\.route/), "Retention"), /1-d (indefinitely)/, "1-d retention"),
      ),
    impl: (f) => ruleDuration(f, "api_metrics_1d"),
  },
  {
    id: "RET-writer-ledger",
    claim: "§3 writer de-duplication ledger: 7 days",
    source: "scf.retention_rules() api_ingest_ledger",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 3, /^Writer de-duplication ledger/), "Retention"),
          /^(\d+ days)/,
          "ledger retention",
        ),
      ),
    impl: (f) => ruleDuration(f, "api_ingest_ledger"),
  },
  {
    id: "RET-web-hourly",
    claim: "§1 aggregates: hourly rows 25 months",
    source: "scf.retention_rules() web_hourly_totals",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 1, /^Daily and hourly per-site aggregates/), "Retention"),
          /hourly rows (\d+ months)/,
          "hourly retention",
        ),
      ),
    impl: (f) => ruleDuration(f, "web_hourly_totals"),
  },
  {
    id: "RET-web-daily",
    claim: "§1 aggregates: daily rows indefinitely",
    source: "no retention rule for web_daily_totals / web_daily_breakdowns",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 1, /^Daily and hourly per-site aggregates/), "Retention"),
          /daily rows (indefinitely)/,
          "daily retention",
        ),
      ),
    impl: (f) => {
      const a = ruleDuration(f, "web_daily_totals");
      const b = ruleDuration(f, "web_daily_breakdowns");
      return a === b ? a : `${a} / ${b}`;
    },
  },
  {
    id: "RET-edge-counters",
    claim: "§1 verdict and reason counters: 25 months",
    source: "scf.retention_rules() web_edge_counters",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 1, /^Verdict and reason counters/), "Retention"),
          /(\d+ months)/,
          "counter retention",
        ),
      ),
    impl: (f) => ruleDuration(f, "web_edge_counters"),
  },
  {
    id: "RET-edge-counters-all",
    claim:
      "§1 verdict and reason counters: the retention covers every per-site counter (one rule for the table)",
    source: "scf.retention_rules() web_edge_counters (applies to all counters)",
    check: (inv, f) => {
      const text = cell(row(inv, 1, /^Verdict and reason counters/), "Retention");
      return f.retention.web_edge_counters !== undefined && /not fixed/.test(text)
        ? [
            `doc says some counters' retention is "not fixed", but web_edge_counters has one rule for every counter (${ruleDuration(f, "web_edge_counters")})`,
          ]
        : [];
    },
  },
  {
    id: "RET-web-rpc",
    claim: "§1 browser Stellar RPC / Horizon call counts: 25 months",
    source: "scf.retention_rules() web_rpc_client_daily",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 1, /^Browser Stellar RPC \/ Horizon call counters/), "Retention"),
          /^(\d+ months)/,
          "rpc counter retention",
        ),
      ),
    impl: (f) => ruleDuration(f, "web_rpc_client_daily"),
  },
  {
    id: "RET-app-events",
    claim: "§1 self-attested app events: kept for the site's life (no retention rule)",
    source: "no retention rule for app_event_daily",
    doc: (inv) =>
      /no retention rule/.test(cell(row(inv, 1, /^Self-attested app event counters/), "Retention"))
        ? "indefinite"
        : cell(row(inv, 1, /^Self-attested app event counters/), "Retention"),
    impl: (f) => ruleDuration(f, "app_event_daily"),
  },
  ...(
    [
      ["partner", /^Partner API call metrics/],
      ["payments", /^Agent-payment events/],
      ["anchors", /^Anchor metrics/],
    ] as const
  ).flatMap(([set, r]): Claim[] => [
    {
      id: `RET-integration-${set}-1h`,
      claim: `§3 ${set} client metrics: 1-h rows 35 d`,
      source: "scf.retention_rules() integration_metrics_1h",
      doc: (inv) => dur(pick(cell(row(inv, 3, r), "Retention"), /1-h (\d+ ?\w+)/, "1-h retention")),
      impl: (f) => ruleDuration(f, "integration_metrics_1h"),
    },
    {
      id: `RET-integration-${set}-1d`,
      claim: `§3 ${set} client metrics: 1-d rows 25 mo`,
      source: "scf.retention_rules() integration_metrics_1d",
      doc: (inv) => dur(pick(cell(row(inv, 3, r), "Retention"), /1-d (\d+ ?\w+)/, "1-d retention")),
      impl: (f) => ruleDuration(f, "integration_metrics_1d"),
    },
    {
      id: `RET-integration-${set}-state`,
      claim: `§3 ${set} client metrics: stream state 7 d idle`,
      source: "scf.retention_rules() integration_stream_state",
      doc: (inv) =>
        dur(
          pick(
            cell(row(inv, 3, r), "Retention"),
            /stream state (\d+ ?\w+) idle/,
            "state retention",
          ),
        ),
      impl: (f) => ruleDuration(f, "integration_stream_state"),
    },
  ]),
  {
    id: "RET-trust",
    claim: "§1 trust score: indefinitely",
    source: "no retention rule for web_trust_scores / api_service_assurance",
    doc: (inv) =>
      /indefinitely/.test(cell(row(inv, 1, /^Trust score/), "Retention"))
        ? "indefinite"
        : cell(row(inv, 1, /^Trust score/), "Retention"),
    impl: (f) =>
      [ruleDuration(f, "web_trust_scores"), ruleDuration(f, "api_service_assurance")].every(
        (x) => x === "indefinite",
      )
        ? "indefinite"
        : "has a rule",
  },
  {
    id: "RET-onchain",
    claim: "§4 on-chain daily counts: indefinitely",
    source: "no retention rule for onchain_daily",
    doc: (inv) =>
      /indefinitely/.test(cell(row(inv, 4, /^On-chain daily counts/), "Retention"))
        ? "indefinite"
        : "other",
    impl: (f) => ruleDuration(f, "onchain_daily"),
  },
  {
    id: "RET-audit",
    claim: "§5 audit log: life of the service",
    source: "no retention rule for audit_log",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 5, /^Actor \(user id/), "Retention"),
          /^(life of (?:the )?service)/,
          "audit retention",
        ),
      ),
    impl: (f) => ruleDuration(f, "audit_log"),
  },
  {
    id: "RET-erasure-selector",
    claim: "§5 erasure selector: until finished plus 56 days, then replaced by type and length",
    source: "scf.retention_rules() erasure_requests (mechanism redact, age t.finished_at)",
    doc: (inv) => {
      const t = cell(row(inv, 5, /^Erasure requests — literal selector/), "Retention");
      return {
        keep: dur(pick(t, /finished plus (\d+ days)/, "selector retention")),
        mechanism: /replaced by the selector's type and length/.test(t) ? "redact" : "?",
        from: "finished_at",
      };
    },
    impl: (f) => {
      const r = f.retention.erasure_requests;
      return {
        keep: ruleDuration(f, "erasure_requests"),
        mechanism: r?.mechanism,
        from: r?.age_expr.replace(/^t\./, ""),
      };
    },
  },
  {
    id: "RET-ew",
    claim: "legend EW: 90 days by default, settable 30–395 days",
    source: "settings.web_event_retention_days (value + CHECK), sites.event_retention_days CHECK",
    doc: (inv) => {
      const m = /(\d+) days by default, settable (\d+)–(\d+) days/.exec(inv.legend);
      if (!m) throw new Error("legend: EW definition not found");
      return { default: Number(m[1]), min: Number(m[2]), max: Number(m[3]) };
    },
    impl: (f) => {
      const min = Math.min(...f.ewAccepted);
      const max = Math.max(...f.ewAccepted);
      const site = f.checks.find((c) =>
        /^scf\.sites: CHECK \(\(\(event_retention_days >= \d+\) AND \(event_retention_days <= \d+\)\)\)$/.test(
          c,
        ),
      );
      const sm = site ? /(\d+)\) AND \(event_retention_days <= (\d+)/.exec(site) : null;
      const siteRange = sm ? `${sm[1]}-${sm[2]}` : "missing";
      const contiguous = f.ewRefused.every((v) => v < min || v > max);
      return siteRange === `${min}-${max}` && contiguous
        ? { default: f.ewDefault, min, max }
        : { default: f.ewDefault, min, max, siteRange, contiguous };
    },
  },
  // ---- transient copies ---------------------------------------------------------------------------------------------
  {
    id: "SPOOL-72h",
    claim: "legend + §7: spool never older than 72 h",
    source: "gateway spool default Expiry, forwarder Expiry",
    doc: (inv) => {
      const a = dur(pick(inv.legend, /never older than (\d+ h)\b/, "legend spool bound"));
      const b = dur(
        pick(
          cell(row(inv, 7, /^Edge spool/), "Retention"),
          /never older than (\d+) hours/,
          "§7 spool bound",
        ).concat(" h"),
      );
      return a === b ? a : `${a} / ${b}`;
    },
    impl: (f) =>
      f.spoolExpiryHours === f.forwarderExpiryHours
        ? hours(f.spoolExpiryHours)
        : `${f.spoolExpiryHours} h / ${f.forwarderExpiryHours} h`,
  },
  {
    id: "EVENT-ID-window",
    claim: "§1 per-event random ID: 10-minute in-memory window",
    source: "gateway ingest eventIDs TTL set",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 1, /^Per-event random ID/), "Retention"),
          /^(\d+)-minute/,
          "event id window",
        ).concat(" minutes"),
      ),
    impl: (f) => fmtDuration({ months: 0, days: 0, minutes: f.eventIdWindowMinutes }),
  },
  {
    id: "QUEUE-72h",
    claim: "legend queue: writer drops points received more than 72 h earlier",
    source: "metrics-writer batch.MaxReceiptAge",
    doc: (inv) => dur(pick(inv.legend, /received more than (\d+ h) earlier/, "queue cap")),
    impl: (f) => hours(f.writerMaxReceiptAgeHours),
  },
  {
    id: "QUEUE-late-48h",
    claim: "legend queue: 48-hour late-data bound of the sanitise step",
    source: "collector.yaml scfsanitize.max_age",
    doc: (inv) =>
      dur(pick(inv.legend, /the (\d+)-hour late-data bound/, "late-data bound").concat(" h")),
    impl: (f) => goDuration(f.collectorSanitizeMaxAge),
  },
  // ---- accounts and sessions ------------------------------------------------------------------------------------------
  {
    id: "SESSION-timeouts",
    claim:
      "§4 sessions: tenants idle 12 h / absolute 14 days; operators idle 30 min / absolute 12 h",
    source: "control-plane auth/sessions.ts TIMEOUTS",
    doc: (inv) => {
      const t = cell(row(inv, 4, /^Server-side sessions/), "Retention");
      const m =
        /tenants idle (\d+ \w+) \/ absolute (\d+ \w+); SCF operators idle (\d+ \w+) \/ absolute (\d+ \w+)/.exec(
          t,
        );
      if (!m) throw new Error(`§4 sessions retention not in the expected form: ${t}`);
      return [m[1], m[2], m[3], m[4]].map((x) => dur(x as string));
    },
    impl: (f) => {
      const s = f.sessionTimeoutsMinutes;
      return [s.tenant_user.idle, s.tenant_user.absolute, s.operator.idle, s.operator.absolute].map(
        (m) =>
          m % 1440 === 0
            ? dur(`${m / 1440} days`)
            : m % 60 === 0
              ? dur(`${m / 60} h`)
              : dur(`${m} min`),
      );
    },
  },
  {
    id: "OAUTH-state",
    claim: "§4 OAuth state cookie: 10 minutes",
    source: "control-plane auth/github.ts STATE_TTL_MS and the auth challenge's expiry",
    doc: (inv) =>
      dur(
        pick(
          cell(row(inv, 4, /^OAuth state cookie/), "Retention"),
          /^(\d+ minutes)/,
          "OAuth state",
        ),
      ),
    impl: (f) =>
      dur(f.oauthChallengeInterval) === dur(`${f.oauthStateMinutes} minutes`)
        ? dur(`${f.oauthStateMinutes} minutes`)
        : "cookie and challenge differ",
  },
  {
    id: "OPKEY-expiry",
    claim: "§4 operator API keys: expiry default 90 days, at most 365 days",
    source: "operator/handlers.ts default; operator_api_keys CHECK",
    doc: (inv) => {
      const t = cell(row(inv, 4, /^SCF operator API keys/), "Retention");
      return {
        default: Number(pick(t, /expiry default (\d+) days/, "op key default")),
        max: Number(pick(t, /at most (\d+) days/, "op key max")),
      };
    },
    impl: (f) => {
      const c = f.checks.find(
        (x) =>
          x.startsWith("scf.operator_api_keys: ") &&
          /expires_at <= \(created_at \+ '(\d+) days'::interval\)/.test(x),
      );
      if (!c) throw new Error("operator_api_keys: no maximum-expiry CHECK");
      return { default: f.opKeyDefaultDays, max: Number(/'(\d+) days'/.exec(c)?.[1]) };
    },
  },
  {
    id: "HASH-only",
    claim:
      "§3/§4 ingest tokens, operator API keys, share keys: hash only; Umami password and API key encrypted",
    source: "scf.ingest_tokens / operator_api_keys / share_keys / umami_credentials columns",
    check: (inv, f) => {
      const v: string[] = [];
      const need = (sec: number, r: RegExp, phrase: RegExp) => {
        if (!phrase.test(cell(row(inv, sec, r), "Stored")))
          v.push(`doc §${sec} ${r}: Stored? no longer says ${phrase}`);
      };
      need(3, /^Ingest token/, /Hash only/);
      need(4, /^SCF operator API keys/, /Hash only/);
      need(4, /^Tenant pub share keys/, /Hash only/);
      need(4, /^Umami per-tenant view-only user/, /encrypted/);
      for (const t of ["ingest_tokens", "operator_api_keys", "share_keys"]) {
        const cols = f.columns
          .filter((c) => c.startsWith(`${t}.`))
          .map((c) => c.slice(t.length + 1));
        if (!cols.includes("secret_hash")) v.push(`${t}: no secret_hash column`);
        for (const c of cols)
          if (/(^|_)(secret|token|key)$/.test(c) && c !== "secret_hash")
            v.push(`${t}.${c}: looks like a plaintext secret`);
      }
      const uc = f.columns
        .filter((c) => c.startsWith("umami_credentials."))
        .map((c) => c.slice(18));
      for (const need of ["api_key_ciphertext", "password_ciphertext"])
        if (!uc.includes(need)) v.push(`umami_credentials.${need} missing`);
      for (const c of uc)
        if (/(password|api_key)$/.test(c))
          v.push(`umami_credentials.${c}: plaintext credential column`);
      return v;
    },
  },
  {
    id: "INSTANCE-not-dimension",
    claim: "§3 service.instance.id: stream state only, not a stored dimension",
    source: "api_metrics_* columns vs api_stream_state",
    check: (inv, f) => {
      const v: string[] = [];
      if (!/not a stored dimension/.test(cell(row(inv, 3, /^service\.instance\.id/), "Stored")))
        v.push("doc §3 service.instance.id: 'not a stored dimension' gone");
      for (const c of f.columns)
        if (/^api_metrics_/.test(c) && /instance/.test(c))
          v.push(`${c}: an instance column in a metrics table`);
      if (!f.columns.some((c) => c === "api_stream_state.stream_key"))
        v.push("api_stream_state.stream_key missing (stream state)");
      return v;
    },
  },
  // ---- never stored --------------------------------------------------------------------------------------------------
  {
    id: "NEVER-columns",
    claim: "§8 never collected (and the 'No' rows of §1–§3): no column of schema scf can hold them",
    source: "pg_attribute of schema scf",
    check: (inv, f) => {
      const v: string[] = [];
      for (const fc of FORBIDDEN_COLUMNS) {
        if (!inv.neverCollected.some((b) => fc.doc.test(b)) && fc.doc.source !== ".")
          v.push(`doc §8: bullet ${fc.doc} (${fc.why}) is gone`);
        for (const c of f.columns) {
          const col = c.split(".")[1] as string;
          if (fc.pattern.test(col) && !(fc.allow && c in fc.allow))
            v.push(`${c}: column name matches ${fc.why} (${fc.pattern})`);
        }
        for (const a of Object.keys(fc.allow ?? {}))
          if (!f.columns.includes(a)) v.push(`allow-list entry ${a} no longer exists — remove it`);
      }
      return v;
    },
  },
  {
    id: "NEVER-titles-setting",
    claim: "§8 page titles: no setting to collect them",
    source: "scf.settings keys and scf.sites columns",
    check: (inv, f) => {
      const v: string[] = [];
      if (!inv.neverCollected.some((b) => /there is no setting to collect them/.test(b)))
        v.push("doc §8: 'no setting to collect them' gone");
      for (const c of f.columns)
        if (/^(sites|settings)\./.test(c) && /title/.test(c)) v.push(`${c}: a title setting`);
      return v;
    },
  },
  {
    id: "TLS-fingerprint",
    claim: "§8 TLS fingerprints: what the document says about computing them matches the gateway",
    source: "services/gateway/internal/transport (JA4, C-124)",
    check: (inv, f) => {
      const bullet = inv.neverCollected.find((b) => /TLS fingerprints/.test(b));
      if (bullet === undefined) return ["doc §8: TLS fingerprint bullet gone"];
      const v: string[] = [];
      if (f.gatewayComputesJa4 && /JA4 is not computed/.test(bullet)) {
        v.push(
          "doc §8 says 'JA4 is not computed in the first release', but the gateway computes a JA4 fingerprint in memory (C-124)",
        );
      }
      if (f.gatewayComputesJa4 && !/memory/.test(bullet))
        v.push("doc §8 must say the JA4 fingerprint is held in memory only");
      for (const [struct, tags] of Object.entries(f.spool))
        for (const t of tags)
          if (/ja4|fingerprint|tls/.test(t))
            v.push(`spool ${struct}.${t}: a fingerprint in the spool`);
      return v;
    },
  },
  // ---- spool record ---------------------------------------------------------------------------------------------------
  {
    id: "SPOOL-event-fields",
    claim: "§1/§7: the spool holds exactly the documented fields (no IP, no raw User-Agent)",
    source: "services/gateway/internal/spool/records.go EventRecord",
    check: (inv, f) => {
      const v: string[] = [];
      const tags = f.spool.EventRecord ?? [];
      const mappedRows = new Set<string>();
      for (const t of tags) {
        const m = SPOOL_EVENT_FIELDS[t];
        if (m === undefined) {
          v.push(
            `spool field "${t}" is not documented: add a data-inventory row (Where: spool) and an entry in SPOOL_EVENT_FIELDS`,
          );
          continue;
        }
        if (typeof m === "string") continue;
        for (const ref of Array.isArray(m) ? m : [m]) {
          const r = row(inv, ref.section, ref.row);
          mappedRows.add(`${r.section}:${r.field}`);
          if (!SPOOL_RELEVANT(cell(r, "Where")))
            v.push(
              `spool field "${t}" → §${r.section} "${r.field}": its Where column does not list spool ("${cell(r, "Where")}")`,
            );
          if (/^No\b/.test(cell(r, "Stored")))
            v.push(
              `spool field "${t}" → §${r.section} "${r.field}": Stored? says "${cell(r, "Stored")}" but the spool stores it`,
            );
        }
      }
      for (const t of Object.keys(SPOOL_EVENT_FIELDS))
        if (!tags.includes(t))
          v.push(`SPOOL_EVENT_FIELDS lists "${t}", which the spool record no longer has`);
      // every §1 row that says it lives in the spool must be a spool field or a counter
      for (const r of inv.rows.filter((x) => x.section === 1 && SPOOL_RELEVANT(cell(x, "Where")))) {
        if (/counters/i.test(r.field)) continue;
        if (!mappedRows.has(`${r.section}:${r.field}`))
          v.push(`§1 "${r.field}" says spool, but no spool field maps to it`);
      }
      const s7 = cell(row(inv, 7, /^Edge spool/), "Contents");
      if (!/no IP, no raw User-Agent/.test(s7))
        v.push("doc §7 edge spool: 'no IP, no raw User-Agent' gone");
      return v;
    },
  },
  {
    id: "SPOOL-counter-fields",
    claim: "§1/§2: counter records carry per-site counts only",
    source:
      "services/gateway/internal/spool/records.go CounterRecord, WebCounter, OTLPCounter, TokenUse, Accounting",
    check: (inv, f) => {
      const v: string[] = [];
      for (const s of ["CounterRecord", "WebCounter", "OTLPCounter", "TokenUse", "Accounting"]) {
        const tags = f.spool[s];
        if (!tags) {
          v.push(`records.go: struct ${s} gone`);
          continue;
        }
        for (const t of tags) {
          const part = s === "CounterRecord" ? COUNTER_PARTS[t] : undefined;
          if (part) {
            const ptags = f.spool[part.struct];
            if (!ptags) v.push(`records.go: struct ${part.struct} (counter part ${t}) gone`);
            for (const pt of ptags ?? [])
              if (!part.fields.includes(pt))
                v.push(
                  `spool ${part.struct}.${pt}: not in the documented ${t} part — document it or remove it`,
                );
            if (![...inv.sectionText.values()].some((x) => part.documented.test(x)))
              v.push(
                `data-inventory: counter part ${t} lands in a table the inventory does not name (${part.documented})`,
              );
            continue;
          }
          if (!COUNTER_FIELDS_ALLOWED.has(t))
            v.push(`spool ${s}.${t}: not a count or id — document it or remove it`);
        }
      }
      return v;
    },
  },
  // ---- OpenTelemetry --------------------------------------------------------------------------------------------------
  {
    id: "OTEL-allow-list",
    claim: "§3: the Collector keeps only the documented attributes",
    source: "scfsanitize proto-level allow-list (protoallow_test.go allowedKeys) + collector.yaml",
    check: (inv, f) => {
      const v: string[] = [];
      for (const k of f.collectorKeys) {
        const m = COLLECTOR_KEYS[k];
        if (m === undefined) {
          v.push(
            `Collector key "${k}" is not documented: add it to data-inventory §3 and COLLECTOR_KEYS`,
          );
          continue;
        }
        if (typeof m === "string") continue;
        if ("legend" in m) {
          if (!inv.legend.includes(m.legend))
            v.push(`Collector key "${k}": legend no longer mentions ${m.legend}`);
          continue;
        }
        const r = row(inv, m.section, m.row);
        if (
          !r.field.includes(m.mentions) &&
          !Object.values(r.cells).some((c) => c.replace(/`/g, "").includes(m.mentions))
        ) {
          v.push(
            `Collector key "${k}" → §${m.section} "${r.field}": the row does not mention "${m.mentions}"`,
          );
        }
      }
      for (const k of Object.keys(COLLECTOR_KEYS))
        if (!f.collectorKeys.includes(k))
          v.push(`COLLECTOR_KEYS lists "${k}", which the allow-list no longer has`);
      // what §3 / §8 say is never kept must not be on the allow-list
      // url.template (OTel semconv: the low-cardinality route template) is the one url.* key allowed: the Collector
      // replaces its value by one of a fixed list of Horizon templates (§3 "Stellar client metrics"); url.full,
      // url.path, url.query, … stay on the never-kept list.
      const never =
        /^(client\.|network\.peer|user_agent\.|url\.(?!template$)|http\.target|http\.url|http\.route$|enduser\.|user\.|session\.|host\.|process\.|container\.|exception\.)/;
      for (const k of f.collectorKeys)
        if (never.test(k)) v.push(`Collector key "${k}" is on the never-kept list of §3/§8`);
      return v;
    },
  },
  {
    id: "OTEL-logs-refused",
    claim: "§3 logs (/v1/logs) refused; exemplars, span events and links stripped",
    source: "collector.yaml pipelines; proto allow-list fields",
    check: (inv, f) => {
      const v: string[] = [];
      if (!/Refused/.test(cell(row(inv, 3, /^Logs \(\/v1\/logs\)/), "Collected")))
        v.push("doc §3 logs: 'Refused' gone");
      if (!/Stripped/.test(cell(row(inv, 3, /^Exemplars/), "Collected")))
        v.push("doc §3 exemplars: 'Stripped' gone");
      if (f.collectorPipelines.some((p) => /^logs/.test(p)))
        v.push(`collector.yaml has a logs pipeline: ${f.collectorPipelines.join(", ")}`);
      if (!f.collectorPipelines.includes("metrics"))
        v.push(`collector.yaml pipelines unexpected: ${f.collectorPipelines.join(", ")}`);
      for (const field of ["exemplars", "events", "links", "body"])
        if (f.collectorProtoFields.includes(field))
          v.push(`Collector output may carry OTLP field "${field}"`);
      return v;
    },
  },
  // ---- operational logs, monitoring, backups -------------------------------------------------------------------------
  {
    id: "LOGS-30d",
    claim: "§6 service logs and access logs: 30 days",
    source: "compose.monitoring.yaml VictoriaLogs -retentionPeriod",
    doc: (inv) => {
      const a = dur(
        pick(cell(row(inv, 6, /^Service logs/), "Retention"), /^(\d+ days)/, "service logs"),
      );
      const b = dur(
        pick(
          cell(row(inv, 6, /^Portal\/API access logs/), "Retention"),
          /^(\d+ days)/,
          "access logs",
        ),
      );
      return a === b ? a : `${a} / ${b}`;
    },
    impl: (f) => goDuration(f.logsRetention),
  },
  {
    id: "PROM-13mo",
    claim: "§6 Prometheus metrics: 13 months",
    source: "compose.monitoring.yaml --storage.tsdb.retention.time",
    doc: (inv) =>
      Number(
        pick(cell(row(inv, 6, /^Prometheus metrics/), "Retention"), /^(\d+) months/, "prometheus"),
      ),
    impl: (f) => {
      const d = Number(/^(\d+)d$/.exec(f.prometheusRetention)?.[1]);
      // a month is 28–31 days: n months ≈ d days when d lies within [n×30, n×31]
      const n = Math.round(d / 30.4);
      return d >= n * 30 && d <= n * 31
        ? n
        : `${f.prometheusRetention} is not a whole number of months`;
    },
  },
  {
    id: "BACKUP-windows",
    claim:
      "§7 + legend: 35-day point-in-time window, previous versions 14 days, erased data gone within 56 days",
    source:
      "pgbackrest.conf.j2 retention-full; OpenTofu backup_previous_version_days; compose.ha.yaml full-backup interval",
    doc: (inv) => {
      const t = cell(row(inv, 7, /^pgBackRest repository 1/), "Retention");
      const pitr = Number(pick(t, /(\d+)-day point-in-time window/, "pitr window"));
      const prev = Number(pick(t, /for (\d+) more days/, "previous versions"));
      const total = Number(
        pick(inv.legend, /within (\d+) days: (\d+)-day retention/, "56-day bound"),
      );
      const legendPitr = Number(
        pick(inv.legend, /within \d+ days: (\d+)-day retention/, "legend pitr"),
      );
      const legendPrev = Number(
        pick(inv.legend, /\+ (\d+) days as a previous version/, "legend previous"),
      );
      const full = Number(
        pick(inv.legend, /up to (\d+) days until the next full/, "full interval"),
      );
      return { pitr, prev, total, legendPitr, legendPrev, sum: legendPitr + full + legendPrev };
    },
    impl: (f) => {
      const pitr = new Set(f.pgbackrestRetentionFullDays);
      const prev = new Set(f.previousVersionDays);
      if (pitr.size !== 1 || prev.size !== 1) return { differs: [...pitr, ...prev] };
      const p = [...pitr][0] as number;
      const q = [...prev][0] as number;
      const full = f.backupFullEveryDays;
      return {
        pitr: p,
        prev: q,
        total: p + full + q,
        legendPitr: p,
        legendPrev: q,
        sum: p + full + q,
      };
    },
  },
];

/** null when the claim holds; otherwise why not. */
export function outcome(c: Claim, inv: Inventory, f: Facts): string | null {
  try {
    if (c.check) {
      const v = c.check(inv, f);
      return v.length === 0 ? null : v.join("; ");
    }
    const d = c.doc?.(inv);
    const i = c.impl?.(f);
    return JSON.stringify(d) === JSON.stringify(i)
      ? null
      : `document says ${JSON.stringify(d)}, implementation has ${JSON.stringify(i)}`;
  } catch (e) {
    return (e as Error).message;
  }
}
