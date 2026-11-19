// SPDX-License-Identifier: Apache-2.0
// Integration examples (examples/<integration>) that are not browser apps: each is started the way its README says,
// against local stand-ins of the UsageMap endpoints (OTLP receiver, app-events edge, control plane) and of the
// third-party service it talks to. One file per group, run one after another.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fsModuleCache: false,
    include: ["quickstarts/integrations/*.spec.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
