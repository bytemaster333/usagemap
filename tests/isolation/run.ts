// SPDX-License-Identifier: Apache-2.0
// Isolation-matrix runner (isolation.tenant-rls): one report from the database matrix (db/tests: RLS FORCE
// and backstop on every table and partition, no partition grants, security_invoker views, definer allow-list,
// cross-tenant matrix, op_* functions, transaction-local tenant context) and the HTTP matrix
// (services/control-plane/test/integration/isolation.test.ts: every operation × role × own/foreign/unknown/malformed
// id, generated from the OpenAPI document).
//
//   node isolation/run.ts                         # HTTP matrix run here (project scf-wsl-iso, ports 56310/56311);
//                                                 # DB matrix only with --run-db or --db-json
//   node isolation/run.ts --run-db                # also runs db/tests (its own project scf-wse, ports 56100/56101)
//   node isolation/run.ts --db-json f --http-json g   # aggregate outputs produced elsewhere
//
// The report states for each part whether it ran here, came from a file, or did not run.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { loadEnv, REPO_ROOT } from "../lib/env.ts";
import { type Check, writeEvidence } from "../lib/evidence.ts";
import { type Case, caseRows, parseGoTestJson, parseVitestJson, totals } from "./parse.ts";

const run = promisify(execFile);
const { values: a } = parseArgs({
  options: {
    "run-db": { type: "boolean", default: false },
    "db-json": { type: "string" },
    "http-json": { type: "string" },
    "skip-http": { type: "boolean", default: false },
    "no-evidence": { type: "boolean", default: false },
  },
});
const env = loadEnv();
mkdirSync(env.workDir, { recursive: true });

const DB_TESTS =
  "^(TestCrossTenantMatrix|TestCrossTenantMatrixCatchesHoles|TestPartitionsUnreachable|TestSetTenantCtx.*|TestTenantContextReadsOwnRows|TestOp.*|TestGates.*|TestGateG.*)$";

async function execJson(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
) {
  try {
    const r = await run(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      maxBuffer: 256 * 1024 * 1024,
      timeout: 1_800_000,
    });
    return { stdout: r.stdout, code: 0, stderr: r.stderr };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: x.stdout ?? "", code: x.code ?? 1, stderr: x.stderr ?? "" };
  }
}

interface Part {
  cases: Case[];
  source: string;
  ran: boolean;
  note: string;
}

async function dbPart(): Promise<Part> {
  if (a["db-json"])
    return {
      cases: parseGoTestJson(readFileSync(a["db-json"], "utf8")),
      source: `file ${a["db-json"]}`,
      ran: true,
      note: "",
    };
  if (!a["run-db"])
    return {
      cases: [],
      source: "not run",
      ran: false,
      note: "db/tests uses its own Compose project (scf-wse, ports 56100/56101); run with --run-db or pass --db-json",
    };
  const r = await execJson(
    "go",
    ["test", "-json", "-count=1", "-run", DB_TESTS, "./..."],
    join(REPO_ROOT, "db/tests"),
    {},
  );
  return {
    cases: parseGoTestJson(r.stdout),
    source: "go test -json in db/tests (run here)",
    ran: true,
    note: r.code ? `exit ${r.code}` : "",
  };
}

async function httpPart(): Promise<Part> {
  if (a["http-json"])
    return {
      cases: parseVitestJson(readFileSync(a["http-json"], "utf8")),
      source: `file ${a["http-json"]}`,
      ran: true,
      note: "",
    };
  if (a["skip-http"]) return { cases: [], source: "not run", ran: false, note: "--skip-http" };
  const out = join(env.workDir, "http-isolation.json");
  const r = await execJson(
    "pnpm",
    [
      "--filter",
      "@usagemap/control-plane",
      "exec",
      "vitest",
      "run",
      // the control plane's own integration settings + an assertion counter (cases per test)
      "--config",
      join(REPO_ROOT, "tests/isolation/vitest.http.config.ts"),
      "--reporter=json",
      `--outputFile=${out}`,
    ],
    REPO_ROOT,
    // the control plane's harness takes its database stack's project and ports from these (the tests/ port range by
    // default; SCF_ISO_PG_PROJECT / SCF_ISO_PG_PORT / SCF_ISO_PGB_PORT move it, e.g. for a second run on one host)
    {
      SCF_WSF_PG_PROJECT: process.env.SCF_ISO_PG_PROJECT ?? "scf-wsl-iso",
      SCF_WSF_PG_PORT: process.env.SCF_ISO_PG_PORT ?? "56310",
      SCF_WSF_PGB_PORT: process.env.SCF_ISO_PGB_PORT ?? "56311",
    },
  );
  if (!existsSync(out))
    return {
      cases: [],
      source: "vitest (run here)",
      ran: true,
      note: `no report; exit ${r.code}: ${r.stderr.slice(-400)}`,
    };
  return {
    cases: parseVitestJson(readFileSync(out, "utf8")),
    source: `vitest --reporter=json on services/control-plane isolation.test.ts (run here, project ${process.env.SCF_ISO_PG_PROJECT ?? "scf-wsl-iso"})`,
    ran: true,
    note: r.code ? `exit ${r.code}` : "",
  };
}

