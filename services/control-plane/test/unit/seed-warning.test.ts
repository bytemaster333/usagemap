// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { seedWarningFrom } from "../../src/api/seed-warning.ts";

const row = (service_id: string, day: string, n: number) => ({
  service_id,
  service_name: service_id === "z" ? null : `svc-${service_id}`,
  day,
  n: String(n),
});

describe("seedWarningFrom", () => {
  it("sums everything when never acknowledged", () => {
    const w = seedWarningFrom(
      [row("a", "2026-11-01", 2), row("b", "2026-11-03", 5), row("a", "2026-11-04", 1)],
      { at: null, day: null, baseline: {} },
    );
    expect(w).toEqual({
      count: 8,
      since: "2026-11-01",
      last_seen: "2026-11-04",
      acknowledged_at: null,
      services: [
        { service_id: "b", service_name: "svc-b", count: 5 },
        { service_id: "a", service_name: "svc-a", count: 3 },
      ],
    });
  });

  it("drops days before the acknowledgement and subtracts each service's baseline on its day", () => {
    const at = new Date("2026-11-04T10:00:00Z");
    const w = seedWarningFrom(
      [
        row("a", "2026-11-03", 9),
        row("a", "2026-11-04", 3), // baseline 2 → 1 after
        row("b", "2026-11-04", 4), // baseline 4 → 0 after
        row("z", "2026-11-05", 2),
      ],
      { at, day: "2026-11-04", baseline: { a: 2, b: 4 } },
    );
    expect(w.count).toBe(3);
    expect(w.since).toBe("2026-11-04");
    expect(w.last_seen).toBe("2026-11-05");
    expect(w.acknowledged_at).toBe(at.toISOString());
    expect(w.services).toEqual([
      { service_id: "z", service_name: null, count: 2 },
      { service_id: "a", service_name: "svc-a", count: 1 },
    ]);
  });

  it("is empty after an acknowledgement with nothing new, and ignores a malformed baseline value", () => {
    const at = new Date("2026-11-04T10:00:00Z");
    expect(
      seedWarningFrom([row("a", "2026-11-04", 2)], { at, day: "2026-11-04", baseline: { a: 2 } }),
    ).toMatchObject({ count: 0, since: null, last_seen: null, services: [] });
    expect(
      seedWarningFrom([row("a", "2026-11-04", 2)], { at, day: "2026-11-04", baseline: { a: "x" } })
        .count,
    ).toBe(2);
  });
});
