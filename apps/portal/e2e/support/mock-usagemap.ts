// SPDX-License-Identifier: Apache-2.0
// Mock answers of the Ecosystem Usage Map (operatorUsageMap, operatorUsageMapProject, getTenantUsageMap) for the
// portal's browser tests. Every project, contract and figure here is FAKE. It follows the contract where the portal
// depends on it: SCF operators only (403 otherwise), the round / category / status / name filters applied by the
// server, CSV on `Accept: text/csv`, distinct-account figures under min_count null, 404 for an unknown project; the
// tenant view lists the projects a tenant has a confirmed registry link to (members only, 404 otherwise). Every JSON
// body is validated against the OpenAPI document by the server.

import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import { type Answer, MockProblem } from "./mock-extra.ts";

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
}) => Answer;

export interface UsageMapCtx {
  session(req: IncomingMessage): { userId: string; role: string | null };
  /** Throws (404) unless the signed-in user is a member of the tenant. */
  member(req: IncomingMessage, tenantId: string): void;
}

const LABELS: Record<ControlPlane.UsageMapStatus, string> = {
  unclaimed: "public chain data — ownership not verified",
  claimed: "claimed — contracts not verified",
  verified: "verified — contracts in the claimant's verified footprint",
};
const DEFINITIONS = {
  invocations:
    "Top-level InvokeHostFunction operations calling a listed contract (failed included).",
  weekly_active_accounts:
    "SCF Growth Hack: accounts that initiated at least one operation in the ISO week.",
};
const MIN_COUNT = 10;

export const FAKE_USAGE: ControlPlane.UsageMapItem[] = [
  item(
    "e0000000-0000-4000-8000-000000000001",
    "Fakeswap DEX (FAKE)",
    33,
    ["financial_protocols"],
    "verified",
    {
      invocations: 4200,
      ok: 3990,
      calls: 310,
      peak: 140,
      waa: 380,
      prev: 300,
      series: [500, 600, 550, 700, 650, 600, 600],
    },
  ),
  item(
    "e0000000-0000-4000-8000-000000000002",
    "Fakelend (FAKE)",
    35,
    ["financial_protocols"],
    "unclaimed",
    {
      invocations: 900,
      ok: 880,
      calls: 0,
      peak: 40,
      waa: 95,
      prev: 120,
      series: [100, 150, 120, 130, 140, null, 160],
    },
  ),
  item(
    "e0000000-0000-4000-8000-000000000003",
    "Fakewallet Kit (FAKE)",
    35,
    ["developer_tooling"],
    "claimed",
    {
      invocations: 12,
      ok: 12,
      calls: 0,
      peak: null,
      waa: null,
      prev: null,
      series: [2, 1, 3, 0, 2, 2, 2],
    },
  ),
];

function item(
  id: string,
  name: string,
  round: number,
  categories: ControlPlane.ScfCategory[],
  status: ControlPlane.UsageMapStatus,
  f: {
    invocations: number;
    ok: number;
    calls: number;
    peak: number | null;
    waa: number | null;
    prev: number | null;
    series: (number | null)[];
  },
): ControlPlane.UsageMapItem {
  return {
    registry_project_id: id,
    name,
    website: null,
    categories,
    award_round: round,
    award_stage: null,
    scf_awarded: true,
    contracts_listed: 2,
    contracts_verified: status === "verified" ? 1 : 0,
    status,
    label: LABELS[status],
    days_covered: 7,
    invocations: f.invocations,
    successful_invocations: f.ok,
    success_rate: Math.round((f.ok / f.invocations) * 10_000) / 10_000,
    contract_calls: f.calls,
    peak_daily_invokers: f.peak,
    daily_invocations: f.series,
    week_start: "2026-11-09",
    weekly_active_accounts: f.waa,
    weekly_active_accounts_successful: f.waa === null ? null : Math.round(f.waa * 0.9),
    prev_weekly_active_accounts: f.prev,
  };
}

const C1 = `C${"F".repeat(54)}A`;
const C2 = `C${"F".repeat(54)}B`;

