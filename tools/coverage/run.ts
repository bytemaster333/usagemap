// SPDX-License-Identifier: Apache-2.0
// Coverage report (test.automated-suite): runs every Go module of go.work with `go test -coverprofile` and every TypeScript workspace
// package with vitest `--coverage` (v8 provider), merges the Go profiles, and writes one summary:
//   coverage/summary.json, coverage/summary.md, coverage/go/merged.out, coverage/go/<module>.out,
//   coverage/ts/<package>/coverage-summary.json (+ lcov for upload).
//
//   node tools/coverage/run.ts                 # unit mode: everything that needs no Docker
//   node tools/coverage/run.ts --mode all      # also integration/contract suites (Docker)
//   node tools/coverage/run.ts --only go|ts    # one language
//   node tools/coverage/run.ts --fail-under 60 # exit 1 when total line coverage is below 60 %
//
// Exit code 1 when any test run failed (the summary is still written and names the failures), 2 on usage errors.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildSummary,
  formatGoProfile,
  type GoProfile,
  goPackageCoverage,
  goWorkModules,
  type IstanbulSummary,
  mergeGoProfiles,
  parseGoProfile,
  renderMarkdown,
  sumCoverage,
  tsPackageCoverage,
  type UnitResult,
} from "./lib.ts";
import { GO_EXCLUSIONS, TS_TARGETS } from "./targets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "unit" },
    only: { type: "string" },
    out: { type: "string", default: "coverage" },
    "fail-under": { type: "string" },
  },
});
const mode = values.mode;
if (mode !== "unit" && mode !== "all") {
  console.error("--mode must be unit or all");
  process.exit(2);
}
if (values.only !== undefined && values.only !== "go" && values.only !== "ts") {
  console.error("--only must be go or ts");
  process.exit(2);
}
const OUT = join(ROOT, values.out);
const slug = (p: string) => p.replace(/[^A-Za-z0-9]+/g, "-");

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function runGo(): UnitResult[] {
  const modules = goWorkModules(readFileSync(join(ROOT, "go.work"), "utf8"));
  mkdirSync(join(OUT, "go"), { recursive: true });
  const results: UnitResult[] = [];
  const profiles: GoProfile[] = [];
  for (const mod of modules) {
    const out = join(OUT, "go", `${slug(mod)}.out`);
    rmSync(out, { force: true });
    const args = ["test", "-count=1", "-covermode=atomic", `-coverprofile=${out}`, "./..."];
    // unit mode: no Docker, and (as in `make test` of the build job) no Collector end to end and no writer load run —
    // the job `metrics writer unit and integration` runs those with the built Collector
    const unitEnv = {
      SCF_SKIP_DOCKER_TESTS: "1",
      SCF_SKIP_COLLECTOR_E2E: "1",
      SCF_WSD_LOAD_SECONDS: "0",
    };
    const env = { ...process.env, ...(mode === "unit" ? unitEnv : {}) };
    console.log(
      `\n== go ${mod}: go ${args.join(" ")}${
        mode === "unit"
          ? ` (${Object.entries(unitEnv)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")})`
          : ""
      }`,
    );
    const r = spawnSync("go", args, { cwd: join(ROOT, mod), env, stdio: "inherit" });
    const ex = GO_EXCLUSIONS[mod];
    const excluded = [...(mode === "unit" ? (ex?.unit ?? []) : []), ...(ex?.always ?? [])];
    let packages: UnitResult["packages"] = [];
    if (existsSync(out)) {
      const p = parseGoProfile(readFileSync(out, "utf8"));
      profiles.push(p);
      packages = goPackageCoverage(p);
    }
    results.push({
      unit: mod,
      status: r.status === 0 && existsSync(out) ? "passed" : "failed",
      command: `go test -covermode=atomic ./...${
        mode === "unit"
          ? ` (${Object.entries(unitEnv)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")})`
          : ""
      }`,
      excluded,
      total: sumCoverage(mod, packages),
      packages,
    });
  }
  if (profiles.length > 0)
    writeFileSync(join(OUT, "go", "merged.out"), formatGoProfile(mergeGoProfiles(profiles)));
  return results;
}

function runTs(): UnitResult[] {
  const results: UnitResult[] = [];
  for (const t of TS_TARGETS) {
    const dir = join(OUT, "ts", slug(t.dir));
    rmSync(dir, { recursive: true, force: true });
    const projectArgs = mode === "unit" ? t.unitArgs : [];
    const args = [
      "exec",
      "vitest",
      "run",
      ...projectArgs,
      "--coverage.enabled",
      "--coverage.provider=v8",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=lcovonly",
      `--coverage.reportsDirectory=${dir}`,
      ...t.include.map((g) => `--coverage.include=${g}`),
    ];
    console.log(`\n== ts ${t.dir}: pnpm ${args.join(" ")}`);
    const r = spawnSync("pnpm", args, { cwd: join(ROOT, t.dir), stdio: "inherit" });
    const file = join(dir, "coverage-summary.json");
    const excluded = [...(mode === "unit" ? t.excludedInUnit : []), ...t.neverRun];
    const pkg = existsSync(file)
      ? tsPackageCoverage(t.dir, JSON.parse(readFileSync(file, "utf8")) as IstanbulSummary)
      : sumCoverage(t.dir, []);
    results.push({
      unit: t.dir,
      status: r.status === 0 && existsSync(file) ? "passed" : "failed",
      command: `vitest run ${projectArgs.join(" ")} --coverage (v8)`.replace(/\s+/g, " "),
      excluded,
      total: pkg,
      packages: [pkg],
    });
  }
  return results;
}

mkdirSync(OUT, { recursive: true });
const go = values.only === "ts" ? [] : runGo();
const ts = values.only === "go" ? [] : runTs();
const summary = buildSummary({
  generatedAt: new Date(),
  commit: git("rev-parse", "--short=12", "HEAD") || "unknown",
  dirty: git("status", "--porcelain") !== "",
  mode,
  go,
  ts,
});
writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const md = renderMarkdown(summary);
writeFileSync(join(OUT, "summary.md"), md);
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: "a" });

console.log(`\ncoverage: ${relative(ROOT, join(OUT, "summary.md"))}`);
for (const t of [summary.go.total, summary.ts.total, summary.total]) {
  console.log(
    `  ${t.name.padEnd(10)} lines ${t.lines.covered}/${t.lines.total} = ${t.lines.pct.toFixed(1)} %`,
  );
}
let code = 0;
if (summary.failed.length > 0) {
  console.error(`test failures in: ${summary.failed.join(", ")}`);
  code = 1;
}
const floor = values["fail-under"] === undefined ? undefined : Number(values["fail-under"]);
if (floor !== undefined && summary.total.lines.pct < floor) {
  console.error(
    `total line coverage ${summary.total.lines.pct} % is below --fail-under ${floor} %`,
  );
  code = 1;
}
process.exit(code);
