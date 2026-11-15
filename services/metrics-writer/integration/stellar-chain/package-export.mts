// SPDX-License-Identifier: Apache-2.0
// Records one live OTLP/HTTP JSON export of @usagemap/stellar-otel: the package's own scenario
// (packages/stellar-otel/test/scenario.ts — instrumented js-stellar-sdk rpc.Server and Horizon.Server against
// recorded testnet answers, the OTel JS SDK's OTLPMetricExporter) into a local sink. Usage: node package-export.mts <out>
import { writeFileSync } from "node:fs";
import { runScenario, sink } from "../../../../packages/stellar-otel/test/scenario.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node package-export.mts <out.json>");
const s = await sink();
try {
  await runScenario(s.url);
} finally {
  s.close();
}
const body = s.bodies[0]?.body;
if (!body) throw new Error("the package exported nothing");
writeFileSync(out, body);
console.log(`package export: ${body.length} bytes`);
