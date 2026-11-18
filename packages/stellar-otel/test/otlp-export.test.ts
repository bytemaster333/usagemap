// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assertClean } from "./helpers.ts";
import { runScenario, sink } from "./scenario.ts";

describe("export through the real OTLP/HTTP exporter (what the UsageMap Collector receives)", () => {
  it("sends the five metric names as OTLP JSON, with no address, hash, XDR, URL or key", async () => {
    const s = await sink();
    try {
      await runScenario(s.url);
    } finally {
      s.close();
    }
    expect(s.bodies.length).toBeGreaterThanOrEqual(1);
    expect(s.bodies[0]?.type).toContain("application/json");
    const all = s.bodies.map((b) => b.body).join("\n");
    for (const n of [
      "rpc.client.call.duration",
      "http.client.request.duration",
      "stellar.tx.submissions",
      "stellar.tx.polls",
      "stellar.tx.simulations",
    ])
      expect(all).toContain(`"name":"${n}"`);
    // The exporter itself adds no URL; our attributes carry none.
    assertClean(all);
  });
});
