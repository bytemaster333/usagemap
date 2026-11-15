// SPDX-License-Identifier: Apache-2.0
// Compile-time parameters of the tracker. Everything that varies between deployments is fixed here at build time
// and compiled into the pinned file (ADR-0004: no remote configuration). Release builds use the defaults; a test
// or staging build may override them through the environment, which produces different bytes and a different SRI
// hash — so an overridden build can never be mistaken for a released one.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Profile = "standard" | "strict";
export const PROFILES: readonly Profile[] = ["standard", "strict"];

/** gzip size budgets in bytes (C-32): strict ≤ 2.5 kB, standard ≤ 3.5 kB, both including the solver. */
export const BUDGET: Record<Profile, number> = { strict: 2500, standard: 3500 };

/**
 * The two ingest hosts on two domains (wire-formats §a.1). Placeholder defaults; deployments set their own, and production
 * names must also pass the filter-list check (web.adblock-safe-script-name).
 */
export const DEFAULT_HOSTS = [
  "https://ingest-a.example-analytics.org",
  "https://ingest-b.example-analytics.net",
] as const;

/**
 * Proof-of-work. The difficulty itself (`cost`, `max`) is issued per challenge by the gateway (§b.2; contract
 * defaults cost 512, max 1024, adaptive multiplier ≤ 8, i.e. at most 512 × 8192 = 2^22 PBKDF2 iterations). The
 * tracker only carries a ceiling — a challenge asking for more work than this is not solved (events go without
 * proof) so a misconfigured or hostile gateway cannot burn visitors' CPU — and the number of WebCrypto calls kept
 * in flight. Both are adjustable after spike S-07.
 */
export const DEFAULT_POW_MAX_WORK = 2 ** 24;
export const DEFAULT_POW_PARALLEL = 8;

export interface BuildConfig {
  version: string;
  hosts: readonly [string, string];
  powMaxWork: number;
  powParallel: number;
}

const int = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};

/**
 * `versionOverride` builds the same source under another version number — only for fixtures that need two released
 * versions side by side (tracker.intentional-upgrade: every released version stays served; tests of concurrent serving). Releases always
 * use the package version.
 */
export function buildConfig(versionOverride?: string): BuildConfig {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  const version = versionOverride ?? pkg.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error("version must be plain semver");
  const env = process.env.TRACKER_HOSTS;
  const hosts = env ? env.split(",").map((h) => h.trim()) : [...DEFAULT_HOSTS];
  if (
    hosts.length !== 2 ||
    !hosts.every((h) =>
      /^https:\/\/[a-z0-9.-]+(:[0-9]+)?$|^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(h),
    )
  ) {
    throw new Error(
      "TRACKER_HOSTS must be two origins (https, or http on localhost), comma-separated",
    );
  }
  return {
    version,
    hosts: [hosts[0] as string, hosts[1] as string],
    powMaxWork: int("TRACKER_POW_MAX_WORK", DEFAULT_POW_MAX_WORK),
    powParallel: int("TRACKER_POW_PARALLEL", DEFAULT_POW_PARALLEL),
  };
}

/** esbuild/vitest `define` map for one profile. */
export function defines(cfg: BuildConfig, profile: Profile): Record<string, string> {
  return {
    __STRICT__: JSON.stringify(profile === "strict"),
    __VERSION__: JSON.stringify(cfg.version),
    __HOSTS__: JSON.stringify(cfg.hosts),
    __POW_MAX_WORK__: JSON.stringify(cfg.powMaxWork),
    __POW_PARALLEL__: JSON.stringify(cfg.powParallel),
  };
}
