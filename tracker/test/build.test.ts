// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
// Release artefacts: layout, SRI manifest, size budgets (C-32), least-power static check (ADR-0004, C-33, C-65, C-89),
// npm entries. Runs once (standard project); the build itself covers both profiles.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAll, RELEASES, releasedVersions } from "../scripts/build.ts";
import { BUDGET, DEFAULT_HOSTS, ROOT } from "../scripts/build-config.ts";
import { check, checkDist } from "../scripts/check-output.ts";

declare const __STRICT__: boolean;

describe.runIf(!__STRICT__)("release build", () => {
  let out = "";
  let version = "";
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "scf-tracker-build-"));
    version = (await buildAll(out)).cfg.version;
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes dist/<semver>/{standard,strict}.js and a manifest with matching SRI hashes", () => {
    const m = JSON.parse(readFileSync(join(out, version, "manifest.json"), "utf8"));
    expect(m.version).toBe(version);
    expect(m.config.hosts).toEqual(DEFAULT_HOSTS);
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(["standard.js", "strict.js"]);
    for (const f of m.files) {
      const code = readFileSync(join(out, version, f.path));
      expect(f.integrity).toBe(`sha384-${createHash("sha384").update(code).digest("base64")}`);
      expect(f.sha256).toBe(createHash("sha256").update(code).digest("hex"));
      expect(f.bytes).toBe(code.byteLength);
      expect(f.gzip_bytes).toBe(gzipSync(code).byteLength);
    }
  });

  it("ships every released version byte-identical next to the new one (1.0.0 stays immutable)", async () => {
    // the SRI strings tenants pinned for 1.0.0 (README of 1.0.0, docs/guides/quickstarts)
    const pinned: Record<string, string> = {
      "standard.js": "sha384-grGHJaIn1S7+QsKcbybsmEiu1LXgxcbaz4buMHrOZKdbGyYIStg+BbK8eJuYeX8K",
      "strict.js": "sha384-gbYqCs3Lbddg6Db5dI0EHQcSrYJ3O7/3vCYBPbhT6om3e+f89IkQkiwlLBzlABwP",
    };
    expect(releasedVersions()).toContain("1.0.0");
    expect(version).not.toBe("1.0.0");
    for (const [file, sri] of Object.entries(pinned)) {
      const code = readFileSync(join(out, "1.0.0", file));
      expect(`sha384-${createHash("sha384").update(code).digest("base64")}`).toBe(sri);
      expect(readFileSync(join(out, "1.0.0", file))).toEqual(
        readFileSync(join(RELEASES, "1.0.0", file)),
      );
    }
    await expect(buildAll(out, { version: "1.0.0", keepOtherVersions: true })).rejects.toThrow(
      /already released/,
    );
  });

  it("meets the gzip size budgets (strict ≤ 2.5 kB, standard ≤ 3.5 kB)", () => {
    for (const p of ["standard", "strict"] as const) {
      const size = gzipSync(readFileSync(join(out, version, `${p}.js`))).byteLength;
      expect(size, p).toBeLessThanOrEqual(BUDGET[p]);
    }
  });

  it("passes the static least-power check", () => {
    expect(checkDist(out, version)).toEqual([]);
  });

  it("is a single classic script: no import/export statements, no module syntax", () => {
    for (const p of ["standard", "strict"]) {
      const code = readFileSync(join(out, version, `${p}.js`), "utf8");
      expect(code).not.toMatch(/^\s*(import|export)\b|\bimport\.meta\b/m);
      expect(code.startsWith(`/*! scf-tracker ${version} ${p} Apache-2.0 */`)).toBe(true);
    }
  });

  it("strict contains the solver but no client-signal, referrer, screen, language or kit reads", () => {
    const strict = readFileSync(join(out, version, "strict.js"), "utf8");
    const standard = readFileSync(join(out, version, "standard.js"), "utf8");
    expect(strict).toContain("PBKDF2");
    expect(strict).toContain("deriveBits");
    expect(check(strict, true)).toEqual([]);
    expect(check(standard, true)).not.toEqual([]); // the strict rules do bite on the standard build
    for (const re of [
      /webdriver/,
      /userActivation/,
      /\breferrer\b/,
      /\bscreen\b/,
      /language/,
      /swk/,
    ]) {
      expect(standard).toMatch(re);
      expect(strict).not.toMatch(re);
    }
  });

  it("npm entries: init() for both profiles, the adapters and the debug module", async () => {
    const std = await import(pathToFileURL(join(out, "npm", "standard.js")).href);
    const str = await import(pathToFileURL(join(out, "npm", "strict.js")).href);
    expect(typeof std.init).toBe("function");
    expect(typeof str.init).toBe("function");
    expect(std.init({ site: "Q4mZ8bS1pTn0aR7cLx2VwE" })).toBeUndefined(); // no window here: SSR-safe
    const entry = async (name: string) =>
      Object.keys(await import(pathToFileURL(join(out, "npm", `${name}.js`)).href)).sort();
    expect(await entry("wallets-kit")).toEqual(
      [
        "attachWalletsKit",
        "attachWalletsKitV1",
        "networkOf",
        "stellarEvent",
        "walletContext",
        "walletType",
        "wrapWalletsKitModules",
      ].sort(),
    );
    expect(await entry("wallets")).toEqual(
      [
        "attachHorizonServer",
        "attachRpcServer",
        "detectInjectedWallet",
        "networkOf",
        "stellarEvent",
        "walletContext",
        "walletType",
        "wrapAlbedo",
        "wrapFreighter",
        "wrapHana",
        "wrapHot",
        "wrapInjected",
        "wrapLobstr",
        "wrapXBull",
      ].sort(),
    );
    expect(await entry("passkey")).toEqual(
      [
        "attachPasskeyKit",
        "attachPasskeyServer",
        "attachSmartAccountKit",
        "networkOf",
        "passkeyFailReason",
        "stellarEvent",
        "walletContext",
      ].sort(),
    );
    expect(await entry("privy")).toEqual(
      [
        "networkOf",
        "privyLoginCallbacks",
        "resetPrivyState",
        "stellarEvent",
        "walletContext",
        "wrapPrivyStellar",
      ].sort(),
    );
    expect(await entry("stellar-rpc")).toEqual(
      [
        "HORIZON_TEMPLATES",
        "MAX_CELLS",
        "RPC_OPERATIONS",
        "attachHorizonTelemetry",
        "attachRpcTelemetry",
        "countCall",
        "failureOutcome",
        "flushRpcTelemetry",
        "horizonOperation",
        "latency",
        "rpcTelemetryCells",
        "templateOperation",
      ].sort(),
    );
    expect(await entry("debug")).toEqual([
      "blockedReasons",
      "debug",
      "explainDebugHeader",
      "explainStatus",
    ]);
    expect(readFileSync(join(out, "npm", "types", "npm.d.ts"), "utf8")).toContain(
      "export declare function init",
    );
    for (const name of ["wallets-kit", "wallets", "passkey", "privy", "stellar-rpc", "debug"]) {
      expect(readFileSync(join(out, "npm", "types", `${name}.d.ts`), "utf8")).toContain("export");
    }
    // package.json exports every entry, types first
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
    };
    for (const name of ["wallets-kit", "wallets", "passkey", "privy", "stellar-rpc", "debug"]) {
      expect(pkg.exports[`./${name}`]).toEqual({
        types: `./dist/npm/types/${name}.d.ts`,
        default: `./dist/npm/${name}.js`,
      });
    }
  });

  it("adapter size budgets (gzip) and no wallet library bundled or imported", () => {
    // Loaded only by apps that import them; budgets keep them small (C-32 covers the core only).
    // 1.2.0: connect failures, wallet context and the WalletConnect funnel (+~1 kB each for the shared vocabulary).
    const budget = {
      "wallets-kit": 6_144,
      wallets: 6_144,
      passkey: 4_608,
      privy: 4_608,
      "stellar-rpc": 4_096,
    } as const;
    for (const [name, max] of Object.entries(budget)) {
      const code = readFileSync(join(out, "npm", `${name}.js`));
      expect(gzipSync(code, { level: 9 }).byteLength, name).toBeLessThanOrEqual(max);
      const text = code.toString("utf8");
      // never import or bundle a wallet library (the Wallets Kit, WalletConnect — non-OSI from 2.23 —, Freighter …)
      expect(text, name).not.toMatch(/\bimport\b|\brequire\(/);
      expect(text, name).not.toMatch(
        /@creit\.tech|@walletconnect|@reown|@stellar\/freighter-api|@privy-io|preact/i,
      );
    }
  });

  it("adapters and the debug module never bundle the tracker core (one tracker per page)", () => {
    for (const name of ["wallets-kit", "wallets", "passkey", "privy", "stellar-rpc", "debug"]) {
      const code = readFileSync(join(out, "npm", `${name}.js`), "utf8");
      expect(code, name).not.toContain("deriveBits");
      expect(code, name).not.toMatch(/history\.pushState/);
    }
  });

  it("ships no runtime dependency and no fixture-framework code (React, Vue are e2e dev dependencies only)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      files: string[];
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.files).toEqual(["dist/npm", "README.md"]);
    for (const f of [
      join(out, version, "standard.js"),
      join(out, version, "strict.js"),
      join(out, "npm", "standard.js"),
      join(out, "npm", "strict.js"),
    ]) {
      const code = readFileSync(f, "utf8");
      expect(code).not.toMatch(/\bimport\s.*\bfrom\b|require\(|react|vue|__VUE|createElement/i);
    }
  });
});

