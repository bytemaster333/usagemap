// SPDX-License-Identifier: Apache-2.0
// Pure functions of the coverage report (test.automated-suite): parse and merge Go cover profiles, turn them into per-package line
// and statement coverage, read vitest's v8 `json-summary`, and render one summary (JSON + Markdown). No I/O here;
// `run.ts` runs the tests and writes the files. Node standard library only.

import { posix } from "node:path";

/** One basic block of a Go cover profile: `file:startLine.startCol,endLine.endCol numStmts count`. */
export interface GoBlock {
  file: string; // import path + file name, e.g. github.com/x/y/z.go
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  stmts: number;
  count: number;
}

export interface GoProfile {
  mode: "set" | "count" | "atomic";
  blocks: GoBlock[];
}

const BLOCK = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/;

/** Parses a Go cover profile. Throws on a malformed line (a truncated profile must not pass as a low figure). */
export function parseGoProfile(text: string): GoProfile {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("empty cover profile");
  const head = /^mode: (set|count|atomic)$/.exec(lines[0] ?? "");
  if (!head)
    throw new Error(`cover profile: first line is not a mode line: ${JSON.stringify(lines[0])}`);
  const blocks: GoBlock[] = [];
  for (const [i, line] of lines.slice(1).entries()) {
    if (line.startsWith("mode: ")) continue; // concatenated profiles repeat the mode line
    const m = BLOCK.exec(line);
    if (!m) throw new Error(`cover profile line ${i + 2} malformed: ${JSON.stringify(line)}`);
    const [, file, sl, sc, el, ec, n, c] = m;
    blocks.push({
      file: file as string,
      startLine: Number(sl),
      startCol: Number(sc),
      endLine: Number(el),
      endCol: Number(ec),
      stmts: Number(n),
      count: Number(c),
    });
  }
  return { mode: head[1] as GoProfile["mode"], blocks };
}

const blockKey = (b: GoBlock) => `${b.file}:${b.startLine}.${b.startCol},${b.endLine}.${b.endCol}`;

/** Merges profiles (several modules, or `-coverpkg` runs that cover the same block): the same block is one block,
 *  counts are added. A block whose statement count differs between profiles means two different sources — refused. */
export function mergeGoProfiles(profiles: GoProfile[]): GoProfile {
  const byKey = new Map<string, GoBlock>();
  for (const p of profiles) {
    for (const b of p.blocks) {
      const k = blockKey(b);
      const seen = byKey.get(k);
      if (!seen) {
        byKey.set(k, { ...b });
        continue;
      }
      if (seen.stmts !== b.stmts)
        throw new Error(
          `cover profiles disagree on block ${k}: ${seen.stmts} vs ${b.stmts} statements`,
        );
      seen.count += b.count;
    }
  }
  const blocks = [...byKey.values()].sort((a, b) =>
    a.file === b.file
      ? a.startLine - b.startLine || a.startCol - b.startCol
      : a.file < b.file
        ? -1
        : 1,
  );
  return { mode: profiles.some((p) => p.mode !== "set") ? "atomic" : "set", blocks };
}

export function formatGoProfile(p: GoProfile): string {
  const out = [`mode: ${p.mode}`];
  for (const b of p.blocks) out.push(`${blockKey(b)} ${b.stmts} ${b.count}`);
  return `${out.join("\n")}\n`;
}

export interface Ratio {
  total: number;
  covered: number;
  pct: number; // 0–100, one decimal; 100 when total is 0 (nothing to cover)
}

export const ratio = (covered: number, total: number): Ratio => ({
  total,
  covered,
  pct: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10,
});

export interface PackageCoverage {
  name: string;
  lines: Ratio;
  statements: Ratio;
  files: number;
}

/** Per Go package (the directory of the file's import path): a line counts once; it is covered when any block that
 *  spans it ran. Statements are Go's own figure (`go tool cover -func` total). */
export function goPackageCoverage(p: GoProfile): PackageCoverage[] {
  interface Acc {
    lines: Map<string, boolean>; // "file:line" → covered
    stmts: number;
    stmtsCovered: number;
    files: Set<string>;
  }
  const pkgs = new Map<string, Acc>();
  for (const b of p.blocks) {
    const pkg = posix.dirname(b.file);
    let a = pkgs.get(pkg);
    if (!a) {
      a = { lines: new Map(), stmts: 0, stmtsCovered: 0, files: new Set() };
      pkgs.set(pkg, a);
    }
    a.files.add(b.file);
    a.stmts += b.stmts;
    if (b.count > 0) a.stmtsCovered += b.stmts;
    for (let l = b.startLine; l <= b.endLine; l++) {
      const k = `${b.file}:${l}`;
      a.lines.set(k, (a.lines.get(k) ?? false) || b.count > 0);
    }
  }
  return [...pkgs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, a]) => {
      const covered = [...a.lines.values()].filter(Boolean).length;
      return {
        name,
        lines: ratio(covered, a.lines.size),
        statements: ratio(a.stmtsCovered, a.stmts),
        files: a.files.size,
      };
    });
}

/** The subset of vitest's / istanbul's `coverage-summary.json` we read. */
export interface IstanbulSummary {
  total: {
    lines: { total: number; covered: number };
    statements: { total: number; covered: number };
  };
  [file: string]: {
    lines: { total: number; covered: number };
    statements: { total: number; covered: number };
  };
}

