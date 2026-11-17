// SPDX-License-Identifier: Apache-2.0
// Traction snapshot schema v3 — the SCF Evidence Link (one link a project pastes into its SCF application). v3 is the
// v2 document (wire-formats §i.3.2, unchanged fields and rules) plus:
//   - `funnel`      web visitors → wallet connects → signatures → on-chain calls, verified and raw, daily, with the
//                   C-137 small-count floor (funnel.ts);
//   - `programme`   the Growth Hack block (campaign vs baseline weekly averages, active-account interval, cohort share)
//                   for `growth_hack_during`, the Public Goods block (quarter vs previous quarter) for
//                   `pg_renewal_quarter`, else null (presets.ts);
//   - `comparison`  the project's percentile in its SCF round and categories, with confidence gates and floors
//                   (comparison.ts);
//   - `links.evidence` the public evidence page; `wording` the C4 statement and the seal's status;
//   - a v3 pasteable text.
// Signed by job public_metrics in the jobs service like v2 (F16). "Verified" still means our measurement class or a
// contract whose ownership we checked — never an endorsement (C4).

import type { Tx } from "../db/database.ts";
import { DAY, isoZ } from "../programme/figures.ts";
import type { SealNetworkName } from "../programme/seal-network.ts";
import {
  buildTractionDocumentV2,
  PRESET_LABELS,
  type Preset,
  thousands,
  type V2Options,
  type V2Request,
} from "../programme/snapshot-v2.ts";
import { type CohortData, cohortsOf, comparisonBlock, inCohort } from "./comparison.ts";
import { type Funnel, loadFunnel } from "./funnel.ts";
import {
  campaignAverages,
  cohortShare,
  growthHackBaseline,
  loadWindow,
  previousQuarter,
  publicGoodsBlock,
  weeklyFigures,
} from "./presets.ts";

export const SNAPSHOT_SCHEMA_V3 = "scf-analytics/traction-snapshot/3";

export const WORDING =
  "A measurement by this service, not an endorsement: SCF and SDF have not reviewed or approved these figures.";

/** The windows the cohort read needs: the period, and for a Growth Hack campaign its baseline. */
export function cohortWindows(
  preset: Preset,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  return preset === "growth_hack_during"
    ? [{ start, end }, growthHackBaseline(start, end)]
    : [{ start, end }];
}

interface V3Doc extends Record<string, unknown> {
  onchain: null | {
    network: string;
    invocations: number;
    daily: Array<{ day: string; invocations: number; successful_invocations: number }>;
  };
  web: { verified: { visitors_sum: number }; raw: { visitors_sum: number } };
  confidence: { level: string; reasons: string[] };
  seal: { enabled: boolean; network: SealNetworkName | null };
  links: Record<string, string>;
}

