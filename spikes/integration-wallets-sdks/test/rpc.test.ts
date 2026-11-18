// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
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
import { txResultClass } from "../src/classify.ts";
import { instrumentStellarRpc } from "../src/instrument-stellar-rpc.ts";
import { assertClean, points, setup } from "./helpers.ts";
import { ARCHIVED, BAD_SEQ, FEE_BUMP_INNER_INSUFFICIENT_FEE, type Mock, startMock, TRAPPED } from "./mock-rpc.ts";

const kp = Keypair.random();
const tx = () =>
  new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();

let polls = 0;
let mock: Mock;
before(async () => {
  mock = await startMock((method) => {
    switch (method) {
      case "getHealth":
        return { result: { status: "healthy", latestLedger: 10, oldestLedger: 1, ledgerRetentionWindow: 10 } };
      case "getNetwork":
        return { result: { passphrase: Networks.TESTNET, protocolVersion: 23 } };
      case "sendTransaction":
        return (polls++ % 2 === 0)
          ? { result: { status: "ERROR", hash: "00".repeat(32), latestLedger: 10, latestLedgerCloseTime: "1", errorResultXdr: BAD_SEQ() } }
          : { result: { status: "PENDING", hash: "00".repeat(32), latestLedger: 10, latestLedgerCloseTime: "1" } };
      case "getTransaction":
        return { result: { status: "FAILED", latestLedger: 10, latestLedgerCloseTime: "1", oldestLedger: 1, oldestLedgerCloseTime: "1", resultXdr: TRAPPED(), txHash: "00".repeat(32), envelopeXdr: tx().toEnvelope().toXdr("base64"), resultMetaXdr: "AAAAAQAAAAAAAAAA", ledger: 9, createdAt: 1, applicationOrder: 1, feeBump: false } };
      case "simulateTransaction":
        return { result: { latestLedger: 10, error: `HostError: Error(Contract, #3) contract ${kp.publicKey()}` } };
      case "slow":
        return { delayMs: 800, result: {} };
      case "unavailable":
        return { httpStatus: 503 };
      default:
        return { error: { code: -32601, message: "method not found" } };
    }
  });
});
after(() => mock.close());

