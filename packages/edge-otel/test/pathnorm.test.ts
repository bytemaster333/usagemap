// SPDX-License-Identifier: Apache-2.0
// The edge route normaliser must give exactly the route packages/pathnorm gives,
// on the whole shared corpus (path, route and full-folding page-path vectors).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalize, RULE_SET_VERSION } from "../src/pathnorm.ts";
import { decodeStrKeyType, encodeStrKey } from "../src/strkey.ts";
import { loadVectors, PATHNORM_TESTDATA, ruleSetOf } from "./vectors.ts";

const corpus = loadVectors("vectors.json");
const extra = loadVectors("vectors_extra.json");
// web_full is pathnorm's path mode with full folding; web_relaxed is a gateway-only setting.
const applicable = [...corpus, ...extra].filter((v) => v.mode !== "web_relaxed");
const modeOf = (m: string) => (m === "route" ? "route" : "path");

describe("pathnorm port (scf-path-rules)", () => {
  it("implements the corpus' rule-set version", () => {
    expect(RULE_SET_VERSION).toBe(ruleSetOf("vectors.json"));
    const goSource = readFileSync(join(PATHNORM_TESTDATA, "..", "result.go"), "utf8");
    expect(goSource).toContain(`const RuleSetVersion = "${RULE_SET_VERSION}"`);
  });

  it("covers the whole corpus", () => {
    expect(corpus).toHaveLength(451);
    expect(applicable.length).toBeGreaterThanOrEqual(451 + 30);
  });

  it.each(applicable.map((v) => [`${v.mode} #${v.id} ${JSON.stringify(v.input).slice(0, 60)}`, v]))(
    "%s",
    (_name, v) => {
      expect(normalize(v.input, modeOf(v.mode))).toBe(v.expected);
    },
  );

  it("is idempotent and every output is a fixed point in route mode (what the Collector applies)", () => {
    for (const v of applicable) {
      const once = normalize(v.input, modeOf(v.mode));
      expect(normalize(once, modeOf(v.mode)), `vector ${v.id}`).toBe(once);
      expect(normalize(once, "route"), `vector ${v.id} route mode`).toBe(once);
    }
  });

  it("never lets a derived secret seed through, in any case or encoding", () => {
    for (const v of applicable) {
      const out = normalize(v.input, modeOf(v.mode));
      expect(out).not.toMatch(/[Ss][A-Da-d][A-Za-z2-7]{54}/);
    }
  });
});

describe("strkey", () => {
  it("round-trips every type and rejects a bad checksum", () => {
    const payload = Array.from({ length: 32 }, (_, i) => i * 7);
    for (const t of ["G", "C", "T", "X", "L"] as const) {
      const k = encodeStrKey(t, payload);
      expect(decodeStrKeyType(k)).toBe(t);
      const bad = k.slice(0, -1) + (k.endsWith("A") ? "B" : "A");
      expect(decodeStrKeyType(bad)).toBeUndefined();
    }
    expect(decodeStrKeyType(encodeStrKey("M", Array(40).fill(1)))).toBe("M");
    expect(decodeStrKeyType(encodeStrKey("B", [0, ...Array(32).fill(2)]))).toBe("B");
    expect(decodeStrKeyType(encodeStrKey("B", [1, ...Array(32).fill(2)]))).toBeUndefined();
  });
});
