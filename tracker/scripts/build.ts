// SPDX-License-Identifier: Apache-2.0
// Release build of the tracker.
//
//   node scripts/build.ts [--out <dir>] [--fixture-version <x.y.z>]
//
// `--fixture-version` builds the same source under another version next to the versions already in <out> (test
// fixtures for two concurrently served versions, tracker.intentional-upgrade); releases never use it.
//
// Produces, deterministically (no timestamps, no absolute paths, pinned esbuild and Node):
//   <out>/<semver>/standard.js, <out>/<semver>/strict.js   classic scripts, single file each (ADR-0004)
//   <out>/<semver>/manifest.json                            sha256 / sha384 (SRI) / sizes per file
//   <out>/npm/{standard,strict,wallets-kit,wallets,passkey,privy,stellar-rpc,debug}.js + types/   ESM package entries
// and fails when a size budget (C-32) or the static least-power check is violated.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { build, version as esbuildVersion } from "esbuild";
import {
  BUDGET,
  type BuildConfig,
  buildConfig,
  DEFAULT_HOSTS,
  DEFAULT_POW_MAX_WORK,
  DEFAULT_POW_PARALLEL,
  defines,
  PROFILES,
  type Profile,
  ROOT,
} from "./build-config.ts";
import { checkDist } from "./check-output.ts";

// Browsers from mid-2021 on: native optional chaining (Chrome < 91 has a known bug that would force a down-level
// transform), WebCrypto PBKDF2, fetch keepalive, AbortController.
const TARGET = ["es2020", "chrome91", "edge91", "firefox90", "safari15"];

const banner = (cfg: BuildConfig, what: string): string =>
  `/*! scf-tracker ${cfg.version} ${what} Apache-2.0 */`;

async function bundle(
  cfg: BuildConfig,
  entry: string,
  profile: Profile,
  format: "iife" | "esm",
  what: string,
): Promise<Uint8Array> {
  const res = await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format,
    platform: "browser",
    target: TARGET,
    charset: "utf8",
    legalComments: "none",
    sourcemap: false,
    define: defines(cfg, profile),
    banner: { js: banner(cfg, what) },
    ...(format === "iife"
      ? { minify: true }
      : { minifySyntax: true, treeShaking: true, minifyWhitespace: false }),
  });
  const out = res.outputFiles[0];
  if (!out || res.errors.length) throw new Error(`esbuild failed for ${entry}`);
  return out.contents;
}

/** ESM-only package entries besides the two profiles (`@usagemap/tracker/<entry>`). */
export const NPM_EXTRAS = [
  "wallets-kit",
  "wallets",
  "passkey",
  "privy",
  "stellar-rpc",
  "debug",
] as const;

export interface FileEntry {
  path: string;
  profile: Profile;
  bytes: number;
  gzip_bytes: number;
  sha256: string;
  sha384: string;
  integrity: string;
}

export interface BuildOptions {
  /** build under this version instead of the package version (fixtures only, see buildConfig) */
  version?: string;
  /** keep other versions already in `out` (default: start from an empty `out`) */
  keepOtherVersions?: boolean;
}

/**
 * Released versions are immutable (tracker.intentional-upgrade, ADR-0004): their exact bytes are archived in releases/<semver>/ (classic
 * files + manifest, built from the source of that release) and copied into every release build next to the current
 * version, after each file's SHA-384 is checked against the archived manifest. A version that is archived can never
 * be rebuilt from newer source.
 */
export const RELEASES = join(ROOT, "releases");

export function releasedVersions(): string[] {
  return existsSync(RELEASES)
    ? readdirSync(RELEASES)
        .filter((v) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v))
        .sort()
    : [];
}

/** Copy (and verify) the archived released versions into `out`. */
export function copyReleases(out: string, except: string): void {
  for (const v of releasedVersions()) {
    if (v === except) continue;
    const src = join(RELEASES, v);
    const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as {
      version: string;
      files: { path: string; integrity: string }[];
    };
    if (m.version !== v) throw new Error(`releases/${v}: manifest says ${m.version}`);
    for (const f of m.files) {
      const sri = `sha384-${createHash("sha384")
        .update(readFileSync(join(src, f.path)))
        .digest("base64")}`;
      if (sri !== f.integrity)
        throw new Error(`releases/${v}/${f.path}: bytes differ from its manifest`);
    }
    rmSync(join(out, v), { recursive: true, force: true });
    cpSync(src, join(out, v), { recursive: true });
  }
}

