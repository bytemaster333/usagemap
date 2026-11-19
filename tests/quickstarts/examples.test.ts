// SPDX-License-Identifier: Apache-2.0
// docs.quickstarts-run, tracker.ssr-frameworks, api.dual-export: every example under examples/ is copy-paste material, so its README cannot drift from its
// code. No network, no build. For every examples/<name>/:
//   - README.md has the five sections in order ("Run it" with exactly three steps: install, set the key, run; "The
//     lines that add UsageMap"; "What you'll see in the portal"; "Test it without the app"; "Tested by");
//   - every code block under "The lines that add UsageMap" is copied verbatim from the file named right above it
//     (a line that is just `// …` or `# …` marks an elision; the pieces between must appear in order);
//   - its guide link resolves into docs/onboarding/, and "Tested by" names a path under tests/ that exists;
//   - every package.json dependency is an exact version (or a link into this repository);
//   - examples/README.md lists it with the same guide.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/env.ts";

const EXAMPLES = join(REPO_ROOT, "examples");
const SECTIONS = [
  "Run it",
  "The lines that add UsageMap",
  "What you'll see in the portal",
  "Test it without the app",
  "Tested by",
];
const ELISION = /^\s*(\/\/|#|<!--|\{\/\*)\s*…\s*(-->|\*\/\})?\s*$/;

const exampleDirs = (): string[] =>
  readdirSync(EXAMPLES)
    .filter((d) => !d.startsWith(".") && d !== "node_modules")
    .filter((d) => statSync(join(EXAMPLES, d)).isDirectory())
    .sort();

/** `## Heading` → body, in document order (code fences are not headings). */
function sections(md: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let fence = false;
  let cur: { heading: string; lines: string[] } | undefined;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^## (.+)$/.exec(line);
    if (m) {
      if (cur) out.push({ heading: cur.heading, body: cur.lines.join("\n") });
      cur = { heading: (m[1] as string).trim(), lines: [] };
    } else cur?.lines.push(line);
  }
  if (cur) out.push({ heading: cur.heading, body: cur.lines.join("\n") });
  return out;
}

