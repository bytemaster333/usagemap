// SPDX-License-Identifier: Apache-2.0
// Mock answers of the protocol interactions (getTenantProtocols, operatorProtocols; migration 0082) for the portal's
// browser tests. Every project, contract and figure here is FAKE. It follows the contract where the portal depends on
// it: members only for the tenant view (404 otherwise), SCF operators only for the list (403 otherwise), the five
// protocols in registry order with zeros, `active_only` applied by the server. Every JSON body is validated against
// the OpenAPI document by the server.

import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import { type Answer, MockProblem } from "./mock-extra.ts";
import type { UsageMapCtx } from "./mock-usagemap.ts";

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
}) => Answer;

const DOCS_TENANT = "a0000000-0000-4000-8000-000000000001";
/** The docs tenant's verified contract (FAKE id, valid strkey alphabet). */
export const FAKE_PROTOCOL_CONTRACT = `CFAKEPROTOCOL${"A".repeat(43)}`;
const DEFINITION =
  "Transactions that touch your contracts and also touch a protocol's public contracts (FAKE definition text).";
const META = {
  blend: { name: "Blend", website: "https://www.blend.capital", kind: "lending" },
  soroswap: { name: "Soroswap", website: "https://soroswap.finance", kind: "exchange" },
  defindex: { name: "DeFindex", website: "https://www.defindex.io", kind: "yield vaults" },
  aquarius: { name: "Aquarius", website: "https://aqua.network", kind: "exchange" },
  reflector: { name: "Reflector", website: "https://reflector.network", kind: "price oracle" },
} as const;
type Id = keyof typeof META;
const IDS = Object.keys(META) as Id[];

function entries(
  t: Partial<Record<Id, number>>,
  total: number,
): ControlPlane.ProtocolInteraction[] {
  return IDS.map((id) => {
    const n = t[id] ?? 0;
    return {
      protocol: id,
      ...META[id],
      transactions: n,
      successful_transactions: n,
      days_active: n > 0 ? 3 : 0,
      share: total > 0 ? Math.round((n / total) * 10_000) / 10_000 : null,
    };
  });
}

export function protocolsHandlers(c: UsageMapCtx): Record<string, Handler> {
  return {
    getTenantProtocols: ({ req, q, p }) => {
      const tenantId = p.tenantId as string;
      c.member(req, tenantId);
      const docs = tenantId === DOCS_TENANT;
      const body: ControlPlane.TenantProtocols = {
        network: q.get("network") === "testnet" ? "testnet" : "mainnet",
        start: q.get("start") ?? "2026-11-09T00:00:00Z",
        end: q.get("end") ?? "2026-11-16T00:00:00Z",
        days_covered: 7,
        days_with_data: docs ? 7 : 0,
        registry_version: docs ? "2026-11-19.1" : null,
        definition: DEFINITION,
        transactions: docs ? 400 : 0,
        successful_transactions: docs ? 380 : 0,
        contracts: docs ? [FAKE_PROTOCOL_CONTRACT] : [],
        protocols: entries(docs ? { reflector: 120, blend: 40 } : {}, docs ? 400 : 0),
        daily: docs
          ? [
              { day: "2026-11-14", protocol: "reflector", transactions: 60 },
              { day: "2026-11-15", protocol: "reflector", transactions: 60 },
              { day: "2026-11-15", protocol: "blend", transactions: 40 },
            ]
          : [],
      };
      return { status: 200, body };
    },
    operatorProtocols: ({ req, q }) => {
      if (!c.session(req).role) throw new MockProblem(403, "forbidden", "SCF operators only");
      const subjects: ControlPlane.OperatorProtocols["subjects"] = [
        {
          kind: "project",
          id: "e0000000-0000-4000-8000-000000000001",
          name: "Fakeswap DEX (FAKE)",
          label: "public chain data — ownership not verified",
          transactions: 1000,
          successful_transactions: 950,
          protocols: entries({ soroswap: 500, reflector: 250 }, 1000),
        },
        {
          kind: "tenant",
          id: DOCS_TENANT,
          name: null,
          label: "tenant (verified contracts)",
          transactions: 400,
          successful_transactions: 380,
          protocols: entries({ reflector: 120, blend: 40 }, 400),
        },
        {
          kind: "project",
          id: "e0000000-0000-4000-8000-000000000002",
          name: "Fakelend (FAKE)",
          label: "public chain data — ownership not verified",
          transactions: 30,
          successful_transactions: 30,
          protocols: entries({}, 30),
        },
      ];
      const body: ControlPlane.OperatorProtocols = {
        network: q.get("network") === "testnet" ? "testnet" : "mainnet",
        start: q.get("start") ?? "2026-11-09T00:00:00Z",
        end: q.get("end") ?? "2026-11-16T00:00:00Z",
        days_covered: 7,
        definition: DEFINITION,
        network_totals: IDS.map((id) => ({
          protocol: id,
          name: META[id].name,
          transactions: {
            blend: 52_000,
            soroswap: 31_000,
            defindex: 4_000,
            aquarius: 18_000,
            reflector: 9_500,
          }[id],
          successful_transactions: 1000,
          days_active: 7,
        })),
        subjects:
          q.get("active_only") === "true"
            ? subjects.filter((s) => s.protocols.some((x) => x.transactions > 0))
            : subjects,
      };
      return { status: 200, body };
    },
  };
}
