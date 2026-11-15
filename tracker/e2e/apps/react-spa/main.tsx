// SPDX-License-Identifier: Apache-2.0
// React Router SPA fixture (History API). The tracker is the npm package, started in the root layout's effect —
// the README's recommended integration. Built in React's development mode on purpose: <StrictMode> then mounts,
// unmounts and re-mounts every component, so the effect (and init()) runs twice, which must not double-count.

import { init } from "@usagemap/tracker";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet, useNavigate, useParams } from "react-router";
import { RouterProvider } from "react-router/dom";

const root = document.getElementById("root") as HTMLElement;
const site = root.dataset.site ?? "";
window.fixture = { trackers: [], ready: false };

function Layout() {
  useEffect(() => {
    window.fixture.trackers.push(init({ site }));
    window.fixture.ready = true;
  }, []);
  return (
    <>
      <nav>
        <Link id="nav-home" to="/">
          Home
        </Link>
        <Link id="nav-products" to="/products">
          Products
        </Link>
        <Link id="nav-product-2" to="/products/2">
          Product 2
        </Link>
        <Link id="nav-search" to="/search?q=wallet">
          Search
        </Link>
      </nav>
      <Outlet />
    </>
  );
}

function Home() {
  return <h1>Home</h1>;
}

function Products() {
  const navigate = useNavigate();
  return (
    <>
      <h1>Products</h1>
      <a id="to-reviews" href="#reviews">
        Reviews (fragment only)
      </a>
      <button
        id="replace-to-7"
        type="button"
        onClick={() => navigate("/products/7", { replace: true })}
      >
        Replace with product 7
      </button>
      <section id="reviews">Reviews</section>
    </>
  );
}

function Product() {
  const { id } = useParams();
  return (
    <>
      <h1>Product {id}</h1>
      <button
        id="add-to-cart"
        type="button"
        onClick={() => window.fixture.trackers[0]?.track("add_to_cart", { sku: `P-${id}`, qty: 1 })}
      >
        Add to cart
      </button>
    </>
  );
}

function Search() {
  const navigate = useNavigate();
  return (
    <>
      <h1>Search</h1>
      <button id="refine" type="button" onClick={() => navigate("/search?q=wallet&page=2")}>
        Next results page (query change only)
      </button>
    </>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Home },
      { path: "products", Component: Products },
      { path: "products/:id", Component: Product },
      { path: "search", Component: Search },
    ],
  },
]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
