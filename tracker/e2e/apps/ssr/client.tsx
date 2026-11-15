// SPDX-License-Identifier: Apache-2.0
// Client side of the SSR fixture: hydrates the server-rendered markup. createBrowserRouter picks up the loader data
// the server embedded (window.__staticRouterHydrationData), so hydration renders exactly the server's markup.

import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { routes } from "./routes.tsx";

const router = createBrowserRouter(routes);

hydrateRoot(
  document.getElementById("root") as HTMLElement,
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
