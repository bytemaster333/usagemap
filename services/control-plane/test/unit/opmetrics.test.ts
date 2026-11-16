// SPDX-License-Identifier: Apache-2.0
import { operatorMetricsOpenApi } from "@usagemap/api-types";
import { describe, expect, it } from "vitest";
import { OpenApi } from "../../src/http/openapi.ts";
import { ApiError } from "../../src/http/problem.ts";
import {
  daysOf,
  decodeCursor,
  encodeCursor,
  ms,
  page,
  sorter,
  toCsv,
} from "../../src/operator/common.ts";
import { metricsHandlers } from "../../src/opmetrics/routes.ts";

describe("operator helpers", () => {
  it("writes RFC 4180 CSV with flattened objects and empty nulls", () => {
    const csv = toCsv([
      { a: 1, b: null, c: 'x,"y"', d: { p: 0.5, q: null } },
      { a: 2, b: "z", c: "line\nbreak", d: { p: 1, q: 2 } },
    ]);
    expect(csv).toBe('a,b,c,d.p,d.q\r\n1,,"x,""y""",0.5,\r\n2,z,"line\nbreak",1,2\r\n');
  });

  it("binds cursors to their query and rejects foreign or forged ones", () => {
    const c = encodeCursor(50, "q1");
    expect(decodeCursor(c, "q1")).toBe(50);
    expect(decodeCursor(undefined, "q1")).toBe(0);
    expect(() => decodeCursor(c, "q2")).toThrow(ApiError);
    expect(() => decodeCursor("not-base64-json", "q1")).toThrow(ApiError);
    const p = page([1, 2, 3], 0, 2, "b");
    expect(p.items).toEqual([1, 2]);
    expect(decodeCursor(p.next_cursor, "b")).toBe(2);
    expect(page([1, 2, 3], 2, 2, "b").next_cursor).toBeNull();
  });

  it("sorts ascending/descending with nulls last and a stable tiebreak", () => {
    const rows = [
      { id: "a", v: 2 },
      { id: "b", v: null },
      { id: "c", v: 5 },
      { id: "d", v: 2 },
    ];
    expect([...rows].sort(sorter("-v", (r) => r.id)).map((r) => r.id)).toEqual([
      "c",
      "a",
      "d",
      "b",
    ]);
    expect([...rows].sort(sorter("v", (r) => r.id)).map((r) => r.id)).toEqual(["a", "d", "c", "b"]);
  });

  it("converts seconds to milliseconds and lists UTC days of a half-open range", () => {
    expect(ms(0.1234567)).toBe(123.457);
    expect(ms(null)).toBeNull();
    expect(daysOf("2026-11-30T00:00:00Z", "2026-12-02T00:00:00Z")).toEqual([
      "2026-11-30",
      "2026-12-01",
    ]);
  });

  it("has a handler for every operation of operator-metrics.openapi.yaml", () => {
    const ids = new OpenApi(operatorMetricsOpenApi()).operations.map((o) => o.operationId).sort();
    expect(ids).toHaveLength(16);
    expect(Object.keys(metricsHandlers(Date.now)).sort()).toEqual(ids);
  });
});
