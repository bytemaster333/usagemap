// SPDX-License-Identifier: Apache-2.0
// Closed-set classifiers for Stellar RPC results. Every function returns a member of a fixed list; nothing derived from
// an address, hash, XDR body, amount or error text ever leaves these functions.

/** The 13 Stellar RPC methods (stellar-rpc, js-stellar-sdk 17.4.0 `src/rpc/server.ts`). Anything else is `_OTHER`. */
export const RPC_METHODS = [
  "getHealth",
  "getNetwork",
  "getLatestLedger",
  "getLedgers",
  "getLedgerEntries",
  "getEvents",
  "getFeeStats",
  "getVersionInfo",
  "getTransaction",
  "getTransactions",
  "simulateTransaction",
  "sendTransaction",
  "queryEvents",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number] | "_OTHER";
export const rpcMethod = (m: unknown): RpcMethod =>
  typeof m === "string" && (RPC_METHODS as readonly string[]).includes(m) ? (m as RpcMethod) : "_OTHER";

export const NETWORKS = ["mainnet", "testnet", "futurenet", "local", "unknown"] as const;
export type Network = (typeof NETWORKS)[number];
const PASSPHRASES: Record<string, Network> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "local",
};
/** Passphrase → network name, in memory only; the passphrase itself is never recorded. */
export const networkOf = (p: unknown): Network =>
  typeof p === "string" ? (PASSPHRASES[p] ?? "unknown") : "unknown";

/** Transaction result class (closed). */
export const RESULT_CLASSES = [
  "success",
  "bad_seq",
  "insufficient_fee",
  "insufficient_balance",
  "bad_auth",
  "time_bounds",
  "no_account",
  "malformed",
  "soroban_invalid",
  "resource_limit",
  "expired_state",
  "contract_error",
  "op_failed",
  "undecodable",
  "other",
] as const;
export type ResultClass = (typeof RESULT_CLASSES)[number];

// TransactionResultCode (Stellar-transaction.x; numeric values checked against js-stellar-sdk 17.4.0
// lib/esm/xdr/generated/transaction-result-code.js). txFROZEN_KEY_ACCESSED (-18) is new in protocol 25+ XDR.
const TX_CODE: Record<number, ResultClass> = {
  0: "success",
  1: "success", // txFEE_BUMP_INNER_SUCCESS
  [-2]: "time_bounds",
  [-3]: "time_bounds",
  [-4]: "malformed",
  [-5]: "bad_seq",
  [-6]: "bad_auth",
  [-7]: "insufficient_balance",
  [-8]: "no_account",
  [-9]: "insufficient_fee",
  [-10]: "bad_auth",
  [-11]: "other",
  [-12]: "malformed",
  [-14]: "malformed",
  [-15]: "bad_seq",
  [-16]: "malformed",
  [-17]: "soroban_invalid",
  [-18]: "other",
};
// InvokeHostFunctionResultCode.
const HOST_FN_CODE: Record<number, ResultClass> = {
  [-1]: "malformed",
  [-2]: "contract_error",
  [-3]: "resource_limit",
  [-4]: "expired_state",
  [-5]: "insufficient_fee",
};
const OP_INVOKE_HOST_FUNCTION = 24;

const b64bytes = (s: string): Uint8Array | undefined => {
  try {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  } catch {
    return undefined;
  }
};

/**
 * Decode a base64 XDR `TransactionResult` (RPC `errorResultXdr` / `resultXdr`) far enough to classify it, without the
 * SDK's XDR classes: js-stellar-sdk 17 replaced the js-xdr accessor API (`.result().switch().name`) with new generated
 * classes (`.result.type`), so a decoder that reads the fixed wire layout is version-independent and adds no bundle
 * weight. Layout: int64 feeCharged | int32 code | (txFAILED: uint32 n, then OperationResult[] = int32 opCode
 * [0 = opINNER] | int32 opType | int32 opResultCode …) | (fee bump: Hash(32) | InnerTransactionResult {int64 fee |
 * int32 code | …}). Soroban transactions have exactly one operation, so only the first one is inspected.
 */
export function txResultClass(b64: unknown): ResultClass {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > 1 << 16) return "undecodable";
  const u = b64bytes(b64);
  if (!u || u.length < 12) return "undecodable";
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const at = (off: number): ResultClass => {
    if (dv.byteLength < off + 4) return "undecodable";
    const code = dv.getInt32(off);
    if (code === -1) {
      // txFAILED: OperationResult results<>
      if (dv.byteLength < off + 16) return "op_failed";
      const n = dv.getUint32(off + 4);
      if (n < 1 || dv.getInt32(off + 8) !== 0) return "op_failed";
      if (dv.getInt32(off + 12) === OP_INVOKE_HOST_FUNCTION && dv.byteLength >= off + 20)
        return HOST_FN_CODE[dv.getInt32(off + 16)] ?? "op_failed";
      return "op_failed";
    }
    if (code === -13) return off === 8 ? at(8 + 4 + 32 + 8) : "other"; // fee bump: inner result code
    return TX_CODE[code] ?? "other";
  };
  return at(8);
}

/** Simulation failure class from the host's free-text error. The text is matched in memory and then discarded. */
export const SIM_CLASSES = [
  "contract_error",
  "resource_limit",
  "expired_state",
  "auth",
  "wasm_trap",
  "value_error",
  "storage",
  "no_account",
  "other",
] as const;
export type SimClass = (typeof SIM_CLASSES)[number];
export function simErrorClass(text: unknown): SimClass {
  if (typeof text !== "string") return "other";
  if (/Error\(Contract, #\d+\)/.test(text)) return "contract_error";
  if (/Error\(Budget,/.test(text)) return "resource_limit";
  if (/archived|Error\(Storage, ?MissingValue\)/i.test(text)) return "expired_state";
  if (/Error\(Auth,/.test(text)) return "auth";
  if (/Error\(WasmVm,/.test(text)) return "wasm_trap";
  if (/Error\((Value|Object|Crypto),/.test(text)) return "value_error";
  if (/Error\(Storage,/.test(text)) return "storage";
  if (/[Aa]ccount not found|missing account/.test(text)) return "no_account";
  return "other";
}

/** Horizon route templates: ids, hashes, account ids and query strings are replaced, never recorded. */
const H_COLLECTIONS = new Set([
  "accounts",
  "assets",
  "claimable_balances",
  "effects",
  "fee_stats",
  "ledgers",
  "liquidity_pools",
  "offers",
  "operations",
  "order_book",
  "paths",
  "payments",
  "trade_aggregations",
  "trades",
  "transactions",
  "transactions_async",
  "friendbot",
  "health",
]);
const H_SUB = new Set([
  "effects",
  "operations",
  "payments",
  "trades",
  "transactions",
  "offers",
  "data",
  "ledgers",
  "strict-send",
  "strict-receive",
]);
export function horizonRoute(url: unknown): string {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return "_OTHER";
  }
  const seg = u.pathname.split("/").filter(Boolean);
  if (seg.length === 0) return "/";
  const [a, b, c] = seg;
  if (!a || !H_COLLECTIONS.has(a)) return "_OTHER";
  if (b === undefined) return `/${a}`;
  // /paths/strict-send is a fixed route, not an id.
  const second = a === "paths" && H_SUB.has(b) ? b : "{id}";
  if (c === undefined && seg.length === 2) return `/${a}/${second}`;
  if (seg.length === 3 && c && H_SUB.has(c)) return `/${a}/${second}/${c}`;
  return "_OTHER";
}