describe.runIf(!__STRICT__)("static check rules", () => {
  it.each([
    ["eval('1')", "eval"],
    ["new Function('a')", "Function constructor"],
    ["Function('a')()", "Function constructor"],
    ["import('./x.js')", "dynamic import()"],
    ["document.cookie='a=b'", "cookies"],
    ["sessionStorage.setItem('a','b')", "web storage other than the opt-out flag"],
    ["indexedDB.open('x')", "web storage other than the opt-out flag"],
    ["localStorage.key(0)", "localStorage used other than get/set/remove"],
    ['localStorage.getItem("other")', "localStorage key must be the opt-out flag"],
    ["document.title", "page title (C-89)"],
    ["location.search", "query string / fragment (C-65)"],
    ["location.href", "query string / fragment (C-65)"],
    ["window.freighter", "wallet globals"],
    ["el.innerHTML=x", "DOM-XSS sink (Trusted Types)"],
    ["new Worker(u)", "worker / remote code"],
    ["addEventListener('message',f)", "postMessage listener (Tier 2 is not shipped)"],
    [
      "navigator.sendBeacon(u,b)",
      "navigator.sendBeacon (EasyPrivacy blocks third-party ping requests; scripts/filter-list-check.ts)",
    ],
  ])("flags %s", (code, why) => {
    expect(check(code, false)).toContain(why);
  });

  it.each([
    ["navigator.webdriver", "client-signal read in strict"],
    ["document.referrer", "referrer read in strict"],
    ["screen.width", "screen/language read in strict"],
    ["section.stellar-wallets-kit", "Wallets Kit probe in strict"],
  ])("flags %s in strict only", (code, why) => {
    expect(check(code, true)).toContain(why);
    expect(check(code, false)).not.toContain(why);
  });

  it.each([
    ["fetch(u)", "network access in an adapter"],
    ["new WebSocket(u)", "network access in an adapter"],
    ['localStorage.getItem("@StellarWalletsKit/activeAddress")', "web storage in an adapter"],
    ["window.postMessage(x)", "message passing in an adapter"],
    ["addEventListener('message',f)", "message passing in an adapter"],
    ["Object.keys(window)", "global enumeration (extension fingerprinting)"],
    ["for (const k in globalThis) f(k)", "global enumeration (extension fingerprinting)"],
    ["eval('1')", "eval"],
    ["el.innerHTML=x", "DOM-XSS sink (Trusted Types)"],
  ])("flags %s in an adapter", (code, why) => {
    expect(check(code, "adapter")).toContain(why);
  });

  it("adapters may name wallets; the core and the debug module may not", () => {
    const code = 'const a={varial:"freighter",lobstr:"lobstr"};wrap(window.xBullSDK)';
    expect(check(code, "adapter")).toEqual([]);
    expect(check(code, "core")).toContain("wallet globals");
    expect(check(code, "debug")).toContain("wallet globals");
  });

  it("allows the opt-out flag and the referrerPolicy fetch option in strict", () => {
    expect(
      check('localStorage.getItem("scf_optout");fetch(u,{referrerPolicy:"origin"})', true),
    ).toEqual([]);
  });
});

