// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fsModuleCache: false,
    testTimeout: 20_000,
    include: ["test/**/*.test.ts"],
  },
});
