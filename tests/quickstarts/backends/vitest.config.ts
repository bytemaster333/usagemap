// SPDX-License-Identifier: Apache-2.0
// Backend examples (examples/api-*) against a local OTLP receiver: one file, tests run one after another.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    include: ["quickstarts/backends/backends.spec.ts"],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
});
