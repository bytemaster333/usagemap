// SPDX-License-Identifier: Apache-2.0
// Web reports of one website read live from the analytics engine (wire-formats §j.3 R6–R8; `getWebFunnelReport`,
// `getWebGoalsReport`, `getWebJourneyReport`): a funnel of ordered steps, goals as conversions to a page or an event,
// and the most frequent visit journeys. What the page states, because the contract says so:
//   - reports cover the site's live window only — the part of a longer range before it is left out and said so
//     (`range.truncated`), never estimated; an engine that cannot answer is a 503, shown with its retry hint;
//   - counts are visitors per UTC day summed over the range (the visitor key rotates daily, C-110);
//   - with anonymous reports (C-51) small counts are withheld and the rest rounded; journeys are always floored at the
//     minimum count, so a rare path never singles a visitor out;
//   - there are no retention or campaign (UTM) reports: visitors are not recognised across UTC days (C-110) and
//     campaign parameters are never collected (C-65).
// Every figure carries a `data-metric` key; the definitions are wired by the shared tooltip layer.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId, useState } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { MetricDefinitions } from "../components/MetricInfo.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { fmtDay, fmtInt, fmtPct, fmtRange } from "../lib/format.ts";
import { useSite } from "./SiteLayout.tsx";

type FunnelReport = ControlPlane.WebFunnelReport;
type GoalsReport = ControlPlane.WebGoalsReport;
type JourneyReport = ControlPlane.WebJourneyReport;
type ReportRange = ControlPlane.ReportRange;
type StepType = "path" | "event";

export const REPORTS = ["funnel", "goals", "journey"] as const;
export type ReportKind = (typeof REPORTS)[number];
export const REPORT_RANGES = ["24h", "7d", "30d"] as const;
export type ReportRangeKind = (typeof REPORT_RANGES)[number];

export const REPORT_TEXT: Record<ReportKind, string> = {
  funnel: "Funnel",
  goals: "Goals",
  journey: "Journeys",
};
const RANGE_TEXT: Record<ReportRangeKind, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export const FUNNEL_LIMITS = { min: 2, max: 8 } as const;
export const GOAL_LIMITS = { min: 1, max: 5 } as const;

export interface ReportsSearch {
  report: ReportKind;
  range: ReportRangeKind;
  variant: "verified" | "raw";
  /** funnel steps, `path:/x` or `event:name` */
  step: string[];
  /** minutes between funnel steps */
  window: number;
  /** goals, same syntax */
  goal: string[];
  /** leading events of a visit in a journey */
  depth: number;
  /** journeys starting with this item (optional) */
  from?: string | undefined;
}

function strings(v: unknown, max: number): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return list.filter((x): x is string => typeof x === "string" && x.length <= 520).slice(0, max);
}

function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
}

export function parseReportsSearch(s: Record<string, unknown>): ReportsSearch {
  const from = typeof s.from === "string" && s.from.length <= 520 ? s.from : undefined;
  return {
    report: (REPORTS as readonly unknown[]).includes(s.report)
      ? (s.report as ReportKind)
      : "funnel",
    range: (REPORT_RANGES as readonly unknown[]).includes(s.range)
      ? (s.range as ReportRangeKind)
      : "7d",
    variant: s.variant === "raw" ? "raw" : "verified",
    step: strings(s.step, FUNNEL_LIMITS.max),
    window: intIn(s.window, 1, 1440, 60),
    goal: strings(s.goal, GOAL_LIMITS.max),
    depth: intIn(s.depth, 2, 7, 4),
    ...(from ? { from } : {}),
  };
}

export const DEFAULT_REPORTS_SEARCH: ReportsSearch = parseReportsSearch({});

/** `path:/pricing` → { type: path, value: /pricing }; anything else is an event name without its prefix. */
export function decodeStep(raw: string): { type: StepType; value: string } {
  if (raw.startsWith("path:")) return { type: "path", value: raw.slice(5) };
  if (raw.startsWith("event:")) return { type: "event", value: raw.slice(6) };
  return raw.startsWith("/") ? { type: "path", value: raw } : { type: "event", value: raw };
}

export function encodeStep(type: StepType, value: string): string {
  return `${type}:${value.trim()}`;
}

/** How a step reads: a path as is, an event as “Event: name”. */
export function stepLabel(s: { type: StepType; value: string }): string {
  return s.type === "path" ? s.value : `Event: ${s.value}`;
}

/** A count the API withholds (null, below the minimum count with anonymous reports) — never shown as 0. */
export function fmtWithheld(n: number | null | undefined): string {
  return n === null || n === undefined ? "withheld" : fmtInt(n);
}

// ------------------------------------------------------------------------------------------------ views

