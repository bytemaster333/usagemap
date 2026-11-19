// SPDX-License-Identifier: Apache-2.0
// The SCF Evidence Link: one public, read-only page per signed traction snapshot (`/evidence/<snapshot id>`, no
// sign-in) — the link a project pastes into its SCF application. Everything on it comes from the signed document the
// public endpoint serves (getPublicSnapshot), so a reader can check every figure with the Verify link: the funnel
// (web visitors → wallet connects → signatures, with on-chain calls beside it — ledger counts are never joined to
// visitors, decision D5), verified vs raw, daily; the API summary; confidence and its reasons; the window preset;
// the Growth Hack or Public Goods block; the project's position in its SCF round and categories; data coverage.
// Counts the document withholds (below the small-count floor, C-137) read "fewer than k", never 0. Wording rule C4:
// a measurement, never an endorsement; a testnet seal is a demonstration.

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useId } from "react";
import { ApiError, api } from "../../api/client.ts";
import { CopyButton } from "../../components/CopyButton.tsx";
import { LineChart } from "../../components/LineChart.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { fmtDay, fmtInt, fmtShare } from "../../lib/format.ts";
import { TESTNET_NOTICE } from "../../lib/seal.ts";
import { PublicFrame } from "../PublicStats.tsx";
import { PRESET_TEXT } from "../TractionSnapshots.tsx";
import {
  asEvidence,
  COHORT_SHARE_TEXT,
  CONFIDENCE_REASON_TEXT,
  cellText,
  cohortName,
  type EvidenceDoc,
  type Funnel,
  growthHackOf,
  METRIC_TEXT,
  PG_METRIC_TEXT,
  POSITION_TEXT,
  PRESET_EXPLAINED,
  publicGoodsOf,
  STAGE_TEXT,
  stageShares,
  wordingOf,
} from "./model.ts";

const lastDay = (end: string) => new Date(Date.parse(end) - 86_400_000).toISOString();
const num = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : new Intl.NumberFormat("en-US").format(v);

