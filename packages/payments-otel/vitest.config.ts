// SPDX-License-Identifier: Apache-2.0
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fsModuleCache: false,
    testTimeout: 30_000,
    // The example test needs examples/api-x402 installed (its own workspace): `pnpm run test:example`.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.PAYMENTS_OTEL_EXAMPLE === "1" ? [] : ["test/example-x402.test.ts"]),
    ],
  },
});