/** Whether this build uses the release defaults (an overridden test build never carries released files). */
const isReleaseConfig = (cfg: BuildConfig): boolean =>
  cfg.hosts[0] === DEFAULT_HOSTS[0] &&
  cfg.hosts[1] === DEFAULT_HOSTS[1] &&
  cfg.powMaxWork === DEFAULT_POW_MAX_WORK &&
  cfg.powParallel === DEFAULT_POW_PARALLEL;

export async function buildAll(
  out: string,
  opts: BuildOptions = {},
): Promise<{ cfg: BuildConfig; files: FileEntry[] }> {
  const cfg = buildConfig(opts.version);
  if (releasedVersions().includes(cfg.version)) {
    throw new Error(
      `version ${cfg.version} is already released (releases/${cfg.version}): bump the version, released bytes never change`,
    );
  }
  const rel = join(out, cfg.version);
  const npm = join(out, "npm");
  if (opts.keepOtherVersions) {
    rmSync(rel, { recursive: true, force: true });
    rmSync(npm, { recursive: true, force: true });
  } else {
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(rel, { recursive: true });
  mkdirSync(npm, { recursive: true });

  const files: FileEntry[] = [];
  for (const profile of PROFILES) {
    const code = await bundle(cfg, "src/classic.ts", profile, "iife", profile);
    writeFileSync(join(rel, `${profile}.js`), code);
    const sha384 = createHash("sha384").update(code).digest("base64");
    files.push({
      path: `${profile}.js`,
      profile,
      bytes: code.byteLength,
      gzip_bytes: gzipSync(code).byteLength,
      sha256: createHash("sha256").update(code).digest("hex"),
      sha384,
      integrity: `sha384-${sha384}`,
    });
    writeFileSync(
      join(npm, `${profile}.js`),
      await bundle(cfg, "src/npm.ts", profile, "esm", `${profile} (ESM)`),
    );
  }
  // Adapters and the debug module: separate ESM entries, each self-contained (they find the running tracker through
  // `Symbol.for("scf.tracker")` and never bundle the core, so one page never runs two trackers).
  for (const entry of NPM_EXTRAS) {
    writeFileSync(
      join(npm, `${entry}.js`),
      await bundle(cfg, `src/${entry}.ts`, "standard", "esm", entry),
    );
  }

  // Declarations for the npm entries (same API for both profiles).
  execFileSync(
    join(ROOT, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.types.json", "--outDir", join(npm, "types")],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );

  const manifest = {
    name: "@usagemap/tracker",
    version: cfg.version,
    protocol: "v1",
    url_pattern: "/lib/<version>/<profile>.js",
    build: {
      esbuild: esbuildVersion,
      node: process.versions.node,
      commit: process.env.SOURCE_COMMIT || null,
      container_digest: process.env.BUILD_CONTAINER_DIGEST || null,
    },
    config: {
      hosts: cfg.hosts,
      pow_max_work: cfg.powMaxWork,
      pow_parallel: cfg.powParallel,
    },
    budgets_gzip_bytes: BUDGET,
    files,
  };
  writeFileSync(join(rel, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (isReleaseConfig(cfg)) copyReleases(out, cfg.version);
  return { cfg, files };
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const out = arg("--out") ?? join(ROOT, "dist");
  const version = arg("--fixture-version");
  const { cfg, files } = await buildAll(out, version ? { version, keepOtherVersions: true } : {});
  let failed = false;
  for (const f of files) {
    const over = f.gzip_bytes > BUDGET[f.profile];
    failed ||= over;
    console.log(
      `${cfg.version}/${f.path}: ${f.bytes} B, ${f.gzip_bytes} B gzip (budget ${BUDGET[f.profile]}) ${over ? "OVER BUDGET" : "ok"}  ${f.integrity}`,
    );
  }
  const errors = checkDist(out, cfg.version);
  for (const e of errors) console.error(`FORBIDDEN ${e}`);
  if (failed || errors.length) process.exit(1);
}
