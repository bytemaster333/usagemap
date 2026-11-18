# Web: Vue (Vue Router)

**Status (docs.quickstarts-run): checked against the code and the tracker's end-to-end fixtures.** Checked against the Vue Router fixture `tracker/e2e/apps/vue-spa/` and
`tracker/e2e/fixtures.spec.ts`: script tag with SRI in `<head>`, the app as a separate module, `createWebHistory()`.
Vue Router calls `history.replaceState` for the same URL when it starts; that is not counted.

## 1. Script tag in `index.html` (the tested pattern)

```html
<!doctype html>
<html>
  <head>
    <script>window.scf = window.scf || [];</script>
    <script
      src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
      integrity="sha384-…from the portal snippet…"
      crossorigin="anonymous"
      data-site="YOUR_22_CHAR_SITE_KEY"
      defer
    ></script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Use `createWebHistory()` in your router: History-API navigations that change the path are page views. Hash mode
(`createWebHashHistory()`) changes only the fragment and is **not** counted.

## 2. Custom events from components

```ts
const scf = (window as unknown as { scf?: { track?: (n: string, p?: Record<string, string | number | boolean>) => boolean } | unknown[] }).scf;
function trackCopy() {
  if (Array.isArray(scf)) scf.push(["track", "copy_snippet"]); // tracker not started yet: queued, replayed in order
  else scf?.track?.("copy_snippet");
}
```

The fixture queues `["track", "app_boot", { mode: "spa" }]` before the tag and calls
`window.scf.track("copy_snippet")` from a click handler; both arrive.

## 3. Alternative: the npm package

`import { init } from "@usagemap/tracker"` and call `init({ site: "…" })` once in `main.ts` before
`app.mount()`. This is the same `init()` that the React fixtures cover; it has not been run in a Vue fixture.

## 4. Content Security Policy

`script-src https://ingest-a.example-analytics.org` (or a nonce) and `connect-src
https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.
