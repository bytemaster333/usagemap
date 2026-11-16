// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  addCounts,
  criteriaView,
  globToLike,
  parseRange,
  selectorOf,
  selectorSummary,
  zeroCounts,
} from "../../src/erasure/criteria.ts";
import { type RequestRow, requestView } from "../../src/erasure/requests.ts";
import { failureCodeOf } from "../../src/erasure/worker.ts";

describe("erasure criteria (data-model §8.8, C-86, C-88)", () => {
  it("converts the glob: `*` is any run incl. `/`, LIKE metacharacters and the escape are literal", () => {
    expect(globToLike("/users/*")).toBe("/users/%");
    expect(globToLike("/a_b/50%/*/x\\y")).toBe("/a\\_b/50\\%/%/x\\\\y");
    expect(globToLike("/exact")).toBe("/exact");
  });

  it("finds the one selector and summarises it by type and code-point length only", () => {
    const c = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z", event_name: "sïgnup" };
    expect(selectorOf(c)).toEqual({ type: "event_name", value: "sïgnup" });
    expect(selectorSummary(c)).toEqual({ type: "event_name", length: 6 });
    expect(selectorOf({ start: c.start, end: c.end, path_pattern: null })).toBeNull();
    // after redaction the stored criteria carry only the summary (C-88)
    const red = {
      start: c.start,
      end: c.end,
      selector: { type: "path_pattern" as const, length: 9 },
    };
    expect(selectorOf(red)).toBeNull();
    expect(selectorSummary(red)).toEqual({ type: "path_pattern", length: 9 });
    expect(criteriaView(red)).toEqual({
      start: c.start,
      end: c.end,
      path_pattern: null,
      event_name: null,
      property_key: null,
    });
  });

  it("ranges are start-inclusive, end-exclusive and non-empty (C-86)", () => {
    expect(
      parseRange({ start: "2026-09-01T00:00:00Z", end: "2026-09-01T00:00:00Z" }),
    ).toMatchObject({
      pointer: "/criteria/end",
    });
    const r = parseRange({ start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z" });
    expect("start" in r && r.end.getTime() - r.start.getTime()).toBe(86_400_000);
  });

  it("adds counts and merges days", () => {
    const a = { ...zeroCounts(), website_events: 2, aggregate_days: ["2026-09-02", "2026-09-01"] };
    const b = { ...zeroCounts(), breakdown_rows: 3, aggregate_days: ["2026-09-02", "2026-09-03"] };
    expect(addCounts(a, b)).toMatchObject({
      website_events: 2,
      breakdown_rows: 3,
      aggregate_days: ["2026-09-01", "2026-09-02", "2026-09-03"],
    });
  });

  it("the view never shows a redacted literal and states the backup date (56 days, C-112)", () => {
    const row: RequestRow = {
      tenant_id: "t",
      request_id: "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e16",
      site_id: null,
      service_id: null,
      scope: "tenant",
      criteria: {
        start: "2026-09-01T00:00:00Z",
        end: "2026-10-01T00:00:00Z",
        selector: { type: "path_pattern", length: 17 },
      },
      status: "completed",
      preview: zeroCounts(),
      result: {
        ...zeroCounts(),
        website_events: 4,
        spool_sweep: { due_at: "2026-10-05T00:00:00Z" },
      },
      created_at: new Date("2026-10-02T11:50:00Z"),
      confirmed_at: new Date("2026-10-02T11:55:00Z"),
      started_at: null,
      completed_at: new Date("2026-10-02T12:00:00Z"),
      finished_at: new Date("2026-10-02T12:00:00Z"),
      selector_redacted_at: new Date("2026-11-27T12:00:00Z"),
      failure_code: null,
    };
    const v = requestView(row);
    expect(v.selector).toEqual({ type: "path_pattern", length: 17 });
    expect(v.backup_expiry_note).toBe(
      "Erased data leaves all backups within 56 days (by 2026-11-27).",
    );
    expect(v.result).toMatchObject({ website_events: 4 });
    expect(v.result).not.toHaveProperty("spool_sweep");
    expect(v.spool_sweep).toEqual({
      due_at: "2026-10-05T00:00:00Z",
      done_at: null,
      counts: null,
      skipped: null,
    });
  });

  it("maps errors to failure codes by SQLSTATE / network code only", () => {
    expect(failureCodeOf({ code: "ECONNREFUSED" }, "umami")).toBe("UMAMI_UNAVAILABLE");
    expect(failureCodeOf(new Error("x"), "umami")).toBe("UMAMI_UNAVAILABLE");
    expect(failureCodeOf({ code: "57014" }, "umami")).toBe("TIMEOUT");
    expect(failureCodeOf({ code: "23505" }, "scf")).toBe("INTERNAL");
  });
});
