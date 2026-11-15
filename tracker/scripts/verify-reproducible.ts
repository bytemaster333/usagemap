// SPDX-License-Identifier: Apache-2.0
// Reproducible-build check (ADR-0023, supply-chain §3.2, tracker.no-remote-updates).
//
//   node scripts/verify-reproducible.ts [--against <dist-dir>]
//
// Copies the tracker sources into two fresh temporary directories with different absolute paths, builds each with
// a fixed environment (SOURCE_DATE_EPOCH, TZ=UTC, LC_ALL=C, umask-independent writes), and compares every output
// file byte for byte. With --against it also compares the release files with an existing dist directory (e.g. a
// published release), so an independent job can verify a published manifest. Exits non-zero on any difference.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ROOT } from "./build-config.ts";

const SOURCES = [
  "src",
  "scripts",
  "releases",
  "package.json",
  "tsconfig.json",
  "tsconfig.types.json",
];

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)];
    });
}

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function buildIn(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `scf-tracker-repro-${label}-`));
  const work = join(dir, "tracker");
  for (const s of SOURCES) cpSync(join(ROOT, s), join(work, s), { recursive: true });
  // The tsconfig extends the repository base config; copy it to the same relative place.
  cpSync(join(ROOT, "..", "tsconfig.base.json"), join(dir, "tsconfig.base.json"));
  // Dependencies come from the frozen lockfile install; link, do not copy, so both builds use identical tools.
  symlinkSync(join(ROOT, "node_modules"), join(work, "node_modules"), "dir");
  execFileSync(process.execPath, ["scripts/build.ts", "--out", join(work, "dist")], {
    cwd: work,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      TZ: "UTC",
      LC_ALL: "C",
      SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0",
      ...(process.env.SOURCE_COMMIT ? { SOURCE_COMMIT: process.env.SOURCE_COMMIT } : {}),
    },
  });
  return join(work, "dist");
}

const dirs = [buildIn("a"), buildIn("b")];
const [a, b] = dirs as [string, string];
const files = walk(a);
let diff = walk(b).join() !== files.join();
if (diff) console.error("file lists differ");
for (const f of files) {
  const ha = sha(join(a, f));
  const hb = sha(join(b, f));
  if (ha !== hb) {
    diff = true;
    console.error(`DIFFERS ${f}`);
  } else {
    console.log(`identical ${f} sha256=${ha}`);
  }
}

const i = process.argv.indexOf("--against");
const against = i > 0 ? process.argv[i + 1] : undefined;
if (against) {
  for (const f of walk(a).filter((x) => !x.startsWith("npm/types"))) {
    if (sha(join(a, f)) !== sha(join(against, f))) {
      diff = true;
      console.error(`DIFFERS from ${against}: ${f}`);
    }
  }
}

for (const d of dirs) rmSync(join(d, "..", ".."), { recursive: true, force: true });
if (diff) {
  console.error("reproducible: NO");
  process.exit(1);
}
console.log(
  `reproducible: yes (${files.length} files, two clean builds${against ? ` and ${against}` : ""})`,
);
