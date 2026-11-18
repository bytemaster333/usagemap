#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Assemble the UsageMap community template for Scaffold Stellar from a
// checkout of the official UI monorepo (stellar-scaffold/ui) at the pinned
// commit in UPSTREAM.json:
//
//   node templates/scaffold-stellar/assemble.mjs --upstream <ui checkout> --out <dir>
//        [--tracker <exact version> | --tracker-tarball <npm-packed tracker .tgz>]
//
// `stellar scaffold init --template org/repo#tag` copies a community repository
// as is (no framework instantiation), so the output is an already-instantiated
// project: the React template promoted to app/, exactly as init does for an
// official template, plus the UsageMap overlay:
//   app/src/usagemap.ts              tracker + Wallets Kit adapter (off without PUBLIC_USAGEMAP_SITE)
//   app/src/main.tsx                 `import "./usagemap"` as the first import
//   app/package.json                 tracker pinned exactly; the kit at app-lib's range
//   scaffold.yml                     extensions.usagemap (record contracts; registration opt-in)
//   tools/stellar-scaffold-usagemap  the post-deploy extension (npm workspace, bin on the scripts' PATH)
//   usagemap.env.example, USAGEMAP.md, USAGEMAP_TEMPLATE.json (provenance + file hashes)
//
// Files only: nothing from the upstream checkout is executed, and nothing is
// installed or downloaded. Every edit checks its anchor and fails loudly if
// upstream has changed shape.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const UPSTREAM = JSON.parse(readFileSync(join(HERE, "UPSTREAM.json"), "utf8"));
const OVERLAY_VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;

// As instantiate.rs (stellar-scaffold/cli @ UPSTREAM.cli.commit) after promoting a framework.
const INSTANTIATED_WORKSPACES = ["app", "app-lib", "app-lib/clients/*", "e2e"];
const EXTENSION_DIR = "tools/stellar-scaffold-usagemap";
const IMPORT_LINE =
  'import "./usagemap" // first: UsageMap analytics, before app-lib/wallet.ts initialises the Wallets Kit';
const SKIP = new Set([".git", "node_modules", "target", ".scaffold", "dist"]);

class AssembleError extends Error {}
const fail = (msg) => {
  throw new AssembleError(msg);
};

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Indentation of a JSON file: its first indented line ("\t" upstream). */
function indentOf(text) {
  return /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
}

function writeJsonLike(p, value, original) {
  writeFileSync(p, `${JSON.stringify(value, null, indentOf(original))}\n`);
}

function sortedObject(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Step 1: copy the checkout (without VCS, dependencies or build output). */
function copyUpstream(src, out) {
  if (existsSync(out) && readdirSync(out).length > 0) fail(`--out ${out} must be empty or absent`);
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(src)) {
    if (SKIP.has(name)) continue;
    cpSync(join(src, name), join(out, name), {
      recursive: true,
      filter: (s) => !SKIP.has(s.split(/[\\/]/).pop() ?? ""),
    });
  }
}

/** Step 2: promote templates/<framework> to app/, as `stellar scaffold init --template <framework>` does. */
function instantiate(out, framework) {
  const templates = join(out, "templates");
  const selected = join(templates, framework);
  if (!existsSync(selected) || !statSync(selected).isDirectory())
    fail(`upstream has no templates/${framework}`);
  if (existsSync(join(out, "app"))) fail("upstream already has app/: not the UI monorepo layout");
  renameSync(selected, join(out, "app"));
  rmSync(templates, { recursive: true, force: true });
  const pkgPath = join(out, "package.json");
  const text = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(text);
  if (!Array.isArray(pkg.workspaces) || !pkg.workspaces.includes("templates/*")) {
    fail('root package.json workspaces no longer contain "templates/*"');
  }
  pkg.workspaces = [...INSTANTIATED_WORKSPACES, EXTENSION_DIR];
  writeJsonLike(pkgPath, pkg, text);
  const tests = join(out, "e2e", "tests");
  if (existsSync(tests)) {
    for (const e of readdirSync(tests, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.endsWith("-snapshots"))
        rmSync(join(tests, e.name), { recursive: true });
    }
  }
}

/** Step 3: `import "./usagemap"` as the very first statement of app/src/main.tsx. */
function patchMain(out) {
  const p = join(out, "app", "src", "main.tsx");
  if (!existsSync(p)) fail("app/src/main.tsx is missing");
  const text = readFileSync(p, "utf8");
  if (text.includes('import "./usagemap"')) fail("app/src/main.tsx already imports ./usagemap");
  if (!/^import\s/m.test(text) || !text.includes("createRoot("))
    fail("app/src/main.tsx changed shape (no imports or createRoot)");
  writeFileSync(p, `${IMPORT_LINE}\n${text}`);
}

/** Step 4: dependencies of app/: the tracker (exact) and the kit (the range app-lib uses). */
function patchAppPackage(out, trackerSpec) {
  const p = join(out, "app", "package.json");
  const text = readFileSync(p, "utf8");
  const pkg = JSON.parse(text);
  const libPkg = readJson(join(out, "app-lib", "package.json"));
  const kitRange = libPkg.dependencies?.["@creit.tech/stellar-wallets-kit"];
  if (!kitRange) fail("app-lib no longer depends on @creit.tech/stellar-wallets-kit");
  const deps = { ...(pkg.dependencies ?? {}) };
  if (deps["@usagemap/tracker"]) fail("app/package.json already depends on @usagemap/tracker");
  deps["@usagemap/tracker"] = trackerSpec;
  deps["@creit.tech/stellar-wallets-kit"] ??= kitRange;
  pkg.dependencies = sortedObject(deps);
  writeJsonLike(p, pkg, text);
  return { kitRange };
}

