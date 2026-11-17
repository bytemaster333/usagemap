// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { METHODOLOGY_CSS, METHODOLOGY_CSS_PATH, methodologyPages } from "./scripts/methodology.ts";

/**
 * Adds Subresource Integrity (sha384) to every script and stylesheet the built index.html references, so a tampered
 * asset on the server is refused by the browser (supply-chain hardening; `Integrity-Policy` once supported).
 */
function subresourceIntegrity(): Plugin {
  return {
    name: "scf-sri",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (html?.type !== "asset" || typeof html.source !== "string") return;
      const digest = (file: string): string => {
        const item = bundle[file];
        if (!item) throw new Error(`SRI: ${file} is not in the bundle`);
        const bytes = item.type === "chunk" ? item.code : item.source;
        return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
      };
      html.source = html.source.replace(
        /<(script|link)\b([^>]*?)\b(src|href)="\/([^"]+)"([^>]*)>/g,
        (tag, el: string, before: string, attr: string, file: string, after: string) => {
          if (!file.startsWith("assets/") || tag.includes("integrity=")) return tag;
          return `<${el}${before}${attr}="/${file}" integrity="${digest(file)}"${after}>`;
        },
      );
    },
  };
}

/**
 * Renders the published measurement methodology (docs/methodology/scf-methodology-<semver>.md) into static, read-only
 * pages at /docs/methodology/<semver> (the URL signed into v2 traction snapshots; plan C1 #6, feature.signed-snapshot-v2).
 */
function methodologyPlugin(dir: string): Plugin {
  return {
    name: "scf-methodology",
    apply: "build",
    generateBundle() {
      const sri = `sha384-${createHash("sha384").update(METHODOLOGY_CSS).digest("base64")}`;
      this.emitFile({ type: "asset", fileName: METHODOLOGY_CSS_PATH, source: METHODOLOGY_CSS });
      const pages = methodologyPages(dir, sri);
      if (pages.length === 0) throw new Error(`no methodology document in ${dir}`);
      for (const p of pages) this.emitFile({ type: "asset", fileName: p.fileName, source: p.html });
    },
  };
}

export default defineConfig({
  // JSX through Vite's own transformer; no React Fast Refresh is needed for this app.
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  plugins: [
    subresourceIntegrity(),
    methodologyPlugin(join(import.meta.dirname, "..", "..", "docs", "methodology")),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2023",
    // The polyfill would add code we do not need (every supported browser has modulepreload).
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rolldownOptions: {
      // React Server Components directives ("use client") are meaningless in a client-only bundle.
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
