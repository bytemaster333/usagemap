// SPDX-License-Identifier: Apache-2.0
// Local mock of a Stellar RPC (JSON-RPC 2.0 over POST) and of Horizon routes, scripted per test. The default RPC
// answers replay responses recorded from the public testnet (test/fixtures/testnet-rpc.json).
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { xdr } from "@stellar/stellar-sdk";
import { b64 } from "./sdk.ts";

export const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/testnet-rpc.json", import.meta.url), "utf8"),
) as Record<string, { result?: Record<string, unknown>; error?: unknown }>;

// Results are built with the XDR classes of the SDK copy under test, so the wire-layout decoder is checked against
// what each major really emits. 17.x: generated classes (structs take an object, unions have per-arm factories,
// int64 is a bigint, `.toXdr`). 13.x to 16.x: js-xdr classes (int64 is `Int64`, void-arm int unions are
// `new U(0)`, `.toXDR`).
// biome-ignore lint/suspicious/noExplicitAny: the XDR API differs per SDK major; only the 17.x types are installed.
const X = xdr as any;
const GENERATED = typeof X.TransactionResult.prototype.toXdr === "function";
const fee = () => (GENERATED ? 100n : X.Int64.fromString("100"));
// biome-ignore lint/suspicious/noExplicitAny: see above.
const v0 = (U: any) => (typeof U.v0 === "function" ? U.v0() : new U(0));

export const txResult = (r: unknown) =>
  b64(new X.TransactionResult({ feeCharged: fee(), result: r, ext: v0(X.TransactionResultExt) }));

const hostFn = (r: unknown) =>
  txResult(
    X.TransactionResultResult.txFailed([
      X.OperationResult.opInner(X.OperationResultTr.invokeHostFunction(r)),
    ]),
  );
export const BAD_SEQ = () => txResult(X.TransactionResultResult.txBadSeq());
export const INSUFFICIENT_FEE = () => txResult(X.TransactionResultResult.txInsufficientFee());
export const TRAPPED = () => hostFn(X.InvokeHostFunctionResult.invokeHostFunctionTrapped());
export const ARCHIVED = () => hostFn(X.InvokeHostFunctionResult.invokeHostFunctionEntryArchived());
export const RESOURCE_LIMIT = () =>
  hostFn(X.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded());
export const PAYMENT_FAILED = () =>
  txResult(
    X.TransactionResultResult.txFailed([
      X.OperationResult.opInner(X.OperationResultTr.payment(X.PaymentResult.paymentUnderfunded())),
    ]),
  );
export const FEE_BUMP_INNER_INSUFFICIENT_FEE = () =>
  txResult(
    X.TransactionResultResult.txFeeBumpInnerFailed(
      new X.InnerTransactionResultPair({
        transactionHash: GENERATED ? new Uint8Array(32) : Buffer.alloc(32),
        result: new X.InnerTransactionResult({
          feeCharged: fee(),
          result: X.InnerTransactionResultResult.txInsufficientFee(),
          ext: v0(X.InnerTransactionResultExt),
        }),
      }),
    ),
  );
/** txFROZEN_KEY_ACCESSED (-18) exists only in the 17.x XDR; undefined on older majors. */
export const FROZEN_KEY = (): string | undefined =>
  typeof X.TransactionResultResult.txFrozenKeyAccessed === "function"
    ? txResult(X.TransactionResultResult.txFrozenKeyAccessed())
    : undefined;
export const SUCCESS = () => txResult(X.TransactionResultResult.txSuccess([]));

export type RpcAnswer =
  | { result: unknown }
  | { error: unknown }
  | { httpStatus: number }
  | { delayMs: number; result: unknown };
type Handler = (method: string, params: unknown) => RpcAnswer | undefined;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
    });
    req.on("end", () => res(s));
  });

export interface Mock {
  url: string;
  calls: string[];
  /** `X-Client-Version` of each request: proves which SDK copy really sent it. */
  clientVersions: Set<string>;
  close(): Promise<void>;
}

/** Recorded testnet answers for the read-only methods; `handler` may override any method. */
export const replay = (method: string): RpcAnswer | undefined => {
  const r = {
    getNetwork: recorded.getNetwork,
    getHealth: recorded.getHealth,
    getFeeStats: recorded.getFeeStats,
    getVersionInfo: recorded.getVersionInfo,
    getTransaction: recorded.getTransactionNotFound,
  }[method];
  if (r?.result) return { result: r.result };
  return undefined;
};

export async function startMock(
  handler: Handler = () => undefined,
  horizon?: (path: string, method: string) => { status: number; json: unknown },
  rpcPath = "/",
): Promise<Mock> {
  const calls: string[] = [];
  const clientVersions = new Set<string>();
  const srv: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const cv = req.headers["x-client-version"];
    if (typeof cv === "string") clientVersions.add(cv);
    if (horizon && (req.url ?? "/") !== rpcPath) {
      calls.push(`${req.method} ${req.url}`);
      const r = horizon(req.url ?? "/", req.method ?? "GET");
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
      return;
    }
    let msg: { id?: unknown; method?: string; params?: unknown } = {};
    try {
      msg = JSON.parse(raw);
    } catch {}
    calls.push(String(msg.method));
    const out: RpcAnswer = handler(String(msg.method), msg.params) ??
      replay(String(msg.method)) ?? { error: recorded.unknownMethod?.error };
    const delay = (out as { delayMs?: number }).delayMs;
    if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
    if ("httpStatus" in out) {
      res.writeHead(out.httpStatus, { "content-type": "text/plain" });
      res.end("unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const payload = "error" in out ? { error: out.error } : { result: out.result };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, ...payload }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${rpcPath}`,
    calls,
    clientVersions,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}
