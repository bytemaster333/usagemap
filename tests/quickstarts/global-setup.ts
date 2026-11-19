// SPDX-License-Identifier: Apache-2.0
// Unit project setup: quickstarts/extract.test.ts compares the SRI hash the script-tag guide states with the tracker
// build's manifest (tracker/dist/<version>/manifest.json). dist/ is git-ignored, so a clean checkout has none; the
// tracker build is reproducible and takes well under a second, so it is built from the checked-out source here
// instead of depending on an earlier job step having built it.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/env.ts";

export default function setup(): void {
  execFileSync(process.execPath, ["scripts/build.ts"], {
    cwd: join(REPO_ROOT, "tracker"),
    stdio: ["ignore", "ignore", "inherit"],
  });
}
