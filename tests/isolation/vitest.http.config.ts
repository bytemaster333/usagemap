// SPDX-License-Identifier: Apache-2.0
// Runs services/control-plane/test/integration/isolation.test.ts exactly as the control plane's own `integration`
// project does (same root, global setup, timeouts, one file at a time) plus isolation/count-assertions.ts, so the
// JSON report carries the number of assertions (cases) per test. Used by isolation/run.ts only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const cp = join(here, "../../services/control-plane");

export default defineConfig({
  root: cp,
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    name: "isolation-http",
    include: ["test/integration/isolation.test.ts"],
    globalSetup: [join(cp, "test/support/global-setup.ts")],
    setupFiles: [join(here, "count-assertions.ts")],
    testTimeout: 30_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
