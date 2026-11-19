// SPDX-License-Identifier: Apache-2.0
// tracker.ssr-frameworks: the framework guides (docs/onboarding/web-*.md) and the example apps the browser suite runs
// (examples/*, frameworks/frameworks.spec.ts) cannot drift apart. No browser, no network:
//   - every file the guides show in full is byte-for-byte the example's file (only its SPDX line is left out), and
//     the plain-HTML snippet is the one in the example pages;
//   - every script tag in the guides and the examples carries the tracker build's SRI hash for its version/profile;
//   - the versions a guide says it was tested with are the example's exact pins, and every example dependency is
//     pinned exactly (the tracker comes from this repository's build);
//   - the examples are their own pnpm workspace with the root's supply-chain settings, outside the product's
//     workspace (licence exception for examples only: nothing in them is shipped).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/env.ts";
import { type CodeBlock, parseBlocks } from "./extract.ts";
import { APPS, EXAMPLES } from "./frameworks/apps.ts";

const ONBOARDING = join(REPO_ROOT, "docs/onboarding");
const guide = (name: string): string => readFileSync(join(ONBOARDING, name), "utf8");
const blocks = (name: string): CodeBlock[] => parseBlocks(name, guide(name));
const example = (path: string): string => readFileSync(join(EXAMPLES, path), "utf8");

/** An example file as a guide shows it: without the leading SPDX line. */
const shown = (path: string): string => {
  const lines = example(path).split("\n");
  if (lines[0]?.includes("SPDX-License-Identifier")) lines.shift();
  return lines.join("\n").replace(/\n*$/, "\n");
};

/** The files each guide shows in full. */
const SHOWN: Record<string, string[]> = {
  "web-nextjs.md": [
    "nextjs/app/analytics.tsx",
    "nextjs/app/layout.tsx",
    "nextjs/app/signup-button.tsx",
    "nextjs-wallets-kit/app/analytics.tsx",
  ],
  "web-react-spa.md": ["vite-react/src/main.tsx"],
  "web-nuxt.md": [
    "nuxt/nuxt.config.ts",
    "nuxt/app/plugins/scf-analytics.client.ts",
    "nuxt/app/pages/index.vue",
  ],
  "web-sveltekit.md": [
    "sveltekit/src/env.ts",
    "sveltekit/src/lib/analytics.ts",
    "sveltekit/src/routes/+layout.svelte",
    "sveltekit/src/routes/+page.svelte",
  ],
  "web-astro.md": ["astro/src/layouts/Base.astro", "astro/src/pages/index.astro"],
  "web-docs-sites.md": [
    "vitepress/docs/.vitepress/config.mts",
    "vitepress/docs/index.md",
    "docusaurus/docusaurus.config.js",
    "docusaurus/src/pages/index.mdx",
  ],
  "web-react-router.md": [
    "react-router/app/analytics.ts",
    "react-router/app/root.tsx",
    "react-router/app/routes/home.tsx",
  ],
  "web-static-site-generators.md": [
    "eleventy/src/_includes/base.njk",
    "eleventy/src/_data/scf.js",
    "eleventy/src/index.njk",
  ],
};

interface Manifest {
  files: { path: string; integrity: string }[];
}
const manifest = (version: string): Manifest =>
  JSON.parse(
    readFileSync(join(REPO_ROOT, "tracker/dist", version, "manifest.json"), "utf8"),
  ) as Manifest;

/** Pairs of (tracker file URL, integrity value) in a text, in order of appearance. */
function scriptPins(text: string): { version: string; file: string; integrity: string }[] {
  const srcs = [...text.matchAll(/\/lib\/(\d+\.\d+\.\d+)\/(standard|strict)\.js/g)];
  const sris = [...text.matchAll(/integrity[=:]\s*"(sha384-[A-Za-z0-9+/=]+)"/g)];
  expect(sris.length, "one integrity value per tracker URL").toBe(srcs.length);
  return srcs.map((m, i) => ({
    version: m[1] as string,
    file: `${m[2]}.js`,
    integrity: sris[i]?.[1] as string,
  }));
}

