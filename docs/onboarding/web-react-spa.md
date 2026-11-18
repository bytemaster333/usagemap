# React single-page app: the first 10 minutes

For a Vite + React app (including the Scaffold Stellar React template) or any SPA whose router uses the History API.

| Minute | Step |
|---|---|
| 0–2 | Add a website: production domain, `localhost` as a dev origin |
| 2–4 | Install the package and start the tracker in the root layout |
| 4–6 | `pnpm dev` with debug mode: watch the first events arrive as `dev` |
| 6–7 | Register your footprint |
| 7–10 | Deploy, verify the domain, see the first *verified* page view |

**Tested with** `vite@8.3.8`, `react@19.3.1`, `react-router@8.5.1` (production build). The code below is the complete
example app in the repository (`examples/vite-react`); the repository's browser tests build it and check in a real
browser that the landing page, each client-side navigation, the back button and a custom event are each counted
exactly once, and that a deep link with a query string is counted once, as its path.

## 1. Add the website

Portal: **Add a website** → production domain; site settings → **Dev origins** → `localhost` (any port, `http` or
`https`). Add your preview host pattern too if you deploy previews ([dev origins](dev-origins-and-debug.md)).

## 2. Install and start the tracker

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

> **Not yet on npm (2026-11-19):** the package is published to the npm registry together with the public
> repository; until then use the plain script tag of [plain HTML](web-html.md), which the live ingest hosts serve.

Set your site key (portal: site → **Snippet**) as `VITE_SCF_SITE` when you build
(`VITE_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm build`, or in your host's build settings). The key is public; a variable
lets staging and production report to different sites.

```tsx
// src/main.tsx
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";

// your site key (portal: site → Snippet), set at build time: VITE_SCF_SITE=… pnpm build
const SITE = import.meta.env.VITE_SCF_SITE ?? "";

function Layout() {
  useEffect(() => {
    const start = () => init({ site: SITE });
    if (!import.meta.env.DEV) return void start();
    // development: the debug module explains why something was (not) sent; start it before the tracker
    void import("@usagemap/tracker/debug").then(({ debug }) => debug()).finally(start);
  }, []);
  return (
    <>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link>
      </nav>
      <Outlet />
    </>
  );
}

function Home() {
  // init() returns the running tracker, so any component can send a custom event
  const signUp = () => init({ site: SITE })?.track("signup", { plan: "free" });
  return (
    <main>
      <h1>Home</h1>
      <button type="button" onClick={signUp}>
        Sign up
      </button>
    </main>
  );
}

const About = () => <h1>About</h1>;

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: "about", element: <About /> },
    ],
  },
]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- `init()` returns the running tracker, which is how the "Sign up" button sends its custom event.
- StrictMode runs the effect twice in development; the second `init()` returns the running tracker, so nothing is
  counted twice.
- Every router that uses `pushState`/`replaceState`/`popstate` is followed. Hash routers change only the fragment and
  are **not** counted as navigations; query-only changes are not counted either (the query string is never read).
- The debug module needs tracker 1.1.0 or later; with 1.0.0, call `init()` directly.

## 3. Run it locally

```sh
pnpm dev
```

The console explains each send (or why nothing was sent); the portal's first-event panel shows the `localhost`
events as `dev`, never counted.

## 4. Wallets

Scaffold Stellar apps and most Stellar dApps use Stellar Wallets Kit. Attach the adapter once, next to `init()`:

```tsx
// src/analytics.ts — imported once from src/main.tsx (tracker 1.1.0 or later)
import { init } from "@usagemap/tracker";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";

init({ site: "YOUR_22_CHAR_SITE_KEY" });
attachWalletsKit(StellarWalletsKit);
```

Freighter called directly, passkey wallets and smart accounts: [wallet adapters](wallets.md).

## 5. Footprint, deploy, verify

1. Portal → **Footprint**: add your contracts or tick "no on-chain footprint" ([footprint](footprint.md)).
2. Deploy; verify the domain (site → **Domains**).
3. Open the production site in a browser without GPC or an ad blocker; the Installation page shows the first
   `verified` page view within about a minute.

**Content Security Policy**:
`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`. No `worker-src`,
`blob:` or `'unsafe-eval'` is needed.

## Next

- Custom events: `const scf = init({ site: "YOUR_22_CHAR_SITE_KEY" }); scf?.track("swap_started", { pair: "xlm_usdc"
  });`
- Nothing arrives: [troubleshooting](troubleshooting.md).
