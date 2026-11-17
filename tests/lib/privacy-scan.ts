// SPDX-License-Identifier: Apache-2.0
// Data-inventory scanner (ADR-0026 "Data-inventory tests", docs/privacy/data-inventory.md). Two kinds of check:
//   1. canaries — exact values the test itself sent through the front doors (a canary User-Agent, query string,
//      seed, end-user G-address, token, page title, …). Any occurrence in any store or log is a leak: zero tolerance.
//   2. shapes — generic patterns (IPv4/IPv6 client addresses, raw User-Agent strings, StrKey seeds, JWTs, bearer
//      tokens, query strings with values). Hits are leaks unless they match an explicit, reasoned allow-list entry
//      (e.g. a container's own listen address in a startup log line, or the tenant's own sign-in account in `scf`).
// Matches are reported with the value masked; the report never repeats a full secret.

import { isIPv6 } from "node:net";

export type Kind =
  | "canary"
  | "ipv4"
  | "ipv6"
  | "surrogate"
  | "user_agent"
  | "seed"
  | "g_address"
  | "jwt"
  | "bearer"
  | "ingest_token"
  | "query_string";

export interface Canary {
  /** What it stands for, e.g. "user_agent", "query_string", "seed", "page_title". */
  label: string;
  value: string;
}

export interface AllowRule {
  kind: Kind;
  /** Exact value or RegExp that the matched text may equal. */
  match: string | RegExp;
  /** Restrict to sources whose name matches (e.g. /^log:/). */
  source?: RegExp;
  reason: string;
}

export interface Finding {
  source: string;
  kind: Kind;
  label: string;
  masked: string;
  offset: number;
  context: string;
}

