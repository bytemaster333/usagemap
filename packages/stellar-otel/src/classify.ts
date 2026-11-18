// SPDX-License-Identifier: Apache-2.0
// Closed-set classifiers. Every function returns a member of a fixed list; nothing derived from an address, hash, XDR
// body, amount, URL or error text ever leaves these functions. The same lists are enforced again by the UsageMap
// Collector (`collector/processor/scfsanitizeprocessor/stellar.go`, wire-formats §f.5 step 4a); keep them in step.

/** The Stellar RPC JSON-RPC methods (stellar-rpc; js-stellar-sdk 17.4.0 `src/rpc/server.ts`). Others: `_OTHER`. */
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
const RPC_METHOD_SET: ReadonlySet<string> = new Set(RPC_METHODS);
export const rpcMethod = (m: unknown): RpcMethod =>
  typeof m === "string" && RPC_METHOD_SET.has(m) ? (m as RpcMethod) : "_OTHER";

export const NETWORKS = ["mainnet", "testnet", "futurenet", "local", "unknown"] as const;
export type Network = (typeof NETWORKS)[number];
const PASSPHRASES: Readonly<Record<string, Network>> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "local",
};
const NAMED: ReadonlySet<string> = new Set(["mainnet", "testnet", "futurenet", "local"]);
/** A network name or passphrase → network class, in memory only; the passphrase itself is never recorded. */
export const networkOf = (p: unknown): Network => {
  if (typeof p !== "string") return "unknown";
  if (NAMED.has(p)) return p as Network;
  return PASSPHRASES[p] ?? "unknown";
};

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
// lib/esm/xdr/generated/transaction-result-code.js). txFROZEN_KEY_ACCESSED (-18) is new in 17.x XDR.
const TX_CODE: Readonly<Record<number, ResultClass>> = {
  0: "success", // txSUCCESS
  1: "success", // txFEE_BUMP_INNER_SUCCESS
  [-2]: "time_bounds", // txTOO_EARLY
  [-3]: "time_bounds", // txTOO_LATE
  [-4]: "malformed", // txMISSING_OPERATION
  [-5]: "bad_seq", // txBAD_SEQ
  [-6]: "bad_auth", // txBAD_AUTH
  [-7]: "insufficient_balance", // txINSUFFICIENT_BALANCE
  [-8]: "no_account", // txNO_ACCOUNT
  [-9]: "insufficient_fee", // txINSUFFICIENT_FEE
  [-10]: "bad_auth", // txBAD_AUTH_EXTRA
  [-11]: "other", // txINTERNAL_ERROR
  [-12]: "malformed", // txNOT_SUPPORTED
  [-14]: "malformed", // txBAD_SPONSORSHIP
  [-15]: "bad_seq", // txBAD_MIN_SEQ_AGE_OR_GAP
  [-16]: "malformed", // txMALFORMED
  [-17]: "soroban_invalid", // txSOROBAN_INVALID
  [-18]: "other", // txFROZEN_KEY_ACCESSED
};
// InvokeHostFunctionResultCode.
const HOST_FN_CODE: Readonly<Record<number, ResultClass>> = {
  [-1]: "malformed",
  [-2]: "contract_error", // TRAPPED
  [-3]: "resource_limit", // RESOURCE_LIMIT_EXCEEDED
  [-4]: "expired_state", // ENTRY_ARCHIVED
  [-5]: "insufficient_fee", // INSUFFICIENT_REFUNDABLE_FEE
};
const OP_INVOKE_HOST_FUNCTION = 24;
const TX_FAILED = -1;
const TX_FEE_BUMP_INNER_FAILED = -13;
const MAX_XDR_B64 = 1 << 16;

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
 * Classify a base64 XDR `TransactionResult` (RPC `errorResultXdr` / `resultXdr`) without the SDK's XDR classes.
 * js-stellar-sdk 17 replaced the js-xdr accessor API (`.result().switch().name`) with new generated classes
 * (`.result.type`), so reading the fixed wire layout keeps this independent of the SDK version and adds no bundle
 * weight. Layout: int64 feeCharged | int32 code | (txFAILED: uint32 n, OperationResult[] = int32 opCode [0 = opINNER]
 * | int32 opType | int32 opResultCode …) | (fee bump: Hash(32) | InnerTransactionResult {int64 fee | int32 code …}).
 * Soroban transactions have exactly one operation, so only the first one is inspected. The bytes are discarded.
 */
