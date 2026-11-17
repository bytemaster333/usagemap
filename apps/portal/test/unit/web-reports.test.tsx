// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// Web reports (funnel, goals, journeys): search parsing, step syntax, the exploded `step`/`goal` query, and what the
// views state — the live-window truncation, withheld counts, the journey floor and a `data-metric` key on every figure.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ControlPlane } from "@usagemap/api-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuery } from "../../src/api/client.ts";
import {
  decodeStep,
  encodeStep,
  FunnelReportView,
  fmtWithheld,
  GoalsReportView,
  JourneyReportView,
  parseReportsSearch,
  ReportRangeNote,
  StepListEditor,
  stepLabel,
} from "../../src/pages/WebReports.tsx";

afterEach(cleanup);

const RANGE: ControlPlane.ReportRange = {
  start: "2026-10-21T00:00:00Z",
  end: "2026-11-20T00:00:00Z",
  covered_start: "2026-11-15T00:00:00Z",
  truncated: true,
  source: "live",
  timezone: "UTC",
  anonymized: false,
};

describe("search and step syntax", () => {
  it("defaults and bounds every search parameter", () => {
    expect(parseReportsSearch({})).toEqual({
      report: "funnel",
      range: "7d",
      variant: "verified",
      step: [],
      window: 60,
      goal: [],
      depth: 4,
    });
    const s = parseReportsSearch({
      report: "journey",
      range: "90d",
      variant: "raw",
      step: Array.from({ length: 12 }, () => "path:/"),
      window: 5000,
      goal: "event:signup",
      depth: "3",
      from: "path:/",
    });
    expect(s).toMatchObject({
      report: "journey",
      range: "7d",
      variant: "raw",
      window: 60,
      depth: 3,
    });
    expect(s.step).toHaveLength(8);
    expect(s.goal).toEqual(["event:signup"]);
    expect(s.from).toBe("path:/");
  });
  it("encodes and decodes steps", () => {
    expect(encodeStep("path", " /pricing ")).toBe("path:/pricing");
    expect(decodeStep("event:signup")).toEqual({ type: "event", value: "signup" });
    expect(decodeStep("/docs")).toEqual({ type: "path", value: "/docs" });
    expect(decodeStep("signup")).toEqual({ type: "event", value: "signup" });
    expect(stepLabel({ type: "event", value: "signup" })).toBe("Event: signup");
    expect(fmtWithheld(null)).toBe("withheld");
  });
  it("repeats step and goal in the query (paths may contain commas), joins other arrays", () => {
    expect(buildQuery({ step: ["path:/a,b", "event:x"], range: "7d" })).toBe(
      "?step=path%3A%2Fa%2Cb&step=event%3Ax&range=7d",
    );
    expect(buildQuery({ metrics: ["pageviews", "visitors"] })).toBe(
      "?metrics=pageviews%2Cvisitors",
    );
  });
});

