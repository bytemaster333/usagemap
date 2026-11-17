// SPDX-License-Identifier: Apache-2.0
// Ledger look-ups for job `contract_verification` (C-19): which contracts an account deployed, and which account a
// contract's instance storage names as admin. Public data only; requests carry public account and contract ids, never
// tenant data (C-10).
//
// Deployer — Horizon `GET /accounts/{G}/operations` (paged, ascending): `invoke_host_function` operations whose
// `function` is `HostFunctionTypeHostFunctionTypeCreateContract` or `…CreateContractV2` carry the deployer `address`
// and the `salt` (decimal); the contract id follows from CAP-46 (stellar/xdr.ts). Checked against testnet on
// 2026-11-13: the derived ids have live instance entries. A deployment through a factory contract names the factory,
// not the account, and is therefore not found (the contract stays "declared" unless the account is its admin).
// The answer says whether it is COMPLETE: only a walk that reached the end of the account's
// operations AND covers the account's whole life — the Horizon keeps full history (`history_elder_ledger` ≤ 2), or the
// walk began with the operation that created the account — may be read as "never deployed"; a walk cut by the page
// bound, or over a bounded history, is "unknown", never "not the deployer".
// Current admin — Stellar RPC `getLedgerEntries` for the contract instance; an `Admin` key (Symbol or one-element Vec)
// whose value is an account. Admins kept in persistent storage outside the instance are not found.

import {
  contractIdFromAccount,
  contractInstanceKey,
  instanceAdmin,
  parseSalt,
  readContractDataEntry,
} from "./xdr.ts";

export interface ContractInstance {
  /** Whether the contract's instance entry exists on the ledger (live; an archived entry counts as absent). */
  exists: boolean;
  /** The account named as admin in the instance storage, or null (none or not an account). */
  admin: string | null;
}

export interface Deployments {
  /** Contract ids created by the account (directly, not through a factory) among the operations read. */
  contracts: Set<string>;
  /** Whether every operation of the account's life was read (absence then means "not deployed by it"). */
  complete: boolean;
}

export interface ContractLedger {
  deployedBy(account: string): Promise<Deployments>;
  /** The contract's instance (existence and admin), or null when no RPC is configured (nothing can be said). */
  instance(contract: string): Promise<ContractInstance | null>;
}

export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerUnavailable";
  }
}

const CREATE_FUNCTIONS = new Set([
  "HostFunctionTypeHostFunctionTypeCreateContract",
  "HostFunctionTypeHostFunctionTypeCreateContractV2",
]);

export interface HorizonLedgerOptions {
  horizonUrl: string;
  rpcUrl: string | null;
  network: "public" | "testnet";
  maxPages?: number;
  timeoutMs?: number;
}

/** Full history: Horizon's oldest ledger is the genesis (1) or the first closed ledger (2). */
const FULL_HISTORY_ELDER = 2;
const ROOT_TTL_MS = 3_600_000;

export class HorizonRpcLedger implements ContractLedger {
  readonly #o: Required<Omit<HorizonLedgerOptions, "rpcUrl">> & { rpcUrl: string | null };
  #fullHistory: { value: boolean; at: number } | null = null;

  constructor(o: HorizonLedgerOptions) {
    this.#o = {
      // 500 pages × 200 = 100,000 operations per account and run (cached per run by the job)
      maxPages: 500,
      timeoutMs: 20_000,
      ...o,
      horizonUrl: o.horizonUrl.replace(/\/+$/, ""),
    };
  }

  async #get(url: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "scf-analytics-contract-verification/1",
        },
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      throw new LedgerUnavailableError("horizon unreachable");
    }
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new LedgerUnavailableError(`horizon answered ${res.status}`);
    return { status: res.status, body: await res.json() };
  }

  /** Whether this Horizon keeps the network's full history (its root's `history_elder_ledger`), cached for an hour. */
  async #hasFullHistory(): Promise<boolean> {
    if (this.#fullHistory && Date.now() - this.#fullHistory.at < ROOT_TTL_MS)
      return this.#fullHistory.value;
    const { status, body } = await this.#get(`${this.#o.horizonUrl}/`);
    const elder = (body as { history_elder_ledger?: unknown } | null)?.history_elder_ledger;
    if (status === 404 || typeof elder !== "number")
      throw new LedgerUnavailableError("horizon root without history_elder_ledger");
    const value = elder <= FULL_HISTORY_ELDER;
    this.#fullHistory = { value, at: Date.now() };
    return value;
  }

  async deployedBy(account: string): Promise<Deployments> {
    const contracts = new Set<string>();
    if (!/^G[A-Z2-7]{55}$/.test(account)) return { contracts, complete: true };
    const fullHistory = await this.#hasFullHistory();
    let url: string | null =
      `${this.#o.horizonUrl}/accounts/${account}/operations?limit=200&order=asc`;
    let sawCreation = false;
    for (let page = 0; url; page++) {
      if (page >= this.#o.maxPages) return { contracts, complete: false }; // bound reached: unknown
      const { status, body } = await this.#get(url);
      // No operation of this account in the history Horizon has: "never" only when that history is complete.
      if (status === 404) return { contracts, complete: fullHistory };
      const b = body as {
        _embedded?: { records?: Array<Record<string, unknown>> };
        _links?: { next?: { href?: unknown } };
      };
      const records = b._embedded?.records ?? [];
      if (page === 0) {
        const first = records[0];
        sawCreation = first?.type === "create_account" && first.account === account;
      }
      for (const r of records) {
        if (r.type !== "invoke_host_function" || !CREATE_FUNCTIONS.has(String(r.function)))
          continue;
        if (r.address !== account || typeof r.salt !== "string" || r.salt === "") continue;
        try {
          contracts.add(contractIdFromAccount(this.#o.network, account, parseSalt(r.salt)));
        } catch {
          // malformed salt: ignore the record
        }
      }
      if (records.length < 200) return { contracts, complete: fullHistory || sawCreation };
      const next = b._links?.next?.href;
      // Follow only links on the same Horizon (never an arbitrary host from a response).
      url = typeof next === "string" && next.startsWith(`${this.#o.horizonUrl}/`) ? next : null;
    }
    // a full page without a usable next link: the rest is unknown
    return { contracts, complete: false };
  }

  async instance(contract: string): Promise<ContractInstance | null> {
    if (!this.#o.rpcUrl) return null;
    let res: Response;
    try {
      res = await fetch(this.#o.rpcUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "scf-analytics-contract-verification/1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLedgerEntries",
          params: { keys: [contractInstanceKey(contract)] },
        }),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      throw new LedgerUnavailableError("rpc unreachable");
    }
    if (!res.ok) throw new LedgerUnavailableError(`rpc answered ${res.status}`);
    const body = (await res.json()) as {
      result?: { entries?: Array<{ xdr?: unknown }> };
      error?: unknown;
    };
    if (body.error || !body.result) throw new LedgerUnavailableError("rpc error");
    const xdr = body.result.entries?.[0]?.xdr;
    if (typeof xdr !== "string") return { exists: false, admin: null }; // no such contract (or archived)
    try {
      return { exists: true, admin: instanceAdmin(readContractDataEntry(xdr)) };
    } catch {
      return { exists: true, admin: null };
    }
  }
}