export function txResultClass(b64: unknown): ResultClass {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > MAX_XDR_B64) return "undecodable";
  const u = b64bytes(b64);
  if (!u || u.length < 12) return "undecodable";
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const at = (off: number, inner: boolean): ResultClass => {
    if (dv.byteLength < off + 4) return "undecodable";
    const code = dv.getInt32(off);
    if (code === TX_FAILED) {
      if (dv.byteLength < off + 16) return "op_failed";
      const n = dv.getUint32(off + 4);
      if (n < 1 || dv.getInt32(off + 8) !== 0) return "op_failed";
      if (dv.getInt32(off + 12) === OP_INVOKE_HOST_FUNCTION && dv.byteLength >= off + 20)
        return HOST_FN_CODE[dv.getInt32(off + 16)] ?? "op_failed";
      return "op_failed";
    }
    // Fee bump: Hash(32) then the inner result (int64 fee, int32 code). Never recurse twice.
    if (code === TX_FEE_BUMP_INNER_FAILED) return inner ? "other" : at(off + 4 + 32 + 8, true);
    return TX_CODE[code] ?? "other";
  };
  return at(8, false);
}

/** Simulation failure class from the host's free-text error. The text is matched in memory and then discarded. */
export const SIM_ERROR_CLASSES = [
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
export type SimErrorClass = (typeof SIM_ERROR_CLASSES)[number];
const MAX_SIM_TEXT = 1 << 16;
export function simErrorClass(text: unknown): SimErrorClass {
  if (typeof text !== "string") return "other";
  const t = text.length > MAX_SIM_TEXT ? text.slice(0, MAX_SIM_TEXT) : text;
  if (/Error\(Contract, #\d+\)/.test(t)) return "contract_error";
  if (/Error\(Budget,/.test(t)) return "resource_limit";
  if (/archived|Error\(Storage, ?MissingValue\)/i.test(t)) return "expired_state";
  if (/Error\(Auth,/.test(t)) return "auth";
  if (/Error\(WasmVm,/.test(t)) return "wasm_trap";
  if (/Error\((Value|Object|Crypto),/.test(t)) return "value_error";
  if (/Error\(Storage,/.test(t)) return "storage";
  if (/[Aa]ccount not found|missing account/.test(t)) return "no_account";
  return "other";
}

export const SUBMIT_STATUSES = [
  "PENDING",
  "DUPLICATE",
  "TRY_AGAIN_LATER",
  "ERROR",
  "SUCCESS",
  "FAILED",
] as const;
export const POLL_STATUSES = ["SUCCESS", "FAILED", "NOT_FOUND"] as const;
export const SIM_OUTCOMES = ["success", "error", "restore_required"] as const;
export const closed = <T extends string>(set: readonly T[], v: unknown): T | "_OTHER" =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : "_OTHER";

/** JSON-RPC 2.0 error codes kept as-is; any other code is `_OTHER`. */
export const JSONRPC_CODES = ["-32700", "-32600", "-32601", "-32602", "-32603"] as const;
/** HTTP statuses kept as-is in `error.type` (≥ 400) and `http.response.status_code` (all of them). */
export const HTTP_STATUSES = [
  200, 201, 202, 204, 301, 302, 304, 307, 308, 400, 401, 403, 404, 405, 406, 408, 409, 410, 413,
  414, 415, 422, 429, 500, 501, 502, 503, 504,
] as const;
const HTTP_STATUS_SET: ReadonlySet<number> = new Set(HTTP_STATUSES);
export const httpStatus = (s: unknown): number | undefined =>
  typeof s === "number" && HTTP_STATUS_SET.has(s) ? s : undefined;

/** `error.type` of a failed call (closed): JSON-RPC code, HTTP status ≥ 400, `timeout`, `network` or `_OTHER`. */
export function jsonRpcErrorType(code: unknown): string {
  const s = typeof code === "number" && Number.isInteger(code) ? String(code) : "";
  return (JSONRPC_CODES as readonly string[]).includes(s) ? s : "_OTHER";
}
export function transportErrorType(err: unknown): string {
  const e = err as { response?: { status?: unknown }; code?: unknown; name?: unknown } | undefined;
  const status = e?.response?.status;
  if (typeof status === "number") {
    const s = httpStatus(status);
    return s !== undefined && s >= 400 ? String(s) : "_OTHER";
  }
  if (
    e?.code === "ECONNABORTED" ||
    e?.code === "ETIMEDOUT" ||
    e?.name === "TimeoutError" ||
    e?.name === "AbortError"
  )
    return "timeout";
  return "network";
}

/**
 * The closed Horizon route templates (Horizon API reference). Account ids, hashes, ledger numbers, offer and pool
 * ids, data keys, cursors and query strings are replaced by the template and never recorded.
 */
export const HORIZON_TEMPLATES = [
  "/",
  "/accounts",
  "/accounts/{id}",
  "/accounts/{id}/data/{key}",
  "/accounts/{id}/effects",
  "/accounts/{id}/offers",
  "/accounts/{id}/operations",
  "/accounts/{id}/payments",
  "/accounts/{id}/trades",
  "/accounts/{id}/transactions",
  "/assets",
  "/claimable_balances",
  "/claimable_balances/{id}",
  "/claimable_balances/{id}/operations",
  "/claimable_balances/{id}/transactions",
  "/effects",
  "/fee_stats",
  "/friendbot",
  "/health",
  "/ledgers",
  "/ledgers/{id}",
  "/ledgers/{id}/effects",
  "/ledgers/{id}/operations",
  "/ledgers/{id}/payments",
  "/ledgers/{id}/transactions",
  "/liquidity_pools",
  "/liquidity_pools/{id}",
  "/liquidity_pools/{id}/effects",
  "/liquidity_pools/{id}/operations",
  "/liquidity_pools/{id}/trades",
  "/liquidity_pools/{id}/transactions",
  "/offers",
  "/offers/{id}",
  "/offers/{id}/trades",
  "/operations",
  "/operations/{id}",
  "/operations/{id}/effects",
  "/order_book",
  "/paths",
  "/paths/strict-receive",
  "/paths/strict-send",
  "/payments",
  "/trade_aggregations",
  "/trades",
  "/transactions",
  "/transactions/{id}",
  "/transactions/{id}/effects",
  "/transactions/{id}/operations",
  "/transactions/{id}/payments",
  "/transactions_async",
] as const;
const H_TEMPLATE_SET: ReadonlySet<string> = new Set(HORIZON_TEMPLATES);
const H_COLLECTIONS: ReadonlySet<string> = new Set(
  HORIZON_TEMPLATES.map((t) => t.split("/")[1]).filter((s): s is string => !!s),
);
const H_FIXED_SECOND: ReadonlySet<string> = new Set(["strict-receive", "strict-send"]);

const templateOf = (seg: readonly string[]): string | undefined => {
  if (seg.length === 0) return "/";
  const [a, b, c, d] = seg;
  if (!a || !H_COLLECTIONS.has(a) || seg.length > 4) return undefined;
  const parts = [a];
  if (b !== undefined) parts.push(H_FIXED_SECOND.has(b) && a === "paths" ? b : "{id}");
  if (c !== undefined) parts.push(c);
  if (d !== undefined) parts.push(c === "data" ? "{key}" : d);
  const t = `/${parts.join("/")}`;
  return H_TEMPLATE_SET.has(t) ? t : undefined;
};

/**
 * Horizon URL → route template, or `_OTHER`. A base path in front of the Horizon routes (paid providers put API keys
 * there) is skipped: the first suffix of the path that is a known template wins, so the prefix is never recorded.
 */
export function horizonRoute(url: unknown): string {
  let path: string;
  try {
    path = new URL(String(url), "http://h.invalid").pathname;
  } catch {
    return "_OTHER";
  }
  const seg = path.split("/").filter(Boolean);
  if (seg.length > 16) return "_OTHER";
  for (let i = 0; i <= seg.length; i++) {
    const rest = seg.slice(i);
    if (rest.length === 0 && i > 0) break; // a bare prefix is not "/"
    const t = templateOf(rest);
    if (t) return t;
  }
  return "_OTHER";
}

/** Horizon `extras.result_codes.transaction` → result class. */
export const HORIZON_TX_CODES: Readonly<Record<string, ResultClass>> = {
  tx_success: "success",
  tx_fee_bump_inner_success: "success",
  tx_bad_seq: "bad_seq",
  tx_bad_min_seq_age_or_gap: "bad_seq",
  tx_insufficient_fee: "insufficient_fee",
  tx_insufficient_balance: "insufficient_balance",
  tx_bad_auth: "bad_auth",
  tx_bad_auth_extra: "bad_auth",
  tx_too_early: "time_bounds",
  tx_too_late: "time_bounds",
  tx_no_source_account: "no_account",
  tx_missing_operation: "malformed",
  tx_malformed: "malformed",
  tx_not_supported: "malformed",
  tx_bad_sponsorship: "malformed",
  tx_failed: "op_failed",
  tx_fee_bump_inner_failed: "op_failed",
  tx_soroban_invalid: "soroban_invalid",
  tx_internal_error: "other",
};
