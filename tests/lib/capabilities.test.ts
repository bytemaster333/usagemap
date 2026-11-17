// SPDX-License-Identifier: Apache-2.0
// Every capability id a suite records as evidence (`rec.start(ctx, [...])`, `ids: [...]`) is a row of
// docs/capabilities.md, and the parser reads that document's table format.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_ID, loadCapabilities, parseCapabilities } from "./capabilities.ts";
import { REPO_ROOT } from "./env.ts";

const TESTS = join(REPO_ROOT, "tests");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "fixtures" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(name) && !name.endsWith("capabilities.test.ts")) out.push(p);
  }
  return out;
}

/** Capability ids recorded by the suites, with where they appear. */
function recordedIds(): { id: string; at: string }[] {
  const found: { id: string; at: string }[] = [];
  for (const file of sources(TESTS)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:\bids:\s*|\.start\(\s*ctx\s*,\s*)\[([^\]]*)\]/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      for (const s of (m[1] as string).matchAll(/["'`]([^"'`]+)["'`]/g))
        found.push({ id: s[1] as string, at: `${relative(REPO_ROOT, file)}:${line}` });
    }
  }
  return found;
}

describe("capability ids (docs/capabilities.md)", () => {
  it("parses the backticked first cell of table rows only", () => {
    const md = [
      "| ID | Capability |",
      "|---|---|",
      "| `web.frontend-origin-only` | Events originate only from frontend code |",
      "| `api.attr-route` | Normalised path |",
      "| not-an-id | prose |",
      "| `C-104` | a decision, not a capability |",
      "Text mentioning `metric.pageviews` outside a table.",
    ].join("\n");
    expect([...parseCapabilities(md)].sort()).toEqual([
      "api.attr-route",
      "web.frontend-origin-only",
    ]);
  });

  it("the document defines capabilities", () => {
    expect(loadCapabilities().size).toBeGreaterThan(100);
  });

  it("every id a suite records as evidence is a capability", () => {
    const known = loadCapabilities();
    const recorded = recordedIds();
    expect(recorded.length).toBeGreaterThan(30);
    const unknown = recorded.filter((r) => !CAPABILITY_ID.test(r.id) || !known.has(r.id));
    expect(unknown.map((u) => `${u.at}: ${u.id}`)).toEqual([]);
  });
});
