// SPDX-License-Identifier: Apache-2.0
// privacy.strategy-docs suite: data-inventory claims vs the implementation. Needs Docker (a throwaway PostgreSQL with every migration).
//   pnpm --filter tests exec vitest run -c privacy-docs/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    name: "privacy-docs",
    root: import.meta.dirname,
    include: ["**/*.test.ts"],
    globalSetup: ["global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
});
