// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** e2e files run one after another in file-name order (10-web, 20-bot, 30-api, 90-inventory): the data-inventory
 *  scan must see the data the earlier suites produced. */
class ByName extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const name = (f: TestSpecification) => f.moduleId.split("/").pop() ?? "";
    return [...files].sort((a, b) => name(a).localeCompare(name(b)));
  }
}

export default defineConfig({
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    sequence: { sequencer: ByName },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          globalSetup: ["quickstarts/global-setup.ts"],
          include: [
            "lib/**/*.test.ts",
            "load/**/*.test.ts",
            "isolation/**/*.test.ts",
            "chaos/**/*.test.ts",
            "quickstarts/**/*.test.ts",
            "onboarding/**/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["**/*.e2e.test.ts"],
          exclude: ["**/node_modules/**", "fixtures/**"],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