// tracker.intentional-upgrade / ADR-0004: tenants upgrade intentionally, so every released version stays served next to newer ones. The
// build lays versions out as <out>/<semver>/ with their own manifest; a second version must not disturb the first.
describe.runIf(!__STRICT__)("two versions side by side (tracker.intentional-upgrade)", () => {
  let out = "";
  let first = "";
  const SECOND = "99.1.0";
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "scf-tracker-two-"));
    first = (await buildAll(out)).cfg.version;
    await buildAll(out, { version: SECOND, keepOtherVersions: true });
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("keeps the first version's files byte-identical and adds the second with its own manifest", () => {
    const m1 = JSON.parse(readFileSync(join(out, first, "manifest.json"), "utf8"));
    const m2 = JSON.parse(readFileSync(join(out, SECOND, "manifest.json"), "utf8"));
    expect(m1.version).toBe(first);
    expect(m2.version).toBe(SECOND);
    for (const m of [m1, m2]) {
      for (const f of m.files) {
        const code = readFileSync(join(out, m.version, f.path));
        expect(f.integrity).toBe(`sha384-${createHash("sha384").update(code).digest("base64")}`);
        expect(code.toString("utf8").startsWith(`/*! scf-tracker ${m.version} ${f.profile}`)).toBe(
          true,
        );
      }
    }
    // Different bytes (the version is compiled in), so different SRI: a snippet pins exactly one of them.
    expect(m1.files[0].integrity).not.toBe(m2.files[0].integrity);
    expect(checkDist(out, first)).toEqual([]);
    expect(checkDist(out, SECOND)).toEqual([]);
  });

  it("reports its own version on the wire (payload field tv)", () => {
    for (const v of [first, SECOND]) {
      const code = readFileSync(join(out, v, "standard.js"), "utf8");
      expect(code).toContain(JSON.stringify(v));
    }
  });

  it("refuses a version that is not plain semver", async () => {
    await expect(buildAll(out, { version: "1.1", keepOtherVersions: true })).rejects.toThrow(
      /semver/,
    );
  });
});
