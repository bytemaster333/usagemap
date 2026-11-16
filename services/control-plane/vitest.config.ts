// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    projects: [
      { extends: true, test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/support/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 240_000,
          // One shared database: files run one after another so global assertions (snapshot content) are stable.
          fileParallelism: false,
        },
      },
    ],
  },
});