interface Pkg {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const pkg = (id: string): Pkg => JSON.parse(example(`${id}/package.json`)) as Pkg;
const deps = (id: string): Record<string, string> => ({
  ...pkg(id).dependencies,
  ...pkg(id).devDependencies,
});

const trackerVersion = (
  JSON.parse(readFileSync(join(REPO_ROOT, "tracker/package.json"), "utf8")) as { version: string }
).version;

describe("framework guides show the example apps' code", () => {
  for (const [name, files] of Object.entries(SHOWN))
    for (const f of files)
      it(`${name} shows examples/${f} verbatim`, () => {
        const want = shown(f);
        const got = blocks(name).map((b) => b.code);
        expect(got, `no block of ${name} equals examples/${f}`).toContain(want);
      });

  it("the plain-HTML and site-builder snippets are the example page's tag, line for line", () => {
    const page = example("html/index.html")
      .split("\n")
      .map((l) => l.trim());
    for (const name of ["web-html.md", "web-cms.md"]) {
      const tag = blocks(name).find((b) => b.lang === "html")?.code ?? "";
      const lines = tag
        .trim()
        .split("\n")
        .map((l) => l.trim());
      expect(lines.length, name).toBeGreaterThanOrEqual(6);
      const at = page.indexOf(lines[0] as string);
      expect(page.slice(at, at + lines.length), name).toEqual(lines);
    }
  });

  it("every guide of the browser suite exists and names its example directory", () => {
    for (const app of APPS) {
      expect(existsSync(join(ONBOARDING, app.guide)), app.guide).toBe(true);
      expect(guide(app.guide), `${app.guide} names examples/${app.id}`).toContain(
        `\`examples/${app.id}\``,
      );
    }
    expect(guide("web-cms.md")).toContain("`examples/html`");
  });
});

describe("SRI hashes", () => {
  it("every script tag in the onboarding pages and the example apps carries the build's hash", () => {
    const texts: [string, string][] = readdirSync(ONBOARDING)
      .filter((f) => f.endsWith(".md"))
      .map((f) => [`docs/onboarding/${f}`, guide(f)]);
    for (const f of [
      "html/index.html",
      "html/about/index.html",
      "astro/src/layouts/Base.astro",
      "eleventy/src/_includes/base.njk",
      "vitepress/docs/.vitepress/config.mts",
      "docusaurus/docusaurus.config.js",
    ])
      texts.push([`examples/${f}`, example(f)]);
    let checked = 0;
    for (const [where, text] of texts)
      for (const p of scriptPins(text)) {
        const want = manifest(p.version).files.find((x) => x.path === p.file)?.integrity;
        expect(p.integrity, `${where}: ${p.version}/${p.file}`).toBe(want);
        expect(p.version, `${where}: the current tracker version`).toBe(trackerVersion);
        checked++;
      }
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});

describe("pinned versions", () => {
  /** `name@x.y.z` tokens of the guide's "Tested with" paragraph (and the Wallets Kit version it names). */
  const testedWith = (name: string): [string, string][] => {
    const text = guide(name);
    const at = text.indexOf("**Tested with**");
    const para = at < 0 ? "" : text.slice(at, text.indexOf("\n\n", at));
    const wk = [...text.matchAll(/`(@creit\.tech\/stellar-wallets-kit)@(\d+\.\d+\.\d+)`/g)];
    return [...para.matchAll(/`(@?[a-z0-9][\w./-]*)@(\d+\.\d+\.\d+)`/g), ...wk].map(
      (m) => [m[1] as string, m[2] as string] as [string, string],
    );
  };

  it("the versions a guide was tested with are its example's exact pins", () => {
    const byGuide = new Map<string, string[]>();
    for (const app of APPS) byGuide.set(app.guide, [...(byGuide.get(app.guide) ?? []), app.id]);
    let checked = 0;
    for (const [name, ids] of byGuide) {
      if (name === "web-html.md") continue; // no dependencies
      const pins = testedWith(name);
      expect(pins.length, `${name} states what it was tested with`).toBeGreaterThan(0);
      for (const [dep, version] of pins) {
        const found = ids.map((id) => deps(id)[dep]).filter(Boolean);
        expect(found, `${name}: ${dep}@${version}`).toContain(version);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it("every example dependency is an exact version; the tracker is this repository's build", () => {
    for (const app of APPS) {
      if (app.id === "html") continue;
      for (const [dep, spec] of Object.entries(deps(app.id))) {
        if (dep === "@usagemap/tracker") {
          expect(spec, app.id).toBe("file:../../tracker");
          expect(app.install, app.id).toBe("npm");
          continue;
        }
        expect(spec, `${app.id}: ${dep}`).toMatch(/^\d+\.\d+\.\d+$/);
      }
      expect(Object.keys(deps(app.id)).includes("@usagemap/tracker"), app.id).toBe(
        app.install === "npm",
      );
      expect(pkg(app.id).scripts?.build, `${app.id} has a build script`).toBeTruthy();
      if (app.serve === "ssr") expect(pkg(app.id).scripts?.start, app.id).toBeTruthy();
    }
  });
});

describe("the examples workspace", () => {
  const ws = readFileSync(join(EXAMPLES, "pnpm-workspace.yaml"), "utf8");

  it("has the root's supply-chain settings and its own lockfile", () => {
    const root = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const age = (s: string) => /^minimumReleaseAge:\s*(\d+)/m.exec(s)?.[1];
    expect(age(ws)).toBe(age(root));
    expect(ws).toMatch(/^allowBuilds:\n(?: {2}\S+: false\n)+/m); // every install script denied
    const lock = readFileSync(join(EXAMPLES, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain("'@usagemap/tracker@file:../tracker':");
    for (const app of APPS.filter((a) => a.id !== "html"))
      expect(lock, `lockfile has importer ${app.id}`).toContain(`\n  ${app.id}:\n`);
  });

  it("is not part of the product's workspace or lockfile (examples are never shipped)", () => {
    const root = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const globs = [...root.matchAll(/^\s+-\s+(\S+)$/gm)].map((m) => m[1] as string);
    for (const g of globs) expect(g.startsWith("examples"), g).toBe(false);
    const rootLock = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    expect(rootLock).not.toMatch(/^ {2}examples\//m);
  });
});
