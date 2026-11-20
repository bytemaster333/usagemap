// SPDX-License-Identifier: Apache-2.0
// Builds the landing page into apps/landing/dist (or LANDING_OUT):
//
//   node build.ts [--release]
//
//   dist/index.html                the page (src/body.html in a shell with its CSP; src/page.ts)
//   dist/assets/site.<hash>.css    src/styles.css, minified, font URLs rewritten; pinned by SRI in the page
//   dist/assets/site.<hash>.js     src/site.js; pinned by SRI in the page
//   dist/assets/fonts/*.<hash>.woff2  Manrope, Geist, Geist Mono (latin, OFL-1.1; assets/fonts/README.md)
//   dist/facts.json                the tracker facts the page pins, for the deployment's live check (check-live.ts)
//   dist/robots.txt
//   dist/llms.txt                  points models at the documentation (docs.usagemap.dev, apps/docs)
//   dist/.well-known/stellar.toml  the SEP-1 file (content/stellar.toml), checked by src/sep1.ts
//
// Asset names carry a hash of their content, so they can be cached forever; index.html is served with no-cache.
// The documentation is its own site (apps/docs, docs.usagemap.dev; C-152): this build publishes no docs pages.
//
// Fails when the tracker manifest is missing or does not match the files it describes, when the page or its assets
// exceed their size budgets, and when the publication guard finds something that must not be published
// (src/guard.ts). `--release` also requires LANDING_SITE_KEY and a tracker built for e1/e2.usagemap.dev.
//
// Size budgets (bytes as served, before compression): index.html + robots.txt + facts.json PAGE_BUDGET_BYTES (the
// page carries its icon sprite and the integrations directory inline); stylesheet + script + fonts
// ASSET_BUDGET_BYTES; stellar.toml SEP-1's own 100 KB (checked by src/sep1.ts).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configFromEnv, LANDING_ROOT, type LandingConfig, ORIGINS } from "./src/config.ts";
import { checkReleaseHosts, type Facts, loadFacts, trackerPackageVersion } from "./src/facts.ts";
import { guardFindings, textFindings } from "./src/guard.ts";
import { type PageAssets, readBody, renderPage, sri } from "./src/page.ts";
import { checkStellarToml } from "./src/sep1.ts";

/** index.html + robots.txt + facts.json. */
export const PAGE_BUDGET_BYTES = 176 * 1024;
/** stylesheet + script + fonts. */
export const ASSET_BUDGET_BYTES = 192 * 1024;

/** The SEP-1 file of usagemap.dev, served at /.well-known/stellar.toml. */
export const STELLAR_TOML_FILE = "apps/landing/content/stellar.toml";

/** Fonts preloaded by the page (used above the fold). */
const PRELOAD_FONTS = ["manrope-latin.woff2", "geist-latin.woff2"];

export interface BuildResult {
  facts: Facts;
  html: string;
  css: string;
  js: string;
  outDir: string;
  /** index.html + robots.txt + facts.json */
  bytes: number;
  /** stylesheet + script + fonts */
  assetBytes: number;
  /** every file written, path relative to the output directory */
  files: Array<[string, string | Buffer]>;
}

/** `name.ext` → `name.<12 hex of sha256>.ext` */
export function hashedName(name: string, bytes: string | Buffer): string {
  const h = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot)}.${h}${name.slice(dot)}`;
}

/** The stylesheet as served: comments, line breaks and indentation removed. */
export function readCss(): string {
  return readFileSync(join(LANDING_ROOT, "src", "styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\n\s*/g, "")
    .trim();
}

export const readJs = (): string => readFileSync(join(LANDING_ROOT, "src", "site.js"), "utf8");

/** The font files of assets/fonts, each with its hashed name. */
export function readFonts(): Array<{ name: string; hashed: string; bytes: Buffer }> {
  const dir = join(LANDING_ROOT, "assets", "fonts");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".woff2"))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(dir, name));
      return { name, hashed: hashedName(name, bytes), bytes };
    });
}

/** llms.txt of the apex: the documentation lives on its own host. */
export const llmsTxt = (): string =>
  `# UsageMap

> Privacy-first web and API analytics for Stellar ecosystem projects.

