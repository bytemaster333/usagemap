// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from "@playwright/test";

// Browser tests of the built release files (dist/<semver>/*.js) and the npm entry (dist/npm/), run by `test:e2e`
// after a build. All network traffic is served by route interception — no ports: the fixture apps (e2e/apps/,
// built by the global setup) and a protocol-v1 mock gateway that validates every request against the wire-format
// JSON Schemas (e2e/lib/gateway.ts). The end-to-end run against the real gateway is a separate suite (tests/).
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/apps/build.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "test-results/e2e-junit.xml" }]]
    : [["list"]],
  use: { trace: process.env.CI ? "retain-on-failure" : "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
