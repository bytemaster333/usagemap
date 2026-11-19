// SPDX-License-Identifier: Apache-2.0
// tracker.ssr-frameworks framework quickstarts: the example apps under examples/ (their own pnpm workspace and lockfile, licence
// exception for examples only, never shipped) and how each one is built and served. Every app has the same two
// routes — Home (`/`, with a "Sign up" button that sends the custom event `signup {plan: "free"}`) and About — and a
// nav with the links "Home" and "About", so one browser scenario covers them all.
//
// The site key reaches each app the way its guide says: a build-time public variable of the framework, a runtime
// variable (Nuxt), or — for plain HTML — pasted into the file (the harness serves the file with the placeholder
// replaced, as the tenant would paste it).

import { join } from "node:path";
import { REPO_ROOT } from "../../lib/env.ts";

export const EXAMPLES = join(REPO_ROOT, "examples");

export interface App {
  /** directory under examples/ */
  id: string;
  /** the tenant guide in docs/onboarding that this app proves */
  guide: string;
  /** how the tracker is installed */
  install: "script-tag" | "npm";
  /** "static": files served as they are; "spa": static files with a fallback to index.html; "ssr": `pnpm run start` */
  serve: "static" | "spa" | "ssr";
  /** output directory served by the harness (static, spa) */
  out?: string;
  /** environment variable that carries the site key */
  siteEnv?: string;
  /** when the app reads it: at build time (default; also set at run time, harmlessly) or only at run time */
  siteAt?: "build" | "run";
  /** whether the in-app links navigate client-side (History API) instead of loading a new document */
  clientNav: boolean;
  /** the About route's path as the app links it */
  about: string;
  /** arguments after `pnpm run start` */
  startArgs?: string[];
}

export const APPS: App[] = [
  {
    id: "html",
    guide: "web-html.md",
    install: "script-tag",
    serve: "static",
    out: ".",
    clientNav: false,
    about: "/about/",
  },
  {
    id: "eleventy",
    guide: "web-static-site-generators.md",
    install: "script-tag",
    serve: "static",
    out: "_site",
    siteEnv: "SCF_SITE",
    clientNav: false,
    about: "/about/",
  },
  {
    id: "astro",
    guide: "web-astro.md",
    install: "script-tag",
    serve: "static",
    out: "dist",
    siteEnv: "PUBLIC_SCF_SITE",
    clientNav: true, // <ClientRouter /> (view transitions)
    about: "/about/",
  },
  {
    id: "vitepress",
    guide: "web-docs-sites.md",
    install: "script-tag",
    serve: "static",
    out: "docs/.vitepress/dist",
    siteEnv: "SCF_SITE",
    clientNav: true, // VitePress router
    about: "/about.html",
  },
  {
    id: "docusaurus",
    guide: "web-docs-sites.md",
    install: "script-tag",
    serve: "static",
    out: "build",
    siteEnv: "SCF_SITE",
    clientNav: true, // React Router inside Docusaurus
    about: "/about",
  },
  {
    id: "vite-react",
    guide: "web-react-spa.md",
    install: "npm",
    serve: "spa",
    out: "dist",
    siteEnv: "VITE_SCF_SITE",
    clientNav: true,
    about: "/about",
  },
  {
    id: "nextjs",
    guide: "web-nextjs.md",
    install: "npm",
    serve: "ssr",
    siteEnv: "NEXT_PUBLIC_SCF_SITE",
    clientNav: true,
    about: "/about",
    startArgs: ["--hostname", "127.0.0.1"],
  },
  {
    id: "nuxt",
    guide: "web-nuxt.md",
    install: "npm",
    serve: "ssr",
    siteEnv: "NUXT_PUBLIC_SCF_SITE",
    siteAt: "run", // runtimeConfig: the build has no key, the server gets it from its environment
    clientNav: true,
    about: "/about",
  },
  {
    id: "sveltekit",
    guide: "web-sveltekit.md",
    install: "npm",
    serve: "ssr",
    siteEnv: "PUBLIC_SCF_SITE",
    clientNav: true,
    about: "/about",
  },
  {
    id: "react-router",
    guide: "web-react-router.md",
    install: "npm",
    serve: "ssr",
    siteEnv: "VITE_SCF_SITE",
    clientNav: true,
    about: "/about",
  },
  {
    id: "nextjs-wallets-kit",
    guide: "web-nextjs.md",
    install: "npm",
    serve: "ssr",
    siteEnv: "NEXT_PUBLIC_SCF_SITE",
    clientNav: true,
    about: "/about",
    startArgs: ["--hostname", "127.0.0.1"],
  },
];

/** QS_FRAMEWORKS=nextjs,nuxt limits a run to some apps (default: all). */
export function selectedApps(): App[] {
  const only = (process.env.QS_FRAMEWORKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of only)
    if (!APPS.some((a) => a.id === id)) throw new Error(`QS_FRAMEWORKS: no example app "${id}"`);
  return only.length ? APPS.filter((a) => only.includes(a.id)) : APPS;
}

/** Environment for building (`phase` "build") or starting an app: its site-key variable, telemetry off. */
export function appEnv(app: App, site: string, phase: "build" | "run"): NodeJS.ProcessEnv {
  const withSite = app.siteEnv && !(phase === "build" && app.siteAt === "run");
  return {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NUXT_TELEMETRY_DISABLED: "1",
    ASTRO_TELEMETRY_DISABLED: "1",
    ...(withSite ? { [app.siteEnv as string]: site } : {}),
  };
}
