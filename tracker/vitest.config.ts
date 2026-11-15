// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { type BuildConfig, defines, type Profile } from "./scripts/build-config.ts";

// Tests compile the source with the same compile-time constants as the release build, once per profile, with fixed
// test hosts (the release defaults are placeholders) and a small proof-of-work ceiling.
const cfg: BuildConfig = {
  version: "1.2.0",
  hosts: ["https://a.ingest.test", "https://b.ingest.test"],
  powMaxWork: 2 ** 16,
  powParallel: 4,
};

const project = (profile: Profile) => ({
  extends: true as const,
  define: defines(cfg, profile),
  test: { name: profile },
});

export default defineConfig({
  test: {
    // No persistent transform cache: a stale shared node_modules/.vitest-cache once served old modules (CI never relies on it).
    fsModuleCache: false,
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    projects: [project("standard"), project("strict")],
  },
});
