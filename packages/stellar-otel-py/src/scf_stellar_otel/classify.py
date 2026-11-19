# SPDX-License-Identifier: Apache-2.0
"""Closed-set classifiers.

Every function returns a member of a fixed list; nothing derived from an address, hash, XDR body, amount, URL or
error text ever leaves these functions. The lists are identical to ``packages/stellar-otel/src/classify.ts`` (the
JavaScript package) and are enforced again by the UsageMap Collector
(``collector/processor/scfsanitizeprocessor/stellar.go``, wire-formats §f.5 step 4a); ``tests/test_sets_match.py``
keeps the three in step.
"""

from __future__ import annotations

import base64
import binascii
import re
import struct
from collections.abc import Mapping
from typing import Final
from urllib.parse import urlsplit

OTHER: Final = "_OTHER"

#: The Stellar RPC JSON-RPC methods (stellar-rpc). Others: ``_OTHER``.
RPC_METHODS: Final = (
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
)
_RPC_METHOD_SET: Final = frozenset(RPC_METHODS)


def rpc_method(m: object) -> str:
    return m if isinstance(m, str) and m in _RPC_METHOD_SET else OTHER


NETWORKS: Final = ("mainnet", "testnet", "futurenet", "local", "unknown")
_PASSPHRASES: Final[Mapping[str, str]] = {
    "Public Global Stellar Network ; September 2015": "mainnet",
    "Test SDF Network ; September 2015": "testnet",
    "Test SDF Future Network ; October 2022": "futurenet",
    "Standalone Network ; February 2017": "local",
}
_NAMED: Final = frozenset(("mainnet", "testnet", "futurenet", "local"))


def network_of(p: object) -> str:
    """A network name or passphrase → network class, in memory only; the passphrase itself is never recorded."""
    if not isinstance(p, str):
        return "unknown"
    if p in _NAMED:
        return p
    return _PASSPHRASES.get(p, "unknown")


#: Transaction result class (closed).
RESULT_CLASSES: Final = (
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
)

# TransactionResultCode (Stellar-transaction.x; the same table as the JavaScript package).
_TX_CODE: Final[Mapping[int, str]] = {
    0: "success",  # txSUCCESS
    1: "success",  # txFEE_BUMP_INNER_SUCCESS
    -2: "time_bounds",  # txTOO_EARLY
    -3: "time_bounds",  # txTOO_LATE
    -4: "malformed",  # txMISSING_OPERATION
    -5: "bad_seq",  # txBAD_SEQ
    -6: "bad_auth",  # txBAD_AUTH
    -7: "insufficient_balance",  # txINSUFFICIENT_BALANCE
    -8: "no_account",  # txNO_ACCOUNT
    -9: "insufficient_fee",  # txINSUFFICIENT_FEE
    -10: "bad_auth",  # txBAD_AUTH_EXTRA
    -11: "other",  # txINTERNAL_ERROR
    -12: "malformed",  # txNOT_SUPPORTED
    -14: "malformed",  # txBAD_SPONSORSHIP
    -15: "bad_seq",  # txBAD_MIN_SEQ_AGE_OR_GAP
    -16: "malformed",  # txMALFORMED
    -17: "soroban_invalid",  # txSOROBAN_INVALID
    -18: "other",  # txFROZEN_KEY_ACCESSED
}
# InvokeHostFunctionResultCode.
_HOST_FN_CODE: Final[Mapping[int, str]] = {
    -1: "malformed",
    -2: "contract_error",  # TRAPPED
    -3: "resource_limit",  # RESOURCE_LIMIT_EXCEEDED
    -4: "expired_state",  # ENTRY_ARCHIVED
    -5: "insufficient_fee",  # INSUFFICIENT_REFUNDABLE_FEE
}
_OP_INVOKE_HOST_FUNCTION: Final = 24
_TX_FAILED: Final = -1
_TX_FEE_BUMP_INNER_FAILED: Final = -13
_MAX_XDR_B64: Final = 1 << 16