const [db, http] = await Promise.all([dbPart(), httpPart()]);
const checks: Check[] = [];
for (const [label, p] of [
  ["Database isolation matrix and gates (db/tests)", db],
  ["HTTP isolation matrix (control plane, generated from the OpenAPI document)", http],
] as const) {
  const t = totals(p.cases);
  const rows = caseRows(p.cases);
  const cases = rows.reduce((n, r) => n + (r.cases ?? 0), 0);
  const unit = p === db ? "subtests" : "assertion cases";
  checks.push({
    name: label,
    outcome: !p.ran ? "not_run" : t.fail === 0 && t.pass > 0 ? "pass" : "fail",
    detail: `${p.source}; ${rows.length} top-level tests (${rows.filter((r) => r.outcome === "pass").length} passed, ${rows.filter((r) => r.outcome === "fail").length} failed) covering ${cases} ${unit}; all entries ${t.pass} passed, ${t.fail} failed, ${t.skip} skipped${p.note ? `; ${p.note}` : ""}`,
    ids: ["isolation.tenant-rls"],
  });
}
const all = [...db.cases, ...http.cases];
const failing = all.filter((c) => c.outcome === "fail");
const table = (s: Case["suite"], unit: string) => {
  const rows = caseRows(all.filter((c) => c.suite === s));
  if (!rows.length) return ["- not run"];
  return [
    `| Test | Outcome | ${unit} | Passed | Failed |`,
    "|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| \`${r.name.replace(/\|/g, "\\|")}\` | ${r.outcome.toUpperCase()} | ${r.cases ?? "unknown"} | ${r.passed ?? (r.outcome === "pass" ? (r.cases ?? "—") : "—")} | ${r.failed ?? (r.outcome === "fail" ? "≥ 1" : 0)} |`,
    ),
  ];
};
const notes = [
  "### Database part — per test (subtests)",
  "",
  ...table("db", "Subtests"),
  "",
  "### HTTP part — per test (assertions = operation × caller × identifier cases checked)",
  "",
  "A vitest test stops at its first failed assertion, so for a failed test the count is the cases checked up to the failure.",
  "",
  ...table("http", "Cases"),
  "",
  `### Failing cases: ${failing.length}`,
  "",
  ...failing.slice(0, 100).map((c) => `- [${c.suite}] ${c.name}`),
].join("\n");
for (const c of checks) console.log(`${c.outcome.toUpperCase().padEnd(8)} ${c.name} — ${c.detail}`);
if (!a["no-evidence"] && checks.some((c) => c.outcome !== "not_run")) {
  const out = writeEvidence(env.evidenceDir, {
    layer: "isolation",
    name: "matrix",
    title: "Isolation matrix: database and HTTP",
    summary:
      "One report over the two isolation suites: the database gate suite (RLS ENABLE + FORCE and the restrictive backstop on every table and partition, no partition grants, security_invoker views, the SECURITY DEFINER allow-list, the cross-tenant read/write matrix, op_* functions, transaction-local tenant context) and the HTTP matrix (every operation × role × own/foreign/unknown/malformed identifier, generated from the OpenAPI document). Each part says whether it ran here or was read from a CI artefact.",
    checks,
    data: {
      db: { source: db.source, totals: totals(db.cases), perTest: caseRows(db.cases) },
      http: { source: http.source, totals: totals(http.cases), perTest: caseRows(http.cases) },
      failing,
    },
    notes,
  });
  console.log(`evidence: ${out.md}`);
}
process.exit(checks.some((c) => c.outcome === "fail") ? 1 : 0);
