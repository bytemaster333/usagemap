// SPDX-License-Identifier: Apache-2.0
// Browser tests against the built portal (dist/) served by the mock control plane under the production security
// headers. Run `pnpm --filter @usagemap/portal test:e2e` (builds first). Port 56230 (range 56220–56239).
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.SCF_PORTAL_MOCK_PORT ?? 56230);

export default defineConfig({
  testDir: "e2e/mock",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    locale: "en-GB",
    timezoneId: "Pacific/Auckland",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node e2e/support/run-mock.ts ${PORT}`,
    url: `http://localhost:${PORT}/signin`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
