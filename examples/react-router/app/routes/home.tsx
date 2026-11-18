// SPDX-License-Identifier: Apache-2.0
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
