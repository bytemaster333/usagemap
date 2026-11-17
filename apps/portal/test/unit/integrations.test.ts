// SPDX-License-Identifier: Apache-2.0
// Integrations page (integration plan I1.0), pure rules: search parameters, the text filter, recommended-first
// ordering, the dev-origin precondition of the web test, and when the live check decides the test has arrived.
import type { ControlPlane } from "@usagemap/api-types";
import { describe, expect, it } from "vitest";
import {
  appTestArrived,
  matches,
  needsLocalhost,
  ordered,
  otlpTestArrived,
  parseIntegrationsSearch,
  STATUS_TEXT,
  webTestArrived,
} from "../../src/pages/integrations/model.ts";

const card = (p: Partial<ControlPlane.Integration>): ControlPlane.Integration => ({
  id: "web_script_tag",
  group: "web",
  title: "Script tag (any website)",
  summary: "One pinned tag.",
  measures: ["Page views"],
  privacy: ["No cookies"],
  availability: "ready",
  availability_note: null,
  target: "site",
  audiences: ["website"],
  stacks: ["html", "any"],
  guide_path: null,
  example_path: null,
  needs: null,
  setup: [],
  test: { kind: "web_dev_event", instructions: "", command: null, expect: [], requires: [] },
  live_check: "dev_events",
  status: "not_started",
  status_detail: "",
  recommended: null,
  ...p,
});

describe("search parameters", () => {
  it("keeps only valid values", () => {
    const u = "0B0E1A3C-0000-4000-8000-000000000001";
    expect(
      parseIntegrationsSearch({
        group: "api",
        site: u,
        service: "nope",
        card: "api_otel_node",
        q: "  next  ",
      }),
    ).toEqual({ group: "api", site: u.toLowerCase(), card: "api_otel_node", q: "next" });
    expect(parseIntegrationsSearch({ group: "everything", card: "DROP TABLE", q: "" })).toEqual({});
  });
});

describe("filtering and order", () => {
  it("matches every word against title, summary and stack tags", () => {
    const c = card({ title: "OpenTelemetry: Python / FastAPI", stacks: ["python", "fastapi"] });
    expect(matches(c, undefined)).toBe(true);
    expect(matches(c, "PYTHON")).toBe(true);
    expect(matches(c, "fastapi opentelemetry")).toBe(true);
    expect(matches(c, "python go")).toBe(false);
  });
  it("puts recommended integrations first and keeps catalogue order otherwise", () => {
    const a = card({ id: "a" });
    const b = card({ id: "b", recommended: "Start here" });
    const c = card({ id: "c" });
    expect(ordered([a, b, c]).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
  it("names every status", () => {
    expect(Object.keys(STATUS_TEXT).sort()).toEqual(
      ["configured", "live_data_seen", "not_observable", "not_started", "test_received"].sort(),
    );
  });
});

describe("live check", () => {
  const ev = (iso: string): ControlPlane.DevEvent => ({
    received_at: iso,
    kind: "pageview",
    event_name: "pageview",
    path: "/usagemap-test",
    would_be_verdict: "rejected",
    reason: "challenge_missing",
  });
  it("web: an event received after the check started (one second of skew allowed)", () => {
    const start = Date.parse("2026-11-19T10:00:00.500Z");
    expect(webTestArrived([ev("2026-11-19T09:59:00Z")], start)).toBeNull();
    expect(webTestArrived([ev("2026-11-19T10:00:00Z")], start)?.path).toBe("/usagemap-test");
    expect(webTestArrived([], start)).toBeNull();
  });
  it("OTLP: the baseline counter went up after the check started", () => {
    expect(otlpTestArrived(null, 5)).toBe(false);
    expect(otlpTestArrived(3, undefined)).toBe(false);
    expect(otlpTestArrived(3, 3)).toBe(false);
    expect(otlpTestArrived(3, 4)).toBe(true);
    // app cards: the same rule on the website's stale app-event drops
    expect(appTestArrived(0, 0)).toBe(false);
    expect(appTestArrived(0, 1)).toBe(true);
  });
  it("the web test needs localhost itself (the curl claims http://localhost:5173)", () => {
    expect(needsLocalhost([])).toBe(true);
    expect(needsLocalhost(["127.0.0.1", "myapp-*.vercel.app"])).toBe(true);
    expect(needsLocalhost(["localhost"])).toBe(false);
  });
});