describe("views", () => {
  it("states the live window and anonymised counts", () => {
    render(<ReportRangeNote range={{ ...RANGE, anonymized: true }} />);
    expect(screen.getByTestId("report-truncated").textContent).toMatch(/live window only/);
    expect(screen.getByTestId("report-truncated").textContent).toMatch(/not\s+estimated/);
    expect(screen.getByTestId("report-anonymized")).toBeTruthy();
  });

  it("funnel: steps in order, conversions, withheld counts, a metric key on every figure", () => {
    render(
      <FunnelReportView
        report={{
          range: RANGE,
          variant: "verified",
          window_minutes: 30,
          steps: [
            {
              type: "path",
              value: "/",
              visitors: 120,
              conversion_pct: 100,
              step_conversion_pct: null,
              suppressed: false,
            },
            {
              type: "path",
              value: "/pricing",
              visitors: 50,
              conversion_pct: 41.7,
              step_conversion_pct: 41.7,
              suppressed: false,
            },
            {
              type: "event",
              value: "signup",
              visitors: null,
              conversion_pct: null,
              step_conversion_pct: null,
              suppressed: true,
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("report-funnel-step-1").textContent).toMatch(
      /2\. \/pricing.*50.*41\.7%.*41\.7%.*previous step/,
    );
    expect(screen.getByTestId("report-funnel-step-2").textContent).toMatch(
      /Event: signup.*withheld/,
    );
    expect(screen.getByTestId("report-funnel").textContent).toMatch(/within 30 minutes/);
    const keys = [...document.querySelectorAll("[data-metric]")].map((e) =>
      e.getAttribute("data-metric"),
    );
    expect(new Set(keys)).toEqual(
      new Set([
        "report_funnel_visitors",
        "report_funnel_conversion",
        "report_funnel_step_conversion",
      ]),
    );
  });

  it("goals: total and per-goal conversion", () => {
    render(
      <GoalsReportView
        report={{
          range: RANGE,
          variant: "raw",
          total_visitors: 120,
          goals: [
            {
              type: "path",
              value: "/pricing",
              visitors: 30,
              conversion_pct: 25,
              suppressed: false,
            },
            {
              type: "event",
              value: "signup",
              visitors: null,
              conversion_pct: null,
              suppressed: true,
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("report-goals-total").textContent).toBe("120");
    expect(screen.getByTestId("report-goal-0").textContent).toMatch(/\/pricing.*30.*25\.0%/);
    expect(screen.getByTestId("report-goal-1").textContent).toMatch(/withheld/);
    expect(document.querySelectorAll('[data-metric="report_goal_conversion"]')).toHaveLength(2);
    expect(document.querySelector('[data-metric="report_goal_total_visitors"]')).toBeTruthy();
  });

  it("journeys: sequences with visits, and the floor stated with the rarer journeys counted only", () => {
    render(
      <JourneyReportView
        report={{
          range: RANGE,
          variant: "verified",
          steps: 3,
          min_count: 10,
          journeys: [
            {
              items: [
                { type: "path", value: "/" },
                { type: "path", value: "/pricing" },
                { type: "event", value: "signup" },
              ],
              visits: 42,
            },
          ],
          other_visits: 13,
          suppressed_journeys: 4,
        }}
      />,
    );
    expect(screen.getByTestId("report-journey-0").textContent).toMatch(
      /\/ → \/pricing → Event: signup\s*42 visits/,
    );
    const floor = screen.getByTestId("report-journey-floor").textContent ?? "";
    expect(floor).toMatch(/at least 10 visits/);
    expect(floor).toMatch(/4 rarer journeys with 13 visits/);
    expect(document.querySelector('[data-metric="report_journey_visits"]')).toBeTruthy();
    expect(document.querySelector('[data-metric="report_journey_other_visits"]')).toBeTruthy();
  });

  it("journeys: an empty list names the minimum", () => {
    render(
      <JourneyReportView
        report={{
          range: RANGE,
          variant: "verified",
          steps: 4,
          min_count: 10,
          journeys: [],
          other_visits: 0,
          suppressed_journeys: 0,
        }}
      />,
    );
    expect(screen.getByTestId("report-journey-empty").textContent).toMatch(/at least 10 visits/);
  });
});

describe("StepListEditor", () => {
  it("starts with the minimum rows, adds and removes within bounds, runs encoded steps", () => {
    const onRun = vi.fn();
    render(
      <StepListEditor
        label="Step"
        initial={[]}
        min={2}
        max={3}
        submitText="Show funnel"
        onRun={onRun}
      />,
    );
    const values = () => screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(values()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show funnel" }));
    expect(screen.getByTestId("step-editor-problem").textContent).toMatch(/step 2/);
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.change(values()[1] as HTMLInputElement, { target: { value: "pricing" } });
    fireEvent.click(screen.getByRole("button", { name: "Show funnel" }));
    expect(screen.getByTestId("step-editor-problem").textContent).toMatch(/starts with \//);
    fireEvent.change(values()[1] as HTMLInputElement, { target: { value: "/pricing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Step 3 type"), { target: { value: "event" } });
    fireEvent.change(values()[2] as HTMLInputElement, { target: { value: "/signup" } });
    fireEvent.click(screen.getByRole("button", { name: "Show funnel" }));
    expect(screen.getByTestId("step-editor-problem").textContent).toMatch(/Page path/);
    fireEvent.change(values()[2] as HTMLInputElement, { target: { value: "signup" } });
    fireEvent.click(screen.getByRole("button", { name: "Show funnel" }));
    expect(onRun).toHaveBeenCalledWith(["path:/", "path:/pricing", "event:signup"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(values()).toHaveLength(2);
  });
});
