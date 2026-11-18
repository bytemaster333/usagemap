# Web: Vite + React single-page app

**Status (docs.quickstarts-run, tracker.ssr-frameworks): run as a real Vite app.** The tenant guide
[`docs/onboarding/web-react-spa.md`](../../onboarding/web-react-spa.md) shows the complete example app
`examples/vite-react` (Vite 8.3.8, React 19.3.1, React Router 8.5.1), which the framework browser suite
(`tests/quickstarts/frameworks/frameworks.spec.ts`) builds and drives in Chromium (one page view per load and per
client-side navigation, back button, custom event, deep link). The tracker's own fixtures cover the edge cases
(`tracker/e2e/fixtures.spec.ts`: `replace`, query-only and fragment-only changes, `init()` twice under StrictMode).
The portal's `vite` snippet is the same as its `npm` snippet.

## 1. Install

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

## 2. Start the tracker in the root layout's effect

```tsx
// src/main.tsx
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";

function Layout() {
  useEffect(() => {
    init({ site: "YOUR_22_CHAR_SITE_KEY" });
  }, []);
  return <Outlet />;
}

const router = createBrowserRouter([{ path: "/", element: <Layout />, children: [/* your routes */] }]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

This is the fixture's pattern. StrictMode runs the effect twice in development; the second `init()` returns the
running tracker. Any router that uses the History API (`pushState`, `replaceState`, `popstate`) is followed; hash-based
routers change only the fragment and are **not** counted as navigations.

## 3. Custom events

```ts
import { init } from "@usagemap/tracker";
const scf = init({ site: "YOUR_22_CHAR_SITE_KEY" }); // returns the running instance if already started
scf?.track("checkout_started", { step: 1 });
```

## 4. Content Security Policy

`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`. No `worker-src` or
`blob:` is needed.
