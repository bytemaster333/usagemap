// SPDX-License-Identifier: Apache-2.0
// Installation check (C-39): how the gateway judged this site's events — verdict counters, the reason codes behind
// suspect and rejected events (wire-formats §h.2), drop counters, the tracker version seen against the latest
// release (tracker.intentional-upgrade), Wallets Kit presence
// (C-75), the site's multiplicity mode with the events it left unchanged in shadow mode (C-124) and the site's ingest
// limits (C-80, C-90).

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useId } from "react";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { MetricTile } from "../components/MetricInfo.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { PageHeader } from "../components/ui/index.ts";
import { WEB_REASON_TEXT } from "../lib/apiFormat.ts";
import { fmtInt, fmtRange } from "../lib/format.ts";
import { latestActive, upgradeState } from "../lib/trackerVersions.ts";
import { useSite } from "./SiteLayout.tsx";

/** Plain-language meaning of every web reason code (wire-formats §h.2); kept in lib/apiFormat.ts. */
export const REASON_TEXT = WEB_REASON_TEXT;

/**
 * Current vs latest tracker version (tracker.intentional-upgrade, ADR-0004). Upgrading is the tenant's decision: the panel only states the
 * difference and links to the snippet of the newer version (version + SRI hash to paste); every released version
 * keeps being served until it is withdrawn for a security defect.
 */
export function TrackerVersionPanel({
  tenantId,
  siteId,
  seen,
  outdated,
}: {
  tenantId: string;
  siteId: string;
  seen: string | null;
  outdated: boolean;
}) {
  const versions = useQuery({
    queryKey: ["tracker-versions"],
    queryFn: () => api.call("listTrackerVersions", {}),
  });
  const state = versions.data ? upgradeState(seen, versions.data) : null;
  const snippetLink = (version: string, text: string) => (
    <Link
      to="/t/$tenantId/sites/$siteId/snippet"
      params={{ tenantId, siteId }}
      search={{ format: "html", version }}
    >
      {text}
    </Link>
  );
  return (
    <section className="card stack" aria-labelledby="tv-h" data-testid="tracker-version">
      <h3 id="tv-h">Tracker version</h3>
      <ProblemAlert error={versions.error} />
      <p>
        Seen on your pages: <strong data-testid="tracker-seen">{seen ?? "not reported"}</strong> ·
        latest release:{" "}
        <strong data-testid="tracker-latest">
          {versions.data ? (latestActive(versions.data) ?? "none") : "…"}
        </strong>
      </p>
      {state?.kind === "update_available" ? (
        <p className="alert warn" data-testid="tracker-update" role="status">
          Update available: {state.seen} → {state.latest}. Your pages keep working with {state.seen}
          ; upgrade when it suits you by replacing the snippet (new version and SRI hash) or bumping{" "}
          <code>@usagemap/tracker</code>.{" "}
          {snippetLink(state.latest, `Get the ${state.latest} snippet`)}
        </p>
      ) : state?.kind === "withdrawn" ? (
        <p className="alert error" data-testid="tracker-update" role="alert">
          Version {state.seen} was withdrawn for a security defect and is no longer served; events
          from it are refused.{" "}
          {state.advisory ? <a href={state.advisory}>Read the advisory</a> : null}{" "}
          {state.latest ? snippetLink(state.latest, `Get the ${state.latest} snippet`) : null}
        </p>
      ) : state?.kind === "current" ? (
        <p className="alert ok" data-testid="tracker-update" role="status">
          Up to date.
        </p>
      ) : state?.kind === "unknown" ? (
        <p className="alert warn" data-testid="tracker-update" role="status">
          Version {state.seen} is not a published release.
        </p>
      ) : state?.kind === "not_reported" ? (
        <p className="small muted" data-testid="tracker-update">
          The version your pages load is reported once the gateway has counted events with it.
        </p>
      ) : null}
      {outdated && state?.kind !== "update_available" && state?.kind !== "withdrawn" ? (
        <p className="alert warn">
          Your pages load an outdated tracker version. Update the snippet.
        </p>
      ) : null}
    </section>
  );
}

