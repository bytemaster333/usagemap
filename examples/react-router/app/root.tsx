// SPDX-License-Identifier: Apache-2.0
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
