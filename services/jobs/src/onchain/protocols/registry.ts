// SPDX-License-Identifier: Apache-2.0
// The curated, versioned registry of DeFi protocol contracts (registry.json in this directory): public Soroban contract
// ids of Blend, Soroswap, DeFindex, Aquarius and Reflector on mainnet and testnet, each with its official source (a
// repository file at a pinned commit, or official documentation) and status VERIFIED | LIKELY. Job protocol_usage
// passes the contracts of its network to `onchain-reader protocols`; only the protocol id leaves the reader, never a
// contract or an account. The registry is validated when it is loaded (every id a checksummed C… strkey, a contract
// in one protocol only, the protocol ids the enum of migration 0082).

import { strkeyDecode } from "../../stellar/xdr.ts";
import data from "./registry.json" with { type: "json" };

export const PROTOCOL_IDS = ["blend", "soroswap", "defindex", "aquarius", "reflector"] as const;
export type ProtocolId = (typeof PROTOCOL_IDS)[number];

export interface ProtocolContract {
  network: "mainnet" | "testnet";
  contract_id: string;
  role: string;
  status: "VERIFIED" | "LIKELY";
  source: string;
}

export interface ProtocolEntry {
  id: ProtocolId;
  name: string;
  website: string;
  contracts: ProtocolContract[];
}

export interface ProtocolRegistry {
  version: string;
  retrieved: string;
  note: string;
  protocols: ProtocolEntry[];
}

const CONTRACT_VERSION = 2 << 3;

/** Validates a registry document; throws on the first problem (the registry is code-reviewed data). */
export function validateRegistry(doc: unknown): ProtocolRegistry {
  const fail = (m: string): never => {
    throw new Error(`protocol registry: ${m}`);
  };
  if (typeof doc !== "object" || doc === null) return fail("not an object");
  const r = doc as Record<string, unknown>;
  if (typeof r.version !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(r.version))
    fail("version must be YYYY-MM-DD.N");
  if (typeof r.retrieved !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.retrieved))
    fail("retrieved must be a date");
  if (!Array.isArray(r.protocols)) return fail("protocols missing");
  const seen = new Map<string, string>();
  const ids = new Set<string>();
  for (const p of r.protocols as Record<string, unknown>[]) {
    if (!PROTOCOL_IDS.includes(p.id as ProtocolId)) fail(`unknown protocol id ${String(p.id)}`);
    if (ids.has(p.id as string)) fail(`protocol ${String(p.id)} listed twice`);
    ids.add(p.id as string);
    if (
      typeof p.name !== "string" ||
      typeof p.website !== "string" ||
      !p.website.startsWith("https://")
    )
      fail(`protocol ${String(p.id)}: name and https website required`);
    if (!Array.isArray(p.contracts) || p.contracts.length === 0)
      fail(`protocol ${String(p.id)}: no contracts`);
    for (const c of p.contracts as Record<string, unknown>[]) {
      const id = c.contract_id;
      if (c.network !== "mainnet" && c.network !== "testnet") fail(`${String(id)}: network`);
      if (c.status !== "VERIFIED" && c.status !== "LIKELY") fail(`${String(id)}: status`);
      if (typeof c.role !== "string" || !/^[a-z0-9_]{1,64}$/.test(c.role))
        fail(`${String(id)}: role`);
      if (typeof c.source !== "string" || !c.source.startsWith("https://"))
        fail(`${String(id)}: source`);
      if (typeof id !== "string" || !id.startsWith("C"))
        return fail(`${String(id)}: not a contract id`);
      try {
        strkeyDecode(id, CONTRACT_VERSION);
      } catch {
        fail(`${id}: invalid strkey`);
      }
      const key = `${String(c.network)}/${id}`;
      const prev = seen.get(key);
      if (prev !== undefined) fail(`${id} listed for ${prev} and ${String(p.id)}`);
      seen.set(key, p.id as string);
    }
  }
  return doc as ProtocolRegistry;
}

export const REGISTRY: ProtocolRegistry = validateRegistry(data);

/** The (protocol, contract) pairs of one network. */
export function protocolContracts(
  reg: ProtocolRegistry,
  network: "mainnet" | "testnet",
): { protocol: ProtocolId; contract: string }[] {
  return reg.protocols.flatMap((p) =>
    p.contracts
      .filter((c) => c.network === network)
      .map((c) => ({ protocol: p.id, contract: c.contract_id })),
  );
}