export function InstallationPage() {
  const id = useId();
  const { tenantId, siteId } = useParams({ from: "/app/t/$tenantId/sites/$siteId/installation" });
  const search = useSearch({ from: "/app/t/$tenantId/sites/$siteId/installation" });
  const navigate = useNavigate();
  const site = useSite(tenantId, siteId);
  useTitle(site.data ? `${site.data.name} installation check` : "Installation check");
  const check = useQuery({
    queryKey: ["installation", tenantId, siteId, search.range],
    queryFn: () =>
      api.call("getInstallationCheck", {
        path: { tenantId, siteId },
        query: { range: search.range },
      }),
  });
  const c = check.data;
  const total = c ? c.verdicts.verified + c.verdicts.suspect + c.verdicts.rejected : 0;

  return (
    <>
      <PageHeader title="Trust" sub={`Installation check · ${site.data?.name ?? "website"}`} />
      <h2 className="um-h2">Installation check</h2>
      <div className="row">
        <div>
          <label htmlFor={`${id}-r`}>Period</label>
          <select
            id={`${id}-r`}
            value={search.range}
            onChange={(e) =>
              void navigate({
                to: "/t/$tenantId/sites/$siteId/installation",
                params: { tenantId, siteId },
                search: { range: e.target.value as "24h" | "7d" | "30d" },
                replace: true,
              })
            }
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>
      </div>
      <ProblemAlert error={check.error} />
      {c ? (
        <>
          <p>
            {fmtRange(c.start, c.end)} <span className="muted">(UTC)</span>
          </p>
          {total === 0 ? (
            <p className="alert warn" data-testid="no-events">
              No events have arrived yet. Add the snippet to your pages and open one of them.
            </p>
          ) : (
            <p className="alert ok" data-testid="receiving">
              Events are arriving: {fmtInt(total)} in this period.
            </p>
          )}
          <div className="tiles">
            <MetricTile
              metric="events_by_verdict"
              testId="verdict-verified"
              label="Verified"
              value={fmtInt(c.verdicts.verified)}
              sub="counted as verified"
            />
            <MetricTile
              metric="events_by_verdict"
              testId="verdict-suspect"
              label="Suspect"
              value={fmtInt(c.verdicts.suspect)}
              sub="counted in raw figures only"
            />
            <MetricTile
              metric="events_by_verdict"
              testId="verdict-rejected"
              label="Rejected"
              value={fmtInt(c.verdicts.rejected)}
              sub="never counted"
            />
            <MetricTile
              metric="kit_present_pageviews"
              testId="kit-present"
              label="Page views with Stellar Wallets Kit"
              value={fmtInt(c.kit_present_pageviews)}
            />
          </div>
          <TrackerVersionPanel
            tenantId={tenantId}
            siteId={siteId}
            seen={c.tracker_version_seen ?? null}
            outdated={c.outdated_tracker === true}
          />
          <section className="card">
            <table data-testid="reasons">
              <caption>Reasons</caption>
              <thead>
                <tr>
                  <th scope="col">Reason</th>
                  <th scope="col">Effect</th>
                  <th scope="col">Meaning</th>
                  <th scope="col" className="num">
                    Events
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.reasons.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No suspect or rejected events.
                    </td>
                  </tr>
                ) : (
                  [...c.reasons]
                    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
                    .map((r) => (
                      <tr key={`${r.code}-${r.verdict}`}>
                        <td>
                          <code>{r.code}</code>
                        </td>
                        <td>{r.verdict}</td>
                        <td>{REASON_TEXT[r.code] ?? ""}</td>
                        <td className="num">{fmtInt(r.count)}</td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
            <p className="small muted">
              An event can have several reasons; its verdict is the worst of them.
            </p>
          </section>
          <section className="card" data-testid="multiplicity">
            <h3>Many visitors from one network</h3>
            <p>
              Mode: <strong data-testid="multiplicity-mode">{c.multiplicity.mode}</strong>{" "}
              <span className="muted">
                (
                {c.multiplicity.source === "site"
                  ? "set for this website by SCF"
                  : "the platform setting"}
                )
              </span>
            </p>
            {c.multiplicity.mode === "shadow" ? (
              <p>
                In shadow mode such events are not marked suspect for this reason; they are only
                counted:{" "}
                <strong data-testid="multiplicity-high-shadow">
                  {fmtInt(c.multiplicity.high_shadow)}
                </strong>{" "}
                events in this period would have been suspect.
              </p>
            ) : c.multiplicity.high_shadow > 0 ? (
              <p data-testid="multiplicity-high-shadow">
                {fmtInt(c.multiplicity.high_shadow)} events in this period were only counted while
                shadow mode was on.
              </p>
            ) : (
              <p className="small muted">
                Events from a network with many visitors and little engagement are marked suspect (
                <code>multiplicity_high</code>).
              </p>
            )}
          </section>
          <section className="card">
            <table data-testid="drops">
              <caption>Dropped before counting</caption>
              <thead>
                <tr>
                  <th scope="col">Cause</th>
                  <th scope="col" className="num">
                    Events
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.drops.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="muted">
                      Nothing dropped.
                    </td>
                  </tr>
                ) : (
                  c.drops.map((d) => (
                    <tr key={d.label}>
                      <td>
                        <code>{d.label}</code>
                      </td>
                      <td className="num">{fmtInt(d.count)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
      {site.data ? (
        <section className="card" data-testid="limits">
          <h3>Ingest limits</h3>
          <p>
            Rate limit: {fmtInt(site.data.limits.rate_limit_per_min)} events per minute · Daily
            quota of verified events:{" "}
            {site.data.limits.daily_quota === null ? "none" : fmtInt(site.data.limits.daily_quota)}{" "}
            · Verified today: {fmtInt(site.data.limits.verified_events_today)}
          </p>
        </section>
      ) : null}
    </>
  );
}
