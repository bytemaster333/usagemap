// SPDX-License-Identifier: Apache-2.0
// Local mock of a Stellar RPC (JSON-RPC 2.0 over POST /) and a few Horizon routes, scripted per test.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";

// js-stellar-sdk 17 XDR classes: structs take an object, unions are built from per-arm factories.
export const txResult = (r: unknown) =>
  new xdr.TransactionResult({
    feeCharged: 100n,
    result: r as xdr.TransactionResultResult,
    ext: xdr.TransactionResultExt.v0(),
  }).toXdr("base64");

export const BAD_SEQ = () => txResult(xdr.TransactionResultResult.txBadSeq());
export const TRAPPED = () =>
  txResult(
    xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(
        xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()),
      ),
    ]),
  );
export const ARCHIVED = () =>
  txResult(
    xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(
        xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionEntryArchived()),
      ),
    ]),
  );
export const FEE_BUMP_INNER_INSUFFICIENT_FEE = () =>
  txResult(
    xdr.TransactionResultResult.txFeeBumpInnerFailed(
      new xdr.InnerTransactionResultPair({
        transactionHash: new Uint8Array(32) as unknown as xdr.Hash,
        result: new xdr.InnerTransactionResult({
          feeCharged: 100n,
          result: xdr.InnerTransactionResultResult.txInsufficientFee(),
          ext: xdr.InnerTransactionResultExt.v0(),
        }),
      }),
    ),
  );
export const SOROBAN_DATA = () => new SorobanDataBuilder().build().toXdr("base64");

type Handler = (method: string, params: unknown) => unknown | Promise<unknown>;

const body = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => res(s));
  });

export interface Mock {
  url: string;
  calls: string[];
  close(): Promise<void>;
}

/** `handler` returns `{result}` / `{error}` objects, or `{httpStatus}`, or `{delayMs, ...}`. */
export async function startMock(handler: Handler, horizon?: (path: string, method: string) => { status: number; json: unknown }): Promise<Mock> {
  const calls: string[] = [];
  const srv: Server = createServer(async (req, res) => {
    const raw = await body(req);
    if (horizon && req.url !== "/") {
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
    const out = (await handler(String(msg.method), msg.params)) as Record<string, unknown>;
    if (typeof out?.delayMs === "number") await new Promise((r) => setTimeout(r, out.delayMs as number));
    if (typeof out?.httpStatus === "number") {
      res.writeHead(out.httpStatus as number, { "content-type": "text/plain" });
      res.end("unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const { delayMs: _d, ...rest } = out ?? {};
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, ...rest }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    calls,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}