/** Code blocks of a section, each with the file named in the paragraph right above it (`path`:). */
function namedBlocks(body: string): { file: string | undefined; code: string }[] {
  const out: { file: string | undefined; code: string }[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```/.exec(lines[i] as string);
    if (!open) continue;
    let j = i - 1;
    while (j >= 0 && (lines[j] as string).trim() === "") j--;
    const named = /^`([^`]+)`:\s*$/.exec((lines[j] ?? "").trim());
    const indent = (open[1] as string).length;
    const code: string[] = [];
    i++;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) {
      code.push((lines[i] as string).slice(indent));
      i++;
    }
    out.push({ file: named?.[1], code: code.join("\n") });
  }
  return out;
}

/** Whether `code` is a verbatim excerpt of `file` (pieces between elision lines contiguous and in order). */
function isExcerpt(code: string, file: string): boolean {
  const fileLines = file.split("\n").map((l) => l.trimEnd());
  const pieces: string[][] = [[]];
  for (const l of code.split("\n")) {
    if (ELISION.test(l)) pieces.push([]);
    else (pieces[pieces.length - 1] as string[]).push(l.trimEnd());
  }
  let from = 0;
  for (const piece of pieces) {
    while (piece.length && piece[0] === "") piece.shift();
    while (piece.length && piece[piece.length - 1] === "") piece.pop();
    if (piece.length === 0) continue;
    let found = -1;
    for (let k = from; k + piece.length <= fileLines.length; k++)
      if (piece.every((l, n) => fileLines[k + n] === l)) {
        found = k;
        break;
      }
    if (found < 0) return false;
    from = found + piece.length;
  }
  return true;
}

describe("the README parser", () => {
  it("finds sections outside code fences and the file named above each block", () => {
    const md = [
      "# T",
      "## Run it",
      "```sh",
      "## not a heading",
      "```",
      "## The lines that add UsageMap",
      "`src/a.ts`:",
      "",
      "```ts",
      "a",
      "// …",
      "c",
      "```",
    ].join("\n");
    const s = sections(md);
    expect(s.map((x) => x.heading)).toEqual(["Run it", "The lines that add UsageMap"]);
    expect(namedBlocks(s[1]?.body ?? "")).toEqual([{ file: "src/a.ts", code: "a\n// …\nc" }]);
  });

  it("accepts verbatim excerpts with elisions, in order, and nothing else", () => {
    const f = "a\nb\nc\nd\n";
    expect(isExcerpt("b\nc", f)).toBe(true);
    expect(isExcerpt("a\n// …\nd", f)).toBe(true);
    expect(isExcerpt("a\n# …\nc\nd", f)).toBe(true);
    expect(isExcerpt("d\n// …\na", f)).toBe(false);
    expect(isExcerpt("a\nc", f)).toBe(false);
    expect(isExcerpt("b \nc", f)).toBe(true); // trailing spaces do not count
  });
});

describe("every example has a README that matches its code", () => {
  const index = readFileSync(join(EXAMPLES, "README.md"), "utf8");

  for (const dir of exampleDirs()) {
    describe(`examples/${dir}`, () => {
      const root = join(EXAMPLES, dir);
      const readmePath = join(root, "README.md");

      it("has a README with the five sections and three steps", () => {
        expect(existsSync(readmePath), "README.md").toBe(true);
        const md = readFileSync(readmePath, "utf8");
        expect(md.split("\n")[0]).toMatch(/^# \S/);
        const heads = sections(md).map((s) => s.heading);
        expect(heads.slice(0, SECTIONS.length)).toEqual(SECTIONS);
        const steps = (sections(md)[0]?.body ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
        expect(steps).toHaveLength(3);
        expect(steps[0]).toMatch(/^1\. \*\*Install/);
        expect(steps[1]).toMatch(/^2\. \*\*Set/);
        expect(steps[2]).toMatch(/^3\. \*\*Run/);
      });

      it("shows the lines that add UsageMap verbatim from the example's files", () => {
        const md = readFileSync(readmePath, "utf8");
        const body = sections(md).find((s) => s.heading === SECTIONS[1])?.body ?? "";
        const blocks = namedBlocks(body);
        expect(blocks.length, "at least one code block").toBeGreaterThan(0);
        for (const b of blocks) {
          expect(b.file, `block without a \`file\`: line above it:\n${b.code}`).toBeDefined();
          const p = normalize(join(root, b.file as string));
          expect(p.startsWith(root) || p.startsWith(REPO_ROOT), b.file).toBe(true);
          expect(existsSync(p), `${b.file} exists`).toBe(true);
          expect(isExcerpt(b.code, readFileSync(p, "utf8")), `${b.file}:\n${b.code}`).toBe(true);
        }
      });

      it("links its guide, names its test, and is in the index with that guide", () => {
        const md = readFileSync(readmePath, "utf8");
        const guides = [
          ...md.matchAll(/\]\((\.\.\/\.\.\/docs\/onboarding\/[^)#\s]+)(#[^)\s]*)?\)/g),
        ];
        expect(guides.length, "a link into docs/onboarding").toBeGreaterThan(0);
        for (const g of guides)
          expect(existsSync(normalize(join(root, g[1] as string))), g[1]).toBe(true);
        const tested = sections(md).find((s) => s.heading === "Tested by")?.body ?? "";
        const paths = [...tested.matchAll(/`(tests\/[^`\s]+)`/g)].map((m) => m[1] as string);
        expect(paths.length, "a tests/ path in Tested by").toBeGreaterThan(0);
        for (const p of paths) expect(existsSync(join(REPO_ROOT, p)), p).toBe(true);

        const row = index.split("\n").find((l) => l.startsWith(`| [\`${dir}\`](${dir}/)`));
        expect(row, `examples/README.md row for ${dir}`).toBeDefined();
        const first = String(guides[0]?.[1]).replace("../../docs/", "../docs/");
        expect(row).toContain(first);
      });

      it("pins every dependency exactly", () => {
        const pkg = join(root, "package.json");
        if (!existsSync(pkg)) return;
        const j = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, Record<string, string>>;
        for (const field of ["dependencies", "devDependencies"])
          for (const [name, v] of Object.entries(j[field] ?? {}))
            expect(v, `${field}.${name}`).toMatch(
              /^(\d+\.\d+\.\d+(-[\w.]+)?|(link|file):\.\.\/\.\.\/.+)$/,
            );
      });
    });
  }

  it("the index lists no example that does not exist", () => {
    const listed = [...index.matchAll(/^\| \[`([^`]+)`\]\(\1\/\)/gm)].map((m) => m[1] as string);
    expect([...new Set(listed)].sort()).toEqual(exampleDirs());
    for (const m of index.matchAll(/\]\((\.\.\/docs\/[^)#\s]+)/g))
      expect(existsSync(normalize(join(EXAMPLES, m[1] as string))), m[1]).toBe(true);
    expect(dirname(EXAMPLES)).toBe(REPO_ROOT);
  });
});
