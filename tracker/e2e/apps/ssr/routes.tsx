// SPDX-License-Identifier: Apache-2.0
// Routes shared by the server render and the client hydration of the SSR fixture (React Router data router: route
// loaders run on the server for the first request and in the browser for client-side navigations).

import { init } from "@usagemap/tracker";
import { useEffect } from "react";
import { Link, Outlet, type RouteObject, useLoaderData } from "react-router";

/** The site key is rendered by the server into `#root[data-site]`; read it only in the browser. */
const siteKey = (): string => document.getElementById("root")?.dataset.site ?? "";

function Layout() {
  // Root-layout effect: runs only in the browser, after hydration (README "npm"). On pages that also carry the
  // script tag, init() returns the instance the tag created, so the page view is not counted twice.
  useEffect(() => {
    window.fixture.trackers.push(init({ site: siteKey() }));
    window.fixture.hydrated = true;
  }, []);
  return (
    <>
      <nav>
        <Link id="nav-home" to="/">
          Home
        </Link>
        <Link id="nav-hello" to="/articles/hello">
          Hello
        </Link>
        <Link id="nav-world" to="/articles/world">
          World
        </Link>
      </nav>
      <Outlet />
    </>
  );
}

function Home() {
  return <h1>Home</h1>;
}

interface ArticleData {
  slug: string;
  words: number;
}

function Article() {
  const a = useLoaderData() as ArticleData;
  return (
    <article>
      <h1 id="article-title">Article {a.slug}</h1>
      <p>{a.words} words</p>
      <a id="to-comments" href="#comments">
        Comments (fragment only)
      </a>
      <section id="comments">Comments</section>
    </article>
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Home },
      {
        path: "articles/:slug",
        loader: ({ params }): ArticleData => ({
          slug: params.slug ?? "",
          words: (params.slug ?? "").length * 100,
        }),
        Component: Article,
      },
    ],
  },
];