/** The v3 document (without signature), read under the tenant's context as job public_metrics. */
export async function buildTractionDocumentV3(
  tx: Tx,
  r: V2Request,
  o: V2Options,
  now: number,
  cohort: CohortData,
): Promise<Record<string, unknown>> {
  const doc = (await buildTractionDocumentV2(tx, r, o, now)) as V3Doc;
  const network = o.onchainNetwork === "public" ? "mainnet" : "testnet";
  const k = cohort.minValue;
  const funnel = await loadFunnel(
    tx,
    r.tenantId,
    r.start,
    r.end,
    network,
    k,
    doc.onchain?.daily ?? null,
    doc.onchain?.invocations ?? null,
  );

  // The footprint of the document (same rule as v2's on-chain block): only when the v2 block exists.
  const contracts = doc.onchain
    ? (
        await tx.query<{ contract_ref: string }>(
          `SELECT contract_ref::text AS contract_ref FROM scf.declared_contracts
            WHERE tenant_id = $1 AND status = 'verified' AND removed_at IS NULL AND conflict_since IS NULL
              AND network = $2`,
          [r.tenantId, o.onchainNetwork],
        )
      ).map((c) => c.contract_ref)
    : null;

  let programme: Record<string, unknown> | null = null;
  if (r.preset === "growth_hack_during") {
    const b = growthHackBaseline(r.start, r.end);
    const cur = await loadWindow(tx, r.tenantId, r.start, r.end, r.includeApi, contracts);
    const base = await loadWindow(tx, r.tenantId, b.start, b.end, r.includeApi, contracts);
    const cw = weeklyFigures(cur.days, r.start, r.end, "campaign");
    const bw = weeklyFigures(base.days, b.start, b.end, "baseline");
    const avg = campaignAverages(bw, cw);
    const weeks = cw.length;
    const me = cohort.members.find((m) => m.tenantId === r.tenantId);
    const target = cohortsOf(me)[0] ?? null;
    const deltas = target
      ? cohort.members
          .filter((m) => m.eligible && inCohort(m, target))
          .map((m) => {
            const c = m.values[0]?.onchain_calls ?? null;
            const p = m.values[1]?.onchain_calls ?? null;
            return c === null || p === null ? null : (c - p) / weeks;
          })
          .filter((d): d is number => d !== null)
      : [];
    programme = {
      kind: "growth_hack",
      campaign: { start: isoZ(r.start), end: isoZ(r.end), weeks },
      baseline: { start: isoZ(b.start), end: isoZ(b.end), weeks },
      active_account_definition:
        "an account that initiated at least one operation invoking a verified contract of the project " +
        "(Growth Hack official rules: initiated at least one operation; restricted here to the verified footprint)",
      weekly: [...bw, ...cw],
      averages: avg,
      cohort_share: cohortShare(
        target,
        me?.eligible ? avg.change.onchain_calls : null,
        deltas,
        cohort.minProjects,
      ),
      ambiguities: [
        "A1: weekly distinct accounts are not stored; each week shows an interval (largest daily count of one " +
          "contract … sum of daily counts) instead of one number",
        "A2: accounts are those invoking the verified footprint, not every operation in the protocol",
        "A3: the retention test (within 30% / ≤70% decline / retention ≥30%) is worded three ways in the rules; " +
          "create a snapshot of the retention weeks and compare its weekly averages yourself",
        "A4: the cohort share uses the project's SCF cohort measured by this service, not the official Growth Hack " +
          "cohort, and on-chain calls only (TVL is out of scope)",
      ],
    };
  } else if (r.preset === "pg_renewal_quarter") {
    const pq = previousQuarter(r.start);
    const cur = await loadWindow(tx, r.tenantId, r.start, r.end, r.includeApi, contracts);
    const prev = await loadWindow(tx, r.tenantId, pq.start, pq.end, r.includeApi, contracts);
    programme = {
      kind: "public_goods",
      ...publicGoodsBlock(r.start, r.end, cur.days, cur.api, prev.days, prev.api),
      ambiguities: [
        "P1: the PG Score names uptime, downloads, dependents and the pony factor; this service measures none of them",
        "P2: 'invoking accounts' is a sum of daily distinct counts, not distinct accounts over the quarter",
      ],
    };
  }

  const comparison = comparisonBlock(
    cohort,
    r.tenantId,
    {
      web_visitors_verified: doc.web.verified.visitors_sum,
      onchain_calls: doc.onchain ? doc.onchain.invocations : null,
    },
    doc.confidence.level,
  );

  const portal = o.portalOrigin;
  const v3: Record<string, unknown> = {
    ...doc,
    schema: SNAPSHOT_SCHEMA_V3,
    funnel,
    programme,
    comparison,
    wording: {
      statement: WORDING,
      seal:
        doc.seal.enabled && doc.seal.network === "testnet"
          ? "sealed on Stellar testnet: a demonstration, not a permanent record"
          : doc.seal.enabled
            ? "sealed on Stellar mainnet"
            : "not sealed",
    },
    links: { ...doc.links, evidence: `${portal}/evidence/${r.snapshotId}` },
  };
  v3.text = snapshotTextV3(v3);
  return v3;
}

