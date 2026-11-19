// SPDX-License-Identifier: Apache-2.0
// Closed-set classifiers for outbound partner calls. Every function returns a member of a fixed list: the URL is read
// in memory (host, path segments and, for partners serving both networks on one host, the `network` query
// parameter) and then discarded. Query strings, ids, addresses, amounts, keys and bodies never leave this file.
// The UsageMap Collector enforces the same sets again (scfsanitizeprocessor/partner.go, wire-formats §f.5 step 4b).

import { PARTNERS, type Partner } from "./partners.ts";

export const OTHER = "_OTHER";

/** `stellar.partner.outcome` (closed). */
export const OUTCOMES = [
  "success",
  "client_error",
  "auth_error",
  "not_found",
  "rate_limited",
  "server_error",
  "timeout",
  "network",
] as const;
export type Outcome = (typeof OUTCOMES)[number] | "_OTHER";

/** `stellar.network` of a partner call: the network the app names, else the partner host's environment. */
export const NETWORKS = ["mainnet", "testnet", "futurenet", "local", "unknown"] as const;
export type Network = (typeof NETWORKS)[number];

const PASSPHRASES: Readonly<Record<string, Network>> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "local",
};
/** A network name or passphrase → network class (in memory only). `public` is an alias some partners use. */
export function networkOf(p: unknown): Network {
  if (typeof p !== "string") return "unknown";
  const v = p.toLowerCase();
  if (v === "mainnet" || v === "public" || v === "pubnet") return "mainnet";
  if (v === "testnet" || v === "futurenet" || v === "local") return v;
  return PASSPHRASES[p] ?? "unknown";
}

const MAX_SEGMENTS = 16;
const isPlaceholder = (s: string) => s.startsWith("{") && s.endsWith("}");

interface Compiled {
  readonly hosts: ReadonlyMap<string, string>;
  readonly templates: ReadonlyArray<{ readonly t: string; readonly seg: readonly string[] }>;
}
const COMPILED: ReadonlyMap<Partner, Compiled> = new Map(
  (Object.keys(PARTNERS) as Partner[]).map((p) => [
    p,
    {
      hosts: new Map(Object.entries(PARTNERS[p].hosts)),
      templates: PARTNERS[p].operations.map((t) => ({ t, seg: t.split("/").filter(Boolean) })),
    },
  ]),
);
const BY_HOST: ReadonlyMap<string, Partner> = new Map(
  [...COMPILED].flatMap(([p, c]) => [...c.hosts.keys()].map((h) => [h, p] as const)),
);

export const isPartner = (p: unknown): p is Partner =>
  typeof p === "string" && COMPILED.has(p as Partner);

/** The partner whose API host this is (exact host, case-insensitive, port ignored), or undefined. */
export function partnerOfHost(host: string): Partner | undefined {
  return BY_HOST.get(host.toLowerCase().replace(/:\d+$/, ""));
}

/**
 * A request path → the partner's route template, or `_OTHER`. Any prefix in front of the routes (a version such as
 * `/v1`, a base path, a key in the path) is skipped: the first suffix of the path that matches a template wins, and
 * among templates matching that suffix the one with the most literal segments. Placeholders match one segment.
 */
export function operationOf(partner: Partner, path: string): string {
  const c = COMPILED.get(partner);
  if (!c) return OTHER;
  const seg = path.split("/").filter(Boolean);
  if (seg.length > MAX_SEGMENTS) return OTHER;
  for (let i = 0; i < seg.length; i++) {
    const rest = seg.slice(i);
    let best: string | undefined;
    let bestLiterals = -1;
    for (const { t, seg: ts } of c.templates) {
      if (ts.length !== rest.length) continue;
      let literals = 0;
      let ok = true;
      for (let k = 0; k < ts.length; k++) {
        const s = ts[k] as string;
        if (isPlaceholder(s)) continue;
        if (s !== rest[k]) {
          ok = false;
          break;
        }
        literals++;
      }
      if (ok && literals > bestLiterals) {
        best = t;
        bestLiterals = literals;
      }
    }
    if (best !== undefined) return best;
  }
  return OTHER;
}

export interface CallClass {
  readonly partner: Partner;
  readonly operation: string;
  readonly network: Network;
}

/**
 * Classify a request URL. `partner` forces the partner (a custom domain or a proxy in front of a partner API);
 * `network` overrides the environment. Undefined when the URL is not a partner API and no partner is forced: such a
 * call is not measured at all.
 */
export function classifyUrl(
  url: string | URL,
  opts: { partner?: string | undefined; network?: string | undefined } = {},
): CallClass | undefined {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return undefined;
  }
  const byHost = partnerOfHost(u.host);
  const partner =
    opts.partner !== undefined ? (isPartner(opts.partner) ? opts.partner : undefined) : byHost;
  if (!partner) return undefined;
  let network: Network;
  if (opts.network !== undefined) network = networkOf(opts.network);
  else {
    const env =
      byHost === partner
        ? COMPILED.get(partner)?.hosts.get(u.host.toLowerCase().replace(/:\d+$/, ""))
        : undefined;
    network = env === "query" ? networkOf(u.searchParams.get("network")) : networkOf(env);
  }
  return { partner, operation: operationOf(partner, u.pathname), network };
}

/** HTTP status → outcome class. */
export function outcomeOfStatus(status: unknown): Outcome {
  if (typeof status !== "number" || !Number.isInteger(status)) return OTHER;
  if (status >= 200 && status < 400) return "success";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500 && status < 600) return "server_error";
  return OTHER;
}

/** A thrown error without an HTTP status → `timeout` or `network`. */
export function outcomeOfError(err: unknown): Outcome {
  const e = err as
    | { name?: unknown; code?: unknown; cause?: { name?: unknown; code?: unknown } }
    | undefined;
  const names = [e?.name, e?.code, e?.cause?.name, e?.cause?.code];
  return names.some(
    (n) =>
      n === "TimeoutError" ||
      n === "AbortError" ||
      n === "ECONNABORTED" ||
      n === "ETIMEDOUT" ||
      n === "UND_ERR_CONNECT_TIMEOUT" ||
      n === "UND_ERR_HEADERS_TIMEOUT" ||
      n === "UND_ERR_BODY_TIMEOUT",
  )
    ? "timeout"
    : "network";
}
