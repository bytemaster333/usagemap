// SPDX-License-Identifier: Apache-2.0
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
