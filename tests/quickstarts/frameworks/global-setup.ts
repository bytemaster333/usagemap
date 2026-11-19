// SPDX-License-Identifier: Apache-2.0
// Global setup of the framework quickstarts: build the tracker from the checked-out source, install the example
// apps from their own frozen lockfile (examples/pnpm-lock.yaml), make sure the installed tracker package is the one
// just built, then build every selected app in production mode with its guide's site-key variable set.
// QS_FRAMEWORKS_SKIP_BUILD=1 reuses the previous builds (local iteration only).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SITE } from "../../../tracker/test/protocol.ts";
import { REPO_ROOT } from "../../lib/env.ts";
import { appEnv, EXAMPLES, selectedApps } from "./apps.ts";

const TRACKER = join(REPO_ROOT, "tracker");
/** Where pnpm puts the tracker (a `file:` directory dependency is injected: copied, not linked). */
const INJECTED = join(EXAMPLES, "node_modules/.pnpm/@usagemap+tracker@file+..+tracker");
const INSTALLED = join(INJECTED, "node_modules/@usagemap/tracker");

const run = (cmd: string, args: string[], cwd: string, env = process.env) =>
  execFileSync(cmd, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });

/** Files of dist/npm that differ between the tracker build and the installed package. */
function staleTrackerFiles(): string[] {
  const src = join(TRACKER, "dist/npm");
  const dst = join(INSTALLED, "dist/npm");
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(src.length + 1));
  return files.filter((f) => {
    try {
      return !readFileSync(join(src, f)).equals(readFileSync(join(dst, f)));
    } catch {
      return true;
    }
  });
}

export default function setup(): void {
  run(process.execPath, ["scripts/build.ts"], TRACKER);
  run("pnpm", ["install", "--frozen-lockfile", "--reporter=append-only"], EXAMPLES);
  if (staleTrackerFiles().length > 0) {
    // the tracker changed since the last install: pnpm copies it again when its directory is gone
    rmSync(INJECTED, { recursive: true, force: true });
    run("pnpm", ["install", "--frozen-lockfile", "--reporter=append-only"], EXAMPLES);
    const still = staleTrackerFiles();
    if (still.length)
      throw new Error(`installed tracker differs from the build: ${still.join(", ")}`);
  }
  const version = (
    JSON.parse(readFileSync(join(INSTALLED, "package.json"), "utf8")) as { version: string }
  ).version;
  const built = (
    JSON.parse(readFileSync(join(TRACKER, "package.json"), "utf8")) as { version: string }
  ).version;
  if (version !== built) throw new Error(`installed tracker ${version}, built ${built}`);

  if (process.env.QS_FRAMEWORKS_SKIP_BUILD === "1") return;
  for (const app of selectedApps()) {
    if (app.id === "html") continue; // nothing to build
    const t0 = Date.now();
    run("pnpm", ["run", "--silent", "build"], join(EXAMPLES, app.id), appEnv(app, SITE, "build"));
    console.log(`built examples/${app.id} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
