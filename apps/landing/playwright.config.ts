// SPDX-License-Identifier: Apache-2.0
// Browser check of the built landing page in Chromium. Every request is served by route interception (no ports, no
// network): the page itself, the pinned tracker file from the release archive and a gateway answer.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "test-results/e2e-junit.xml" }]]
    : [["list"]],
  use: { trace: process.env.CI ? "retain-on-failure" : "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