export function ReportRangeNote({ range }: { range: ReportRange }) {
  return (
    <div className="alert info" data-testid="report-range">
      <p>
        <strong>{fmtRange(range.covered_start, range.end)}</strong>, read live from the analytics
        engine. Visitors are counted per UTC day and summed over the range.
      </p>
      {range.truncated ? (
        <p data-testid="report-truncated">
          Reports cover this website's live window only, which starts on{" "}
          {fmtDay(range.covered_start)}. The earlier part of the range you chose is left out, not
          estimated.
        </p>
      ) : null}
      {range.anonymized ? (
        <p data-testid="report-anonymized">
          Anonymous reports are on: counts below the minimum are withheld and the others rounded.
        </p>
      ) : null}
    </div>
  );
}

export function FunnelReportView({ report }: { report: FunnelReport }) {
  const first = report.steps[0]?.visitors ?? null;
  return (
    <section className="card stack" aria-labelledby="rf-h" data-testid="report-funnel">
      <h2 id="rf-h">Funnel</h2>
      <MetricDefinitions
        metrics={[
          "report_funnel_visitors",
          "report_funnel_conversion",
          "report_funnel_step_conversion",
        ]}
      />
      <ol className="funnel">
        {report.steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a step may repeat; its position is its identity
          <li key={`${i}-${s.type}-${s.value}`} data-testid={`report-funnel-step-${i}`}>
            <span>
              {i + 1}. {stepLabel(s)}
            </span>
            <meter
              min={0}
              max={100}
              value={s.conversion_pct ?? 0}
              aria-label={`${stepLabel(s)}: ${fmtPct(s.conversion_pct)} of the first step`}
            />
            <span className="num">
              <span data-metric="report_funnel_visitors">{fmtWithheld(s.visitors)}</span>{" "}
              <span className="small muted">
                (<span data-metric="report_funnel_conversion">{fmtPct(s.conversion_pct)}</span>
                {i > 0 ? (
                  <>
                    {" · "}
                    <span data-metric="report_funnel_step_conversion">
                      {fmtPct(s.step_conversion_pct)}
                    </span>{" "}
                    of the previous step
                  </>
                ) : null}
                )
              </span>
            </span>
          </li>
        ))}
      </ol>
      <p className="small muted">
        Visitors who reached each step in this order, each within {report.window_minutes} minutes of
        the previous one.{" "}
        {report.variant === "verified"
          ? "Verified: the first step was a verified event."
          : "Verified and suspect events."}{" "}
        {first === 0 ? "No visitor reached the first step in this range." : null}
      </p>
    </section>
  );
}