const SHAPES: { kind: Kind; re: RegExp }[] = [
  // Dotted quads with valid octets, not part of a longer dotted/numeric run (versions like 1.2.3.4.5 are skipped).
  {
    kind: "ipv4",
    re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
  },
  // Surrogates live only in the gateway → engine-proxy hop (2001:db8::/32, wire-formats §c.3).
  { kind: "surrogate", re: /\b2001:db8:[0-9a-f:]*/gi },
  // IPv6 candidates (validated with net.isIPv6 below, so clock times such as 12:30:45 never count).
  // Bounded by non-word characters, so SQL casts such as `x::bigint` or `2::float8` never form a candidate.
  { kind: "ipv6", re: /(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi },
  {
    kind: "user_agent",
    re: /Mozilla\/5\.0 \([^)]{3,200}\)|HeadlessChrome\/[\d.]+|curl\/\d+\.\d+|Go-http-client\/\d|python-requests\/\d/g,
  },
  { kind: "seed", re: /\bS[A-Z2-7]{55}\b/g },
  { kind: "g_address", re: /\bG[A-Z2-7]{55}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { kind: "ingest_token", re: /\bscfa_(?:ing|key|shr)_[A-Za-z0-9_-]{10,}/g },
  // A URL or path followed by a query with a key=value pair.
  {
    kind: "query_string",
    re: /(?:https?:\/\/[^\s"'<>]+|\/[A-Za-z0-9._~%/-]*)\?[A-Za-z0-9_.%-]+=[^\s"'&<>]+/g,
  },
];

export function mask(v: string): string {
  if (v.length <= 8) return `${v.slice(0, 2)}…(${v.length})`;
  return `${v.slice(0, 6)}…${v.slice(-2)}(${v.length})`;
}

function contextOf(text: string, start: number, end: number): string {
  const pre = text.slice(Math.max(0, start - 40), start).replace(/\s+/g, " ");
  const post = text.slice(end, end + 40).replace(/\s+/g, " ");
  return `${pre}[…]${post}`;
}

export interface ScanInput {
  source: string;
  text: string;
}

export interface ScanResult {
  findings: Finding[];
  allowedHits: { source: string; kind: Kind; masked: string; reason: string }[];
  bytesScanned: number;
  sources: string[];
}

export function scan(inputs: ScanInput[], canaries: Canary[], allow: AllowRule[]): ScanResult {
  const findings: Finding[] = [];
  const allowedHits: ScanResult["allowedHits"] = [];
  let bytes = 0;
  for (const { source, text } of inputs) {
    bytes += text.length;
    for (const c of canaries) {
      if (c.value.length < 6) throw new Error(`canary ${c.label} too short to be meaningful`);
      let i = text.indexOf(c.value);
      while (i >= 0) {
        findings.push({
          source,
          kind: "canary",
          label: c.label,
          masked: mask(c.value),
          offset: i,
          context: contextOf(text, i, i + c.value.length).replaceAll(c.value, "<canary>"),
        });
        i = text.indexOf(c.value, i + 1);
      }
    }
    for (const { kind, re } of SHAPES) {
      for (const m of text.matchAll(re)) {
        const value = m[0];
        // product versions such as Chrome/131.0.0.0 are not addresses
        if (
          kind === "ipv4" &&
          /[A-Za-z]\/$/.test(text.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0))
        )
          continue;
        if (kind === "ipv6") {
          const groups = value.split(":").filter(Boolean).length;
          if (!isIPv6(value) || /^2001:db8:/i.test(value)) continue;
          if (groups < 2 || (groups < 3 && !value.includes("::"))) continue;
        }
        const rule = allow.find(
          (r) =>
            r.kind === kind &&
            (!r.source || r.source.test(source)) &&
            (typeof r.match === "string" ? r.match === value : r.match.test(value)),
        );
        if (rule) {
          allowedHits.push({ source, kind, masked: mask(value), reason: rule.reason });
          continue;
        }
        findings.push({
          source,
          kind,
          label: kind,
          masked: mask(value),
          offset: m.index ?? 0,
          context: contextOf(text, m.index ?? 0, (m.index ?? 0) + value.length).replaceAll(
            value,
            "<match>",
          ),
        });
      }
    }
  }
  return { findings, allowedHits, bytesScanned: bytes, sources: inputs.map((i) => i.source) };
}

/**
 * The Stellar accounts the platform may store, read from the `scf` database at scan time (C-137).
 * A `G…` in a store or log is a leak unless it is EXACTLY one of these values — there is no blanket `G…` rule:
 *   - `footprint`: subjects of `footprint_items` that are `verified` and not removed — accounts a project declared
 *     as its own and proved (data-model §12.1). Rejected and removed items are NOT allowed: an unproven address is
 *     not the project's; job `retention` deletes them at its next hourly run (plan C1 #9, purgeUnprovenFootprint).
 *   - `openClaims`: subjects of claims still open — `claimed`, not removed, claimed less than 30 days ago. The claim
 *     must be stored while the project proves it (stellar.toml check or signed challenge); job `retention` deletes a
 *     claim 30 days after it was made (scf.retention_rules(), C-137), so this is exactly what the job keeps.
 *   - `accountHolders`: the platform's own users and projects — Stellar sign-in identities, sign-in/link challenges
 *     of those identities, a project's proven `stellar_account` evidence and the enrolment tombstones of removed
 *     projects (account holders of the platform, never end users of a tenant site).
 *   - `platform`: the sealing account of the daily seal (`seal_days.source_account`).
 */
export interface StellarAccountSets {
  footprint: string[];
  openClaims: string[];
  accountHolders: string[];
  platform: string[];
}

/** One query per set; each returns one G-address per row. Run as the database owner (the scanner reads everything). */
export const STELLAR_ACCOUNT_QUERIES: Record<keyof StellarAccountSets, string> = {
  footprint: `SELECT subject FROM scf.footprint_items
               WHERE status = 'verified' AND removed_at IS NULL AND kind IN ('issuing_account', 'app_account')`,
  openClaims: `SELECT subject FROM scf.footprint_items
                WHERE status = 'claimed' AND removed_at IS NULL AND kind IN ('issuing_account', 'app_account')
                  AND created_at >= now() - interval '30 days'`,
  accountHolders: `SELECT subject FROM scf.external_identities WHERE provider = 'stellar'
                   UNION SELECT subject FROM scf.verification_evidence WHERE kind = 'stellar_account'
                   UNION SELECT subject FROM scf.enrollment_tombstones WHERE kind = 'stellar_account'
                   UNION SELECT a.subject FROM scf.auth_challenges a
                           JOIN scf.external_identities i ON i.provider = 'stellar' AND i.subject = a.subject`,
  platform: `SELECT DISTINCT source_account FROM scf.seal_days WHERE source_account IS NOT NULL`,
};

/**
 * Exact-value `g_address` allow rules for the `scf` dump. A value that appears in more than one set keeps the first
 * reason. Anything else shaped like a `G…` account — an end user's address, a rejected or removed footprint item, a
 * claim older than 30 days, a canary — remains a finding.
 */
export function stellarAccountAllowList(sets: StellarAccountSets): AllowRule[] {
  const reasons: [keyof StellarAccountSets, string][] = [
    [
      "footprint",
      "a verified Registered Footprint account: declared by the project as its own and proved (data-model §12.1)",
    ],
    [
      "openClaims",
      "an open Registered Footprint claim under verification: kept at most 30 days unless proved (C-137, plan C1 #9)",
    ],
    [
      "accountHolders",
      "a platform account holder's own Stellar account (sign-in identity, proven project account or tombstone) — not an end user of a tenant site",
    ],
    ["platform", "the platform's own daily-seal account"],
  ];
  const seen = new Set<string>();
  const out: AllowRule[] = [];
  for (const [k, reason] of reasons)
    for (const v of sets[k]) {
      if (!/^G[A-Z2-7]{55}$/.test(v)) throw new Error(`${k}: not a G… account: ${mask(v)}`);
      if (seen.has(v)) continue;
      seen.add(v);
      out.push({ kind: "g_address", match: v, source: /^pg_dump:scf$/, reason });
    }
  return out;
}

/** Allow-list entries every stack needs, each with its reason. */
export function baseAllowList(): AllowRule[] {
  return [
    { kind: "ipv4", match: "0.0.0.0", reason: "unspecified listen address" },
    {
      kind: "ipv4",
      match: "127.0.0.1",
      reason: "loopback listen/health address of the service itself",
    },
    {
      kind: "ipv4",
      match: "127.0.0.11",
      reason: "Docker's embedded DNS resolver (resolver messages in service logs)",
    },
    {
      kind: "ipv4",
      match: "255.255.255.255",
      reason: "broadcast/netmask constant (PostgreSQL defaults)",
    },
    {
      kind: "ipv6",
      match: /^::1?$/,
      reason: "IPv6 loopback / unspecified listen address",
    },
  ];
}
