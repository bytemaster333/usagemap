// SPDX-License-Identifier: Apache-2.0
import { metrics } from "@opentelemetry/api";
import {
  Account,
  BASE_FEE,
  contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { instrumentStellarRpc, SCOPE_NAME } from "../src/index.ts";
import { assertClean, assertKeys, points, setup, sum } from "./helpers.ts";
import {
  BAD_SEQ,
  type Mock,
  RESOURCE_LIMIT,
  type RpcAnswer,
  recorded,
  startMock,
  TRAPPED,
} from "./mock-rpc.ts";
import {
  b64,
  detachAll,
  EXPECTED_VERSION,
  instrumentRpc,
  MODULE_SCOPE,
  rpcClient,
  sdk,
} from "./sdk.ts";

const kp = Keypair.random();
const tx = () =>
  new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
const HASH = "ab".repeat(32);
const sent = (status: string, extra: Record<string, unknown> = {}): RpcAnswer => ({
  result: { status, hash: HASH, latestLedger: 10, latestLedgerCloseTime: "1", ...extra },
});
const failedTx = (resultXdr: string): RpcAnswer => ({
  result: {
    status: "FAILED",
    latestLedger: 10,
    latestLedgerCloseTime: "1",
    oldestLedger: 1,
    oldestLedgerCloseTime: "1",
    resultXdr,
    txHash: HASH,
    envelopeXdr: b64(tx().toEnvelope()),
    resultMetaXdr: "AAAAAQAAAAAAAAAA",
    ledger: 9,
    createdAt: 1,
    applicationOrder: 1,
    feeBump: false,
  },
});

// Scripted answers in order per method; when a queue is empty the recorded testnet answer is replayed.
const script: Record<string, RpcAnswer[]> = {};
let mock: Mock;
beforeAll(async () => {
  // The RPC URL carries a provider API key in its path, as paid RPC providers do: it must never be recorded.
  mock = await startMock((method) => script[method]?.shift(), undefined, "/v1/apikey-SECRET123/");
});
afterAll(() => mock.close());
afterEach(detachAll);

const SERVER_TIMEOUT = Number(EXPECTED_VERSION?.split(".")[0] ?? 17) >= 17;
const server = (o: Partial<rpc.Server.Options> = {}) =>
  new rpc.Server(mock.url, { allowHttp: true, ...o });

describe(`instrumentStellarRpc (js-stellar-sdk ${EXPECTED_VERSION ?? "17"}, mock RPC replaying recorded testnet answers)`, () => {
  it("runs against the SDK copy this project pins, through the hook point of its major", async () => {
    const { reader, meter } = setup();
    const s = server();
    const h = instrumentRpc(s, { meter, network: "testnet" });
    expect(h).toMatchObject({ instrumented: true, scope: MODULE_SCOPE ? "module" : "server" });
    mock.clientVersions.clear();
    await s.getHealth();
    if (EXPECTED_VERSION) expect([...mock.clientVersions]).toEqual([EXPECTED_VERSION]);
    expect(sum(await points(reader), "rpc.client.call.duration")).toBe(1);
    if (MODULE_SCOPE) {
      // A server instance has no client of its own on these majors: it is refused, not half-instrumented.
      expect(instrumentStellarRpc(s as never)).toMatchObject({ instrumented: false });
      // The module-wide hook covers every server created from this SDK copy.
      await server().getHealth();
      expect(sum(await points(reader), "rpc.client.call.duration")).toBe(2);
    } else {
      // On per-server majors the namespace has nothing to hook.
      expect(instrumentStellarRpc(sdk.rpc as never)).toMatchObject({ instrumented: false });
    }
  });

  it("records duration per JSON-RPC method and learns the network from getNetwork", async () => {
    const { reader, meter } = setup();
    const s = server();
    expect(instrumentRpc(s, { meter }).instrumented).toBe(true);
    await s.getHealth();
    await s.getNetwork();
    await s.getFeeStats();
    await s.getVersionInfo();
    const g = await s.getTransaction(HASH);
    expect(g.status).toBe("NOT_FOUND");
    const p = await points(reader);
    assertKeys(p);
    const dur = p.filter((x) => x.name === "rpc.client.call.duration");
    expect(
      Object.fromEntries(dur.map((d) => [d.attrs["rpc.method"], d.attrs["stellar.network"]])),
    ).toEqual({
      getHealth: "unknown", // before getNetwork answered
      getNetwork: "testnet",
      getFeeStats: "testnet",
      getVersionInfo: "testnet",
      getTransaction: "testnet",
    });
    for (const d of dur) {
      expect(d.unit).toBe("s");
      expect(d.attrs["rpc.system.name"]).toBe("jsonrpc");
      expect(d.attrs["error.type"]).toBeUndefined();
    }
    expect(p.find((x) => x.name === "stellar.tx.polls")?.attrs).toEqual({
      "stellar.tx.status": "NOT_FOUND",
      "stellar.network": "testnet",
    });
    assertClean(JSON.stringify(p));
  });

  it("classifies sendTransaction statuses and decodes the error result XDR to a class", async () => {
    const { reader, meter } = setup();
    const s = server();
    instrumentRpc(s, { meter, network: Networks.TESTNET });
    script.sendTransaction = [
      sent("ERROR", { errorResultXdr: BAD_SEQ() }),
      sent("PENDING"),
      sent("TRY_AGAIN_LATER"),
      sent("DUPLICATE"),
      sent("ERROR", { errorResultXdr: "%%%" }),
      sent("SOMETHING_NEW"),
    ];
    const statuses = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        await s.sendTransaction(tx()).then(
          (r) => r.status,
          () => "parser_threw",
        ),
      );
    // The SDK's own parser rejects the broken XDR; the metric is still recorded and the caller sees the SDK's error.
    expect(statuses).toEqual([
      "ERROR",
      "PENDING",
      "TRY_AGAIN_LATER",
      "DUPLICATE",
      "parser_threw",
      "SOMETHING_NEW",
    ]);
    const p = await points(reader);
    assertKeys(p);
    const sub = p
      .filter((x) => x.name === "stellar.tx.submissions")
      .map((x) => [
        x.attrs["stellar.tx.status"],
        x.attrs["stellar.tx.result_class"] ?? null,
        x.value,
      ])
      .sort();
    expect(sub).toEqual([
      ["DUPLICATE", null, 1],
      ["ERROR", "bad_seq", 1],
      ["ERROR", "undecodable", 1],
      ["PENDING", null, 1],
      ["TRY_AGAIN_LATER", null, 1],
      ["_OTHER", null, 1],
    ]);
    for (const x of p.filter((x) => x.name === "stellar.tx.submissions"))
      expect(x.attrs).toMatchObject({ "stellar.tx.via": "rpc", "stellar.network": "testnet" });
    expect(sum(p, "rpc.client.call.duration", (a) => a["rpc.method"] === "sendTransaction")).toBe(
      6,
    );
    assertClean(JSON.stringify(p));
  });

  it("classifies polls and simulations, including the recorded testnet simulation answers", async () => {
    const { reader, meter } = setup();
    const s = server();
    instrumentRpc(s, { meter, network: "testnet" });
    script.getTransaction = [failedTx(TRAPPED()), failedTx(RESOURCE_LIMIT())];
    expect((await s.getTransaction(HASH)).status).toBe("FAILED");
    expect((await s.getTransaction(HASH)).status).toBe("FAILED");
    script.simulateTransaction = [
      { result: recorded.simulateSuccess?.result },
      { result: recorded.simulateError?.result },
      {
        result: { latestLedger: 10, error: `HostError: Error(Contract, #3) at ${kp.publicKey()}` },
      },
      {
        result: {
          ...recorded.simulateSuccess?.result,
          restorePreamble: {
            minResourceFee: "1",
            transactionData: recorded.simulateSuccess?.result?.transactionData,
          },
        },
      },
    ];
    expect(rpc.Api.isSimulationSuccess(await s.simulateTransaction(tx()))).toBe(true);
    expect(rpc.Api.isSimulationError(await s.simulateTransaction(tx()))).toBe(true);
    expect(rpc.Api.isSimulationError(await s.simulateTransaction(tx()))).toBe(true);
    expect(rpc.Api.isSimulationRestore(await s.simulateTransaction(tx()))).toBe(true);
    const p = await points(reader);
    assertKeys(p);
    const polls = p
      .filter((x) => x.name === "stellar.tx.polls")
      .map((x) => `${x.attrs["stellar.tx.status"]}/${x.attrs["stellar.tx.result_class"]}`)
      .sort();
    expect(polls).toEqual(["FAILED/contract_error", "FAILED/resource_limit"]);
    const sims = p
      .filter((x) => x.name === "stellar.tx.simulations")
      .map((x) => `${x.attrs["stellar.sim.outcome"]}/${x.attrs["stellar.sim.error_class"] ?? "-"}`)
      .sort();
    // The recorded testnet error is "Error(Context, UnexpectedSize)": not in a specific class → other.
    expect(sims).toEqual([
      "error/contract_error",
      "error/other",
      "restore_required/-",
      "success/-",
    ]);
    assertClean(JSON.stringify(p));
  });

  it("records JSON-RPC errors as error.type with the code; an unknown method is _OTHER", async () => {
    const { reader, meter } = setup();
    const s = server();
    instrumentRpc(s, { meter, network: "testnet" });
    const r = await rpcClient(s).post(mock.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountSecrets",
    });
    expect((r.data as { error: { code: number } }).error.code).toBe(-32601);
    script.getHealth = [{ error: { code: -32099, message: "custom server error with G... text" } }];
    await expect(s.getHealth()).rejects.toBeTruthy();
    const dur = (await points(reader)).filter((x) => x.name === "rpc.client.call.duration");
    expect(
      dur
        .map((d) => d.attrs)
        .sort((a, b) => String(a["rpc.method"]).localeCompare(String(b["rpc.method"]))),
    ).toEqual([
      {
        "rpc.system.name": "jsonrpc",
        "rpc.method": "_OTHER",
        "stellar.network": "testnet",
        "error.type": "-32601",
        "rpc.status_code": "-32601",
      },
      {
        "rpc.system.name": "jsonrpc",
        "rpc.method": "getHealth",
        "stellar.network": "testnet",
        "error.type": "_OTHER",
      },
    ]);
  });

  it("classifies HTTP failures and timeouts without changing the caller's error", async () => {
    const { reader, meter } = setup();
    const s = server({ timeout: 200 });
    instrumentRpc(s, { meter, network: "testnet" });
    script.getHealth = [{ httpStatus: 503 }, { delayMs: 800, result: {} }, { httpStatus: 418 }];
    const e1 = await s.getHealth().catch((e: unknown) => e);
    expect((e1 as { response?: { status?: number } }).response?.status).toBe(503);
    // `rpc.Server`'s own `timeout` option is new in 17.0; on older majors a timeout is set per request (axios config).
    const e2 = await (SERVER_TIMEOUT
      ? s.getHealth()
      : rpcClient(s).post(
          mock.url,
          { jsonrpc: "2.0", id: 1, method: "getHealth" },
          { timeout: 200 },
        )
    ).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(Error);
    await s.getHealth().catch(() => undefined);
    const types = (await points(reader))
      .filter((x) => x.name === "rpc.client.call.duration")
      .map((d) => d.attrs["error.type"])
      .sort();
    expect(types).toEqual(["503", "_OTHER", "timeout"]);
  });

  it("covers contract.AssembledTransaction / generated clients through the injected server", async () => {
    const { reader, meter } = setup();
    const s = server();
    instrumentRpc(s, { meter, network: "testnet" });
    await contract.AssembledTransaction.build({
      contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
      method: "hello",
      args: [],
      networkPassphrase: Networks.TESTNET,
      rpcUrl: mock.url,
      allowHttp: true,
      server: s,
      publicKey: kp.publicKey(),
      parseResultXdr: () => null,
    } as unknown as Parameters<typeof contract.AssembledTransaction.build>[0]).catch(
      () => undefined,
    );
    const p = await points(reader);
    const methods = new Set(
      p.filter((x) => x.name === "rpc.client.call.duration").map((x) => x.attrs["rpc.method"]),
    );
    expect(methods.has("getLedgerEntries")).toBe(true);
    assertClean(JSON.stringify(p));
  });

  it("is idempotent and detachable", async () => {
    const { reader, meter } = setup();
    const s = server();
    const h1 = instrumentRpc(s, { meter });
    expect(instrumentRpc(s, { meter })).toBe(h1);
    await s.getHealth();
    h1.detach();
    h1.detach();
    await s.getHealth();
    expect(sum(await points(reader), "rpc.client.call.duration")).toBe(1);
    // Re-attaching after detach works.
    const h2 = instrumentRpc(s, { meter });
    expect(h2).not.toBe(h1);
    await s.getHealth();
    expect(sum(await points(reader), "rpc.client.call.duration")).toBe(2);
    h2.detach();
  });

  it("uses the application's global MeterProvider when no meter is given", async () => {
    const { reader, provider } = setup();
    metrics.setGlobalMeterProvider(provider);
    try {
      const s = server();
      const h = instrumentRpc(s);
      await s.getHealth();
      const { resourceMetrics } = await reader.collect();
      expect(resourceMetrics.scopeMetrics.map((m) => m.scope.name)).toContain(SCOPE_NAME);
      h.detach();
    } finally {
      metrics.disable();
    }
  });

  it("never breaks the caller: no interceptors → not instrumented; a throwing meter is contained", async () => {
    expect(instrumentStellarRpc({} as never)).toMatchObject({
      instrumented: false,
      reason: "no_interceptors",
    });
    expect(instrumentStellarRpc(null as never).instrumented).toBe(false);
    const hostile = Object.defineProperty({}, "httpClient", {
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(instrumentStellarRpc(hostile as never).instrumented).toBe(false);
    // A server-shaped client without `eject` cannot be detached cleanly: refused.
    const noEject = { use: () => 0 };
    expect(
      instrumentStellarRpc({
        AxiosClient: { interceptors: { request: noEject, response: noEject } },
      } as never).instrumented,
    ).toBe(false);
    const boom = () => {
      throw new Error("meter exploded");
    };
    const meter = {
      createHistogram: () => ({ record: boom }),
      createCounter: () => ({ add: boom }),
    } as never;
    const s = server();
    instrumentRpc(s, { meter, network: "testnet" });
    script.sendTransaction = [sent("PENDING")];
    expect((await s.getHealth()).status).toBe("healthy");
    expect((await s.sendTransaction(tx())).status).toBe("PENDING");
  });
});
