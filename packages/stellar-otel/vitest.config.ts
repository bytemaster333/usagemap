// SPDX-License-Identifier: Apache-2.0
// The same suite runs once per supported js-stellar-sdk major: each project aliases `@stellar/stellar-sdk` to an
// exact-pinned devDependency alias (package.json). `sdk-14-module` is 14.1.0, the last 14.x line before servers got
// their own `httpClient` (14.3.1); it exercises the module-wide hook like 13.x. Run one: `vitest run --project sdk-15`.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const MATRIX: Record<string, string> = {
  "sdk-17": "@stellar/stellar-sdk",
  "sdk-16": "stellar-sdk-v16",
  "sdk-15": "stellar-sdk-v15",
  "sdk-14": "stellar-sdk-v14",
  "sdk-14-module": "stellar-sdk-v14-module",
  "sdk-13": "stellar-sdk-v13",
};
const versionOf = (pkg: string): string =>
  (
    JSON.parse(
      readFileSync(new URL(`./node_modules/${pkg}/package.json`, import.meta.url), "utf8"),
    ) as { version: string }
  ).version;

export default defineConfig({
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    testTimeout: 20_000,
    projects: Object.entries(MATRIX).map(([name, pkg]) => ({
      extends: true,
      resolve:
        pkg === "@stellar/stellar-sdk"
          ? {}
          : { alias: [{ find: /^@stellar\/stellar-sdk$/, replacement: pkg }] },
      test: {
        name,
        // The optional public-testnet smoke runs once (17.x), not per major.
        include: name === "sdk-17" ? ["test/**/*.test.ts"] : ["test/**/!(testnet.smoke).test.ts"],
        env: { STELLAR_SDK_EXPECTED_VERSION: versionOf(pkg) },
      },
    })),
  },
});
