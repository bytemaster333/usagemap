# React Router framework mode and Remix: the first 10 minutes

For a server-rendered app on React Router's framework mode — the successor of Remix: a Remix app upgrades to it —
and for Remix apps generally. The tracker is an npm package with no dependencies; the root route starts it once.

| Minute | Step |
|---|---|
| 0–2 | Add a website: production domain, `localhost` as a dev origin |
| 2–4 | Install the package and start it in `app/root.tsx` |
| 4–6 | `pnpm dev`: watch the first events arrive as `dev` |
| 6–7 | Register your footprint |
| 7–10 | Deploy, verify the domain, see the first *verified* page view |

**Tested with** `react-router@8.5.1`, `@react-router/dev@8.5.1`, `@react-router/serve@8.5.1`, `react@19.3.1`
(production build, server rendering on every request). The code below is the example app in the repository
(`examples/react-router`); the repository's browser tests build it and check in a real browser that the
server-rendered landing page, each client-side navigation, the back button and a custom event are each counted
exactly once, and that a deep link with a query string is counted once, as its path.

## 1. Add the website

Portal: **Add a website** → production domain; site settings → **Dev origins** → `localhost`
([dev origins](dev-origins-and-debug.md)). Dev-origin events are shown to you but never counted.

## 2. Install and start the tracker

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

> **Not yet on npm (2026-11-19):** the package is published to the npm registry together with the public
> repository; until then use the plain script tag of [plain HTML](web-html.md), which the live ingest hosts serve.

The site key (portal: site → **Snippet**) is fixed at build time
(`VITE_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm build`):

```ts
// app/analytics.ts
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"

// your site key (portal: site → Snippet), set at build time: VITE_SCF_SITE=… pnpm build
const SITE = import.meta.env.VITE_SCF_SITE ?? "";

/** Starts the tracker in the browser, or returns the running one; undefined during server rendering. */
export const analytics = () => init({ site: SITE });
```

```tsx
// app/root.tsx
import { type ReactNode, useEffect } from "react";
import { Link, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { analytics } from "./analytics";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <nav>
          <Link to="/">Home</Link> <Link to="/about">About</Link>
        </nav>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // once, after hydration; client-side navigations are followed through the History API
  useEffect(() => void analytics(), []);
  return <Outlet />;
}
```

- `useEffect` runs only in the browser, after hydration; hydration itself adds no page view. Navigations through
  `<Link>`, `useNavigate` and form submissions that change the path are followed through the History API.
- A rewrite of the current history entry that keeps the path (routers do this to store scroll positions) is not
  counted.
- Remix v2 has the same `app/root.tsx` shape (imports from `@remix-run/react`); the tracker code is the same (Remix v2
  is not covered by the tests here).

## 3. Custom events

```tsx
// app/routes/home.tsx — a custom event
import { analytics } from "../analytics";

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <button type="button" onClick={() => analytics()?.track("signup", { plan: "free" })}>
        Sign up
      </button>
    </main>
  );
}
```

## 4. Run it locally

```sh
VITE_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm dev
```

The portal's first-event panel (site → **Installation**) lists the events from `localhost` as `dev`. Debug mode:
[dev origins and debug mode](dev-origins-and-debug.md).

## 5. Footprint, deploy, verify

1. Portal → **Footprint**: add your contracts or tick "no on-chain footprint" ([footprint](footprint.md)).
2. Build with `VITE_SCF_SITE` set, deploy, verify the domain (site → **Domains**).
3. Open the production site in a browser without GPC or an ad blocker; the Installation page shows the first
   `verified` page view within about a minute.

**Content Security Policy**:
`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

Wallets: attach an adapter next to `init()` in `app/analytics.ts` ([wallet adapters](wallets.md)).