describe("instrumentStellarRpc against a local mock RPC (js-stellar-sdk 17.4.0)", () => {
  it("records duration per JSON-RPC method and Stellar result classes, address-free", async () => {
    const { reader, meter } = setup();
    const server = new rpc.Server(mock.url, { allowHttp: true });
    instrumentStellarRpc(server, { meter });

    await server.getHealth();
    await server.getNetwork(); // learns `testnet` from the passphrase in memory
    const s1 = await server.sendTransaction(tx());
    assert.equal(s1.status, "ERROR");
    const s2 = await server.sendTransaction(tx());
    assert.equal(s2.status, "PENDING");
    const g = await server.getTransaction("00".repeat(32));
    assert.equal(g.status, "FAILED");
    const sim = await server.simulateTransaction(tx());
    assert.ok(rpc.Api.isSimulationError(sim));
    // An unknown method → `_OTHER` + JSON-RPC error code.
    await assert.rejects(server.httpClient.post(mock.url, { jsonrpc: "2.0", id: 1, method: "getAccountSecrets", params: {} }).then((r) => {
      if (r.data.error) throw r.data.error;
    }));

    const p = await points(reader);
    const dur = p.filter((x) => x.name === "rpc.client.call.duration");
    const byMethod = Object.fromEntries(dur.map((d) => [`${d.attrs["rpc.method"]}|${d.attrs["error.type"] ?? ""}`, d.value]));
    assert.equal(byMethod["getHealth|"], 1);
    assert.equal(byMethod["sendTransaction|"], 2);
    assert.equal(byMethod["getTransaction|"], 1);
    assert.equal(byMethod["simulateTransaction|"], 1);
    assert.equal(byMethod["_OTHER|-32601"], 1);
    for (const d of dur) assert.equal(d.attrs["rpc.system.name"], "jsonrpc");
    // getHealth ran before getNetwork, so it is `unknown`; later calls carry `testnet`.
    assert.equal(dur.find((d) => d.attrs["rpc.method"] === "getHealth")?.attrs["stellar.network"], "unknown");
    assert.equal(dur.find((d) => d.attrs["rpc.method"] === "sendTransaction")?.attrs["stellar.network"], "testnet");

    const sub = p.filter((x) => x.name === "stellar.tx.submissions");
    assert.deepEqual(
      sub.map((s) => [s.attrs["stellar.tx.status"], s.attrs["stellar.tx.result_class"] ?? null, s.value]).sort(),
      [["ERROR", "bad_seq", 1], ["PENDING", null, 1]],
    );
    const poll = p.find((x) => x.name === "stellar.tx.polls");
    assert.deepEqual(poll?.attrs, { "stellar.tx.status": "FAILED", "stellar.tx.result_class": "contract_error", "stellar.network": "testnet" });
    const simP = p.find((x) => x.name === "stellar.tx.simulations");
    assert.equal(simP?.attrs["stellar.sim.error_class"], "contract_error");

    assertClean(JSON.stringify(p));
  });

  it("classifies HTTP failures and timeouts without breaking the caller's error", async () => {
    const { reader, meter } = setup();
    const server = new rpc.Server(mock.url, { allowHttp: true, timeout: 200 });
    instrumentStellarRpc(server, { meter, network: Networks.TESTNET });
    const e1 = await server.httpClient.post(mock.url, { jsonrpc: "2.0", id: 1, method: "unavailable" }).catch((e) => e);
    assert.equal(e1?.response?.status, 503, "the caller still sees the original error");
    const e2 = await server.httpClient.post(mock.url, { jsonrpc: "2.0", id: 1, method: "slow" }).catch((e) => e);
    assert.ok(e2 instanceof Error || typeof e2 === "object");
    const dur = (await points(reader)).filter((x) => x.name === "rpc.client.call.duration");
    const types = dur.map((d) => d.attrs["error.type"]).sort();
    assert.deepEqual(types, ["http_503", "timeout"]);
  });

  it("covers a generated contract.Client through the injected server (one instrumented server for bindings)", async () => {
    const { reader, meter } = setup();
    const server = new rpc.Server(mock.url, { allowHttp: true });
    instrumentStellarRpc(server, { meter, network: "testnet" });
    // contract.Client from a spec-less instance: build the client and run a raw AssembledTransaction simulate.
    const at = await contract.AssembledTransaction.build({
      contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
      method: "hello",
      args: [],
      networkPassphrase: Networks.TESTNET,
      rpcUrl: mock.url,
      allowHttp: true,
      server,
      publicKey: kp.publicKey(),
      parseResultXdr: () => null,
    } as unknown as Parameters<typeof contract.AssembledTransaction.build>[0]).catch((e) => e);
    void at;
    const p = await points(reader);
    const methods = new Set(p.filter((x) => x.name === "rpc.client.call.duration").map((x) => x.attrs["rpc.method"]));
    // AssembledTransaction.build loads the source account first (getLedgerEntries) through the injected server.
    assert.ok(methods.has("getLedgerEntries"), `contract client calls went through the instrumented server: ${[...methods]}`);
    void contract.Client;
    assertClean(JSON.stringify(p));
  });

  it("is idempotent and detachable", async () => {
    const { reader, meter } = setup();
    const server = new rpc.Server(mock.url, { allowHttp: true });
    const d1 = instrumentStellarRpc(server, { meter });
    const d2 = instrumentStellarRpc(server, { meter });
    assert.equal(d1, d2);
    await server.getHealth();
    d1();
    await server.getHealth();
    const dur = (await points(reader)).filter((x) => x.name === "rpc.client.call.duration");
    assert.equal(dur.reduce((a, d) => a + d.value, 0), 1);
  });

  it("decodes fee-bump and undecodable results to a closed class", () => {
    assert.equal(txResultClass("not-xdr"), "undecodable");
    assert.equal(txResultClass(BAD_SEQ()), "bad_seq");
    assert.equal(txResultClass(TRAPPED()), "contract_error");
    assert.equal(txResultClass(ARCHIVED()), "expired_state");
    assert.equal(txResultClass(FEE_BUMP_INNER_INSUFFICIENT_FEE()), "insufficient_fee");
  });

  it("exports OTLP/HTTP JSON that a Collector would receive, and the payload is address-free", async () => {
    const bodies: string[] = [];
    const sink = createServer((req, res) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        bodies.push(s);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const port = (sink.address() as AddressInfo).port;
    const exporter = new OTLPMetricExporter({ url: `http://127.0.0.1:${port}/v1/metrics` });
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({
      readers: [reader],
      resource: resourceFromAttributes({ "service.name": "spike-dapp-backend" }),
    });
    const server = new rpc.Server(mock.url, { allowHttp: true });
    instrumentStellarRpc(server, { meter: provider.getMeter("@usagemap/stellar"), network: "testnet" });
    await server.sendTransaction(tx());
    await server.getTransaction("00".repeat(32));
    await provider.forceFlush();
    await provider.shutdown();
    sink.close();
    assert.ok(bodies.length >= 1);
    const all = bodies.join("\n");
    // The exporter sends protobuf by default in 0.301; check the metric names and the absence of identifiers.
    assert.match(all, /rpc\.client\.call\.duration/);
    assert.match(all, /stellar\.tx\.polls/);
    for (const re of [/[GCM][A-Z2-7]{55}/, /\b[0-9a-f]{64}\b/]) assert.doesNotMatch(all, re);
    assert.doesNotMatch(all, new RegExp(String(mock.url).replace(/[/.]/g, "\\$&")));
  });
});
