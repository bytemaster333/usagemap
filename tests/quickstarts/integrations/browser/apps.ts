// SPDX-License-Identifier: Apache-2.0
// Browser integration examples (examples/<id>): vanilla Vite apps (React for Privy) that add one UsageMap
// integration each. global-setup.ts builds them with `vite build` and the environment below; the spec serves the
// `dist/` output as static files and drives it in Chromium against the protocol-v1 mock gateway.

import { join } from "node:path";
import { CANARY } from "../../../../tracker/test/canary.ts";
import { REPO_ROOT } from "../../../lib/env.ts";

export const EXAMPLES = join(REPO_ROOT, "examples");

/** Stand-in hosts the builds point at; the spec answers them (nothing leaves the machine). */
export const RPC_URL = "https://rpc.stellar.test";
export const APP_EVENTS_URL = "https://app-events.usagemap.test/v1/app-events";

export interface BrowserApp {
  /** directory under examples/ */
  id: string;
  /** the tenant guide in docs/onboarding this example shows */
  guide: string;
  /** build-time variables besides VITE_USAGEMAP_SITE */
  env?: Record<string, string>;
}

export const APPS: BrowserApp[] = [
  { id: "wallets-kit", guide: "wallets.md" },
  { id: "freighter", guide: "wallets.md" },
  {
    id: "walletconnect",
    guide: "wallets.md",
    env: { VITE_WALLETCONNECT_PROJECT_ID: "0123456789abcdef0123456789abcdef" },
  },
  {
    id: "passkey",
    guide: "wallets.md",
    // the verifier address is a canary: the kit holds it, the tracker must never send it
    env: { VITE_STELLAR_RPC_URL: RPC_URL, VITE_WEBAUTHN_VERIFIER: CANARY.C },
  },
  { id: "privy", guide: "wallets.md", env: { VITE_PRIVY_APP_ID: "cm0example0appid000000000" } },
  { id: "stellar-rpc-browser", guide: "wallets.md", env: { VITE_STELLAR_RPC_URL: RPC_URL } },
  {
    id: "telegram-mini-app",
    guide: "mobile.md",
    env: { VITE_USAGEMAP_APP_EVENTS: APP_EVENTS_URL },
  },
];

/** QS_BROWSER_INTEGRATIONS=freighter,passkey limits a run (default: all). */
export function selectedApps(): BrowserApp[] {
  const only = (process.env.QS_BROWSER_INTEGRATIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of only)
    if (!APPS.some((a) => a.id === id))
      throw new Error(`QS_BROWSER_INTEGRATIONS: no example "${id}"`);
  return only.length ? APPS.filter((a) => only.includes(a.id)) : APPS;
}

export const selected = (id: string): BrowserApp | undefined =>
  selectedApps().find((a) => a.id === id);

export function buildEnv(app: BrowserApp, site: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: "production", VITE_USAGEMAP_SITE: site, ...app.env };
}
