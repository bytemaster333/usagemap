// SPDX-License-Identifier: Apache-2.0
// Loads the shared pathnorm corpus (packages/pathnorm/testdata) exactly as
// packages/pathnorm/vectors_test.go does: derived secret-seed tokens are
// computed at run time from the published formula and never stored.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeStrKey } from "../src/strkey.ts";

export interface Vector {
  id: number;
  mode: "path" | "route" | "web_full" | "web_relaxed";
  input: string;
  expected: string;
}

export const PATHNORM_TESTDATA = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "pathnorm",
  "testdata",
);

const testSeed = (label: string) => encodeStrKey("S", createHash("sha256").update(label).digest());

export function derivedTokens(): Record<string, string> {
  const s1 = testSeed("scf-vector-S1-test-only");
  const s2 = testSeed("scf-vector-S2-test-only");
  if (!s1.startsWith("SC5") || !s2.startsWith("SCT")) {
    throw new Error("seed derivation does not match the corpus legend");
  }
  return { "«S1»": s1, "«S2»": s2, "«S1lc»": s1.toLowerCase(), "«S1enc»": `%53${s1.slice(1)}` };
}

export function loadVectors(file: "vectors.json" | "vectors_extra.json"): Vector[] {
  const f = JSON.parse(readFileSync(join(PATHNORM_TESTDATA, file), "utf8")) as {
    count: number;
    rule_set: string;
    derived_tokens: Record<string, string>;
    vectors: Vector[];
  };
  const tokens = derivedTokens();
  for (const tok of Object.keys(f.derived_tokens)) {
    if (!(tok in tokens)) throw new Error(`${file}: derived token ${tok} has no derivation`);
  }
  if (f.count !== f.vectors.length) throw new Error(`${file}: count mismatch`);
  return f.vectors.map((v) => {
    let { input, expected } = v;
    for (const [tok, val] of Object.entries(tokens)) {
      input = input.replaceAll(tok, val);
      expected = expected.replaceAll(tok, val);
    }
    if (input.includes("«") || expected.includes("«")) {
      throw new Error(`${file}: vector ${v.id} has an unresolved token`);
    }
    return { ...v, input, expected };
  });
}

export function ruleSetOf(file: "vectors.json" | "vectors_extra.json"): string {
  return (JSON.parse(readFileSync(join(PATHNORM_TESTDATA, file), "utf8")) as { rule_set: string })
    .rule_set;
}
