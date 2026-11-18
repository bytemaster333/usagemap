// SPDX-License-Identifier: Apache-2.0
// Parsers for the two isolation-matrix outputs aggregated by isolation/run.ts:
//   - `go test -json` of db/tests (RLS/grant/view/function gates, cross-tenant matrix, op_* functions, context);
//   - vitest's JSON reporter for services/control-plane/test/integration/isolation.test.ts (HTTP matrix).

export interface Case {
  suite: "db" | "http";
  name: string;
  /** Parent test for Go subtests (`TestCrossTenantMatrix/scf.sites/select`), "" for top level. */
  parent: string;
  outcome: "pass" | "fail" | "skip";
  ms?: number;
  /** HTTP part: `expect` assertions the test made = (operation × caller × identifier) cases it checked. */
  assertions?: number;
}

interface GoEvent {
  Action?: string;
  Test?: string;
  Elapsed?: number;
  Package?: string;
}

/** Final outcome per test and subtest from `go test -json` (one JSON object per line). */
export function parseGoTestJson(text: string): Case[] {
  const out = new Map<string, Case>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(line) as GoEvent;
    } catch {
      continue;
    }
    if (!e.Test || !e.Action || !["pass", "fail", "skip"].includes(e.Action)) continue;
    const slash = e.Test.indexOf("/");
    out.set(e.Test, {
      suite: "db",
      name: e.Test,
      parent: slash > 0 ? e.Test.slice(0, slash) : "",
      outcome: e.Action as Case["outcome"],
      ...(e.Elapsed !== undefined ? { ms: Math.round(e.Elapsed * 1000) } : {}),
    });
  }
  return [...out.values()];
}

interface VitestJson {
  testResults?: {
    assertionResults?: {
      fullName?: string;
      title?: string;
      status?: string;
      duration?: number;
      meta?: { assertions?: unknown };
    }[];
  }[];
}

export function parseVitestJson(text: string): Case[] {
  const j = JSON.parse(text) as VitestJson;
  const out: Case[] = [];
  for (const f of j.testResults ?? [])
    for (const a of f.assertionResults ?? []) {
      const st = a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip";
      out.push({
        suite: "http",
        name: a.fullName ?? a.title ?? "",
        parent: "",
        outcome: st,
        ...(a.duration !== undefined ? { ms: Math.round(a.duration) } : {}),
        ...(typeof a.meta?.assertions === "number" ? { assertions: a.meta.assertions } : {}),
      });
    }
  return out;
}

export interface Totals {
  pass: number;
  fail: number;
  skip: number;
}

export function totals(cases: Case[]): Totals {
  const t = { pass: 0, fail: 0, skip: 0 };
  for (const c of cases) t[c.outcome]++;
  return t;
}

/** One row of the per-case report: a top-level test with its subtests (db) or its assertion count (http). */
export interface CaseRow {
  suite: Case["suite"];
  name: string;
  outcome: Case["outcome"];
  /** db: subtests (1 for a test without subtests); http: assertions (cases checked); undefined when unknown. */
  cases?: number;
  passed?: number;
  failed?: number;
}

export function caseRows(cases: Case[]): CaseRow[] {
  return cases
    .filter((c) => c.parent === "")
    .map((c) => {
      if (c.suite === "http")
        return {
          suite: c.suite,
          name: c.name,
          outcome: c.outcome,
          ...(c.assertions !== undefined ? { cases: c.assertions } : {}),
        };
      const subs = cases.filter((x) => x.suite === "db" && x.parent === c.name);
      // a test without subtests is one case
      const t = totals(subs.length ? subs : [c]);
      return {
        suite: c.suite,
        name: c.name,
        outcome: c.outcome,
        cases: Math.max(subs.length, 1),
        passed: t.pass,
        failed: t.fail,
      };
    });
}