export function GoalsReportView({ report }: { report: GoalsReport }) {
  return (
    <section className="card stack" aria-labelledby="rg-h" data-testid="report-goals">
      <h2 id="rg-h">Goals</h2>
      <MetricDefinitions
        metrics={["report_goal_visitors", "report_goal_conversion", "report_goal_total_visitors"]}
      />
      <p>
        Visitors in this range:{" "}
        <strong data-metric="report_goal_total_visitors" data-testid="report-goals-total">
          {fmtWithheld(report.total_visitors)}
        </strong>
      </p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Visitors who reached each goal</caption>
          <thead>
            <tr>
              <th scope="col">Goal</th>
              <th scope="col" className="num">
                Visitors
              </th>
              <th scope="col" className="num">
                Conversion
              </th>
            </tr>
          </thead>
          <tbody>
            {report.goals.map((g, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a goal may repeat; its position is its identity
              <tr key={`${i}-${g.type}-${g.value}`} data-testid={`report-goal-${i}`}>
                <th scope="row">{stepLabel(g)}</th>
                <td className="num" data-metric="report_goal_visitors">
                  {fmtWithheld(g.visitors)}
                </td>
                <td className="num" data-metric="report_goal_conversion">
                  {fmtPct(g.conversion_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function JourneyReportView({ report }: { report: JourneyReport }) {
  return (
    <section className="card stack" aria-labelledby="rj-h" data-testid="report-journey">
      <h2 id="rj-h">Journeys</h2>
      <MetricDefinitions metrics={["report_journey_visits", "report_journey_other_visits"]} />
      {report.journeys.length === 0 ? (
        <p className="muted" data-testid="report-journey-empty">
          No journey was followed by at least {report.min_count} visits in this range.
        </p>
      ) : (
        <ol className="stack">
          {report.journeys.map((j, i) => (
            <li
              key={j.items.map((it) => `${it.type}:${it.value}`).join("\u0001")}
              data-testid={`report-journey-${i}`}
            >
              <span>{j.items.map((it) => stepLabel(it)).join(" → ")}</span>{" "}
              <span className="small muted">
                <span data-metric="report_journey_visits">{fmtInt(j.visits)}</span> visits
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="small muted" data-testid="report-journey-floor">
        Only journeys followed by at least {report.min_count} visits are listed, so no single
        visitor's path is ever shown.{" "}
        {report.suppressed_journeys > 0 ? (
          <>
            {fmtInt(report.suppressed_journeys)} rarer journeys with{" "}
            <span data-metric="report_journey_other_visits">{fmtInt(report.other_visits)}</span>{" "}
            visits in total are counted only.
          </>
        ) : null}
      </p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ editors

interface Row {
  type: StepType;
  value: string;
}

/** A list of path/event steps with add and remove, bounded by `min`/`max`; `onRun` gets them encoded. */
export function StepListEditor({
  label,
  initial,
  min,
  max,
  submitText,
  onRun,
  children,
}: {
  label: string;
  initial: string[];
  min: number;
  max: number;
  submitText: string;
  onRun: (steps: string[]) => void;
  children?: React.ReactNode;
}) {
  const id = useId();
  const [rows, setRows] = useState<Row[]>(() => {
    const r: Row[] = initial.map(decodeStep);
    while (r.length < min) r.push({ type: "path", value: r.length === 0 ? "/" : "" });
    return r;
  });
  const [problem, setProblem] = useState<string | null>(null);
  const update = (i: number, r: Partial<Row>) =>
    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const submit = () => {
    const empty = rows.findIndex((r) => r.value.trim() === "");
    if (empty >= 0) return setProblem(`Enter a value for ${label.toLowerCase()} ${empty + 1}.`);
    const notPath = rows.findIndex((r) => r.type === "path" && !r.value.trim().startsWith("/"));
    if (notPath >= 0)
      return setProblem(`A page path starts with / (${label.toLowerCase()} ${notPath + 1}).`);
    const slashEvent = rows.findIndex((r) => r.type === "event" && r.value.trim().startsWith("/"));
    if (slashEvent >= 0)
      return setProblem(
        `An event name does not start with /: choose “Page path” for ${label.toLowerCase()} ${slashEvent + 1}.`,
      );
    setProblem(null);
    onRun(rows.map((r) => encodeStep(r.type, r.value)));
  };
  return (
    <form
      className="card stack"
      aria-label={`${label}s`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ol className="stack" data-testid="step-editor">
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
          <li key={i} className="row">
            <label htmlFor={`${id}-t${i}`} className="sr-only">
              {label} {i + 1} type
            </label>
            <select
              id={`${id}-t${i}`}
              value={r.type}
              onChange={(e) => update(i, { type: e.target.value as StepType })}
            >
              <option value="path">Page path</option>
              <option value="event">Event</option>
            </select>
            <label htmlFor={`${id}-v${i}`} className="sr-only">
              {label} {i + 1}
            </label>
            <input
              id={`${id}-v${i}`}
              value={r.value}
              maxLength={500}
              placeholder={r.type === "path" ? "/pricing or /docs/*" : "signup"}
              onChange={(e) => update(i, { value: e.target.value })}
            />
            {rows.length > min ? (
              <button
                type="button"
                className="secondary"
                aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="row">
        {rows.length < max ? (
          <button
            type="button"
            className="secondary"
            onClick={() => setRows((rs) => [...rs, { type: "path", value: "" }])}
          >
            Add {label.toLowerCase()}
          </button>
        ) : null}
        {children}
        <button type="submit">{submitText}</button>
      </div>
      {problem ? (
        <p className="alert error" role="alert" data-testid="step-editor-problem">
          {problem}
        </p>
      ) : null}
      <p className="small muted">
        Paths as tracked: no query string, placeholders such as {"{account}"} instead of addresses,
        and * for any run of characters.
      </p>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------ page

export function WebReportsPage() {
  const id = useId();
  const route = "/app/t/$tenantId/sites/$siteId/reports" as const;
  const { tenantId, siteId } = useParams({ from: route });
  const search = useSearch({ from: route });
  const navigate = useNavigate();
  const site = useSite(tenantId, siteId);
  useTitle(site.data ? `${site.data.name} reports` : "Reports");
  const [windowMin, setWindowMin] = useState(search.window);
  const [depth, setDepth] = useState(search.depth);
  const [from, setFrom] = useState(search.from ?? "");
  const set = (s: Partial<ReportsSearch>) =>
    void navigate({
      to: "/t/$tenantId/sites/$siteId/reports",
      params: { tenantId, siteId },
      search: { ...search, ...s },
      replace: true,
    });
  const base = { range: search.range, variant: search.variant } as const;
  const path = { tenantId, siteId };
  const funnel = useQuery({
    queryKey: ["report-funnel", tenantId, siteId, base, search.step, search.window],
    enabled: search.report === "funnel" && search.step.length >= FUNNEL_LIMITS.min,
    retry: false,
    queryFn: () =>
      api.call("getWebFunnelReport", {
        path,
        query: { ...base, step: search.step, window: search.window },
      }),
  });
  const goals = useQuery({
    queryKey: ["report-goals", tenantId, siteId, base, search.goal],
    enabled: search.report === "goals" && search.goal.length >= GOAL_LIMITS.min,
    retry: false,
    queryFn: () => api.call("getWebGoalsReport", { path, query: { ...base, goal: search.goal } }),
  });
  const journey = useQuery({
    queryKey: ["report-journey", tenantId, siteId, base, search.depth, search.from],
    enabled: search.report === "journey",
    retry: false,
    queryFn: () =>
      api.call("getWebJourneyReport", {
        path,
        query: {
          ...base,
          steps: search.depth,
          ...(search.from ? { start_step: search.from } : {}),
        },
      }),
  });
  const current = search.report === "funnel" ? funnel : search.report === "goals" ? goals : journey;
  const data = current.data as FunnelReport | GoalsReport | JourneyReport | undefined;
  return (
    <>
      <nav aria-label="Report">
        <ul className="tabs" data-testid="report-tabs">
          {REPORTS.map((r) => (
            <li key={r}>
              <Link
                to="/t/$tenantId/sites/$siteId/reports"
                params={path}
                search={{ ...search, report: r }}
                replace
                {...(search.report === r ? { "aria-current": "page" as const } : {})}
              >
                {REPORT_TEXT[r]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <form className="card" aria-label="Report filters" onSubmit={(e) => e.preventDefault()}>
        <div className="row">
          <div>
            <label htmlFor={`${id}-r`}>Time range</label>
            <select
              id={`${id}-r`}
              value={search.range}
              onChange={(e) => set({ range: e.target.value as ReportRangeKind })}
            >
              {REPORT_RANGES.map((p) => (
                <option key={p} value={p}>
                  {RANGE_TEXT[p]}
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend>Events</legend>
            <label className="inline">
              <input
                type="radio"
                name={`${id}-v`}
                checked={search.variant === "verified"}
                onChange={() => set({ variant: "verified" })}
              />
              Verified
            </label>
            <label className="inline">
              <input
                type="radio"
                name={`${id}-v`}
                checked={search.variant === "raw"}
                onChange={() => set({ variant: "raw" })}
              />
              Verified and suspect
            </label>
          </fieldset>
        </div>
      </form>
      {search.report === "funnel" ? (
        <StepListEditor
          key={`funnel-${search.step.join("|")}`}
          label="Step"
          initial={search.step}
          min={FUNNEL_LIMITS.min}
          max={FUNNEL_LIMITS.max}
          submitText="Show funnel"
          onRun={(step) => set({ step, window: windowMin })}
        >
          <label className="inline" htmlFor={`${id}-w`}>
            Minutes between steps
            <input
              id={`${id}-w`}
              type="number"
              min={1}
              max={1440}
              value={windowMin}
              onChange={(e) =>
                setWindowMin(Math.min(1440, Math.max(1, Number(e.target.value) || 1)))
              }
            />
          </label>
        </StepListEditor>
      ) : null}
      {search.report === "goals" ? (
        <StepListEditor
          key={`goals-${search.goal.join("|")}`}
          label="Goal"
          initial={search.goal}
          min={GOAL_LIMITS.min}
          max={GOAL_LIMITS.max}
          submitText="Show goals"
          onRun={(goal) => set({ goal })}
        />
      ) : null}
      {search.report === "journey" ? (
        <form
          className="card row"
          aria-label="Journey options"
          onSubmit={(e) => {
            e.preventDefault();
            const f = from.trim();
            set({
              depth,
              from: f === "" ? undefined : encodeStep(decodeStep(f).type, decodeStep(f).value),
            });
          }}
        >
          <div>
            <label htmlFor={`${id}-d`}>Steps per journey</label>
            <select id={`${id}-d`} value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {[2, 3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-f`}>Starting with (optional)</label>
            <input
              id={`${id}-f`}
              value={from}
              maxLength={500}
              placeholder="/ or event name"
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <button type="submit">Show journeys</button>
        </form>
      ) : null}
      <ProblemAlert error={current.error} />
      {data ? <ReportRangeNote range={data.range} /> : null}
      {search.report === "funnel" && funnel.data ? <FunnelReportView report={funnel.data} /> : null}
      {search.report === "goals" && goals.data ? <GoalsReportView report={goals.data} /> : null}
      {search.report === "journey" && journey.data ? (
        <JourneyReportView report={journey.data} />
      ) : null}
      {current.isLoading ? <p className="muted">Loading…</p> : null}
      <p className="small muted" data-testid="reports-not-offered">
        No retention or campaign (UTM) reports: visitors are not recognised across UTC days, and
        campaign parameters are never collected. Reports never show a single visitor, session or
        recording.
      </p>
    </>
  );
}
