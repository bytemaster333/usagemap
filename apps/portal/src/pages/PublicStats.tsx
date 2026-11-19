// SPDX-License-Identifier: Apache-2.0
// Public pages for the programme outputs (share.signed-usage-report, ADR-0032, wire-formats §i): no sign-in. `/p/<slug>` shows a
// project's metrics document (§i.1) — anonymously when the project made its statistics public, otherwise with a share
// key the reader pastes (kept in this page's memory only and sent as `Authorization: Bearer`, never in a URL; C-14).
// Any refusal reads the same — "not available" — because the endpoint gives no existence oracle (404 for unknown,
// private, pending, suspended and removed projects alike, C-94).
// Plan D-5 (the card upgrade), shown once the document is readable: a card with the headline figures and a daily
// sparkline, the project's public list of signed snapshots in series order with its gap check and verify links, an
// embeddable badge generated in the browser (no request to us from the embedding page), and the "what we never show /
// never store" card (D-4). Wording rule C4: measurements only, never an endorsement.

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { type ReactNode, useEffect, useId, useState } from "react";
import { ApiError, api } from "../api/client.ts";
import { Sparkline } from "../components/BandChart.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { FilteredTraffic } from "../components/FilteredTraffic.tsx";
import { MetricTile } from "../components/MetricInfo.tsx";
import { DemoBanner, PrivacyCard } from "../components/PrivacyCard.tsx";
import { ProblemAlert } from "../components/ProblemAlert.tsx";
import { VerifyNumber } from "../components/VerifyNumber.tsx";
import { badgeHtml, badgeLines, badgeTextWidth } from "../lib/badge.ts";
import type { MetricKey } from "../lib/definitions.gen.ts";
import { fmtDay, fmtDuration, fmtInt, fmtPct, fmtRange, fmtShare } from "../lib/format.ts";
import { checkSeries, describeSeriesProblem } from "../lib/snapshotSeries.ts";
import { metricsPath } from "./Sharing.tsx";
import { PRESET_TEXT } from "./TractionSnapshots.tsx";

type MetricsDoc = ControlPlane.MetricsEndpointDocument;

/** The parts of the metrics document the page shows (wire-formats §i.1; the OpenAPI schema leaves them open). */
export interface MetricsView {
  project: { slug: string; name: string; verification_level: string };
  generated_at: string;
  window: { start: string; end: string; days: number };
  web: {
    verified: { pageviews: number; visitors_sum: number };
    raw: { pageviews: number; visitors_sum: number };
    visit_metrics: {
      visits: number;
      bounces: number;
      bounce_rate_pct: number | null;
      avg_visit_duration_s: number | null;
      suspect_pageview_share: number | null;
    };
    daily: {
      start: string;
      pageviews_verified: number;
      pageviews_raw: number;
      visitors_sum_verified: number;
      visitors_sum_raw: number;
    }[];
    /** events not counted as verified and why (2026-11-19); absent in documents built before it */
    filtered?: {
      events_received: number;
      verified: number;
      suspect: number;
      rejected: number;
      not_counted_share: number | null;
      reasons: { code: string; verdict: "suspect" | "rejected"; count: number }[];
      reasons_suppressed: number;
    };
  };
  api: {
    label: string;
    requests: number;
    error_rate_5xx: number | null;
    p95_ms: number | null;
    accuracy_class: string | null;
    assurance_level: string | null;
    onchain_consistent?: string | null;
    daily: { start: string; requests: number }[];
  };
  links: { definitions: string };
}

export const asView = (d: MetricsDoc) => d as unknown as MetricsView;

