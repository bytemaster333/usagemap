// SPDX-License-Identifier: Apache-2.0
// Audit anchor publishing without a database: the catch-up plan and the file publisher that never
// replaces a published day.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  anchorDaysToPublish,
  buildAnchor,
  FilePublisher,
  MAX_CATCH_UP_DAYS,
} from "../../src/audit/anchor.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "wsg-anchor-unit-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, "audit-anchors"), 0o755);
    } catch {
      // not created
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const doc = (date: string, seq = 1) =>
  buildAnchor(date, new Date(`${date}T23:59:59Z`), [
    { chain_id: "00000000-0000-0000-0000-000000000000", seq, row_hash: "ab".repeat(32) },
  ]);

describe("anchorDaysToPublish (catch-up)", () => {
  it("first run: only the previous day", () => {
    expect(anchorDaysToPublish([[]], "2026-11-18")).toEqual(["2026-11-17"]);
    expect(anchorDaysToPublish([], "2026-11-18")).toEqual(["2026-11-17"]);
  });

  it("up to date: nothing", () => {
    expect(anchorDaysToPublish([["2026-11-16", "2026-11-17"]], "2026-11-18")).toEqual([]);
  });

  it("a failed run leaves no gap: every missing day after the first published one, ascending", () => {
    expect(anchorDaysToPublish([["2026-11-10", "2026-11-11", "2026-11-13"]], "2026-11-16")).toEqual(
      ["2026-11-12", "2026-11-14", "2026-11-15"],
    );
  });

  it("a day one publisher lacks is published again (the others answer exists)", () => {
    expect(
      anchorDaysToPublish(
        [
          ["2026-11-15", "2026-11-16", "2026-11-17"],
          ["2026-11-15", "2026-11-17"],
        ],
        "2026-11-18",
      ),
    ).toEqual(["2026-11-16"]);
  });

  it("never reaches back more than MAX_CATCH_UP_DAYS", () => {
    const days = anchorDaysToPublish([["2020-01-01"]], "2026-11-18");
    expect(days).toHaveLength(MAX_CATCH_UP_DAYS);
    expect(days.at(-1)).toBe("2026-11-17");
  });
});

describe("FilePublisher", () => {
  it("publishes once; a rerun answers exists and leaves the file unchanged", async () => {
    const d = tmp();
    const p = new FilePublisher(d);
    expect(await p.publish(doc("2026-11-17"))).toBe("published");
    expect(await p.publish(doc("2026-11-17", 2))).toBe("exists");
    const onDisk = JSON.parse(readFileSync(join(d, "audit-anchors", "2026-11-17.json"), "utf8"));
    expect(onDisk.chains[0].seq).toBe(1);
    expect(await p.dates()).toEqual(["2026-11-17"]);
    expect((await p.latest())?.date).toBe("2026-11-17");
  });

  it("never replaces a published day it cannot read (EACCES)", async () => {
    const d = tmp();
    const p = new FilePublisher(d);
    const target = join(d, "audit-anchors", "2026-11-17.json");
    mkdirSync(join(d, "audit-anchors"), { recursive: true });
    writeFileSync(target, "published-before\n");
    chmodSync(target, 0o000);
    try {
      expect(await p.publish(doc("2026-11-17"))).toBe("exists");
    } finally {
      chmodSync(target, 0o644);
    }
    expect(readFileSync(target, "utf8")).toBe("published-before\n");
  });

  it("never replaces a target that is a directory, and reports an unwritable directory", async () => {
    const d = tmp();
    const p = new FilePublisher(d);
    mkdirSync(join(d, "audit-anchors", "2026-11-17.json"), { recursive: true });
    expect(await p.publish(doc("2026-11-17"))).toBe("exists");
    chmodSync(join(d, "audit-anchors"), 0o555);
    await expect(p.publish(doc("2026-11-16"))).rejects.toMatchObject({ code: "EACCES" });
  });

  it("dates() of a missing directory is empty", async () => {
    expect(await new FilePublisher(join(tmp(), "nope")).dates()).toEqual([]);
  });
});
