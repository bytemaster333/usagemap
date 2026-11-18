// SPDX-License-Identifier: Apache-2.0
// Setup file injected by isolation/vitest.http.config.ts into the control plane's HTTP isolation suite: records the
// number of `expect` assertions each test made in the test's meta (`meta.assertions`), which vitest's JSON reporter
// carries. Each assertion of that suite is one (operation × caller × identifier) case, so the report can state cases
// per test instead of "8 tests". Changes nothing in what the suite asserts.
import { afterEach, expect } from "vitest";

afterEach((ctx) => {
  (ctx.task.meta as Record<string, unknown>).assertions = expect.getState().assertionCalls;
});
