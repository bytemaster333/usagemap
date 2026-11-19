// SPDX-License-Identifier: Apache-2.0
// Publishes the agent skill (docs/ai/usagemap-instrument/SKILL.md, the one source) at /SKILL.md and at the Agent
// Skills path /skills/usagemap-instrument/SKILL.md. Runs before `next build` and `next dev`.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = join(root, "..", "..", "docs", "ai", "usagemap-instrument", "SKILL.md");
const targets = [
  join(root, "public", "SKILL.md"),
  join(root, "public", "skills", "usagemap-instrument", "SKILL.md"),
];
for (const t of targets) {
  mkdirSync(join(t, ".."), { recursive: true });
  copyFileSync(source, t);
}
console.log(`skill: ${source} -> ${targets.length} files`);
