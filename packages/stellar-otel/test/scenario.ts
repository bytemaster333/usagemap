// SPDX-License-Identifier: Apache-2.0
// A realistic backend session, exported over real OTLP/HTTP (JSON) to `sinkUrl`: RPC reads, submissions with every
// status, polls, simulations, an HTTP failure, an unknown method, and Horizon reads and a failed submission. Used by
// the export test and by scripts/collector-fixture.ts (the Collector's SDK fixture for its golden tests).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { SCOPE_NAME, SCOPE_VERSION } from "../src/index.ts";
import { BAD_SEQ, recorded, startMock, TRAPPED } from "./mock-rpc.ts";
import { b64, detachAll, horizonClient, instrumentHz, instrumentRpc, rpcClient } from "./sdk.ts";

const HASH = "cd".repeat(32);

export async function sink(): Promise<{
  url: string;
  bodies: { type: string; body: string }[];
  close(): void;
}> {
  const bodies: { type: string; body: string }[] = [];
  const srv = createServer((req, res) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
    });
    req.on("end", () => {
      bodies.push({ type: String(req.headers["content-type"]), body: s });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/metrics`,
    bodies,
    close: () => srv.close(),
  };
}

export async function runScenario(sinkUrl: string): Promise<void> {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
  const queue: Record<string, unknown[]> = {
    sendTransaction: [
      { result: { status: "PENDING", hash: HASH, latestLedger: 10, latestLedgerCloseTime: "1" } },
      {
        result: {
          status: "ERROR",
          hash: HASH,
          latestLedger: 10,
          latestLedgerCloseTime: "1",
          errorResultXdr: BAD_SEQ(),
        },
      },
      {
        result: {
          status: "TRY_AGAIN_LATER",
          hash: HASH,
          latestLedger: 10,
          latestLedgerCloseTime: "1",
        },
      },
    ],
    getTransaction: [
      {
        result: {
          status: "FAILED",
          latestLedger: 10,
          latestLedgerCloseTime: "1",
          oldestLedger: 1,
          oldestLedgerCloseTime: "1",
          resultXdr: TRAPPED(),
          txHash: HASH,
          envelopeXdr: b64(tx.toEnvelope()),
          resultMetaXdr: "AAAAAQAAAAAAAAAA",
          ledger: 9,
          createdAt: 1,
          applicationOrder: 1,
          feeBump: false,
        },
      },
    ],
    simulateTransaction: [
      { result: recorded.simulateSuccess?.result },
      { result: recorded.simulateError?.result },
    ],
    getFeeStats: [{ httpStatus: 503 }],
  };
  const mock = await startMock(
    (m) => queue[m]?.shift() as never,
    (path, method) =>
      method === "POST"
        ? {
            status: 400,
            json: {
              type: "tx_failed",
              extras: { result_codes: { transaction: "tx_insufficient_fee" } },
            },
          }
        : path.startsWith("/fee_stats")
          ? { status: 200, json: { last_ledger: "1" } }
          : { status: 404, json: { type: "not_found", status: 404 } },
    "/rpc/",
  );
  const exporter = new OTLPMetricExporter({ url: sinkUrl });
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({
    readers: [reader],
    resource: resourceFromAttributes({
      "service.name": "stellar-dapp-api",
      "deployment.environment.name": "staging",
    }),
  });
  const meter = provider.getMeter(SCOPE_NAME, SCOPE_VERSION);
  try {
    const server = new rpc.Server(mock.url, { allowHttp: true });
    instrumentRpc(server, { meter });
    await server.getNetwork();
    await server.getHealth();
    await server.getHealth();
    await server.getFeeStats().catch(() => undefined);
    for (let i = 0; i < 3; i++) await server.sendTransaction(tx);
    await server.getTransaction(HASH);
    await server.getTransaction(HASH);
    await server.simulateTransaction(tx);
    await server.simulateTransaction(tx);
    await rpcClient(server).post(mock.url, { jsonrpc: "2.0", id: 1, method: "getAccountSecrets" });
    const base = mock.url.replace(/\/rpc\/$/, "");
    const horizon = new Horizon.Server(base, { allowHttp: true });
    instrumentHz(horizon, { meter, network: "testnet" });
    await horizon.feeStats();
    await horizon.loadAccount(kp.publicKey()).catch(() => undefined);
    await horizonClient(horizon)
      .post(`${base}/transactions`, "tx=AAAA")
      .catch(() => undefined);
    await provider.forceFlush();
  } finally {
    detachAll();
    await provider.shutdown();
    await mock.close();
  }
}
