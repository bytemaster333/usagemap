// SPDX-License-Identifier: Apache-2.0
// Rendered on the server for every request (not prerendered), so the example covers request-time SSR + hydration.
export const dynamic = "force-dynamic";

export default function About() {
  return <h1>About</h1>;
}