function days(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function usageMapHandlers(c: UsageMapCtx): Record<string, Handler> {
  const operator = (req: IncomingMessage) => {
    if (!c.session(req).role) throw new MockProblem(403, "forbidden", "SCF operators only");
  };
  return {
    operatorUsageMap: ({ req, q }) => {
      operator(req);
      const start = q.get("start") ?? "2026-11-09T00:00:00Z";
      const end = q.get("end") ?? "2026-11-16T00:00:00Z";
      const n = days(start, end).length;
      const round = q.get("round");
      const items = FAKE_USAGE.map((i) => ({
        ...i,
        // the sparkline spans the requested window (the last 7 days carry the fixture series)
        daily_invocations: [...Array(Math.max(0, n - 7)).fill(null), ...i.daily_invocations].slice(
          -n,
        ),
      })).filter(
        (i) =>
          (!round || i.award_round === Number(round)) &&
          (!q.get("category") ||
            i.categories.includes(q.get("category") as ControlPlane.ScfCategory)) &&
          (!q.get("status") || i.status === q.get("status")) &&
          (!q.get("q") || i.name.toLowerCase().includes((q.get("q") as string).toLowerCase())),
      );
      if ((req.headers.accept ?? "").includes("text/csv"))
        return {
          status: 200,
          type: "text/csv; charset=utf-8",
          body: `registry_project_id,name,status,invocations\r\n${items
            .map((i) => `${i.registry_project_id},${i.name},${i.status},${i.invocations}`)
            .join("\r\n")}\r\n`,
        };
      const totals = {
        projects: FAKE_USAGE.length,
        unclaimed: 0,
        claimed: 0,
        verified: 0,
        active: 0,
      };
      for (const i of FAKE_USAGE) {
        totals[i.status]++;
        if (i.invocations + i.contract_calls > 0) totals.active++;
      }
      const body: ControlPlane.UsageMapList = {
        network: "mainnet",
        start,
        end,
        days: days(start, end),
        min_count: MIN_COUNT,
        source: "public Stellar ledger files, day anchors checked against Horizon (job usage_map)",
        labels: LABELS,
        definitions: DEFINITIONS,
        totals,
        items,
      };
      return { status: 200, body };
    },
    operatorUsageMapProject: ({ req, q, p }) => {
      operator(req);
      const i = FAKE_USAGE.find((x) => x.registry_project_id === p.registryProjectId);
      if (!i) throw new MockProblem(404, "not_found", "Not found");
      const body: ControlPlane.UsageMapProject = {
        project: {
          registry_project_id: i.registry_project_id,
          name: i.name,
          website: null,
          domain: null,
          categories: i.categories,
          award_round: i.award_round,
          award_stage: null,
          sources: ["stellarlight"],
          scf_awarded: true,
        },
        network: "mainnet",
        start: q.get("start") ?? "2026-11-09T00:00:00Z",
        end: q.get("end") ?? "2026-11-16T00:00:00Z",
        min_count: MIN_COUNT,
        status: i.status,
        label: i.label,
        definitions: DEFINITIONS,
        success_rate: i.success_rate,
        days_covered: 7,
        claimed: i.status !== "unclaimed",
        daily: i.daily_invocations.flatMap((v, k) =>
          v === null
            ? []
            : [
                {
                  day: `2026-11-${String(9 + k).padStart(2, "0")}`,
                  invocations: v,
                  successful_invocations: v,
                  distinct_invokers: v >= MIN_COUNT ? Math.round(v / 4) : null,
                  contract_calls: 0,
                  contracts_invoked: 1,
                  contracts_listed: 2,
                },
              ],
        ),
        weekly: [
          {
            week_start: "2026-11-09",
            active_accounts: i.weekly_active_accounts,
            active_accounts_successful: i.weekly_active_accounts_successful,
            invocations: i.invocations,
            successful_invocations: i.successful_invocations,
            contract_calls: i.contract_calls,
          },
        ],
        contracts: [
          {
            contract_id: C1,
            invocations: i.invocations - 100,
            successful_invocations: i.successful_invocations - 100,
            contract_calls: i.contract_calls,
            days_active: 7,
            footprint_verified: i.status === "verified",
          },
          {
            contract_id: C2,
            invocations: 100,
            successful_invocations: 100,
            contract_calls: 0,
            days_active: 3,
            footprint_verified: false,
          },
        ],
        functions: [
          {
            contract_id: C1,
            function: "swap",
            caller_kind: "account",
            calls: 3000,
            successful_calls: 2900,
          },
          {
            contract_id: C1,
            function: "swap",
            caller_kind: "contract",
            calls: 310,
            successful_calls: 310,
          },
          {
            contract_id: C2,
            function: "deposit",
            caller_kind: "account",
            calls: 100,
            successful_calls: 100,
          },
        ],
      };
      return { status: 200, body };
    },
    getTenantUsageMap: ({ req, q, p }) => {
      const tenantId = p.tenantId as string;
      c.member(req, tenantId);
      const start = q.get("start") ?? "2026-11-09T00:00:00Z";
      const end = q.get("end") ?? "2026-11-16T00:00:00Z";
      const body: ControlPlane.TenantUsageMap = {
        network: q.get("network") === "testnet" ? "testnet" : "mainnet",
        start,
        end,
        definitions: DEFINITIONS,
        projects: (TENANT_LINKS[tenantId] ?? []).map((l) => tenantProject(l, start, end)),
      };
      return { status: 200, body };
    },
  };
}

// The tenant view: the registry projects each FAKE tenant has a CONFIRMED registry link to, with the tenant's own
// footprint state per listed contract. "Stellar Docs" holds two (one verified, one claimed); "Pending Labs" none.
type Footprint = ControlPlane.TenantUsageMap["projects"][number]["contracts"][number]["footprint"];
interface TenantLink {
  id: string;
  contracts: { id: string; footprint: Footprint; share: number }[];
}
export const FAKE_TENANT_CONTRACTS = {
  dexVerified: `C${"F".repeat(54)}C`,
  dexUndeclared: `C${"F".repeat(54)}D`,
  kitDeclared: `C${"F".repeat(54)}E`,
  kitConflict: `C${"F".repeat(54)}G`,
};
const TENANT_LINKS: Record<string, TenantLink[]> = {
  "a0000000-0000-4000-8000-000000000001": [
    {
      id: "e0000000-0000-4000-8000-000000000001",
      contracts: [
        { id: FAKE_TENANT_CONTRACTS.dexVerified, footprint: "verified", share: 0.9 },
        { id: FAKE_TENANT_CONTRACTS.dexUndeclared, footprint: "not_declared", share: 0.1 },
      ],
    },
    {
      id: "e0000000-0000-4000-8000-000000000003",
      contracts: [
        { id: FAKE_TENANT_CONTRACTS.kitDeclared, footprint: "declared", share: 1 },
        { id: FAKE_TENANT_CONTRACTS.kitConflict, footprint: "conflict", share: 0 },
      ],
    },
  ],
};

function tenantProject(
  l: TenantLink,
  start: string,
  end: string,
): ControlPlane.TenantUsageMap["projects"][number] {
  const i = FAKE_USAGE.find((x) => x.registry_project_id === l.id) as ControlPlane.UsageMapItem;
  // the fixture series fills the last 7 days of the window; a null is a day without ledger data (no row)
  const window = days(start, end).slice(-7);
  const daily = window.flatMap((day, k) => {
    const v = i.daily_invocations[k + 7 - window.length] ?? null;
    return v === null
      ? []
      : [
          {
            day,
            invocations: v,
            successful_invocations: v - (v > 10 ? 3 : 0),
            // exact in the tenant's own view: small counts are not withheld
            distinct_invokers: Math.max(1, Math.round(v / 50)),
            contract_calls: i.contract_calls > 0 ? 40 : 0,
            contracts_invoked: 1,
            contracts_listed: l.contracts.length,
          },
        ];
  });
  const verified = l.contracts.filter((x) => x.footprint === "verified").length;
  const status = verified > 0 ? "verified" : "claimed";
  return {
    registry_project_id: i.registry_project_id,
    name: i.name,
    status,
    label: LABELS[status],
    contracts_listed: l.contracts.length,
    contracts_verified: verified,
    daily,
    weekly: [
      {
        week_start: "2026-11-09",
        active_accounts: i.weekly_active_accounts ?? 4,
        active_accounts_successful: i.weekly_active_accounts_successful ?? 3,
        invocations: i.invocations,
        successful_invocations: i.successful_invocations,
        contract_calls: i.contract_calls,
      },
    ],
    contracts: l.contracts.map((x) => ({
      contract_id: x.id,
      footprint: x.footprint,
      invocations: Math.round(i.invocations * x.share),
      successful_invocations: Math.round(i.successful_invocations * x.share),
      contract_calls: x.share === 0 ? 0 : i.contract_calls,
      days_active: x.share === 0 ? 0 : daily.length,
    })),
    functions:
      i.invocations > 100
        ? [
            {
              contract_id: l.contracts[0]?.id as string,
              function: "swap",
              caller_kind: "account",
              calls: Math.round(i.invocations * 0.9),
              successful_calls: Math.round(i.successful_invocations * 0.9),
            },
            {
              contract_id: l.contracts[0]?.id as string,
              function: "swap",
              caller_kind: "contract",
              calls: i.contract_calls,
              successful_calls: i.contract_calls,
            },
          ]
        : [],
  };
}
