// SPDX-License-Identifier: Apache-2.0
// Access rules (removed tenants, privacy floors, ops.end-of-window-read-only): the pure rules behind the pipeline and settings changes.

import { controlPlaneOpenApi } from "@usagemap/api-types";
import { describe, expect, it } from "vitest";
import { OpenApi } from "../../src/http/openapi.ts";
import {
  parseReadOnlyMode,
  READ_ONLY_ALLOWED,
  REMOVED_TENANT_READABLE,
} from "../../src/http/pipeline.ts";
import { settingValueAllowed } from "../../src/lifecycle/handlers.ts";

const ops = new OpenApi().operations;
const byId = new Map(ops.map((o) => [o.operationId, o]));

describe("allow-lists name documented operations of the right kind", () => {
  it("removed-tenant reads are tenant-scoped GETs", () => {
    for (const id of REMOVED_TENANT_READABLE) {
      const o = byId.get(id);
      expect(o?.method, id).toBe("get");
      expect(
        o?.roles.some((r) => r.startsWith("tenant:")),
        id,
      ).toBe(true);
    }
  });
  it("read-only exemptions are state-changing operations", () => {
    for (const id of READ_ONLY_ALLOWED) expect(byId.get(id)?.method, id).not.toBe("get");
  });
  it("every refused state-changing operation documents 403 (C-113)", () => {
    // The pipeline answers read-only refusals with 403 `forbidden`: the contract must document it on each of them.
    const doc = controlPlaneOpenApi() as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const writes = ops.filter((o) => o.method !== "get" && !o.internal);
    expect(writes.length).toBeGreaterThan(60);
    for (const o of writes) {
      if (o.operationId.startsWith("auth") || READ_ONLY_ALLOWED.has(o.operationId)) continue;
      expect(Object.keys(doc.paths[o.path]?.[o.method]?.responses ?? {}), o.operationId).toContain(
        "403",
      );
    }
  });
});

describe("read_only_mode setting", () => {
  it("parses the setting; anything malformed or missing is off", () => {
    expect(parseReadOnlyMode({ enabled: true, ingest: "pause" })).toEqual({
      enabled: true,
      ingest: "pause",
    });
    expect(parseReadOnlyMode(undefined)).toEqual({ enabled: false, ingest: "accept" });
    expect(parseReadOnlyMode({ enabled: "true" })).toEqual({ enabled: false, ingest: "accept" });
    expect(parseReadOnlyMode([true])).toEqual({ enabled: false, ingest: "accept" });
  });
  it("accepts exactly {enabled: boolean, ingest: accept|pause}", () => {
    expect(settingValueAllowed("read_only_mode", { enabled: true, ingest: "pause" })).toBe(true);
    expect(settingValueAllowed("read_only_mode", { enabled: false, ingest: "accept" })).toBe(true);
    expect(settingValueAllowed("read_only_mode", { enabled: true })).toBe(false);
    expect(settingValueAllowed("read_only_mode", { enabled: 1, ingest: "pause" })).toBe(false);
    expect(
      settingValueAllowed("read_only_mode", { enabled: true, ingest: "pause", extra: 1 }),
    ).toBe(false);
    expect(settingValueAllowed("read_only_mode", true)).toBe(false);
  });
});

describe("privacy-floor settings (ADR-0027)", () => {
  it.each([
    ["op_min_count", 5, true],
    ["op_min_count", 1000, true],
    ["op_min_count", 0, false],
    ["op_min_count", 4, false],
    ["op_min_count", 10.5, false],
    ["op_min_count", "10", false],
    ["op_round_to", 1, true],
    ["op_round_to", 0, false],
    ["op_round_to", 101, false],
    ["tenant_min_count", 5, true],
    ["tenant_min_count", null, false],
    ["tenant_round_to", 100, true],
    ["tenant_round_to", -1, false],
    ["web_breakdown_top_n", "anything (database CHECKs decide)", true],
  ])("%s = %j → %s", (key, value, ok) => {
    expect(settingValueAllowed(key as string, value)).toBe(ok);
  });
});