- [Documentation index for language models](${ORIGINS.docs}/llms.txt)
- [All documentation in one file](${ORIGINS.docs}/llms-full.txt)
- [Agent skill (SKILL.md)](${ORIGINS.docs}/SKILL.md)
`;

export function build(cfg: LandingConfig): BuildResult {
  const facts = loadFacts(cfg.trackerDist, cfg.trackerVersion);
  if (cfg.release) checkReleaseHosts(facts);
  const fonts = readFonts();
  let css = readCss();
  for (const f of fonts)
    css = css.replaceAll(`url("fonts/${f.name}")`, `url("/assets/fonts/${f.hashed}")`);
  const unresolved = /url\("fonts\/[^"]*"\)/.exec(css);
  if (unresolved) throw new Error(`styles.css refers to a missing font: ${unresolved[0]}`);
  const js = readJs();
  const cssFile = `assets/${hashedName("site.css", css)}`;
  const jsFile = `assets/${hashedName("site.js", js)}`;
  const assets: PageAssets = {
    css: { path: `/${cssFile}`, integrity: sri(css) },
    js: { path: `/${jsFile}`, integrity: sri(js) },
    preloadFonts: PRELOAD_FONTS.map((n) => {
      const f = fonts.find((x) => x.name === n);
      if (!f) throw new Error(`missing font ${n}`);
      return `/assets/fonts/${f.hashed}`;
    }),
  };
  const html = renderPage(facts, cfg.siteKey, assets, readBody());
  const robots = "User-agent: *\nAllow: /\n";
  const factsJson = `${JSON.stringify(
    {
      tracker: {
        version: facts.tracker.version,
        hosts: facts.tracker.hosts,
        files: facts.tracker.files,
      },
      umami: facts.umami,
      dogfood: cfg.siteKey !== undefined,
      release: cfg.release,
    },
    null,
    2,
  )}\n`;
  const bytes = [html, robots, factsJson].reduce((a, s) => a + Buffer.byteLength(s), 0);
  if (bytes > PAGE_BUDGET_BYTES) {
    throw new Error(`landing page is ${bytes} bytes, over its ${PAGE_BUDGET_BYTES}-byte budget`);
  }
  const assetBytes =
    Buffer.byteLength(css) + Buffer.byteLength(js) + fonts.reduce((a, f) => a + f.bytes.length, 0);
  if (assetBytes > ASSET_BUDGET_BYTES) {
    throw new Error(
      `landing assets are ${assetBytes} bytes, over their ${ASSET_BUDGET_BYTES}-byte budget`,
    );
  }
  const problems: string[] = guardFindings("/", html);
  problems.push(...textFindings(`/${cssFile}`, css), ...textFindings(`/${jsFile}`, js));
  const llms = llmsTxt();
  problems.push(...textFindings("/llms.txt", llms));
  const files: Array<[string, string | Buffer]> = [
    ["index.html", html],
    [cssFile, css],
    [jsFile, js],
    ...fonts.map((f): [string, Buffer] => [`assets/fonts/${f.hashed}`, f.bytes]),
    ["facts.json", factsJson],
    ["robots.txt", robots],
    ["llms.txt", llms],
  ];
  const tomlPath = join(cfg.repoRoot, STELLAR_TOML_FILE);
  try {
    const toml = readFileSync(tomlPath, "utf8");
    const r = checkStellarToml(toml, new URL(ORIGINS.landing).host);
    if (r.problems.length)
      problems.push(`${STELLAR_TOML_FILE} is not a valid SEP-1 file: ${r.problems.join("; ")}`);
    problems.push(...textFindings("/.well-known/stellar.toml", toml));
    files.push([".well-known/stellar.toml", toml]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (problems.length) throw new Error(problems.join("\n  "));
  rmSync(cfg.outDir, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const f = join(cfg.outDir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return { facts, html, css, js, outDir: cfg.outDir, bytes, assetBytes, files };
}

if (import.meta.main) {
  try {
    const release = process.argv.includes("--release");
    const cfg = configFromEnv(process.env, {
      release,
      defaultTrackerVersion: trackerPackageVersion(),
    });
    const r = build(cfg);
    const t = r.facts.tracker;
    console.log(
      `landing: ${r.outDir} (page ${r.bytes} B of ${PAGE_BUDGET_BYTES}, assets ${r.assetBytes} B of ${ASSET_BUDGET_BYTES}); ${r.files.length} files; tracker ${t.version} from ${t.hosts[0]}; ` +
        (cfg.siteKey ? "measured by its own tracker" : "no tracker (LANDING_SITE_KEY unset)") +
        (release ? "; release" : ""),
    );
    if (!release && t.hosts[0] !== "https://e1.usagemap.dev") {
      console.warn(
        `landing: note — the tracker build uses ${t.hosts.join(", ")}, not the production hosts; use --release for usagemap.dev`,
      );
    }
  } catch (e) {
    console.error(`landing build failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
