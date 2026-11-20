// SPDX-License-Identifier: Apache-2.0
// The landing page as one static HTML document around the approved design (src/body.html, src/styles.css,
// src/site.js). Stylesheet, script and fonts are files of this site with content-hashed names, the stylesheet and
// script pinned by SRI; the only other origin is UsageMap's own pinned tracker. The Content-Security-Policy allows
// nothing inline (no inline style, script or style attribute) and requires Trusted Types for scripts.
//
// Wording rule C4 (docs/methodology/scf-methodology-1.0.0.md): the page describes a measurement, never an
// endorsement.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANDING_ROOT, ORIGINS } from "./config.ts";
import type { Facts } from "./facts.ts";

export const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Subresource Integrity value (SHA-384) of a file's bytes. */
export const sri = (bytes: string | Buffer): string =>
  `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/** A file the page loads from its own site: published path (from the site root) and SRI value. */
export interface PageAsset {
  path: string;
  integrity: string;
}

export interface PageAssets {
  css: PageAsset;
  js: PageAsset;
  /** fonts to preload (the ones used above the fold) */
  preloadFonts: string[];
}

/** The page body as designed: header, main and footer (no script, no style attribute). */
export const readBody = (): string => readFileSync(join(LANDING_ROOT, "src", "body.html"), "utf8");

export function contentSecurityPolicy(f: Facts, tracked: boolean): string {
  const ingest = f.tracker.hosts;
  return [
    "default-src 'none'",
    `script-src 'self'${tracked ? ` ${ingest[0]}` : ""}`,
    "style-src 'self'",
    "font-src 'self'",
    "img-src data:",
    `connect-src ${tracked ? ingest.join(" ") : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
}

/** The magnet mark of the logo. */
export const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 40 42.5"><rect x="0" y="0" width="10" height="8" rx="1.2" fill="#FFD43B"/><rect x="24" y="0" width="10" height="8" rx="1.2" fill="#FFD43B"/><path d="M5 10v9.5a12 12 0 0 0 24 0V10" fill="none" stroke="#111111" stroke-width="10"/></svg>',
  );

export const TITLE =
  "UsageMap — privacy-first web and API analytics for Stellar ecosystem projects";
export const DESCRIPTION =
  "Private analytics for every Stellar project, one ecosystem-wide view for SCF, and an optional public proof page each project turns on itself. Bots and fake wallets are filtered out, each with a reason.";

export function renderPage(
  f: Facts,
  siteKey: string | undefined,
  assets: PageAssets,
  body: string,
): string {
  const strict = f.tracker.files.strict;
  const tracked = siteKey !== undefined;
  const tracker = tracked
    ? `<script src="${esc(strict.url)}" integrity="${esc(strict.integrity)}" crossorigin="anonymous" data-site="${esc(siteKey)}" defer></script>`
    : "<!-- UsageMap tracker not included: LANDING_SITE_KEY was not set at build time -->";
  const preload = assets.preloadFonts
    .map((p) => `<link rel="preload" href="${esc(p)}" as="font" type="font/woff2" crossorigin>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${esc(contentSecurityPolicy(f, tracked))}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<title>${esc(TITLE)}</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<link rel="canonical" href="${ORIGINS.landing}/">
<link rel="icon" href="${esc(FAVICON)}">
${preload}
<link rel="stylesheet" href="${esc(assets.css.path)}" integrity="${esc(assets.css.integrity)}">
<script src="${esc(assets.js.path)}" integrity="${esc(assets.js.integrity)}" defer></script>
${tracker}
</head>
<body>
${body.trim()}
</body>
</html>
`;
}
