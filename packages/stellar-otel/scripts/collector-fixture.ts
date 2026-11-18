// SPDX-License-Identifier: Apache-2.0
// Writes collector/processor/scfsanitizeprocessor/testdata/sdk/stellar-otel.metrics.json: one OTLP/HTTP JSON export
// request exactly as this package + the OTel JS SDK send it (test/scenario.ts). The Collector's golden tests sanitise
// it (go test -run 'TestSDKFixtures|TestStellarFixture' -update). Run: node scripts/collector-fixture.ts
import { writeFileSync } from "node:fs";
import { assertClean } from "../test/helpers.ts";
import { runScenario, sink } from "../test/scenario.ts";

const s = await sink();
try {
  await runScenario(s.url);
} finally {
  s.close();
}
// forceFlush exports once; shutdown exports the same cumulative state again. The first request is the fixture.
if (s.bodies.length < 1) throw new Error("no export request received");
const body = s.bodies[0]?.body ?? "";
assertClean(body);
const out = new URL(
  "../../../collector/processor/scfsanitizeprocessor/testdata/sdk/stellar-otel.metrics.json",
  import.meta.url,
);
writeFileSync(out, `${JSON.stringify(JSON.parse(body), null, 1)}\n`);
console.log("wrote", out.pathname);
