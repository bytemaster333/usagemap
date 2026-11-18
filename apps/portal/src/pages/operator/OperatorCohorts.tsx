// SPDX-License-Identifier: Apache-2.0
// Operator cohorts (plan C3 / D-9; wire-formats §i.4; `operatorCohorts`): verified web figures and on-chain counts per
// SCF round, category or award stage. A cohort with fewer than `min_tenants` projects is listed without figures; in a
// shown cohort a figure below the small-count floor is null, and the on-chain figures are null unless enough of its
// projects have on-chain data (C-137). Every null is shown as hidden, never as zero. The floor is for fair comparison,
// not a privacy boundary: the project table reads each project's exact totals. Reading this page is audited
// (`operator.read.op_cohorts`).

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  Card,
  EmptyState,
  Icon,
  Note,
  QueryState,
  Segmented,
  TableScroll,
} from "../../components/ui/index.ts";
import { DAY_PRESETS, type DayPreset, presetSpan } from "../../lib/days.ts";
import { LEVELS, type Level } from "../../lib/search.ts";
import { Hid, Num, OpIntro, TopActions, Track } from "./kit.tsx";
import { fmtShareD } from "./model.ts";
import { OPERATOR_DEFAULT_SEARCH } from "./OperatorLayout.tsx";

type By = ControlPlane.CohortList["by"];
type Cohort = ControlPlane.Cohort;

export interface CohortSearch {
  by: By;
  range: DayPreset;
  min_level: Level;
}

export function parseCohortSearch(s: Record<string, unknown>): CohortSearch {
  return {
    by: s.by === "category" || s.by === "award_stage" ? s.by : "round",
    range: (DAY_PRESETS as readonly unknown[]).includes(s.range) ? (s.range as DayPreset) : "90d",
    min_level: (LEVELS as readonly unknown[]).includes(s.min_level) ? (s.min_level as Level) : "L1",
  };
}

/** wire-formats §i.4 slug → label. */
export const CATEGORY_TEXT: Record<string, string> = {
  end_user_application: "End-User Application",
  financial_protocols: "Financial Protocols",
  applications: "Applications",
  developer_tooling: "Developer Tooling",
  infrastructure_services: "Infrastructure & Services",
};
export const STAGE_TEXT: Record<string, string> = {
  t0_prelaunch: "Pre-Launch #0 Awarded",
  t1_mvp: "#1 MVP",
  t2_testnet: "#2 Testnet",
  t3_mainnet: "#3 Mainnet",
};

export function cohortLabel(by: By, cohort: string): string {
  if (by === "round") return /^\d+$/.test(cohort) ? `Round #${cohort}` : cohort;
  if (by === "category") return CATEGORY_TEXT[cohort] ?? cohort;
  return STAGE_TEXT[cohort] ?? cohort;
}

/** Rounds newest first; categories and stages in the vocabulary's order. */
export function sortCohorts(by: By, rows: readonly Cohort[]): Cohort[] {
  const order = by === "category" ? Object.keys(CATEGORY_TEXT) : Object.keys(STAGE_TEXT);
  return [...rows].sort((a, b) =>
    by === "round"
      ? Number(b.cohort) - Number(a.cohort)
      : order.indexOf(a.cohort) - order.indexOf(b.cohort),
  );
}

const BY_TEXT: Record<By, string> = {
  round: "SCF round",
  category: "Category",
  award_stage: "Award stage",
};

