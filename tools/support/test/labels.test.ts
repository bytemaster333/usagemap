// SPDX-License-Identifier: Apache-2.0
// Issue forms and label set (support.first-response, support.resolution; docs/sla.md §9.1–9.2). Run: tools/support/run selftest

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { check, formLabels, loadLabels, plan } from "../labels.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FORMS = join(ROOT, ".github/ISSUE_TEMPLATE");
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function copyForms(): string {
  const d = mkdtempSync(join(tmpdir(), "forms-"));
  dirs.push(d);
  cpSync(FORMS, d, { recursive: true });
  return d;
}

describe("issue forms and labels", () => {
  test("the committed forms, labels.json and the SLA automation agree", () => {
    assert.deepEqual(check(), []);
  });
  test("the forms cover docs/sla.md §9.1: tenant support, bug, enrolment, removal request, privacy question", () => {
    const all = ["tenant-support", "bug", "enrolment", "removal-request", "privacy-question"].map(
      (f) => formLabels(readFileSync(join(FORMS, `${f}.yml`), "utf8")),
    );
    assert.deepEqual(all, [
      ["tenant", "type:support"],
      ["type:bug"],
      ["tenant", "type:enrolment"],
      ["tenant", "type:removal"],
      ["privacy", "type:question"],
    ]);
  });
  test("a form with an unknown label is refused", () => {
    const d = copyForms();
    const f = join(d, "bug.yml");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace('labels: ["type:bug"]', 'labels: ["type:bugg"]'),
    );
    assert.match(check(d).join("\n"), /bug\.yml: label type:bugg/);
  });
  test("a form without the required no-personal-data confirmation is refused", () => {
    const d = copyForms();
    const f = join(d, "tenant-support.yml");
    writeFileSync(f, readFileSync(f, "utf8").replace("id: privacy", "id: consent"));
    assert.match(check(d).join("\n"), /tenant-support\.yml: no required/);
  });
  test("blank issues enabled or a missing private security route is refused", () => {
    const d = copyForms();
    const c = join(d, "config.yml");
    writeFileSync(
      c,
      readFileSync(c, "utf8")
        .replace("blank_issues_enabled: false", "blank_issues_enabled: true")
        .replace("/security/advisories/new", "/issues/new"),
    );
    const p = check(d).join("\n");
    assert.match(p, /blank issues/);
    assert.match(p, /private vulnerability reporting/);
  });
  test("a public form collecting security reports is refused", () => {
    const d = copyForms();
    const f = join(d, "bug.yml");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace('labels: ["type:bug"]', 'labels: ["type:bug", "security"]'),
    );
    assert.match(check(d).join("\n"), /must not collect security reports/);
  });
  test("a label set missing an SLA label is refused", () => {
    const labels = loadLabels().filter((l) => l.name !== "sla:response-breach");
    assert.match(check(FORMS, labels).join("\n"), /lacks sla:response-breach/);
  });
  test("sync plan creates missing labels, fixes drifted ones and never deletes", () => {
    const want = loadLabels();
    const have = [
      { name: "type:bug", color: "D73A4A", description: want[0]?.description ?? "" },
      { name: "tenant", color: "000000", description: "old" },
      { name: "wontfix", color: "ffffff", description: "" },
    ];
    const p = plan(want, have);
    assert.ok(!p.create.some((l) => l.name === "type:bug"), "case-insensitive colour match");
    assert.deepEqual(
      p.update.map((l) => l.name),
      ["tenant"],
    );
    assert.equal(p.create.length, want.length - 2);
    assert.ok(![...p.create, ...p.update].some((l) => l.name === "wontfix"));
  });
});