def _i32(u: bytes, off: int) -> int:
    return struct.unpack_from(">i", u, off)[0]


def tx_result_class(b64: object) -> str:
    """Classify a base64 XDR ``TransactionResult`` (RPC ``errorResultXdr`` / ``resultXdr``) from its fixed wire layout.

    Layout: int64 feeCharged | int32 code | (txFAILED: uint32 n, OperationResult[] = int32 opCode [0 = opINNER] |
    int32 opType | int32 opResultCode …) | (fee bump: Hash(32) | InnerTransactionResult {int64 fee | int32 code …}).
    Soroban transactions have exactly one operation, so only the first one is inspected. The bytes are discarded.
    """
    if not isinstance(b64, str) or not b64 or len(b64) > _MAX_XDR_B64:
        return "undecodable"
    try:
        u = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return "undecodable"
    if len(u) < 12:
        return "undecodable"

    def at(off: int, inner: bool) -> str:
        if len(u) < off + 4:
            return "undecodable"
        code = _i32(u, off)
        if code == _TX_FAILED:
            if len(u) < off + 16:
                return "op_failed"
            n = struct.unpack_from(">I", u, off + 4)[0]
            if n < 1 or _i32(u, off + 8) != 0:
                return "op_failed"
            if _i32(u, off + 12) == _OP_INVOKE_HOST_FUNCTION and len(u) >= off + 20:
                return _HOST_FN_CODE.get(_i32(u, off + 16), "op_failed")
            return "op_failed"
        if code == _TX_FEE_BUMP_INNER_FAILED:
            # Hash(32) then the inner result (int64 fee, int32 code). Never recurse twice.
            return "other" if inner else at(off + 4 + 32 + 8, True)
        return _TX_CODE.get(code, "other")

    return at(8, False)


#: Simulation failure class from the host's free-text error (matched in memory, then discarded).
SIM_ERROR_CLASSES: Final = (
    "contract_error",
    "resource_limit",
    "expired_state",
    "auth",
    "wasm_trap",
    "value_error",
    "storage",
    "no_account",
    "other",
)
_MAX_SIM_TEXT: Final = 1 << 16
_SIM_RULES: Final = (
    (re.compile(r"Error\(Contract, #\d+\)"), "contract_error"),
    (re.compile(r"Error\(Budget,"), "resource_limit"),
    (re.compile(r"archived|Error\(Storage, ?MissingValue\)", re.IGNORECASE), "expired_state"),
    (re.compile(r"Error\(Auth,"), "auth"),
    (re.compile(r"Error\(WasmVm,"), "wasm_trap"),
    (re.compile(r"Error\((Value|Object|Crypto),"), "value_error"),
    (re.compile(r"Error\(Storage,"), "storage"),
    (re.compile(r"[Aa]ccount not found|missing account"), "no_account"),
)


def sim_error_class(text: object) -> str:
    if not isinstance(text, str):
        return "other"
    t = text[:_MAX_SIM_TEXT]
    for rx, cls in _SIM_RULES:
        if rx.search(t):
            return cls
    return "other"


SUBMIT_STATUSES: Final = ("PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR", "SUCCESS", "FAILED")
POLL_STATUSES: Final = ("SUCCESS", "FAILED", "NOT_FOUND")
SIM_OUTCOMES: Final = ("success", "error", "restore_required")


def closed(values: tuple[str, ...], v: object) -> str:
    return v if isinstance(v, str) and v in values else OTHER


#: JSON-RPC 2.0 error codes kept as-is; any other code is ``_OTHER``.
JSONRPC_CODES: Final = ("-32700", "-32600", "-32601", "-32602", "-32603")
#: HTTP statuses kept as-is in ``error.type`` (≥ 400) and ``http.response.status_code`` (all of them).
HTTP_STATUSES: Final = (
    200, 201, 202, 204, 301, 302, 304, 307, 308, 400, 401, 403, 404, 405, 406, 408, 409, 410, 413,
    414, 415, 422, 429, 500, 501, 502, 503, 504,
)  # fmt: skip
_HTTP_STATUS_SET: Final = frozenset(HTTP_STATUSES)


