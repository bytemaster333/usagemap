// SPDX-License-Identifier: Apache-2.0
// Browser integration examples (integrations.spec.ts): examples/{wallets-kit,freighter,walletconnect,passkey,privy,
// stellar-rpc-browser,telegram-mini-app} built with Vite and driven in Chromium against the protocol-v1 mock gateway.
// Run with `tests/quickstarts/integrations/browser/run.sh`.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: "../../../../.cache/quickstarts-integrations-browser/test-results",
  reporter: process.env.CI
    ? [
        ["list"],
        ["junit", { outputFile: "../../../../.cache/quickstarts-integrations-browser/junit.xml" }],
      ]
    : [["list"]],
  use: { trace: process.env.CI ? "retain-on-failure" : "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
