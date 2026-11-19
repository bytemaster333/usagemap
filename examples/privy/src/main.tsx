// SPDX-License-Identifier: Apache-2.0
// A React dApp with a Privy embedded Stellar wallet: log in, create a Stellar wallet, sign a transaction hash.
import { PrivyProvider } from "@privy-io/react-auth";
import { init } from "@usagemap/tracker";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// UsageMap: page views (wallet events come from the wrapped Privy hooks in App.tsx)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });

createRoot(document.getElementById("root") as HTMLElement).render(
  <PrivyProvider appId={import.meta.env.VITE_PRIVY_APP_ID ?? ""}>
    <App />
  </PrivyProvider>,
);
