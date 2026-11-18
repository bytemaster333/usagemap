// SPDX-License-Identifier: Apache-2.0
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { instrumentHorizon } from "../src/index.ts";
import { assertClean, assertKeys, points, setup } from "./helpers.ts";
import { BAD_SEQ, type Mock, startMock } from "./mock-rpc.ts";
import {
  detachAll,
  EXPECTED_VERSION,
  horizonClient,
  instrumentHz,
  MODULE_SCOPE,
  sdk,
} from "./sdk.ts";

const G = Keypair.random().publicKey();
let mock: Mock;
let asyncAnswer: { status: number; json: unknown } = {
  status: 201,
  json: { tx_status: "PENDING", hash: "ab".repeat(32) },
};
beforeAll(async () => {
  mock = await startMock(
    () => undefined,
    (path, method) => {
      const p = path.replace(/^\/apikey-SECRET/, "");
      if (method === "POST" && p.startsWith("/transactions_async")) return asyncAnswer;
      if (method === "POST" && p.startsWith("/transactions"))
        return {
          status: 400,
          json: { type: "tx_failed", extras: { result_codes: { transaction: "tx_bad_seq" } } },
        };
      if (p.startsWith("/accounts/") && p.includes("/payments"))
        return { status: 200, json: { _embedded: { records: [] }, _links: {} } };
      if (p.startsWith("/fee_stats")) return { status: 200, json: { last_ledger: "1" } };
      return { status: 404, json: { type: "not_found", status: 404 } };
    },
    "/rpc-unused",
  );
});
afterAll(() => mock.close());
afterEach(detachAll);

describe(`instrumentHorizon (js-stellar-sdk ${EXPECTED_VERSION ?? "17"} Horizon.Server)`, () => {
  it("hooks the client of this major (per server, or module-wide on 13.x to 14.3.0)", async () => {
    const { reader, meter } = setup();
    const server = new Horizon.Server(mock.url.replace("/rpc-unused", ""), { allowHttp: true });
    const h = instrumentHz(server, { meter });
    expect(h).toMatchObject({ instrumented: true, scope: MODULE_SCOPE ? "module" : "server" });
    mock.clientVersions.clear();
    await server.feeStats();
    if (EXPECTED_VERSION) expect([...mock.clientVersions]).toEqual([EXPECTED_VERSION]);
    expect((await points(reader)).length).toBe(1);
    if (MODULE_SCOPE) expect(instrumentHorizon(server as never).instrumented).toBe(false);
    else expect(instrumentHorizon(sdk.Horizon as never).instrumented).toBe(false);
  });

  it("templates routes; ids, account ids, base-path keys and query strings never appear", async () => {
    const { reader, meter } = setup();
    const base = `${mock.url.replace("/rpc-unused", "")}/apikey-SECRET`;
    const server = new Horizon.Server(base, { allowHttp: true });
    expect(instrumentHz(server, { meter, network: "testnet" }).instrumented).toBe(true);
    await server.feeStats();
    await server.payments().forAccount(G).cursor("now").limit(5).call();
    await server.loadAccount(G).catch(() => undefined); // 404
    await horizonClient(server)
      .post(`${base}/transactions`, "tx=AAAA")
      .catch(() => undefined);
    const p = await points(reader);
    assertKeys(p);
    const routes = p
      .filter((x) => x.name === "http.client.request.duration")
      .map(
        (x) =>
          `${x.attrs["http.request.method"]} ${x.attrs["url.template"]} ${x.attrs["http.response.status_code"]} ${x.attrs["error.type"] ?? "-"}`,
      )
      .sort();
    expect(routes).toEqual([
      "GET /accounts/{id} 404 404",
      "GET /accounts/{id}/payments 200 -",
      "GET /fee_stats 200 -",
      "POST /transactions 400 400",
    ]);
    expect(p.find((x) => x.name === "stellar.tx.submissions")?.attrs).toEqual({
      "stellar.tx.via": "horizon",
      "stellar.tx.status": "FAILED",
      "stellar.tx.result_class": "bad_seq",
      "stellar.network": "testnet",
    });
    assertClean(JSON.stringify(p));
    expect(JSON.stringify(p)).not.toContain(G);
  });

  it("classifies /transactions_async statuses, with the error result XDR decoded", async () => {
    const { reader, meter } = setup();
    const server = new Horizon.Server(mock.url.replace("/rpc-unused", ""), { allowHttp: true });
    instrumentHz(server, { meter, network: "Test SDF Network ; September 2015" });
    const post = () =>
      horizonClient(server)
        .post(`${mock.url.replace("/rpc-unused", "")}/transactions_async`, "tx=AAAA")
        .catch(() => undefined);
    asyncAnswer = { status: 201, json: { tx_status: "PENDING" } };
    await post();
    asyncAnswer = { status: 400, json: { tx_status: "ERROR", errorResultXdr: BAD_SEQ() } };
    await post();
    asyncAnswer = { status: 503, json: { tx_status: "TRY_AGAIN_LATER" } };
    await post();
    const sub = (await points(reader))
      .filter((x) => x.name === "stellar.tx.submissions")
      .map(
        (x) =>
          `${x.attrs["stellar.tx.status"]}/${x.attrs["stellar.tx.result_class"] ?? "-"}/${x.attrs["stellar.network"]}`,
      )
      .sort();
    expect(sub).toEqual([
      "ERROR/bad_seq/testnet",
      "PENDING/-/testnet",
      "TRY_AGAIN_LATER/-/testnet",
    ]);
  });

  it("is idempotent, detachable, and inert on objects without interceptors", async () => {
    const { reader, meter } = setup();
    const server = new Horizon.Server(mock.url.replace("/rpc-unused", ""), { allowHttp: true });
    const h = instrumentHz(server, { meter });
    expect(instrumentHz(server, { meter })).toBe(h);
    await server.feeStats();
    h.detach();
    await server.feeStats();
    const p = await points(reader);
    expect(
      p
        .filter((x) => x.name === "http.client.request.duration")
        .map((x) => [x.attrs["stellar.network"], x.value]),
    ).toEqual([["unknown", 1]]);
    expect(instrumentHorizon({ httpClient: {} } as never).instrumented).toBe(false);
  });
});