/** Step 5: the extension block of scaffold.yml (appended; upstream has no `extensions:` key). */
function patchScaffoldYml(out) {
  const p = join(out, "scaffold.yml");
  const text = readFileSync(p, "utf8");
  if (!/^version: 2\s*$/m.test(text)) fail("scaffold.yml is not version 2");
  if (/^extensions:/m.test(text))
    fail("scaffold.yml already has an extensions: key; merge the usagemap block by hand");
  const block = readFileSync(join(HERE, "overlay", "scaffold.yml.fragment"), "utf8");
  writeFileSync(p, `${text.replace(/\n*$/, "\n")}\n${block}`);
}

/** Step 6: the extension as a workspace package, so npm links its bin into node_modules/.bin. */
function addExtension(out) {
  const dst = join(out, EXTENSION_DIR);
  mkdirSync(join(dst, "bin"), { recursive: true });
  for (const f of ["package.json", "lib.mjs", "bin/stellar-scaffold-usagemap"]) {
    cpSync(join(HERE, "extension", f), join(dst, f));
  }
}

/** Step 7: overlay files that are new in the template. */
function addOverlayFiles(out) {
  for (const f of ["app/src/usagemap.ts", "usagemap.env.example", "USAGEMAP.md"]) {
    const dst = join(out, f);
    if (existsSync(dst)) fail(`${f} already exists upstream`);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(HERE, "overlay", f), dst);
  }
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * Assemble. opts: { upstream, out, tracker = UPSTREAM.tracker, trackerTarball?, framework = "react", commit? }.
 * Returns the provenance record also written to USAGEMAP_TEMPLATE.json.
 */
export function assemble(opts) {
  const upstream = resolve(opts.upstream);
  const out = resolve(opts.out);
  let tracker = opts.tracker ?? UPSTREAM.tracker;
  if (opts.trackerTarball) {
    if (!/^[\w.-]+\.tgz$/.test(basename(opts.trackerTarball)) || !existsSync(opts.trackerTarball)) {
      fail("--tracker-tarball must be an existing <name>.tgz (from `npm pack` of the tracker)");
    }
    tracker = `file:vendor/${basename(opts.trackerTarball)}`;
  } else if (!/^\d+\.\d+\.\d+$/.test(tracker)) {
    fail("--tracker must be an exact version, e.g. 1.1.0");
  }
  if (!existsSync(join(upstream, "scaffold.yml")) || !existsSync(join(upstream, "templates"))) {
    fail(`${upstream} is not a checkout of ${UPSTREAM.repo}`);
  }
  copyUpstream(upstream, out);
  instantiate(out, opts.framework ?? UPSTREAM.framework);
  patchMain(out);
  const { kitRange } = patchAppPackage(out, tracker);
  patchScaffoldYml(out);
  addExtension(out);
  addOverlayFiles(out);
  if (opts.trackerTarball) {
    mkdirSync(join(out, "app", "vendor"), { recursive: true });
    cpSync(opts.trackerTarball, join(out, "app", "vendor", basename(opts.trackerTarball)));
  }
  const touched = [
    "package.json",
    "scaffold.yml",
    "app/package.json",
    "app/src/main.tsx",
    "app/src/usagemap.ts",
    "usagemap.env.example",
    "USAGEMAP.md",
    `${EXTENSION_DIR}/package.json`,
    `${EXTENSION_DIR}/lib.mjs`,
    `${EXTENSION_DIR}/bin/stellar-scaffold-usagemap`,
  ];
  const record = {
    schema: "usagemap-scaffold-template/1",
    overlay_version: OVERLAY_VERSION,
    upstream: {
      repo: UPSTREAM.repo,
      commit: opts.commit ?? UPSTREAM.commit,
      framework: opts.framework ?? UPSTREAM.framework,
    },
    tracker,
    wallets_kit: kitRange,
    files: Object.fromEntries(touched.map((f) => [f, sha256(join(out, f))])),
  };
  writeFileSync(join(out, "USAGEMAP_TEMPLATE.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    const key = {
      "--upstream": "upstream",
      "--out": "out",
      "--tracker": "tracker",
      "--tracker-tarball": "trackerTarball",
      "--commit": "commit",
    }[a];
    if (key) {
      if (!v) fail(`${a} needs a value`);
      o[key] = v;
      i++;
    } else if (a === "--help" || a === "-h") {
      o.help = true;
    } else {
      fail(`unknown argument ${a}`);
    }
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.help || !o.upstream || !o.out) {
      process.stdout.write(
        "usage: node assemble.mjs --upstream <stellar-scaffold/ui checkout> --out <empty dir> [--tracker 1.1.0 | --tracker-tarball <tracker.tgz>] [--commit <sha>]\n",
      );
      process.exitCode = o.help ? 0 : 2;
    } else {
      const r = assemble(o);
      process.stdout.write(
        `assembled ${relative(process.cwd(), resolve(o.out)) || "."} from ${r.upstream.repo}@${r.upstream.commit.slice(0, 7)} (tracker ${r.tracker})\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`assemble: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
