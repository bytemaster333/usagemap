// SPDX-License-Identifier: Apache-2.0
// Support-ticket SLA rule (support.first-response, support.resolution) on fixture events, plus calendar edge cases and a negative control.
// Run: tools/support/run selftest

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { businessDays, type Fixture, parseHolidays, runFixture, zonedMidnight } from "../sla.ts";

const dir = join(import.meta.dirname, "..", "fixtures", "sla");
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture] as const);

describe("support SLA fixtures", () => {
  test("at least the 4/5/8/10-day marks, pause, holiday, time zone and exemption are covered", () =>
    assert.ok(fixtures.length >= 16));
  for (const [file, f] of fixtures)
    test(`${file}: ${f.name}`, () => assert.deepEqual(runFixture(f), []));

  test("negative control: a wrong expectation is reported", () => {
    const f = fixtures.find(([n]) => n.startsWith("03-"))?.[1];
    assert.ok(f);
    assert.notDeepEqual(runFixture({ ...f, expect: { ...f.expect, add: [] } }), []);
  });
});

describe("calendar", () => {
  const utc = { tz: "UTC", holidays: new Set<string>() };
  test("a weekend contributes nothing; Friday noon to Monday noon is one business day", () => {
    assert.equal(
      businessDays(Date.parse("2026-11-07T00:00:00Z"), Date.parse("2026-11-09T00:00:00Z"), utc),
      0,
    );
    assert.equal(
      businessDays(Date.parse("2026-11-13T12:00:00Z"), Date.parse("2026-11-16T12:00:00Z"), utc),
      1,
    );
  });
  test("pauses are subtracted once even when they overlap", () => {
    const s = Date.parse("2026-11-02T00:00:00Z");
    const e = Date.parse("2026-11-03T00:00:00Z");
    const p: [number, number][] = [
      [s, s + 6 * 3_600_000],
      [s + 3 * 3_600_000, s + 12 * 3_600_000],
    ];
    assert.equal(businessDays(s, e, utc, p), 0.5);
  });
  test("local midnight across a DST change (Europe/Berlin, 2026-10-25)", () => {
    assert.equal(
      new Date(zonedMidnight("2026-10-25", "Europe/Berlin")).toISOString(),
      "2026-10-24T22:00:00.000Z",
    );
    assert.equal(
      new Date(zonedMidnight("2026-10-26", "Europe/Berlin")).toISOString(),
      "2026-10-25T23:00:00.000Z",
    );
  });
  test("holiday calendar: list items only; anything else is an error", () => {
    assert.deepEqual(
      [...parseHolidays("# calendar\nholidays:\n  - 2026-12-25\n  - '2026-12-26' # boxing day\n")],
      ["2026-12-25", "2026-12-26"],
    );
    assert.throws(() => parseHolidays("  - 25.12.2026\n"));
  });
});