export function tsPackageCoverage(name: string, s: IstanbulSummary): PackageCoverage {
  if (!s?.total?.lines || typeof s.total.lines.total !== "number")
    throw new Error(`${name}: not a json-summary file`);
  return {
    name,
    lines: ratio(s.total.lines.covered, s.total.lines.total),
    statements: ratio(s.total.statements.covered, s.total.statements.total),
    files: Object.keys(s).filter((k) => k !== "total").length,
  };
}

export const sumCoverage = (name: string, parts: PackageCoverage[]): PackageCoverage => {
  const add = (f: (p: PackageCoverage) => Ratio) =>
    ratio(
      parts.reduce((n, p) => n + f(p).covered, 0),
      parts.reduce((n, p) => n + f(p).total, 0),
    );
  return {
    name,
    lines: add((p) => p.lines),
    statements: add((p) => p.statements),
    files: parts.reduce((n, p) => n + p.files, 0),
  };
};

export type RunStatus = "passed" | "failed";

export interface UnitResult {
  /** A Go module directory or a TS workspace package directory, relative to the repository root. */
  unit: string;
  status: RunStatus;
  /** What was run, e.g. `go test ./...` or `vitest run --project unit`. */
  command: string;
  /** What this run does not include and why (integration projects need Docker, …). */
  excluded: string[];
  total: PackageCoverage;
  packages: PackageCoverage[];
}

export interface Summary {
  schema: "scf-coverage/1";
  generated_at: string;
  commit: string;
  dirty: boolean;
  mode: "unit" | "all";
  go: { total: PackageCoverage; modules: UnitResult[] };
  ts: { total: PackageCoverage; packages: UnitResult[] };
  total: PackageCoverage;
  failed: string[];
}

export function buildSummary(args: {
  generatedAt: Date;
  commit: string;
  dirty: boolean;
  mode: "unit" | "all";
  go: UnitResult[];
  ts: UnitResult[];
}): Summary {
  const goTotal = sumCoverage(
    "go",
    args.go.map((u) => u.total),
  );
  const tsTotal = sumCoverage(
    "typescript",
    args.ts.map((u) => u.total),
  );
  return {
    schema: "scf-coverage/1",
    generated_at: args.generatedAt.toISOString(),
    commit: args.commit,
    dirty: args.dirty,
    mode: args.mode,
    go: { total: goTotal, modules: args.go },
    ts: { total: tsTotal, packages: args.ts },
    total: sumCoverage("all", [goTotal, tsTotal]),
    failed: [...args.go, ...args.ts].filter((u) => u.status === "failed").map((u) => u.unit),
  };
}

const pct = (r: Ratio) => `${r.pct.toFixed(1)} %`;
const frac = (r: Ratio) => `${r.covered} / ${r.total}`;

export function renderMarkdown(s: Summary): string {
  const out: string[] = [];
  out.push("# Test coverage summary (test.automated-suite)", "");
  out.push(
    `Commit \`${s.commit}\`${s.dirty ? " (dirty tree)" : ""} · generated ${s.generated_at} · mode \`${s.mode}\` ` +
      `(${s.mode === "unit" ? "unit tests only; suites that need Docker are listed as excluded" : "unit and integration suites"})`,
    "",
  );
  if (s.failed.length > 0)
    out.push(`**Test failures in:** ${s.failed.map((f) => `\`${f}\``).join(", ")}`, "");
  out.push("| Scope | Lines | Line % | Statement % |", "|---|---:|---:|---:|");
  for (const t of [s.go.total, s.ts.total, s.total])
    out.push(`| ${t.name} | ${frac(t.lines)} | ${pct(t.lines)} | ${pct(t.statements)} |`);
  out.push("");
  const section = (title: string, units: UnitResult[], perPackage: boolean) => {
    out.push(
      `## ${title}`,
      "",
      "| Unit | Result | Lines | Line % | Statement % | Command |",
      "|---|---|---:|---:|---:|---|",
    );
    for (const u of units) {
      out.push(
        `| \`${u.unit}\` | ${u.status} | ${frac(u.total.lines)} | ${pct(u.total.lines)} | ${pct(u.total.statements)} | \`${u.command}\` |`,
      );
    }
    out.push("");
    const ex = units.filter((u) => u.excluded.length > 0);
    if (ex.length > 0) {
      out.push("Not included in this run:", "");
      for (const u of ex) for (const e of u.excluded) out.push(`- \`${u.unit}\`: ${e}`);
      out.push("");
    }
    if (perPackage) {
      out.push(
        `### ${title}: per package`,
        "",
        "| Package | Files | Lines | Line % | Statement % |",
        "|---|---:|---:|---:|---:|",
      );
      for (const u of units)
        for (const p of u.packages)
          out.push(
            `| \`${p.name}\` | ${p.files} | ${frac(p.lines)} | ${pct(p.lines)} | ${pct(p.statements)} |`,
          );
      out.push("");
    }
  };
  section("Go modules", s.go.modules, true);
  section("TypeScript packages", s.ts.packages, false);
  return `${out.join("\n")}\n`;
}

/** `use (...)` entries of a go.work file, without the leading `./`. */
export function goWorkModules(goWork: string): string[] {
  const out: string[] = [];
  const block = /use\s*\(([^)]*)\)/s.exec(goWork);
  const single = [...goWork.matchAll(/^use\s+([^\s(]\S*)\s*$/gm)].map((m) => m[1] as string);
  const entries = block
    ? (block[1] as string).split("\n").map((l) => l.replace(/\/\/.*$/, "").trim())
    : [];
  for (const e of [...entries, ...single]) if (e !== "") out.push(e.replace(/^\.\//, ""));
  return out;
}