export function OperatorCohortsPage() {
  useTitle("Cohorts");
  const search = useSearch({ from: "/app/operator/cohorts" });
  const navigate = useNavigate();
  const span = presetSpan(search.range);
  const set = (s: Partial<CohortSearch>) =>
    void navigate({ to: "/operator/cohorts", search: { ...search, ...s }, replace: true });
  const q = useQuery({
    queryKey: ["op-cohorts", search.by, span.start, span.end, search.min_level],
    queryFn: () =>
      api.call("operatorCohorts", {
        query: { start: span.start, end: span.end, by: search.by, min_level: search.min_level },
      }),
  });
  const m = q.data?.min_tenants;
  return (
    <>
      <TopActions range={search.range} onRange={(r) => set({ range: r })} />
      <OpIntro
        title="Cohorts"
        lead="Stellar ecosystem projects grouped by SCF round, category or award stage, so funding cohorts can be compared without singling anyone out."
        aside={
          m !== undefined ? (
            <span className="um-op-privfloor" data-testid="cohort-floor">
              <Icon name="shield" size="sm" />
              <span>
                Groups under <b>{m}</b> projects hidden
              </span>
            </span>
          ) : null
        }
      />
      <Card
        title={
          search.by === "round"
            ? "By SCF round"
            : search.by === "category"
              ? "By category"
              : "By award stage"
        }
        flush
        className="um-op-card-flush"
        actions={
          <span className="um-op-btns">
            <Segmented
              label="Group by"
              value={search.by}
              onChange={(by) => set({ by })}
              options={[
                { value: "round", label: "Round" },
                { value: "category", label: "Category" },
                { value: "award_stage", label: "Award stage" },
              ]}
            />
            <select
              className="um-op-sel"
              aria-label="Minimum verification level"
              value={search.min_level}
              onChange={(e) => set({ min_level: e.target.value as Level })}
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l} and up
                </option>
              ))}
            </select>
          </span>
        }
        data-testid="cohorts"
      >
        <QueryState
          query={q}
          plain
          isEmpty={(d) => d.cohorts.length === 0}
          empty={<EmptyState plain title="No cohorts in this window" />}
        >
          {(d) => {
            const rows = sortCohorts(d.by, d.cohorts);
            const mx = Math.max(0, ...rows.map((r) => r.pageviews_verified ?? 0));
            return (
              <TableScroll label="Cohorts" stickyFirst>
                <table className="um-table um-op-table">
                  <thead>
                    <tr>
                      <th scope="col">{BY_TEXT[d.by]}</th>
                      <th scope="col" className="um-r">
                        Stellar ecosystem projects
                      </th>
                      <th scope="col" className="um-r">
                        Page views · verified
                      </th>
                      <th scope="col" className="um-r">
                        Visitors
                      </th>
                      <th scope="col" className="um-r um-op-gs">
                        With on-chain data
                      </th>
                      <th scope="col" className="um-r">
                        Contract calls
                      </th>
                      <th scope="col" className="um-r">
                        Succeeded
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => {
                      const label = cohortLabel(d.by, c.cohort);
                      if (c.suppressed)
                        return (
                          <tr
                            key={c.cohort}
                            className="um-op-supp"
                            data-testid={`cohort-${c.cohort}`}
                          >
                            <th scope="row">{label}</th>
                            <td className="um-r">
                              <Hid
                                min={d.min_tenants}
                                why={`Fewer than ${d.min_tenants} projects in this group, so its figures could identify one project.`}
                              />
                            </td>
                            <td colSpan={5} data-testid="cohort-suppressed">
                              <span className="um-op-hid um-op-hid--plain">
                                <Icon name="eyeoff" size="xs" />
                                Hidden · fewer than {d.min_tenants} projects in this group
                              </span>
                            </td>
                          </tr>
                        );
                      const hidden = (n: number | null) =>
                        n === null ? (
                          <Hid min={10} why="Hidden: a small count could identify one project." />
                        ) : (
                          <Num value={n} />
                        );
                      return (
                        <tr key={c.cohort} data-testid={`cohort-${c.cohort}`}>
                          <th scope="row">{label}</th>
                          <td className="um-r">{c.tenant_count ?? "—"}</td>
                          <td className="um-r">
                            {c.pageviews_verified === null ? (
                              hidden(null)
                            ) : (
                              <span className="um-op-cbar">
                                <Num value={c.pageviews_verified} />
                                <Track value={c.pageviews_verified} max={mx} />
                              </span>
                            )}
                          </td>
                          <td className="um-r">{hidden(c.visitors_sum_verified)}</td>
                          <td className="um-r um-op-gs">{c.tenants_with_onchain ?? "—"}</td>
                          {c.onchain_invocations === null ? (
                            <td className="um-r" colSpan={2}>
                              <span
                                className="um-op-hid"
                                title={`On-chain figures show once at least ${d.min_tenants} projects in the group have on-chain data.`}
                              >
                                <Icon name="eyeoff" size="xs" />
                                needs {d.min_tenants} projects
                              </span>
                            </td>
                          ) : (
                            <>
                              <td className="um-r">
                                <Num value={c.onchain_invocations} />
                              </td>
                              <td className="um-r">
                                {c.onchain_invocations && c.onchain_successful_invocations !== null
                                  ? fmtShareD(
                                      c.onchain_successful_invocations / c.onchain_invocations,
                                    )
                                  : "—"}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            );
          }}
        </QueryState>
      </Card>
      {m !== undefined ? (
        <Note tone="warn" icon="alert">
          <span data-testid="cohort-note">
            Cohort figures are a floor for fair comparison, not a privacy boundary. The minimum
            group size comes from the <code className="um-code">cohort_min_tenants</code> setting
            (now {m}). Each project’s exact figures are in the{" "}
            <Link to="/operator/web" search={OPERATOR_DEFAULT_SEARCH} className="um-link">
              project table
            </Link>
            .
          </span>
        </Note>
      ) : null}
    </>
  );
}
