// SPDX-License-Identifier: Apache-2.0
// Builds the Playwright fixture apps into e2e/.build/ (git-ignored) with esbuild. Runs as Playwright's global setup
// after the tracker itself has been built (`test:e2e` builds it first), because the apps bundle the tracker's npm
// entry from dist/npm/ exactly as a tenant's bundler would. The fixture frameworks (React, React Router, Vue, Vue
// Router) are dev dependencies of this package and only ever end up in these fixture bundles — never in dist/.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { ROOT } from "../../scripts/build-config.ts";

export const APPS = join(ROOT, "e2e", "apps");
export const OUT = join(ROOT, "e2e", ".build");

/**
 * `@usagemap/tracker[/<entry>]` → the built npm entry in dist/npm/ (standard.js for the bare name), as
 * installed from the registry.
 */
const trackerPackage: Plugin = {
  name: "scf-tracker-package",
  setup(b) {
    b.onResolve(
      { filter: /^@usagemap\/tracker(\/(strict|wallets-kit|wallets|passkey|debug))?$/ },
      (args) => ({
        path: join(ROOT, "dist", "npm", `${args.path.split("/")[2] ?? "standard"}.js`),
      }),
    );
  },
};

const common = {
  bundle: true,
  logLevel: "warning" as const,
  legalComments: "none" as const,
  plugins: [trackerPackage],
  jsx: "automatic" as const,
};

export default async function buildFixtures(): Promise<void> {
  if (!existsSync(join(ROOT, "dist", "npm", "standard.js"))) {
    throw new Error("tracker not built: run `node scripts/build.ts` first (test:e2e does)");
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // Static HTML: copied as is; the script tag is inserted when served (its SRI hash comes from the manifest).
  cpSync(join(APPS, "static"), join(OUT, "static"), { recursive: true });

  // React Router SPA, React development build so <StrictMode> double-invokes effects (init() twice).
  cpSync(join(APPS, "react-spa", "index.html"), join(OUT, "react-spa", "index.html"));
  await build({
    ...common,
    entryPoints: [join(APPS, "react-spa", "main.tsx")],
    outfile: join(OUT, "react-spa", "main.js"),
    format: "esm",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });

  // Vue Router SPA, production build.
  cpSync(join(APPS, "vue-spa", "index.html"), join(OUT, "vue-spa", "index.html"));
  await build({
    ...common,
    entryPoints: [join(APPS, "vue-spa", "main.ts")],
    outfile: join(OUT, "vue-spa", "main.js"),
    format: "esm",
    platform: "browser",
    minify: true,
    define: {
      "process.env.NODE_ENV": '"production"',
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
  });

  // Wallet dApp (Stellar adapters, plan B2): the same app built against each profile's npm entry.
  for (const profile of ["standard", "strict"] as const) {
    const dir = join(OUT, `wallet-dapp-${profile}`);
    cpSync(join(APPS, "wallet-dapp", "index.html"), join(dir, "index.html"));
    await build({
      ...common,
      entryPoints: [join(APPS, "wallet-dapp", "main.ts")],
      outfile: join(dir, "main.js"),
      format: "esm",
      platform: "browser",
      define: { __PROFILE__: JSON.stringify(profile) },
    });
  }

  // SSR: a Node bundle that renders HTML per request, and the browser bundle that hydrates it (production React).
  await build({
    ...common,
    entryPoints: [join(APPS, "ssr", "server.tsx")],
    outfile: join(OUT, "ssr", "server.cjs"),
    format: "cjs",
    platform: "node",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await build({
    ...common,
    entryPoints: [join(APPS, "ssr", "client.tsx")],
    outfile: join(OUT, "ssr", "public", "client.js"),
    format: "esm",
    platform: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
}

if (import.meta.main) await buildFixtures();
