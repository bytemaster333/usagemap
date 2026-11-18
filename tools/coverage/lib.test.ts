// SPDX-License-Identifier: Apache-2.0
// Self-test of the coverage report's merge and summary logic (test.automated-suite).
//
//   node --test tools/coverage/

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  buildSummary,
  formatGoProfile,
  goPackageCoverage,
  goWorkModules,
  mergeGoProfiles,
  parseGoProfile,
  renderMarkdown,
  sumCoverage,
  tsPackageCoverage,
  type UnitResult,
} from "./lib.ts";
import { TS_TARGETS } from "./targets.ts";

const A = `mode: atomic
example.org/m/a/x.go:3.10,5.2 2 1
example.org/m/a/x.go:5.2,7.3 1 0
example.org/m/a/y.go:1.1,1.20 1 0
example.org/m/b/z.go:10.1,12.2 3 4
`;

describe("Go profiles", () => {
  test("parses blocks and the mode", () => {
    const p = parseGoProfile(A);
    assert.equal(p.mode, "atomic");
    assert.equal(p.blocks.length, 4);
    assert.deepEqual(p.blocks[0], {
      file: "example.org/m/a/x.go",
      startLine: 3,
      startCol: 10,
      endLine: 5,
      endCol: 2,
      stmts: 2,
      count: 1,
    });
  });

  test("refuses malformed and empty profiles instead of reporting a low figure", () => {
    assert.throws(() => parseGoProfile(""), /empty/);
    assert.throws(() => parseGoProfile("example.org/x.go:1.1,2.2 1 1\n"), /mode line/);
    assert.throws(() => parseGoProfile("mode: set\nexample.org/x.go:1.1,2.2 1\n"), /malformed/);
  });

  test("concatenated profiles (repeated mode line) parse", () => {
    assert.equal(
      parseGoProfile(`${A}mode: atomic\nexample.org/m/c/q.go:1.1,2.2 1 1\n`).blocks.length,
      5,
    );
  });

  test("merge adds counts of the same block and keeps distinct blocks", () => {
    const b = parseGoProfile(
      "mode: set\nexample.org/m/a/x.go:5.2,7.3 1 1\nexample.org/m/c/q.go:1.1,2.2 1 0\n",
    );
    const m = mergeGoProfiles([parseGoProfile(A), b]);
    assert.equal(m.mode, "atomic");
    assert.equal(m.blocks.length, 5);
    assert.equal(m.blocks.find((x) => x.file.endsWith("x.go") && x.startLine === 5)?.count, 1);
    // round trip
    assert.deepEqual(parseGoProfile(formatGoProfile(m)), m);
  });

  test("merge refuses two sources for the same block", () => {
    const b = parseGoProfile("mode: set\nexample.org/m/a/x.go:5.2,7.3 9 1\n");
    assert.throws(() => mergeGoProfiles([parseGoProfile(A), b]), /disagree/);
  });

  test("per-package lines: a line shared by a covered and an uncovered block counts once, as covered", () => {
    const [a, b] = goPackageCoverage(parseGoProfile(A));
    // package a: x.go lines 3,4,5 (covered), 6,7 (not), y.go line 1 (not) → 3 / 6
    assert.equal(a?.name, "example.org/m/a");
    assert.deepEqual(a?.lines, { total: 6, covered: 3, pct: 50 });
    assert.deepEqual(a?.statements, { total: 4, covered: 2, pct: 50 });
    assert.equal(a?.files, 2);
    assert.equal(b?.name, "example.org/m/b");
    assert.deepEqual(b?.lines, { total: 3, covered: 3, pct: 100 });
  });
});

describe("TypeScript summaries", () => {
  const summary = {
    total: { lines: { total: 200, covered: 150 }, statements: { total: 210, covered: 151 } },
    "/r/p/src/a.ts": {
      lines: { total: 100, covered: 100 },
      statements: { total: 100, covered: 100 },
    },
    "/r/p/src/b.ts": {
      lines: { total: 100, covered: 50 },
      statements: { total: 110, covered: 51 },
    },
  };
  test("reads totals and file count", () => {
    const c = tsPackageCoverage("p", summary);
    assert.deepEqual(c.lines, { total: 200, covered: 150, pct: 75 });
    assert.equal(c.statements.pct, 71.9);
    assert.equal(c.files, 2);
  });
  test("refuses a file that is not a json-summary", () => {
    assert.throws(() => tsPackageCoverage("p", {} as never), /json-summary/);
  });
  test("every workspace package with a vitest config is a coverage target", () => {
    const ws = readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8");
    const listed = new Set(TS_TARGETS.map((t) => t.dir));
    for (const m of ws.matchAll(/^\s+-\s+(\S+)\s*$/gm)) {
      const entry = m[1] as string;
      if (entry.endsWith("/*")) continue; // globs: apps/* — their members are listed explicitly
      // Members without a vitest config (e.g. templates/scaffold-stellar: node:test over an assembly script) have no
      // TypeScript sources for v8 coverage to measure.
      const hasVitest = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js"].some((f) =>
        existsSync(new URL(`../../${entry}/${f}`, import.meta.url)),
      );
      if (!hasVitest) continue;
      assert.ok(listed.has(entry), `${entry} has no coverage target in tools/coverage/targets.ts`);
    }
    assert.ok(listed.has("apps/portal"));
  });
});

describe("summary", () => {
  const unit = (
    u: string,
    covered: number,
    total: number,
    status: "passed" | "failed" = "passed",
  ): UnitResult => {
    const t = sumCoverage(u, [
      {
        name: u,
        lines: { total, covered, pct: 0 },
        statements: { total, covered, pct: 0 },
        files: 1,
      },
    ]);
    return {
      unit: u,
      status,
      command: "x",
      excluded: status === "failed" ? [] : ["integration: needs Docker"],
      total: t,
      packages: [t],
    };
  };
  test("totals add lines, not percentages", () => {
    const s = buildSummary({
      generatedAt: new Date("2026-11-14T00:00:00Z"),
      commit: "abc",
      dirty: false,
      mode: "unit",
      go: [unit("g1", 90, 100), unit("g2", 0, 900)],
      ts: [unit("t1", 50, 100, "failed")],
    });
    assert.equal(s.go.total.lines.pct, 9);
    assert.equal(s.total.lines.covered, 140);
    assert.equal(s.total.lines.total, 1100);
    assert.deepEqual(s.failed, ["t1"]);
    const md = renderMarkdown(s);
    assert.match(md, /\*\*Test failures in:\*\* `t1`/);
    assert.match(md, /\| `g1` \| passed \| 90 \/ 100 \| 90\.0 % \|/);
    assert.match(md, /- `g1`: integration: needs Docker/);
  });
  test("an empty scope reads as 100 % of nothing, not NaN", () => {
    assert.equal(sumCoverage("x", []).lines.pct, 100);
  });
});

describe("go.work", () => {
  test("lists block and single-line use entries", () => {
    assert.deepEqual(goWorkModules("go 1.27\n\nuse (\n\t./a/b // c\n\t./d\n)\nuse ./e\n"), [
      "a/b",
      "d",
      "e",
    ]);
  });
});
