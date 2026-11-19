// SPDX-License-Identifier: Apache-2.0
// Mock of traction snapshot v3 (SCF Evidence Link, wire-formats §i.3.5): the v2 body of mock-d1 plus the usage funnel
// (with withheld small cells), the Growth Hack or Public Goods block and the cohort position — the shapes the jobs
// service signs (services/control-plane/src/evidence/*). Signed for real by mock-programme like v2.

import { type SnapInput, snapshotBodyV2 } from "./mock-d1.ts";

const DAY = 86_400_000;
const INT = new Intl.NumberFormat("en-US");

export function snapshotBodyV3(s: SnapInput): Record<string, unknown> {
  const v2 = snapshotBodyV2(s) as Record<string, unknown> & {
    links: Record<string, string>;
    seal: { enabled: boolean; network: string | null };
  };
  const base = "https://portal.example.invalid";
  const days: string[] = [];
  for (let d = Date.parse(s.start); d < Date.parse(s.end); d += DAY)
    days.push(new Date(d).toISOString().slice(0, 10));
  const daily = days.map((day, i) => ({
    day,
    web_visitors_verified: 300 + (i % 7) * 10,
    web_visitors_raw: 320 + (i % 7) * 10,
    wallet_connects_verified: i % 5 === 0 ? null : 40 + (i % 3),
    wallet_connects_raw: i % 5 === 0 ? null : 44 + (i % 3),
    signatures_verified: i % 2 === 0 ? null : 12,
    signatures_raw: i % 2 === 0 ? null : 13,
    onchain_calls: s.onchain ? 150 + i : null,
    onchain_calls_successful: s.onchain ? 145 + i : null,
  }));
  const funnel = {
    network: "mainnet",
    min_count: 10,
    stages: [
      { stage: "web_visitors", verified: 9118, raw: 9802 },
      { stage: "wallet_connects", verified: 1204, raw: 1290 },
      { stage: "signatures", verified: 233, raw: 240 },
      { stage: "onchain_calls", verified: s.onchain ? 4820 : null, raw: s.onchain ? 4820 : null },
    ],
    conversion: { connects_per_visitor: 0.132, signatures_per_connect: 0.1935 },
    daily,
    suppressed_cells: daily.filter((d) => d.signatures_verified === null).length * 2,
  };
  let programme: Record<string, unknown> | null = null;
  if (s.preset === "growth_hack_during") {
    const weeks = Math.round((Date.parse(s.end) - Date.parse(s.start)) / (7 * DAY));
    const bStart = new Date(Date.parse(s.start) - weeks * 7 * DAY)
      .toISOString()
      .replace(".000", "");
    programme = {
      kind: "growth_hack",
      campaign: { start: s.start, end: s.end, weeks },
      baseline: { start: bStart, end: s.start, weeks },
      active_account_definition:
        "an account that initiated at least one operation invoking a verified contract of the project",
      weekly: [],
      averages: {
        baseline: {
          onchain_calls: 520,
          active_accounts_min: 40,
          active_accounts_max: 95,
          web_visitors_verified: 1400,
          api_requests: null,
        },
        campaign: {
          onchain_calls: 1205,
          active_accounts_min: 88,
          active_accounts_max: 210,
          web_visitors_verified: 2280,
          api_requests: null,
        },
        change: {
          onchain_calls: 685,
          active_accounts_min: 48,
          active_accounts_max: 115,
          web_visitors_verified: 880,
          api_requests: null,
        },
        ratio: {
          onchain_calls: 2.3173,
          active_accounts_min: 2.2,
          active_accounts_max: 2.2105,
          web_visitors_verified: 1.6286,
          api_requests: null,
        },
      },
      cohort_share: {
        status: "shown",
        cohort: { kind: "round", id: "29" },
        projects: 7,
        share: 0.18,
      },
      ambiguities: ["A1: weekly distinct accounts are not stored; each week shows an interval"],
    };
  } else if (s.preset === "pg_renewal_quarter") {
    programme = {
      kind: "public_goods",
      quarter: "2026-Q3",
      previous_quarter: {
        label: "2026-Q2",
        start: "2026-04-01T00:00:00Z",
        end: "2026-07-01T00:00:00Z",
      },
      figures: [
        { metric: "onchain_calls", value: 4820, previous: 3100, change: 0.5548 },
        { metric: "web_visitors_verified", value: 9118, previous: 7020, change: 0.2989 },
        { metric: "api_requests", value: 1204513, previous: 980000, change: 0.2291 },
        { metric: "api_error_rate_5xx", value: 0.0031, previous: 0.004, change: null },
      ],
      monthly: [],
      not_measured: ["uptime", "downloads", "direct_dependents", "pony_factor"],
      ambiguities: [],
    };
  }
  const comparison = {
    status: "ok",
    method: "mid-rank percentile",
    min_projects: 5,
    min_value: 10,
    positions: [
      {
        cohort: { kind: "round", id: "29" },
        metric: "web_visitors_verified",
        status: "shown",
        projects: 7,
        percentile: 85,
      },
      {
        cohort: { kind: "round", id: "29" },
        metric: "onchain_calls",
        status: "not_enough_projects",
        projects: null,
        percentile: null,
      },
      {
        cohort: { kind: "category", id: "developer_tooling" },
        metric: "web_visitors_verified",
        status: "not_enough_projects",
        projects: null,
        percentile: null,
      },
    ],
  };
  const seal =
    v2.seal.enabled && v2.seal.network === "testnet"
      ? "sealed on Stellar testnet: a demonstration, not a permanent record"
      : v2.seal.enabled
        ? "sealed on Stellar mainnet"
        : "not sealed";
  const wording = {
    statement:
      "A measurement by this service, not an endorsement: SCF and SDF have not reviewed or approved these figures.",
    seal,
  };
  const links: Record<string, string> = { ...v2.links, evidence: `${base}/evidence/${s.id}` };
  const text = [
    `${s.tenant.name} — measured usage (${days.length} days)`,
    `Evidence page: ${links.evidence}`,
    `Snapshot ${s.seq} of this project (all are listed at the link below)`,
    `Funnel (verified, mainnet): ${INT.format(9118)} daily visitors (sum) → ${INT.format(1204)} wallet connects → 233 signatures`,
    "Position in SCF cohort: 85th percentile of 7 SCF round 29 projects measured here (verified daily visitors (sum))",
    `Measured by portal.example.invalid (methodology scf-methodology/1.0.0). ${wording.statement}`,
    `Verify: ${links.verify}   All snapshots of this project: ${links.public_list}`,
  ].join("\n");
  return {
    ...v2,
    schema: "scf-analytics/traction-snapshot/3",
    funnel,
    programme,
    comparison,
    wording,
    links,
    text,
  };
}
