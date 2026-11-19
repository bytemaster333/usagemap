// SPDX-License-Identifier: Apache-2.0
// Monthly support report on recorded ticket timelines (support.first-response, support.resolution). Run: tools/support/run selftest

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { Config, Issue } from "../sla.ts";
import { parseHolidays } from "../sla.ts";
import { build, main, markdown, monthRange } from "../support-report.ts";

const FX = join(import.meta.dirname, "..", "fixtures", "support");
const issues = JSON.parse(readFileSync(join(FX, "2026-10-issues.json"), "utf8")) as Issue[];
const cfg: Config = {
  tz: "UTC",
  holidays: parseHolidays(readFileSync(join(FX, "holidays.yaml"), "utf8")),
};
const AT = "2026-11-02T00:00:00Z";
const rep = build(issues, "2026-10", AT, cfg);
const row = (n: number) => {
  const r = [...rep.cohort, ...rep.carriedOver].find((x) => x.number === n);
  assert.ok(r, `ticket #${n} in the report`);
  return r;
};
const near = (a: number | null, b: number): void => {
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
};

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("cohort selection", () => {
  test("tickets opened in the month, minus sla:exempt; earlier open ones are carried over", () => {
    assert.deepEqual(
      rep.cohort.map((r) => r.number),
      [101, 102, 103, 104, 107, 108, 109],
    );
    assert.deepEqual(
      rep.carriedOver.map((r) => r.number),
      [106],
    );
    assert.deepEqual(rep.excluded.exempt, [105]);
  });
  test("a ticket closed before the month and one opened after it are not in the report", () => {
    const all = [...rep.cohort, ...rep.carriedOver].map((r) => r.number);
    assert.ok(!all.includes(110));
    assert.ok(!all.includes(111));
  });
  test("a duplicated issue number is refused", () => {
    assert.throws(
      () => build([issues[0] as Issue, issues[0] as Issue], "2026-10", AT, cfg),
      /twice/,
    );
  });
  test("month must be YYYY-MM", () => {
    assert.throws(() => monthRange("2026-13"), /no month/);
    assert.throws(() => monthRange("Oct"), /YYYY-MM/);
  });
});

describe("response (≤ 5 business days) and resolution (≤ 10)", () => {
  test("#101: answered after 2 bd, closed after 5 bd (the holiday on 10-12 does not count)", () => {
    near(row(101).responseDays, 2);
    near(row(101).resolutionDays, 5);
    assert.equal(row(101).response, "met");
    assert.equal(row(101).resolution, "met");
  });
  test("#102: first response after 6 bd (a weekend inside) is a breach; closed within 10", () => {
    near(row(102).responseDays, 6);
    assert.equal(row(102).response, "breached");
    near(row(102).resolutionDays, 6.125);
    assert.equal(row(102).resolution, "met");
  });
  test("#103: unanswered and 0.5 bd old at report time is pending, not met", () => {
    assert.equal(row(103).responseDays, null);
    near(row(103).responseAge, 0.5);
    assert.equal(row(103).response, "pending");
    assert.equal(row(103).resolution, "pending");
  });
  test("#104: status:needs-info pauses the clock until the reporter replies (16 calendar days = 3 bd)", () => {
    near(row(104).responseDays, 0.25);
    near(row(104).resolutionDays, 3);
    assert.equal(row(104).resolution, "met");
    assert.equal(row(104).paused, true);
  });
  test("#107: the automation's sla:response-breach label wins over a computed met (never kinder than the label)", () => {
    near(row(107).responseDays, 0.25);
    assert.equal(row(107).response, "breached");
  });
  test("#108: a bot comment is not a response; 5 bd unanswered is a breach", () => {
    assert.equal(row(108).responseDays, null);
    near(row(108).responseAge, 5);
    assert.equal(row(108).response, "breached");
    assert.equal(row(108).resolution, "pending");
  });
  test("#109: opened by a maintainer needs no first response", () => {
    near(row(109).responseDays, 0);
    assert.equal(row(109).response, "met");
  });
  test("#106 (carried over): open for 24 bd is a resolution breach", () => {
    near(row(106).resolutionAge, 24);
    assert.equal(row(106).resolution, "breached");
  });
});

describe("statistics and output", () => {
  test("counts, medians and maxima over the month's cohort", () => {
    const s = rep.stats;
    assert.equal(s.tickets, 7);
    assert.equal(s.responded, 5);
    assert.equal(s.responseMet, 3);
    assert.equal(s.responseBreached, 3);
    assert.equal(s.responsePending, 1);
    near(s.responseMedian, 0.25);
    near(s.responseMax, 6);
    assert.equal(s.resolved, 5);
    assert.equal(s.resolutionMet, 5);
    assert.equal(s.resolutionBreached, 0);
    assert.equal(s.resolutionPending, 2);
    near(s.resolutionMedian, 3);
    near(s.resolutionMax, 6.125);
  });
  test("the Markdown lists every breach with a link and carries no author name", () => {
    const md = markdown(rep, "ORG/REPO");
    assert.match(md, /\[#102\]\(https:\/\/github\.com\/ORG\/REPO\/issues\/102\): response/);
    assert.match(md, /\[#107\]\([^)]+\): response/);
    assert.match(md, /\[#108\]\([^)]+\): response/);
    assert.match(md, /\| Response breaches \| 3 \|/);
    assert.match(md, /sla:exempt/);
    for (const name of ["reporter-", "maint-", "helper-bot"]) assert.ok(!md.includes(name), name);
  });
  test("ages depend only on --at: the same input and time give the same report", () => {
    assert.deepEqual(build(issues, "2026-10", AT, cfg), rep);
  });
  test("CLI writes the Markdown and JSON pair", async () => {
    const out = mkdtempSync(join(tmpdir(), "support-report-"));
    dirs.push(out);
    const rc = await main([
      "--month=2026-10",
      `--issues=${join(FX, "2026-10-issues.json")}`,
      `--holidays=${join(FX, "holidays.yaml")}`,
      "--tz=UTC",
      `--at=${AT}`,
      `--out=${out}`,
    ]);
    assert.equal(rc, 0);
    const json = JSON.parse(readFileSync(join(out, "support-2026-10.json"), "utf8"));
    assert.equal(json.stats.responseBreached, 3);
    assert.match(readFileSync(join(out, "support-2026-10.md"), "utf8"), /# Support report 2026-10/);
  });
  test("CLI without input is a usage error", async () => {
    assert.equal(await main(["--month=2026-10"]), 2);
  });
});
