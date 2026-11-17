// SPDX-License-Identifier: Apache-2.0
// The capability ids of docs/capabilities.md: every table row whose first cell is a backticked `area.short-name`.
// Evidence files name the capabilities each check proves (lib/recorder.ts, lib/evidence.ts); those ids must exist
// there, so a renamed or removed capability cannot leave evidence pointing at nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.ts";

export const CAPABILITIES_DOC = join(REPO_ROOT, "docs/capabilities.md");

/** The form of a capability id: lowercase area, a dot, a kebab-case name. */
export const CAPABILITY_ID = /^[a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Capability ids defined by the document's tables (first cell of a row, in backticks). */
export function parseCapabilities(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const line of markdown.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m && CAPABILITY_ID.test(m[1] as string)) ids.add(m[1] as string);
  }
  return ids;
}

export function loadCapabilities(path: string = CAPABILITIES_DOC): Set<string> {
  return parseCapabilities(readFileSync(path, "utf8"));
}
