// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { caseRows, parseGoTestJson, parseVitestJson, totals } from "./parse.ts";

describe("isolation report parsers", () => {
  it("keeps the final outcome of every Go test and subtest", () => {
    const text = [
      '{"Action":"run","Test":"TestCrossTenantMatrix"}',
      '{"Action":"run","Test":"TestCrossTenantMatrix/scf.sites/select"}',
      '{"Action":"output","Test":"TestCrossTenantMatrix/scf.sites/select","Output":"ok"}',
      '{"Action":"pass","Test":"TestCrossTenantMatrix/scf.sites/select","Elapsed":0.01}',
      '{"Action":"fail","Test":"TestCrossTenantMatrix/scf.sites/delete","Elapsed":0.02}',
      '{"Action":"fail","Test":"TestCrossTenantMatrix","Elapsed":1.5}',
      '{"Action":"skip","Test":"TestGateG8Runtime"}',
      '{"Action":"pass","Package":"x","Elapsed":3}',
      "not json",
    ].join("\n");
    const c = parseGoTestJson(text);
    expect(c).toHaveLength(4);
    expect(totals(c)).toEqual({ pass: 1, fail: 2, skip: 1 });
    expect(c.find((x) => x.name.endsWith("/select"))?.parent).toBe("TestCrossTenantMatrix");
    expect(caseRows(c)).toEqual([
      {
        suite: "db",
        name: "TestCrossTenantMatrix",
        outcome: "fail",
        cases: 2,
        passed: 1,
        failed: 1,
      },
      { suite: "db", name: "TestGateG8Runtime", outcome: "skip", cases: 1, passed: 0, failed: 0 },
    ]);
  });

  it("reads vitest's JSON reporter", () => {
    const c = parseVitestJson(
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              {
                fullName: "isolation matrix a",
                status: "passed",
                duration: 12.4,
                meta: { assertions: 412 },
              },
              { fullName: "isolation matrix b", status: "failed" },
              { fullName: "isolation matrix c", status: "skipped" },
            ],
          },
        ],
      }),
    );
    expect(totals(c)).toEqual({ pass: 1, fail: 1, skip: 1 });
    expect(c[0]).toMatchObject({ suite: "http", ms: 12, assertions: 412 });
    expect(caseRows(c)[0]).toEqual({
      suite: "http",
      name: "isolation matrix a",
      outcome: "pass",
      cases: 412,
    });
    expect(caseRows(c)[1]?.cases).toBeUndefined();
  });
});
