// SPDX-License-Identifier: Apache-2.0
// Unit tests of the chaos/load bookkeeping: per-request page paths and the reconciliation of what Umami stored
// against what the gateway answered (exact accepted vs stored, classified surplus).
import { describe, expect, it } from "vitest";
import { pathCode, reconcile, sumSeries } from "./web-load.ts";

describe("pathCode", () => {
  it("is unique, six non-hex letters (pathnorm keeps it literal)", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 50_000; n++) {
      const c = pathCode(n);
      expect(c).toMatch(/^[g-z]{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(50_000);
    expect(pathCode(0)).toBe("gggggg");
    expect(pathCode(20 ** 6 - 1)).toBe("zzzzzz");
    expect(() => pathCode(20 ** 6)).toThrow(RangeError);
    expect(() => pathCode(-1)).toThrow(RangeError);
  });
});

describe("reconcile", () => {
  it("classifies loss, duplicates, lost answers, refused-but-stored and unknown paths", () => {
    const sent = new Map([
      ["/c/a", "202"], // stored once
      ["/c/b", "202"], // stored twice: one duplicate copy
      ["/c/c", "202"], // lost
      ["/c/d", "error"], // connection cut after the fsync: stored
      ["/c/e", "error"], // never reached the gateway: not stored
      ["/c/f", "503"], // refused but stored: a bug
      ["/c/g", "429"], // refused, not stored
    ]);
    const stored = new Map([
      ["/c/a", 1],
      ["/c/b", 2],
      ["/c/d", 1],
      ["/c/f", 1],
      ["/c/x", 1], // never sent
    ]);
    expect(reconcile(sent, stored)).toEqual({
      accepted: 3,
      storedTotal: 6,
      acceptedStored: 2,
      lost: ["/c/c"],
      duplicateCopies: 1,
      answerLostButStored: 1,
      refusedButStored: ["/c/f (503)"],
      unknown: ["/c/x"],
    });
  });

  it("a clean run has no surplus", () => {
    const r = reconcile(new Map([["/c/a", "202"]]), new Map([["/c/a", 1]]));
    expect(r.storedTotal - r.acceptedStored).toBe(0);
    expect(r.lost).toEqual([]);
  });
});

describe("sumSeries", () => {
  it("sums every labelled series of one metric and only that metric", () => {
    const text = [
      "# TYPE scf_gateway_forward_ambiguous_retries_total counter",
      'scf_gateway_forward_ambiguous_retries_total{core="core-a"} 3',
      'scf_gateway_forward_ambiguous_retries_total{core="core-b"} 2',
      "scf_gateway_forward_ambiguous_retries_total_other 100",
    ].join("\n");
    expect(sumSeries(text, "scf_gateway_forward_ambiguous_retries_total")).toBe(5);
    expect(sumSeries(text, "scf_absent")).toBeNaN();
  });
});

describe("ceiling-mode options", () => {
  it("eventIdFor keeps the former default ids and makes 22-character ids for any prefix", async () => {
    const { eventIdFor } = await import("./web-load.ts");
    expect(eventIdFor("L", 35)).toBe(`L${"z".padStart(21, "0")}`);
    expect(eventIdFor("Cb", 1)).toMatch(/^Cb0{19}1$/);
    expect(eventIdFor("Ca", 7)).not.toBe(eventIdFor("Cb", 7));
    expect(() => eventIdFor("C1", 0)).toThrow(RangeError);
  });
  it("wideRoute gives distinct letter-only templates", async () => {
    const { wideRoute } = await import("./otlp-load.ts");
    const r = new Set(Array.from({ length: 50 }, (_, i) => wideRoute(i)));
    expect(r.size).toBe(50);
    for (const x of r) expect(x).toMatch(/^\/load\/[g-z]{3}\/\{id\}$/);
  });
});
