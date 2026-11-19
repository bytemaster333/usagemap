// SPDX-License-Identifier: Apache-2.0
// Which base URLs belong to which anchor and SEP. Filled from an anchor's stellar.toml (SEP-1 keys or the Wallet SDK's
// parsed `TomlInfo`); requests to any other URL are not measured at all.

import { homeDomainOf, OTHER, type Sep, type Step, stepOf } from "./classify.ts";

/** SEP-1 keys (and the Wallet SDK's `TomlInfo` names) of the servers a wallet talks to. */
const ENDPOINT_KEYS: ReadonlyArray<readonly [Exclude<Sep, "1">, readonly string[]]> = [
  ["10", ["WEB_AUTH_ENDPOINT", "webAuthEndpoint"]],
  ["6", ["TRANSFER_SERVER", "transferServer"]],
  ["24", ["TRANSFER_SERVER_SEP0024", "transferServerSep24"]],
  ["12", ["KYC_SERVER", "kycServer"]],
  ["31", ["DIRECT_PAYMENT_SERVER", "directPaymentServer"]],
  ["38", ["ANCHOR_QUOTE_SERVER", "anchorQuoteServer"]],
];

interface Entry {
  readonly base: string;
  readonly sep: Exclude<Sep, "1">;
  readonly domain: string;
}

export interface Match {
  readonly sep: Exclude<Sep, "1">;
  readonly step: Step;
  readonly domain: string;
}

/** `origin + path` without query, fragment or trailing slash; undefined when not an http(s) URL. */
export function baseOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

export interface DomainPolicy {
  /** Only these home domains are reported by name; others become `_OTHER`. */
  homeDomains?: readonly string[] | undefined;
  /** At most this many distinct home domains are reported by name per process (default 50); later ones `_OTHER`. */
  maxHomeDomains?: number | undefined;
}

export class Registry {
  #entries: Entry[] = [];
  readonly #admitted = new Set<string>();
  readonly #allow: ReadonlySet<string> | undefined;
  readonly #max: number;

  constructor(policy: DomainPolicy = {}) {
    this.#allow = policy.homeDomains
      ? new Set(policy.homeDomains.map((d) => homeDomainOf(d)).filter((d) => d !== OTHER))
      : undefined;
    this.#max = Math.max(0, Math.floor(policy.maxHomeDomains ?? 50));
  }

  /** The reported name of a home domain: normalised, allow-listed and within the cap, else `_OTHER`. */
  domain(homeDomain: unknown): string {
    const d = homeDomainOf(homeDomain);
    if (d === OTHER) return OTHER;
    if (this.#allow && !this.#allow.has(d)) return OTHER;
    if (this.#admitted.has(d)) return d;
    if (this.#admitted.size >= this.#max) return OTHER;
    this.#admitted.add(d);
    return d;
  }

  /**
   * Register an anchor's servers from its stellar.toml (`TomlInfo` from the Wallet SDK or the raw SEP-1 keys).
   * Returns how many server URLs were registered. Re-registering replaces the earlier URLs for that SEP.
   */
  register(homeDomain: string, toml: Readonly<Record<string, unknown>>): number {
    const domain = this.domain(homeDomain);
    let n = 0;
    for (const [sep, keys] of ENDPOINT_KEYS) {
      for (const k of keys) {
        const v = toml[k];
        if (typeof v !== "string") continue;
        const base = baseOf(v);
        if (!base) continue;
        this.#entries = this.#entries.filter((e) => !(e.base === base && e.sep === sep));
        this.#entries.push({ base, sep, domain });
        n++;
        break;
      }
    }
    // Longest base first, so `/sep24` wins over `/` on a shared host.
    this.#entries.sort((a, b) => b.base.length - a.base.length);
    return n;
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Classify a request; undefined when its URL is not below a registered anchor server. */
  match(method: string, url: string): Match | undefined {
    const full = baseOf(url);
    if (!full) return undefined;
    let fallback: Match | undefined;
    for (const e of this.#entries) {
      if (full !== e.base && !full.startsWith(`${e.base}/`)) continue;
      const step = stepOf(e.sep, method, full.slice(e.base.length));
      if (step !== "other") return { sep: e.sep, step, domain: e.domain };
      fallback ??= { sep: e.sep, step, domain: e.domain };
    }
    return fallback;
  }
}
