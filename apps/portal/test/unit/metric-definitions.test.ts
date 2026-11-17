// SPDX-License-Identifier: Apache-2.0
// Every metric card carries a definition (2026-11-19 improvements): cards are rendered only through MetricTile (which
// requires a metric key), every key used anywhere resolves to a definition generated from docs/metrics/definitions.md,
// and every figure marked with data-metric has its definition shown on the same page.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { METRIC_TERMS, parseDefinitions, render } from "../../scripts/gen-definitions.ts";
import { METRIC_DEFINITIONS } from "../../src/lib/definitions.gen.ts";

const root = join(__dirname, "..", "..");
const repo = join(root, "..", "..");
const src = join(root, "src");
/** Pages of the onboarding work stream, handed over separately (their counters are not metric figures yet). */
const NOT_MINE = ["pages/onboard/"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}
const sources = files(src)
  .filter((f) => !NOT_MINE.some((n) => relative(src, f).startsWith(n)))
  .map((f) => ({ f: relative(src, f), s: readFileSync(f, "utf8") }));
const keys = new Set(Object.keys(METRIC_DEFINITIONS));

describe("metric definitions", () => {
  it("are generated from the current definitions document", () => {
    const want = render(
      readFileSync(join(repo, "docs/metrics/definitions.md"), "utf8"),
      readFileSync(join(src, "lib/metric-definitions.pending.md"), "utf8"),
    );
    expect(readFileSync(join(src, "lib/definitions.gen.ts"), "utf8")).toBe(want);
  });

  it("have a term and a non-trivial text for every key", () => {
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual(Object.keys(METRIC_TERMS).sort());
    for (const [k, d] of Object.entries(METRIC_DEFINITIONS)) {
      expect(d.text.length, k).toBeGreaterThan(30);
      expect(d.source, k).toMatch(/^docs\/metrics\/definitions\.md §/);
    }
  });

  it("every metric card is a MetricTile (so it has a definition)", () => {
    const raw = sources.filter(
      (x) => x.f !== "components/MetricInfo.tsx" && /className="tile"/.test(x.s),
    );
    expect(raw.map((x) => x.f)).toEqual([]);
  });

  it("every metric key used in the portal has a definition, and each data-metric figure shows it", () => {
    const used = new Set<string>();
    const shown = new Set<string>();
    for (const { s } of sources) {
      for (const m of s.matchAll(/(?:data-metric|metric)=(?:"([a-z0-9_]+)"|\{([^}]*)\})/g)) {
        // `metric={cond ? "a" : "b"}`: the branches are the keys
        const lits = m[1]
          ? [m[1]]
          : [...(m[2] ?? "").matchAll(/[?:]\s*"([a-z0-9_]+)"/g)].map((x) => x[1] as string);
        for (const k of lits) used.add(k);
        if (!m[0].startsWith("data-")) for (const k of lits) shown.add(k);
      }
      for (const m of s.matchAll(/metrics=\{\[([^\]]*)\]\}/g))
        for (const x of (m[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)) {
          used.add(x[1] as string);
          shown.add(x[1] as string);
        }
    }
    expect(used.size).toBeGreaterThan(20);
    for (const k of used) expect(keys.has(k), `metric key ${k}`).toBe(true);
    for (const { f, s } of sources)
      for (const m of s.matchAll(/data-metric="([a-z0-9_]+)"/g))
        expect(shown.has(m[1] as string), `${f}: ${m[1]} has no MetricInfo/MetricDefinitions`).toBe(
          true,
        );
  });

  it("fails loudly when a figure is missing from the document", () => {
    expect(() => parseDefinitions("| **A** | x |\n| **A** | y |\n", "t.md")).toThrow(/twice/);
    expect(() => render("# x\n", "# y\n")).toThrow(/no definition of/);
  });
});
