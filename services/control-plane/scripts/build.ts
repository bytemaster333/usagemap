// SPDX-License-Identifier: Apache-2.0
// Bundles the service into one ESM file for the container image (dist/main.mjs) plus the third-party licence notices
// of everything bundled (dist/main.mjs.LEGAL.txt). Node runs the TypeScript sources directly in development.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(root, "dist", "main.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  minify: false,
  legalComments: "external",
  // pg loads its optional native binding lazily; it is not installed.
  external: ["pg-native"],
  // CommonJS dependencies inside an ESM bundle need a `require`.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
