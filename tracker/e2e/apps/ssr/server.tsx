// SPDX-License-Identifier: Apache-2.0
// Server side of the SSR fixture: renders the route for a request URL to HTML with React Router's static handler
// and react-dom/server, embeds the hydration data, and (optionally) the tracker's script tag in <head> — the way a
// framework's <Script> or a layout <script> tag puts it there. Bundled for Node by e2e/apps/build.ts.

import { init } from "@usagemap/tracker";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { routes } from "./routes.tsx";

/** init() during server-side rendering: must be a no-op returning undefined (README "npm"). */
export const serverInit = (site: string): unknown => init({ site });

export interface RenderOptions {
  site: string;
  /** The tracker's `<script>` tag, or "" for the npm-only variant. */
  trackerTag: string;
}

export async function render(
  url: string,
  opts: RenderOptions,
): Promise<{ status: number; html: string; location?: string }> {
  const handler = createStaticHandler(routes);
  const ctx = await handler.query(new Request(url));
  if (ctx instanceof Response) {
    return { status: ctx.status, html: "", location: ctx.headers.get("location") ?? "/" };
  }
  const router = createStaticRouter(handler.dataRoutes, ctx);
  const app = renderToString(
    <StrictMode>
      <StaticRouterProvider router={router} context={ctx} />
    </StrictMode>,
  );
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Fixture title — SSR (never sent)</title>
<script>window.fixture = { trackers: [], hydrated: false };</script>
${opts.trackerTag}
</head><body><div id="root" data-site="${opts.site}">${app}</div>
<script type="module" src="/client.js"></script></body></html>`;
  return { status: ctx.statusCode, html };
}
