// SPDX-License-Identifier: Apache-2.0
// Mobile apps (approved design): events that native apps and Telegram Mini Apps send (getAppEvents). An app cannot
// run the browser's proof of work, so everything here is self-attested and none of it counts in web figures, the
// trust score or snapshots.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  BarList,
  buttonClass,
  Card,
  Chart,
  Chip,
  EmptyState,
  fmtCompact,
  Icon,
  Kpi,
  Legend,
  Note,
  PageHeader,
  partialLast,
  QueryState,
  TableScroll,
} from "../../components/ui/index.ts";
import {
  axisLabel,
  fmtN,
  ProjectFrame,
  type ProjectRange,
  parseProjectRange,
  RANGE_SUB,
  RangePicker,
  shares,
} from "./common.tsx";

export function parseAppsSearch(s: Record<string, unknown>): { range: ProjectRange } {
  return { range: parseProjectRange(s.range) };
}

const PLATFORM: Record<string, string> = {
  ios: "iOS",
  android: "Android",
  web: "Telegram Mini App / web",
};

export function AppsPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/apps" });
  const { range } = useSearch({ from: "/app/t/$tenantId/apps" });
  const navigate = useNavigate();
  useTitle("Mobile apps");
  const q = useQuery({
    queryKey: ["app-events", tenantId, { range }],
    queryFn: () => api.call("getAppEvents", { path: { tenantId }, query: { range } }),
  });
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader
        title="Mobile apps"
        sub={`${RANGE_SUB[range]} · events your apps send`}
        badges={<Chip kind="self">Self-reported</Chip>}
      />
      <RangePicker
        value={range}
        onChange={(r) =>
          void navigate({
            to: "/t/$tenantId/apps",
            params: { tenantId },
            search: { range: r },
            replace: true,
          })
        }
      />
      <QueryState
        query={q}
        isEmpty={(d) => d.totals.events === 0 && d.totals.sessions === 0}
        empty={
          <div data-testid="app-events-empty">
            <EmptyState
              title="No app events yet"
              icon="phone"
              action={
                <Link
                  to="/t/$tenantId/integrations"
                  params={{ tenantId }}
                  search={{ group: "mobile" }}
                  className={buttonClass("secondary", { size: "sm" })}
                >
                  <Icon name="plug" />
                  Set it up
                </Link>
              }
            >
              Native apps and Telegram Mini Apps send events with the React Native or Flutter
              helper. One file, no dependency.
            </EmptyState>
          </div>
        }
      >
        {(d) => {
          const platforms = shares(d.platforms, (p) => p.events);
          const versions = shares(d.app_versions, (v) => v.count);
          const droppedShare =
            d.totals.events + d.totals.dropped > 0
              ? d.totals.dropped / (d.totals.events + d.totals.dropped)
              : null;
          return (
            <>
              <section
                className="um-grid um-g4"
                aria-label="Summary"
                data-testid="app-events-totals"
              >
                <Kpi tone="neutral" icon="activity" label="Events" value={fmtN(d.totals.events)} />
                <Kpi
                  tone="neutral"
                  icon="phone"
                  label="Sessions"
                  value={fmtN(d.totals.sessions)}
                  foot="Summed per day and edge node, an upper bound"
                />
                <Kpi
                  tone="neutral"
                  icon="layers"
                  label="Platforms"
                  value={String(d.platforms.filter((p) => p.events > 0).length)}
                  foot={d.platforms
                    .filter((p) => p.events > 0)
                    .map((p) => PLATFORM[p.platform] ?? p.platform)
                    .join(" · ")}
                />
                <Kpi
                  tone="neutral"
                  icon="filter"
                  label="Dropped"
                  value={droppedShare === null ? null : (droppedShare * 100).toFixed(1)}
                  unit="%"
                  foot={`${fmtN(d.totals.dropped)} stale or malformed`}
                />
              </section>
              <section className="um-grid um-g21">
                <Card
                  title="Over time"
                  actions={
                    <Legend
                      items={[
                        { label: "Events", color: "ink2" },
                        { label: "Sessions", color: "grey", dash: true },
                      ]}
                    />
                  }
                >
                  <Chart
                    partial={partialLast(d.daily.map((x) => x.day))}
                    label="App events and sessions per day"
                    labels={d.daily.map((x) => axisLabel(x.day))}
                    series={[
                      {
                        name: "Events",
                        color: "ink2",
                        data: d.daily.map((x) => x.events),
                        area: true,
                      },
                      {
                        name: "Sessions",
                        color: "grey",
                        data: d.daily.map((x) => x.sessions),
                        dash: true,
                        thin: true,
                      },
                    ]}
                    height={210}
                  />
                </Card>
                <Card title="Platforms">
                  <BarList
                    label="Platforms"
                    rows={platforms.map(({ row, share }) => ({
                      key: row.platform,
                      label: PLATFORM[row.platform] ?? row.platform,
                      value: fmtCompact(row.events),
                      share,
                    }))}
                  />
                </Card>
              </section>
              <section className="um-grid um-g21">
                <Card title="Events" flush>
                  <TableScroll label="Events per platform">
                    <table className="um-table" data-testid="app-events-table">
                      <caption className="um-sr">Events per platform</caption>
                      <thead>
                        <tr>
                          <th scope="col">Event</th>
                          <th scope="col" className="um-r">
                            iOS
                          </th>
                          <th scope="col" className="um-r">
                            Android
                          </th>
                          <th scope="col" className="um-r">
                            Web (Mini App)
                          </th>
                          <th scope="col" className="um-r">
                            Total
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.events.map((e) => (
                          <tr key={e.event}>
                            <td>
                              <code>{e.event}</code>
                            </td>
                            <td className="um-r">{fmtN(e.platforms.ios)}</td>
                            <td className="um-r">{fmtN(e.platforms.android)}</td>
                            <td className="um-r">{fmtN(e.platforms.web)}</td>
                            <td className="um-r">{fmtN(e.count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                </Card>
                <Card title="App versions" sub="Sessions per version">
                  {versions.length === 0 ? (
                    <EmptyState plain title="No versions reported" />
                  ) : (
                    <BarList
                      label="App versions"
                      rows={versions.map(({ row, share }) => ({
                        key: row.version,
                        label: <code>{row.version}</code>,
                        value: fmtN(row.count),
                        share,
                      }))}
                    />
                  )}
                  {d.sdk_versions.length > 0 ? (
                    <p className="um-p-fine">
                      SDK: {d.sdk_versions.map((v) => `${v.sdk} ${fmtN(v.count)}`).join(" · ")}
                    </p>
                  ) : null}
                </Card>
              </section>
              <Note icon="info">
                Self-reported: your apps send these events. An app cannot run the browser's proof of
                work, so none of this is verified and none of it counts in the web figures, the
                trust score or snapshots.
              </Note>
            </>
          );
        }}
      </QueryState>
    </ProjectFrame>
  );
}
