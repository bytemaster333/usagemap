// SPDX-License-Identifier: Apache-2.0
// Runs INSIDE our Umami image (usagemap/umami:3.5.0-d3c62a8, network none, read-only): finds the `isbot` expression that
// Umami's server bundle constructs, and evaluates Umami's own `isbot` function body on every line of the corpus.
// Output: JSON {"pattern_sha256", "results": [[ua, bool], ...]} on stdout. Used by gen-parity.sh and the parity test.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function* files(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (p.endsWith(".js")) yield p;
  }
}
let source;
for (const f of files("/app/.next/server/chunks")) {
  const s = readFileSync(f, "utf8");
  const i = s.indexOf('RegExp(" daum[ /]');
  if (i < 0) continue;
  const start = i + "RegExp(".length;
  const end = s.indexOf('","i")', start);
  source = JSON.parse(s.slice(start, end + 1));
  break;
}
if (!source) throw new Error("isbot expression not found in the Umami bundle");
const re = new RegExp(source, "i");
// Umami's bundled isbot(): typeof e == "string" && e !== "" && pattern.test(e)
const isbot = (e) => typeof e === "string" && e !== "" && re.test(e);
const corpus = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = {
  pattern_sha256: createHash("sha256").update(source).digest("hex"),
  results: corpus.map((ua) => [ua, isbot(ua)]),
};
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
