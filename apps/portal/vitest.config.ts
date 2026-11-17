// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    include: ["test/unit/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
