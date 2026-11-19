// SPDX-License-Identifier: Apache-2.0
// Rewrites the SRI hash next to every pinned tracker URL in the tenant guides, the example apps and their READMEs to the value in
// the tracker build's manifest (tracker/dist/<version>/manifest.json). For use after a tracker change that alters
// the bytes of a version's file; frameworks.test.ts fails until the pages agree with the build.
//
//   node tests/quickstarts/frameworks/sync-sri.ts            # rewrite
//   node tests/quickstarts/frameworks/sync-sri.ts --check    # list what would change, exit 1 if anything

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/env.ts";

const FILES = [
  ...readdirSync(join(REPO_ROOT, "docs/onboarding"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/onboarding/${f}`),
  ...readdirSync(join(REPO_ROOT, "docs/guides/quickstarts"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/guides/quickstarts/${f}`),
  "examples/html/index.html",
  "examples/html/about/index.html",
  "examples/astro/src/layouts/Base.astro",
  "examples/eleventy/src/_includes/base.njk",
  "examples/vitepress/docs/.vitepress/config.mts",
  "examples/docusaurus/docusaurus.config.js",
  "examples/README.md",
  // the READMEs show the pinned tag verbatim (tests/quickstarts/examples.test.ts)
  ...readdirSync(join(REPO_ROOT, "examples"))
    .filter((d) => existsSync(join(REPO_ROOT, "examples", d, "README.md")))
    .map((d) => `examples/${d}/README.md`),
];

const integrity = (version: string, file: string): string => {
  const m = JSON.parse(
    readFileSync(join(REPO_ROOT, "tracker/dist", version, "manifest.json"), "utf8"),
  ) as { files: { path: string; integrity: string }[] };
  const f = m.files.find((x) => x.path === file);
  if (!f) throw new Error(`manifest ${version} has no ${file}`);
  return f.integrity;
};

/** A tracker URL followed (within a few lines) by its integrity attribute or property. */
const PIN =
  /(\/lib\/(\d+\.\d+\.\d+)\/(standard|strict)\.js[^\n]*\n(?:[^\n]*\n){0,3}?[^\n]*?integrity[=:]\s*")(sha384-[A-Za-z0-9+/=]+)"/g;

const check = process.argv.includes("--check");
let changed = 0;
for (const rel of FILES) {
  const path = join(REPO_ROOT, rel);
  const before = readFileSync(path, "utf8");
  const after = before.replace(PIN, (_all, head: string, version: string, profile: string, old) => {
    const want = integrity(version, `${profile}.js`);
    if (want !== old) {
      changed++;
      console.log(`${rel}: ${version}/${profile}.js ${old} -> ${want}`);
    }
    return `${head}${want}"`;
  });
  if (!check && after !== before) writeFileSync(path, after);
}
console.log(`${changed} hash(es) ${check ? "out of date" : "rewritten"}`);
if (check && changed) process.exit(1);