/** Frame for pages anyone may open: no session, no tenant switcher. */
export function PublicFrame({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · UsageMap`;
  }, [title]);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <Link to="/signin" search={{}} className="brand">
          UsageMap
        </Link>
        <span className="spacer" />
        <span className="muted small">Public page · no sign-in needed</span>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}

function Tile({
  metric,
  label,
  value,
  sub,
  testId,
}: {
  metric: MetricKey;
  label: string;
  value: string;
  sub?: string;
  testId: string;
}) {
  return <MetricTile metric={metric} testId={testId} label={label} value={value} sub={sub} />;
}

export function MetricsDocumentView({ doc }: { doc: MetricsView }) {
  const vm = doc.web.visit_metrics;
  return (
    <>
      <p>
        {fmtRange(doc.window.start, doc.window.end)}{" "}
        <span className="muted">(UTC, last {doc.window.days} complete days)</span> · verification
        level <strong data-testid="public-level">{doc.project.verification_level}</strong> · rebuilt{" "}
        {fmtDay(doc.generated_at)}
      </p>
      <section className="card" aria-labelledby="pw-h">
        <h2 id="pw-h">Web</h2>
        <div className="tiles">
          <Tile
            metric="pageviews_verified"
            testId="public-pv-verified"
            label="Verified page views"
            value={fmtInt(doc.web.verified.pageviews)}
            sub={`${fmtInt(doc.web.raw.pageviews)} raw`}
          />
          <Tile
            metric="visitors_sum"
            testId="public-visitors"
            label="Visitors (sum of daily uniques)"
            value={fmtInt(doc.web.verified.visitors_sum)}
            sub={`${fmtInt(doc.web.raw.visitors_sum)} raw`}
          />
          <Tile metric="visits" testId="public-visits" label="Visits" value={fmtInt(vm.visits)} />
          <Tile
            metric="bounce_rate"
            testId="public-bounce"
            label="Bounce rate"
            value={fmtPct(vm.bounce_rate_pct)}
          />
          <Tile
            metric="avg_visit_duration"
            testId="public-duration"
            label="Average visit"
            value={fmtDuration(vm.avg_visit_duration_s)}
          />
          <Tile
            metric="suspect_share"
            testId="public-suspect"
            label="Suspect page views"
            value={fmtShare(vm.suspect_pageview_share)}
            sub="counted in raw figures only"
          />
        </div>
        {doc.web.daily.length > 0 ? (
          <div className="table-wrap">
            <table data-testid="public-daily">
              <caption>Daily web figures</caption>
              <thead>
                <tr>
                  <th scope="col">Day (UTC)</th>
                  <th scope="col" className="num">
                    Verified page views
                  </th>
                  <th scope="col" className="num">
                    Raw page views
                  </th>
                  <th scope="col" className="num">
                    Verified visitors
                  </th>
                </tr>
              </thead>
              <tbody>
                {doc.web.daily.map((d) => (
                  <tr key={d.start}>
                    <td>{fmtDay(d.start)}</td>
                    <td className="num">{fmtInt(d.pageviews_verified)}</td>
                    <td className="num">{fmtInt(d.pageviews_raw)}</td>
                    <td className="num">{fmtInt(d.visitors_sum_verified)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {doc.web.filtered ? (
          <section className="stack" aria-labelledby="pf-h" data-testid="public-filtered-section">
            <h3 id="pf-h">Traffic not counted</h3>
            <FilteredTraffic
              verdicts={doc.web.filtered}
              reasons={doc.web.filtered.reasons}
              suppressed={doc.web.filtered.reasons_suppressed}
              caption="Why events were not counted as verified"
              testId="public-filtered"
            />
          </section>
        ) : null}
      </section>
      <section className="card" aria-labelledby="pa-h">
        <h2 id="pa-h">API</h2>
        <p>
          <span className="badge warn" data-testid="public-api-label">
            {doc.api.label}
          </span>{" "}
          <span className="small muted">
            reported by the project's own services; assurance level{" "}
            {doc.api.assurance_level ?? "none"}
          </span>
        </p>
        <div className="tiles">
          <Tile
            metric="api_requests"
            testId="public-requests"
            label="Requests"
            value={fmtInt(doc.api.requests)}
          />
          <Tile
            metric="error_rate_5xx"
            testId="public-5xx"
            label="Server error rate"
            value={fmtShare(doc.api.error_rate_5xx)}
          />
          <Tile
            metric="latency_percentiles"
            testId="public-p95"
            label="p95 latency"
            value={doc.api.p95_ms === null ? "—" : `${fmtInt(Math.round(doc.api.p95_ms))} ms`}
          />
        </div>
      </section>
      <p className="small muted">
        Metric definitions: <a href={doc.links.definitions}>{doc.links.definitions}</a>. This
        document is rebuilt every hour and is not signed; for a signed statement over a period, ask
        the project for a traction snapshot and check it with the snapshot verification page.
      </p>
    </>
  );
}

export function ProjectCard({ doc }: { doc: MetricsView }) {
  const daily = doc.web.daily.map((d) => d.pageviews_verified);
  return (
    <section className="card stack" aria-labelledby="pc-h" data-testid="project-card">
      <h2 id="pc-h">Measured usage, last {doc.window.days} days</h2>
      <div className="row">
        <p className="tile-value" data-testid="card-visitors">
          {fmtInt(doc.web.verified.visitors_sum)}
        </p>
        <p>
          verified visitors (sum of daily uniques)
          <br />
          <span className="small muted">
            {fmtShare(doc.web.visit_metrics.suspect_pageview_share)} of page views suspect · level{" "}
            {doc.project.verification_level}
          </span>
        </p>
        {daily.length > 1 ? (
          <Sparkline values={daily} label="Daily verified page views over the window" />
        ) : null}
      </div>
      <VerifyNumber
        slug={doc.project.slug}
        measure="visitors"
        shown={doc.web.verified.visitors_sum}
      />
      <p>
        API: {fmtInt(doc.api.requests)} requests <span className="badge warn">{doc.api.label}</span>
        {doc.api.assurance_level ? (
          <span className="badge">assurance {doc.api.assurance_level}</span>
        ) : null}
        {doc.api.onchain_consistent && doc.api.onchain_consistent !== "not_applicable" ? (
          <span className="badge" data-testid="card-onchain">
            on-chain: {doc.api.onchain_consistent}
          </span>
        ) : null}
      </p>
      {doc.api.requests > 0 ? (
        <VerifyNumber slug={doc.project.slug} measure="api" shown={doc.api.requests} />
      ) : null}
      <p className="small muted">
        "Verified" means the page views passed our bot checks in the visitor's browser. These are
        measurements, not an endorsement by SCF, SDF or anyone else.
      </p>
    </section>
  );
}

export function PublicSnapshotList({ slug }: { slug: string }) {
  const list = useQuery({
    queryKey: ["snapshot-list", slug],
    queryFn: () => api.call("getPublicSnapshotList", { path: { slug } }),
    retry: false,
  });
  const entries = list.data?.snapshots ?? [];
  const problems = checkSeries(entries);
  const notFound = list.error instanceof ApiError && list.error.status === 404;
  return (
    <section className="card stack" aria-labelledby="ps-h" data-testid="public-snapshots">
      <h2 id="ps-h">Signed snapshots</h2>
      {notFound ? null : <ProblemAlert error={list.error} />}
      {list.data && entries.length === 0 ? <p>No signed snapshots yet.</p> : null}
      {entries.length > 0 ? (
        <>
          <p
            className={problems.length === 0 ? "alert ok" : "alert error"}
            data-testid="public-series-check"
            role="status"
          >
            {problems.length === 0
              ? `Every snapshot this project has issued is listed: 1–${entries.length}, no gap, each linked to the one before by its hash.`
              : `This list is not complete or not linked: ${problems.map(describeSeriesProblem).join(" ")}`}
          </p>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Signed snapshots in series order</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    No.
                  </th>
                  <th scope="col">Period (UTC)</th>
                  <th scope="col">Purpose</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Verify</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.snapshot_id} data-testid={`public-snapshot-${e.seq}`}>
                    <td className="num">{e.seq}</td>
                    <td>{fmtRange(e.period.start, e.period.end)}</td>
                    <td>{e.preset ? PRESET_TEXT[e.preset] : "—"}</td>
                    <td>{e.status === "revoked" ? "revoked" : "valid"}</td>
                    <td>
                      <Link to="/verify" search={{ snapshot: e.snapshot_id }}>
                        Verify<span className="sr-only"> snapshot {e.seq}</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Snapshots are numbered when they are signed and are never deleted; a revoked one stays
            listed. A gap or a broken hash link would mean one was withheld.
          </p>
        </>
      ) : null}
    </section>
  );
}

export function BadgeSection({ doc }: { doc: MetricsView }) {
  const input = {
    name: doc.project.name,
    verifiedVisitors: doc.web.verified.visitors_sum,
    days: doc.window.days,
    asOf: new Date(Date.parse(doc.window.end) - 86_400_000).toISOString().slice(0, 10),
    cardUrl: `${window.location.origin}/p/${encodeURIComponent(doc.project.slug)}`,
  };
  const { left, right } = badgeLines(input);
  const lw = badgeTextWidth(left);
  const rw = badgeTextWidth(right);
  const html = badgeHtml(input);
  return (
    <section className="card stack" aria-labelledby="pb-h" data-testid="badge">
      <h2 id="pb-h">Embed a badge</h2>
      <p>
        <svg
          className="badge-preview"
          width={lw + rw}
          height={20}
          viewBox={`0 0 ${lw + rw} 20`}
          role="img"
          aria-label={`${left}: ${right}`}
        >
          <rect width={lw} height={20} fill="#2f3237" />
          <rect x={lw} width={rw} height={20} fill="#1b6e45" />
          <g fill="#fff" fontFamily="Verdana,DejaVu Sans,sans-serif" fontSize={11}>
            <text x={6} y={14}>
              {left}
            </text>
            <text x={lw + 6} y={14}>
              {right}
            </text>
          </g>
        </svg>
      </p>
      <pre className="code">
        <code data-testid="badge-code">{html}</code>
      </pre>
      <CopyButton text={html} label="Copy badge HTML" />
      <ServerBadges slug={doc.project.slug} />
      <p className="small muted">
        The badge is self-contained: its figure is as of {fmtDay(`${input.asOf}T00:00:00Z`)} and the
        page that embeds it never contacts us, so we never see its visitors. Copy a fresh one to
        update it.
      </p>
    </section>
  );
}

/**
 * Live badges served by UsageMap (2026-11-19): an SVG and a Shields.io endpoint, only while the project's statistics
 * are public (the endpoints answer 404 otherwise). Unlike the self-contained badge above, an embedding page that loads
 * the SVG makes its visitors' browsers contact us; the Shields form makes only Shields contact us.
 */
export function ServerBadges({ slug }: { slug: string }) {
  const base = `${window.location.origin}/public/v1/projects/${encodeURIComponent(slug)}`;
  const svg = `${base}/badge.svg`;
  const shields = `https://img.shields.io/endpoint?url=${encodeURIComponent(`${base}/badge.json`)}`;
  const markdown = `[![Measured by UsageMap](${shields})](${window.location.origin}/p/${encodeURIComponent(slug)})`;
  return (
    <details data-testid="server-badges">
      <summary>Live badges (updated hourly)</summary>
      <ul className="stack">
        <li>
          SVG: <code data-testid="server-badge-svg">{svg}</code> (add <code>?metric=api</code> for
          API requests)
        </li>
        <li>
          README (Shields.io): <code data-testid="server-badge-shields">{markdown}</code>{" "}
          <CopyButton text={markdown} label="Copy README badge" />
        </li>
      </ul>
      <p className="small muted">
        Live badges exist only while the statistics are public. Counts below 100 visitors or 1,000
        API requests read "&lt; 100" / "&lt; 1,000". The SVG link makes the embedding page's
        visitors contact UsageMap; the Shields.io form makes only Shields contact us.
      </p>
    </details>
  );
}

export function PublicStatsPage() {
  const id = useId();
  const { slug } = useParams({ from: "/p/$slug" });
  // The share key lives in component state only: never in the URL, storage or the query cache key.
  const [keyInput, setKeyInput] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [keyVersion, setKeyVersion] = useState(0);
  const doc = useQuery({
    queryKey: ["public-metrics", slug, keyVersion],
    queryFn: () =>
      api.call("getMetricsEndpoint", { path: { slug }, ...(key ? { bearer: key } : {}) }),
    retry: false,
    gcTime: 0,
  });
  const notAvailable = doc.error instanceof ApiError && doc.error.status === 404;
  const view = doc.data && typeof doc.data === "object" ? asView(doc.data as MetricsDoc) : null;
  return (
    <PublicFrame title={view ? `${view.project.name} statistics` : "Project statistics"}>
      <h1>{view ? view.project.name : "Project statistics"}</h1>
      {doc.isLoading ? <p className="muted">Loading…</p> : null}
      {notAvailable ? (
        <p className="alert info" data-testid="public-not-available" role="status">
          {key
            ? "These statistics are not available with this share key."
            : "These statistics are not public. If the project gave you a share key, enter it below."}
        </p>
      ) : (
        <ProblemAlert error={doc.error} />
      )}
      {view ? (
        <>
          <DemoBanner slug={view.project.slug} />
          <ProjectCard doc={view} />
          <MetricsDocumentView doc={view} />
          <PublicSnapshotList slug={view.project.slug} />
          <BadgeSection doc={view} />
          <PrivacyCard compact />
        </>
      ) : null}
      {view || notAvailable ? (
        <form
          className="card stack"
          aria-labelledby={`${id}-h`}
          onSubmit={(e) => {
            e.preventDefault();
            const k = keyInput.trim();
            setKey(k === "" ? null : k);
            setKeyInput("");
            setKeyVersion((v) => v + 1);
          }}
        >
          <h2 id={`${id}-h`}>{key ? "Share key in use" : "Read with a share key"}</h2>
          <div>
            <label htmlFor={`${id}-k`}>Share key</label>
            <input
              id={`${id}-k`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              placeholder="scfa_pub_…"
              onChange={(e) => setKeyInput(e.target.value)}
            />
          </div>
          <p className="small muted">
            The key stays in this page and is sent only in the request header. The same document is
            available to scripts at <code>{metricsPath(slug)}</code> with{" "}
            <code>Authorization: Bearer &lt;key&gt;</code>.
          </p>
          <button type="submit">
            {keyInput.trim() === "" && key ? "Forget the key" : "Use key"}
          </button>
        </form>
      ) : null}
    </PublicFrame>
  );
}
