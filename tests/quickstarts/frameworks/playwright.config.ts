// SPDX-License-Identifier: Apache-2.0
// tracker.ssr-frameworks framework quickstarts (frameworks.spec.ts): the example apps under examples/, built and served for real,
// driven in Chromium against the protocol-v1 mock gateway. Run with `tests/quickstarts/frameworks/run.sh`.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  // apps in parallel; each app's tests in one worker with one server (describe mode "default")
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: "../../../.cache/quickstarts-frameworks/test-results",
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "../../../.cache/quickstarts-frameworks/junit.xml" }]]
    : [["list"]],
  use: { trace: process.env.CI ? "retain-on-failure" : "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
