// SPDX-License-Identifier: Apache-2.0
// The portal against the real control plane (Compose project scf-wsh): run e2e/real/run.sh, which starts the stack,
// runs this configuration and removes the stack again.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/real",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: process.env.SCF_PORTAL_REAL_URL ?? "http://localhost:56220",
    trace: "off",
    timezoneId: "Pacific/Auckland",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