def http_status(s: object) -> int | None:
    return s if isinstance(s, int) and not isinstance(s, bool) and s in _HTTP_STATUS_SET else None


def json_rpc_error_type(code: object) -> str:
    s = str(code) if isinstance(code, int) and not isinstance(code, bool) else ""
    return s if s in JSONRPC_CODES else OTHER


def status_error_type(status: int) -> str:
    """``error.type`` of an HTTP failure: the status when it is a kept status ≥ 400, else ``_OTHER``."""
    s = http_status(status)
    return str(s) if s is not None and s >= 400 else OTHER


def transport_error_type(err: BaseException) -> str:
    """``timeout`` or ``network`` for an exception raised before any HTTP status was received.

    ``stellar_sdk.exceptions.ConnectionError`` wraps the transport error as ``__cause__`` (requests / aiohttp);
    timeouts are recognised by type name along that chain (``Timeout``, ``ReadTimeout``, ``TimeoutError`` …).
    """
    seen: set[int] = set()
    e: BaseException | None = err
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        if isinstance(e, TimeoutError) or "Timeout" in type(e).__name__:
            return "timeout"
        e = e.__cause__ or e.__context__
    return "network"


#: The closed Horizon route templates (Horizon API reference).
HORIZON_TEMPLATES: Final = (
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
)
_H_TEMPLATE_SET: Final = frozenset(HORIZON_TEMPLATES)
_H_COLLECTIONS: Final = frozenset(t.split("/")[1] for t in HORIZON_TEMPLATES if t.split("/")[1])
_H_FIXED_SECOND: Final = frozenset(("strict-receive", "strict-send"))


def _template_of(seg: list[str]) -> str | None:
    if not seg:
        return "/"
    if seg[0] not in _H_COLLECTIONS or len(seg) > 4:
        return None
    a = seg[0]
    parts = [a]
    if len(seg) > 1:
        parts.append(seg[1] if a == "paths" and seg[1] in _H_FIXED_SECOND else "{id}")
    if len(seg) > 2:
        parts.append(seg[2])
    if len(seg) > 3:
        parts.append("{key}" if seg[2] == "data" else seg[3])
    t = "/" + "/".join(parts)
    return t if t in _H_TEMPLATE_SET else None


def horizon_route(url: object) -> str:
    """Horizon URL → route template, or ``_OTHER``.

    A base path in front of the Horizon routes (paid providers put API keys there) is skipped: the first suffix of
    the path that is a known template wins, so the prefix is never recorded. Query strings are never read.
    """
    try:
        path = urlsplit(str(url)).path
    except ValueError:
        return OTHER
    seg = [s for s in path.split("/") if s]
    if len(seg) > 16:
        return OTHER
    for i in range(len(seg) + 1):
        rest = seg[i:]
        if not rest and i > 0:
            break  # a bare prefix is not "/"
        t = _template_of(rest)
        if t is not None:
            return t
    return OTHER


#: Horizon ``extras.result_codes.transaction`` → result class.
HORIZON_TX_CODES: Final[Mapping[str, str]] = {
    "tx_success": "success",
    "tx_fee_bump_inner_success": "success",
    "tx_bad_seq": "bad_seq",
    "tx_bad_min_seq_age_or_gap": "bad_seq",
    "tx_insufficient_fee": "insufficient_fee",
    "tx_insufficient_balance": "insufficient_balance",
    "tx_bad_auth": "bad_auth",
    "tx_bad_auth_extra": "bad_auth",
    "tx_too_early": "time_bounds",
    "tx_too_late": "time_bounds",
    "tx_no_source_account": "no_account",
    "tx_missing_operation": "malformed",
    "tx_malformed": "malformed",
    "tx_not_supported": "malformed",
    "tx_bad_sponsorship": "malformed",
    "tx_failed": "op_failed",
    "tx_fee_bump_inner_failed": "op_failed",
    "tx_soroban_invalid": "soroban_invalid",
    "tx_internal_error": "other",
}
