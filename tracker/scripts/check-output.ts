// SPDX-License-Identifier: Apache-2.0
// Static check of built tracker files (ADR-0004 least-power contract, C-33, C-65, C-89).
// Usage: node scripts/check-output.ts [dist-dir]   — checks dist/<version>/*.js and dist/npm/*.js.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./build-config.ts";

interface Rule {
  re: RegExp;
  why: string;
}

const WALLET_GLOBALS: Rule = {
  re: /\bfreighter\b|xBullSDK|window\.rabet|\blobstr\b|\balbedo\b|\bethereum\b/i,
  why: "wallet globals",
};

/** Forbidden in every build. */
export const COMMON: Rule[] = [
  { re: /\beval\b/, why: "eval" },
  { re: /new\s+Function|\bFunction\s*\(/, why: "Function constructor" },
  { re: /\bimport\s*\(/, why: "dynamic import()" },
  { re: /\bimportScripts\b|\bnew\s+(Shared)?Worker\b/, why: "worker / remote code" },
  { re: /document\.cookie|\bcookieStore\b/, why: "cookies" },
  { re: /sessionStorage|indexedDB/, why: "web storage other than the opt-out flag" },
  {
    re: /localStorage(?!\.(getItem|setItem|removeItem)\()/,
    why: "localStorage used other than get/set/remove",
  },
  { re: /\.title\b/, why: "page title (C-89)" },
  { re: /location\.(search|hash|href)\b|\.searchParams\b/, why: "query string / fragment (C-65)" },
  WALLET_GLOBALS,
  {
    re: /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    why: "DOM-XSS sink (Trusted Types)",
  },
  {
    re: /canvas|getContext|WebGL|AudioContext|hardwareConcurrency|deviceMemory/,
    why: "fingerprinting API",
  },
  {
    re: /addEventListener\(\s*["']message["']/,
    why: "postMessage listener (Tier 2 is not shipped)",
  },
  { re: /\bsourceMappingURL\b/, why: "source map reference" },
  {
    re: /sendBeacon/,
    why: "navigator.sendBeacon (EasyPrivacy blocks third-party ping requests; scripts/filter-list-check.ts)",
  },
];

/** Additionally forbidden in the strict build (C-33): no client signals, referrer, screen, language or kit probe. */
export const STRICT: Rule[] = [
  { re: /webdriver|userActivation|prerendering/, why: "client-signal read in strict" },
  { re: /\breferrer\b/, why: "referrer read in strict" },
  { re: /\bscreen\b|\.language\b/, why: "screen/language read in strict" },
  { re: /swk|stellar-wallets/, why: "Wallets Kit probe in strict" },
  { re: /"sg"|\bsg:/, why: "client signal field in strict" },
];

/**
 * Wallet adapters (`wallets-kit`, `wallets`, `passkey`, `privy`) and `stellar-rpc`: they name wallets (the alias map, the wrapped wallet APIs,
 * the documented provider globals used only to identify a provider the app passed in), so the wallet-name rule is
 * replaced by stricter ones: no network access of their own (they hand events to the tracker), no web storage at
 * all (never the kits' `@StellarWalletsKit/*` keys), no message listeners or postMessage, no global enumeration.
 */
export const ADAPTER: Rule[] = [
  ...COMMON.filter((r) => r !== WALLET_GLOBALS),
  { re: /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, why: "network access in an adapter" },
  { re: /localStorage/, why: "web storage in an adapter" },
  { re: /postMessage|addEventListener\(\s*["'`]message/, why: "message passing in an adapter" },
  {
    re: /(Object\.(keys|entries|values|getOwnPropertyNames)|Reflect\.ownKeys)\(\s*(window|globalThis|self)\b|\bin\s+(window|globalThis|self)\b/,
    why: "global enumeration (extension fingerprinting)",
  },
];

/** Which rule set applies to a built file. */
export type Kind = "core" | "strict" | "adapter" | "debug";

export const kindOf = (file: string): Kind =>
  file.startsWith("strict")
    ? "strict"
    : /^(wallets-kit|wallets|passkey|privy|stellar-rpc)\.js$/.test(file)
      ? "adapter"
      : file === "debug.js"
        ? "debug"
        : "core";

export function check(code: string, kind: boolean | Kind): string[] {
  const k: Kind = kind === true ? "strict" : kind === false ? "core" : kind;
  // The debug module (developers only) is checked like the core: it reads only the visitor's choices, wraps
  // `fetch` to observe the tracker's own requests, and writes text nodes only.
  const rules = k === "strict" ? [...COMMON, ...STRICT] : k === "adapter" ? ADAPTER : COMMON;
  const found = rules.filter((r) => r.re.test(code)).map((r) => r.why);
  if (
    code.includes("localStorage") &&
    (!code.includes('"scf_optout"') || /localStorage\.\w+\(\s*["'`](?!scf_optout["'`])/.test(code))
  ) {
    found.push("localStorage key must be the opt-out flag");
  }
  return found;
}

export function checkDist(dist: string, version: string): string[] {
  const errors: string[] = [];
  const dirs = [join(dist, version), join(dist, "npm")];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      for (const why of check(readFileSync(join(dir, f), "utf8"), kindOf(f))) {
        errors.push(`${join(dir, f)}: ${why}`);
      }
    }
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  if (Object.keys(pkg.dependencies ?? {}).length) errors.push("package.json: runtime dependencies");
  return errors;
}

if (import.meta.main) {
  const dist = process.argv[2] ?? join(ROOT, "dist");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  const errors = checkDist(dist, pkg.version);
  for (const e of errors) console.error(`FORBIDDEN ${e}`);
  if (errors.length) process.exit(1);
  console.log("static check: ok");
}
