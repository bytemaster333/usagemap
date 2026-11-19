// SPDX-License-Identifier: Apache-2.0
import { Link } from "@tanstack/react-router";

export function NotFoundPage() {
  return (
    <main id="main">
      <h1>Page not found</h1>
      <p>
        <Link to="/tenants">Go to your projects</Link>
      </p>
    </main>
  );
}