const pct = (x: number) => (Math.round(x * 1000) / 10).toFixed(1);

const METRIC_TEXT: Record<string, string> = {
  web_visitors_verified: "verified daily visitors (sum)",
  onchain_calls: "on-chain calls",
};

/** The v3 pasteable text, deterministic from the document's other fields; ≤ 4000 characters. */
export function snapshotTextV3(doc: Record<string, unknown>): string {
  const d = doc as {
    project: { name: string };
    series: { seq: number };
    period: { start: string; end: string; days: number };
    preset: Preset;
    issuer: string;
    methodology: { version: string };
    web: {
      verified: { pageviews: number; visitors_sum: number };
      raw: { pageviews: number };
      visit_metrics: { suspect_pageview_share: number | null };
    };
    api: null | {
      label: string;
      requests: number;
      error_rate_5xx: number | null;
      p95_ms: number | null;
    };
    onchain: null | {
      network: string;
      verified_contracts: number;
      invocations: number;
      successful_invocations: number;
    };
    funnel: Funnel;
    programme: null | Record<string, unknown>;
    comparison: { status: string; positions: Array<Record<string, unknown>> };
    coverage: { web_days_with_events: number; days_in_period: number };
    confidence: { level: string; reasons: string[] };
    anomaly_flags: { open_web: number; open_api: number };
    wording: { statement: string; seal: string };
    links: { verify: string; public_list: string; evidence: string };
  };
  const k = d.funnel.min_count;
  const cell = (x: number | null) => (x === null ? `fewer than ${k}` : thousands(x));
  const lastDay = isoZ(Date.parse(d.period.end) - DAY).slice(0, 10);
  const lines: string[] = [
    `${d.project.name} — measured usage, ${d.period.start.slice(0, 10)} to ${lastDay} (${d.period.days} days, ${PRESET_LABELS[d.preset]})`,
    `Evidence page: ${d.links.evidence}`,
    `Snapshot ${d.series.seq} of this project (all are listed at the link below)`,
  ];
  const st = Object.fromEntries(d.funnel.stages.map((s) => [s.stage, s]));
  const funnelParts = [
    `${cell(st.web_visitors?.verified ?? null)} daily visitors (sum)`,
    `${cell(st.wallet_connects?.verified ?? null)} wallet connects`,
    `${cell(st.signatures?.verified ?? null)} signatures`,
  ];
  if (d.onchain) funnelParts.push(`${thousands(d.onchain.invocations)} on-chain calls`);
  lines.push(`Funnel (verified, ${d.funnel.network}): ${funnelParts.join(" → ")}`);
  const share = d.web.visit_metrics.suspect_pageview_share;
  lines.push(
    `Web: ${thousands(d.web.verified.pageviews)} verified page views (${thousands(d.web.raw.pageviews)} raw` +
      `${share === null ? "" : `; ${pct(share)}% suspect`})`,
  );
  if (d.api) {
    const parts = [`${thousands(d.api.requests)} requests`];
    if (d.api.error_rate_5xx !== null) parts.push(`5xx ${pct(d.api.error_rate_5xx)}%`);
    if (d.api.p95_ms !== null) parts.push(`p95 ${thousands(Math.round(d.api.p95_ms))} ms`);
    lines.push(`API (${d.api.label}): ${parts.join("; ")}`);
  }
  if (d.onchain) {
    const o = d.onchain;
    const ok =
      o.invocations > 0 ? `, ${pct(o.successful_invocations / o.invocations)}% successful` : "";
    lines.push(
      `On-chain (${o.network}, ${o.verified_contracts} verified contracts): ${thousands(o.invocations)} calls${ok}`,
    );
  }
  const p = d.programme as null | {
    kind: string;
    baseline?: { weeks: number };
    averages?: {
      baseline: Record<string, number | null>;
      campaign: Record<string, number | null>;
    };
    cohort_share?: {
      status: string;
      share: number | null;
      cohort: { kind: string; id: string } | null;
      projects: number | null;
    };
    quarter?: string;
    previous_quarter?: { label: string };
    figures?: Array<{
      metric: string;
      value: number | null;
      previous: number | null;
      change: number | null;
    }>;
  };
  if (p?.kind === "growth_hack" && p.averages) {
    const a = p.averages;
    const num = (x: number | null | undefined) =>
      x === null || x === undefined ? "n/a" : String(x);
    const accounts =
      a.campaign.active_accounts_min === null
        ? "weekly active accounts n/a (no verified contract)"
        : `weekly active accounts ${num(a.campaign.active_accounts_min)}–${num(a.campaign.active_accounts_max)} ` +
          `(baseline ${num(a.baseline.active_accounts_min)}–${num(a.baseline.active_accounts_max)})`;
    lines.push(
      `Growth Hack, campaign vs ${p.baseline?.weeks ?? 0} weeks before (weekly averages): on-chain calls ` +
        `${num(a.campaign.onchain_calls)} vs ${num(a.baseline.onchain_calls)}; ${accounts}; verified visitors ` +
        `${num(a.campaign.web_visitors_verified)} vs ${num(a.baseline.web_visitors_verified)}`,
    );
    const cs = p.cohort_share;
    if (cs?.status === "shown" && cs.share !== null && cs.cohort)
      lines.push(
        `Share of the increase in on-chain calls among ${cs.projects} ${cohortName(cs.cohort)} projects measured here: ${Math.round(cs.share * 100)}%`,
      );
  } else if (p?.kind === "public_goods" && p.figures) {
    const f = Object.fromEntries(p.figures.map((x) => [x.metric, x]));
    const fig = (m: string, label: string) => {
      const x = f[m];
      if (!x || x.value === null) return null;
      const ch =
        x.change === null
          ? ""
          : ` (${x.change >= 0 ? "+" : ""}${pct(x.change)}% vs ${p.previous_quarter?.label})`;
      return `${label} ${thousands(x.value)}${ch}`;
    };
    const parts = [
      fig("onchain_calls", "on-chain calls"),
      fig("web_visitors_verified", "verified daily visitors (sum)"),
      fig("api_requests", "API requests"),
    ].filter((x): x is string => x !== null);
    lines.push(`Public Goods quarter ${p.quarter}: ${parts.join("; ") || "no usage measured"}`);
  }
  const shown = d.comparison.positions.filter((x) => x.status === "shown");
  if (d.comparison.status === "no_registry_link") {
    lines.push("Position in SCF cohort: no confirmed SCF registry link");
  } else if (shown.length === 0) {
    lines.push("Position in SCF cohort: not enough projects to compare");
  } else {
    lines.push(
      `Position in SCF cohort: ${shown
        .map(
          (x) =>
            `${x.percentile}th percentile of ${x.projects} ${cohortName(x.cohort as { kind: string; id: string })} projects measured here (${METRIC_TEXT[String(x.metric)]})`,
        )
        .join("; ")}`,
    );
  }
  const reasons = d.confidence.reasons.length ? `: ${d.confidence.reasons.join(", ")}` : "";
  lines.push(
    `Coverage: ${d.coverage.web_days_with_events}/${d.coverage.days_in_period} days with web events; confidence ${d.confidence.level}${reasons}`,
  );
  lines.push(
    `Open anomaly flags: web ${d.anomaly_flags.open_web}, API ${d.anomaly_flags.open_api}`,
  );
  lines.push(
    `Measured by ${d.issuer} (methodology ${d.methodology.version}). ${d.wording.statement} "Verified" means passed our bot checks.`,
  );
  if (d.wording.seal !== "not sealed") lines.push(`Seal: ${d.wording.seal}`);
  lines.push(`Verify: ${d.links.verify}   All snapshots of this project: ${d.links.public_list}`);
  return lines.join("\n").slice(0, 4000);
}

export function cohortName(c: { kind: string; id: string }): string {
  return c.kind === "round" ? `SCF round ${c.id}` : `"${c.id.replace(/_/g, " ")}"`;
}