function FunnelSection({ funnel, onchain }: { funnel: Funnel; onchain: boolean }) {
  const id = useId();
  const k = funnel.min_count;
  const shares = stageShares(funnel.stages);
  const web = shares.filter((s) => s.stage !== "onchain_calls");
  const calls = funnel.stages.find((s) => s.stage === "onchain_calls");
  const day = (d: string) => `${d}T00:00:00Z`;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`} data-testid="evidence-funnel">
      <h2 id={`${id}-h`}>Usage funnel ({funnel.network})</h2>
      <ol className="funnel">
        {web.map((s) => (
          <li key={s.stage} data-testid={`evidence-stage-${s.stage}`}>
            <span>{STAGE_TEXT[s.stage] ?? s.stage}</span>
            <meter
              min={0}
              max={1}
              value={s.share ?? 0}
              aria-label={`${STAGE_TEXT[s.stage]}: ${fmtShare(s.share)} of web visitors`}
            />
            <span className="num">
              {cellText(s.verified, k, fmtInt)}{" "}
              <span className="small muted">verified · {cellText(s.raw, k, fmtInt)} raw</span>
            </span>
          </li>
        ))}
      </ol>
      {onchain && calls ? (
        <p data-testid="evidence-stage-onchain_calls">
          <strong>On-chain calls</strong> to the project's verified contracts:{" "}
          {cellText(calls.verified, k, fmtInt)}.{" "}
          <span className="small muted">
            Ledger counts per day, never joined to visitors or signatures — beside the funnel, not a
            step of it.
          </span>
        </p>
      ) : (
        <p className="small muted" data-testid="evidence-no-onchain">
          No on-chain figures: the project has no verified contract on this network, or on-chain
          correlation is off.
        </p>
      )}
      <p className="small muted">
        Each step counts events per UTC day, summed over the period — not the same people moving
        through every step. Wallet connects include restored sessions; a signature is an approved
        signing request. “Verified” passed our bot checks; “raw” is everything accepted. Connects
        per visitor: {fmtShare(funnel.conversion.connects_per_visitor)}; signatures per connect:{" "}
        {fmtShare(funnel.conversion.signatures_per_connect)}.
      </p>
      <LineChart
        title="Daily funnel, verified"
        unit="day"
        format={(v) => (v === null ? "—" : fmtInt(v))}
        series={[
          {
            name: "Web visitors",
            points: funnel.daily.map((d) => ({ t: day(d.day), v: d.web_visitors_verified })),
          },
          {
            name: "Wallet connects",
            points: funnel.daily.map((d) => ({ t: day(d.day), v: d.wallet_connects_verified })),
          },
          {
            name: "Signatures",
            points: funnel.daily.map((d) => ({ t: day(d.day), v: d.signatures_verified })),
          },
        ]}
      />
      {onchain ? (
        <LineChart
          title="Daily on-chain calls"
          unit="day"
          format={(v) => (v === null ? "—" : fmtInt(v))}
          series={[
            {
              name: "On-chain calls",
              points: funnel.daily.map((d) => ({ t: day(d.day), v: d.onchain_calls })),
            },
          ]}
        />
      ) : null}
      <p className="small muted" data-testid="evidence-floor">
        Small counts are withheld: a day's figure from 1 to {k - 1} is shown as a gap (“fewer than{" "}
        {k}”), never as 0 — {funnel.suppressed_cells} figure
        {funnel.suppressed_cells === 1 ? " is" : "s are"} withheld in this snapshot.
      </p>
    </section>
  );
}

function GrowthHackSection({ doc }: { doc: EvidenceDoc }) {
  const g = growthHackOf(doc);
  const id = useId();
  if (!g) return null;
  const a = g.averages;
  const rows: Array<[string, string]> = [
    ["onchain_calls", "On-chain calls"],
    ["active_accounts_min", "Active accounts, at least"],
    ["active_accounts_max", "Active accounts, at most"],
    ["web_visitors_verified", "Verified web visitors (daily, summed)"],
    ["api_requests", "API requests (self-attested)"],
  ];
  const cs = g.cohort_share;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`} data-testid="evidence-growth-hack">
      <h2 id={`${id}-h`}>Growth Hack: campaign vs baseline</h2>
      <p>
        Weekly averages over {g.campaign.weeks} campaign weeks ({fmtDay(g.campaign.start)} –{" "}
        {fmtDay(lastDay(g.campaign.end))}) and the {g.baseline.weeks} weeks before (
        {fmtDay(g.baseline.start)} – {fmtDay(lastDay(g.baseline.end))}). An active account is{" "}
        {g.active_account_definition}.
      </p>
      <div className="table-wrap">
        <table data-testid="evidence-gh-table">
          <caption className="sr-only">Growth Hack weekly averages</caption>
          <thead>
            <tr>
              <th scope="col">Weekly average</th>
              <th scope="col" className="num">
                Baseline
              </th>
              <th scope="col" className="num">
                Campaign
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([m, label]) => (
              <tr key={m}>
                <th scope="row">{label}</th>
                <td className="num">{num(a.baseline[m])}</td>
                <td className="num">{num(a.campaign[m])}</td>
                <td className="num">
                  {a.change[m] === null || a.change[m] === undefined
                    ? "—"
                    : `${(a.change[m] as number) >= 0 ? "+" : ""}${num(a.change[m])}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p data-testid="evidence-gh-share">
        Cohort share (the Growth Hack formula's X/ΣX on on-chain calls):{" "}
        {cs.status === "shown" && cs.share !== null && cs.cohort
          ? `${Math.round(cs.share * 100)}% of the increase among ${cs.projects} ${cohortName(cs.cohort)} projects measured here`
          : (COHORT_SHARE_TEXT[cs.status] ?? cs.status)}
        .
      </p>
      <details>
        <summary>How to read this (known ambiguities)</summary>
        <ul>
          {g.ambiguities.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function PublicGoodsSection({ doc }: { doc: EvidenceDoc }) {
  const p = publicGoodsOf(doc);
  const id = useId();
  if (!p) return null;
  const pct = (x: number | null) =>
    x === null ? "—" : `${x >= 0 ? "+" : ""}${(Math.round(x * 1000) / 10).toFixed(1)}%`;
  const value = (m: string, v: number | null) =>
    v === null ? "—" : m === "api_error_rate_5xx" ? fmtShare(v) : num(v);
  return (
    <section className="card stack" aria-labelledby={`${id}-h`} data-testid="evidence-public-goods">
      <h2 id={`${id}-h`}>Public Goods quarter {p.quarter}</h2>
      <div className="table-wrap">
        <table data-testid="evidence-pg-table">
          <caption className="sr-only">Quarter figures with the previous quarter</caption>
          <thead>
            <tr>
              <th scope="col">Figure</th>
              <th scope="col" className="num">
                {p.quarter}
              </th>
              <th scope="col" className="num">
                {p.previous_quarter.label}
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {p.figures.map((f) => (
              <tr key={f.metric}>
                <th scope="row">{PG_METRIC_TEXT[f.metric] ?? f.metric}</th>
                <td className="num">{value(f.metric, f.value)}</td>
                <td className="num">{value(f.metric, f.previous)}</td>
                <td className="num">{pct(f.change)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Not measured by this service (PG Score signals from elsewhere): {p.not_measured.join(", ")}.
      </p>
    </section>
  );
}

function ComparisonSection({ doc }: { doc: EvidenceDoc }) {
  const id = useId();
  const c = doc.comparison;
  if (!c) return null;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`} data-testid="evidence-comparison">
      <h2 id={`${id}-h`}>Position in the SCF cohort</h2>
      {c.status === "no_registry_link" ? (
        <p data-testid="evidence-no-cohort">
          No confirmed SCF registry link: there is no round or category to compare with.
        </p>
      ) : (
        <ul>
          {c.positions.map((p) => (
            <li
              key={`${p.cohort.kind}-${p.cohort.id}-${p.metric}`}
              data-testid={`evidence-position-${p.cohort.kind}-${p.metric}`}
            >
              {cohortName(p.cohort)}, {METRIC_TEXT[p.metric] ?? p.metric}:{" "}
              {p.status === "shown"
                ? `${p.percentile}th percentile of ${p.projects} projects measured here`
                : (POSITION_TEXT[p.status] ?? p.status)}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">
        Compared only with Stellar ecosystem projects measured by this service, in cohorts of at
        least {c.min_projects} projects that each reach {c.min_value} of the figure; the percentile
        is rounded to 5 so no other project's figure can be inferred. Not a ranking by SCF.
      </p>
    </section>
  );
}

export function EvidenceView({
  doc,
  status,
  revokedAt,
}: {
  doc: EvidenceDoc;
  status: string;
  revokedAt: string | null;
}) {
  const id = useId();
  const w = wordingOf(doc);
  const reasons = doc.confidence.reasons;
  return (
    <div className="stack" data-testid="evidence-page">
      <h1>{doc.project.name}: measured usage</h1>
      <p data-testid="evidence-period">
        {fmtDay(doc.period.start)} – {fmtDay(lastDay(doc.period.end))} ({doc.period.days} days,{" "}
        {PRESET_TEXT[doc.preset]}) · snapshot {doc.series.seq} of this project · issued{" "}
        {fmtDay(doc.issued_at)} by {doc.issuer}
      </p>
      {status === "revoked" ? (
        <p className="alert error" role="alert" data-testid="evidence-revoked">
          The project revoked this snapshot{revokedAt ? ` on ${fmtDay(revokedAt)}` : ""}. Its
          signature still verifies, but the project no longer stands by these figures.
        </p>
      ) : null}
      <p className="alert info" data-testid="evidence-wording">
        {w.statement} “Verified” means passed our bot checks.
      </p>
      <p>
        {/* the verify UI (`/verify?snapshot=…`) checks the signature, the series and the seal in the browser */}
        <a
          href={`/verify?snapshot=${encodeURIComponent(doc.snapshot_id)}`}
          data-testid="evidence-verify"
        >
          Verify this snapshot
        </a>{" "}
        · <a href={`/public/v1/snapshots/${encodeURIComponent(doc.snapshot_id)}`}>signed JSON</a> ·{" "}
        <a href={doc.links.public_list}>all snapshots of this project</a> ·{" "}
        <a href={doc.methodology.url}>methodology {doc.methodology.version}</a>
      </p>
      <section className="card stack" aria-labelledby={`${id}-w`} data-testid="evidence-window">
        <h2 id={`${id}-w`}>Window: {PRESET_TEXT[doc.preset]}</h2>
        <p>{PRESET_EXPLAINED[doc.preset]}</p>
      </section>
      {doc.funnel ? (
        <FunnelSection funnel={doc.funnel} onchain={doc.onchain !== null} />
      ) : (
        <section className="card" data-testid="evidence-v2">
          <h2>Web</h2>
          <p>
            {fmtInt(doc.web.verified.pageviews)} verified page views (
            {fmtInt(doc.web.raw.pageviews)} raw); {fmtInt(doc.web.verified.visitors_sum)} daily
            visitors (summed). This snapshot uses schema v2: it has no funnel or cohort position.
          </p>
        </section>
      )}
      <section className="card stack" aria-labelledby={`${id}-a`} data-testid="evidence-api">
        <h2 id={`${id}-a`}>API usage</h2>
        {doc.api ? (
          <p>
            {fmtInt(doc.api.requests)} requests ({doc.api.label}); 5xx errors{" "}
            {fmtShare(doc.api.error_rate_5xx)}; p95{" "}
            {doc.api.p95_ms === null ? "—" : `${fmtInt(Math.round(doc.api.p95_ms))} ms`}; assurance{" "}
            {doc.api.assurance_level ?? "—"}.
          </p>
        ) : (
          <p className="muted">The project left API figures out of this snapshot.</p>
        )}
      </section>
      <GrowthHackSection doc={doc} />
      <PublicGoodsSection doc={doc} />
      <ComparisonSection doc={doc} />
      <section className="card stack" aria-labelledby={`${id}-t`} data-testid="evidence-trust">
        <h2 id={`${id}-t`}>Trust and coverage</h2>
        <p data-testid="evidence-confidence">
          Confidence <strong>{doc.confidence.level}</strong>
          {reasons.length
            ? `: ${reasons.map((r) => CONFIDENCE_REASON_TEXT[r] ?? r).join("; ")}`
            : " (no reason lowers it)"}
          . Project verification level {doc.project.verification_level}
          {doc.project.registry_matches.length
            ? `; listed in ${doc.project.registry_matches.join(", ")}`
            : ""}
          . Open anomaly flags: web {doc.anomaly_flags.open_web}, API {doc.anomaly_flags.open_api}.
        </p>
        <p data-testid="evidence-coverage">
          Coverage: {doc.coverage.web_days_with_events} of {doc.coverage.days_in_period} days with
          web events, {doc.coverage.web_days_final} final
          {doc.coverage.api_days_with_data === null
            ? ""
            : `; ${doc.coverage.api_days_with_data} days with API data`}
          {doc.coverage.onchain_days_complete === null
            ? ""
            : `; ${doc.coverage.onchain_days_complete} days with complete on-chain data`}
          .
        </p>
        <p className="small" data-testid="evidence-seal">
          Seal: {w.seal}.
          {doc.seal.enabled && doc.seal.network === "testnet" ? ` ${TESTNET_NOTICE}` : ""}
        </p>
      </section>
      {doc.text ? (
        <section className="card stack" aria-labelledby={`${id}-x`}>
          <h2 id={`${id}-x`}>Pasteable text</h2>
          <pre className="code" data-testid="evidence-text">
            <code>{doc.text}</code>
          </pre>
          <CopyButton text={doc.text} label="Copy text" />
        </section>
      ) : null}
    </div>
  );
}

export function EvidencePage() {
  const { snapshotId } = useParams({ from: "/evidence/$snapshotId" });
  const q = useQuery({
    queryKey: ["public-snapshot", snapshotId],
    queryFn: () => api.call("getPublicSnapshot", { path: { snapshotId } }),
    retry: false,
  });
  const doc = q.data ? asEvidence(q.data.snapshot) : null;
  const missing = q.error instanceof ApiError && q.error.status === 404;
  return (
    <PublicFrame title={doc ? `${doc.project.name} evidence` : "Usage evidence"}>
      {q.isLoading ? <p className="muted">Loading…</p> : null}
      {missing ? (
        <p className="alert info" role="status" data-testid="evidence-not-found">
          No signed snapshot has this id (or it is not signed yet).
        </p>
      ) : (
        <ProblemAlert error={q.error} />
      )}
      {q.data && !doc ? (
        <p data-testid="evidence-v1">
          This is a schema v1 snapshot, which has no evidence page.{" "}
          <Link to="/verify/$snapshotId" params={{ snapshotId }}>
            Verify it
          </Link>
          .
        </p>
      ) : null}
      {doc && q.data ? (
        <EvidenceView doc={doc} status={q.data.status} revokedAt={q.data.revoked_at ?? null} />
      ) : null}
    </PublicFrame>
  );
}
