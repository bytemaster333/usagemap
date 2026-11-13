// SPDX-License-Identifier: Apache-2.0
// Minify the solver (worker body) and the solver+loader bundle, report gzip/brotli sizes.
import { buildSync, transformSync } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const dir = new URL(".", import.meta.url).pathname;
mkdirSync(dir + "build", { recursive: true });
const opts = { minify: true, target: "es2017", legalComments: "none" };
const solver = transformSync(readFileSync(dir + "src/solver.js", "utf8"), opts).code.trim();
const loaderSrc = readFileSync(dir + "src/loader.js", "utf8").replace("[__SOLVER__]", "[" + JSON.stringify(solver) + "]");
// keep scfSolve as a global so the bundle is a usable unit (the tracker would inline it in its IIFE)
const bundle = transformSync(loaderSrc, { ...opts, minifyIdentifiers: true }).code.trim();
writeFileSync(dir + "build/solver.min.js", solver);
writeFileSync(dir + "build/solver-bundle.min.js", bundle);
const sz = (s) => ({
  raw: Buffer.byteLength(s),
  gzip9: gzipSync(s, { level: 9 }).length,
  brotli11: brotliCompressSync(s, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});
const out = { esbuild: "0.28.2", target: "es2017", solver_worker_body: sz(solver), solver_plus_loader: sz(bundle) };
writeFileSync(dir + "results/size.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
