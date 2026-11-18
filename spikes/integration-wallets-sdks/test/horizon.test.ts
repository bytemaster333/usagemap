// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { horizonRoute } from "../src/classify.ts";
import { instrumentHorizon } from "../src/instrument-horizon.ts";
import { assertClean, points, setup } from "./helpers.ts";
import { type Mock, startMock } from "./mock-rpc.ts";

const G = Keypair.random().publicKey();
let mock: Mock;
before(async () => {
  mock = await startMock(
    () => ({}),
    (path, method) => {
      if (method === "POST" && path.startsWith("/transactions"))
        return { status: 400, json: { type: "tx_failed", extras: { result_codes: { transaction: "tx_bad_seq" } } } };
      if (path.startsWith("/accounts/") && path.includes("/payments"))
        return { status: 200, json: { _embedded: { records: [] }, _links: {} } };
      if (path.startsWith("/fee_stats")) return { status: 200, json: { last_ledger: "1" } };
      return { status: 404, json: { type: "not_found" } };
    },
  );
});
after(() => mock.close());

describe("instrumentHorizon (js-stellar-sdk 17.4.0 Horizon.Server)", () => {
  it("templates routes; ids, account ids and query strings never appear", async () => {
    const { reader, meter } = setup();
    const server = new Horizon.Server(mock.url, { allowHttp: true });
    instrumentHorizon(server as never, { meter, network: "testnet" });
    await server.feeStats();
    await server.payments().forAccount(G).cursor("now").limit(5).call();
    await server.loadAccount(G).catch(() => undefined); // 404
    await server.httpClient.post(`${mock.url}transactions`, "tx=AAAA").catch(() => undefined);
    const p = await points(reader);
    const routes = p
      .filter((x) => x.name === "http.client.request.duration")
      .map((x) => `${x.attrs["http.request.method"]} ${x.attrs["url.template"]} ${x.attrs["http.response.status_code"]}`)
      .sort();
    assert.deepEqual(routes, [
      "GET /accounts/{id} 404",
      "GET /accounts/{id}/payments 200",
      "GET /fee_stats 200",
      "POST /transactions 400",
    ]);
    const sub = p.find((x) => x.name === "stellar.tx.submissions");
    assert.equal(sub?.attrs["stellar.tx.result_class"], "bad_seq");
    assertClean(JSON.stringify(p));
    assert.ok(!JSON.stringify(p).includes(G));
  });

  it("route templater: closed output", () => {
    assert.equal(horizonRoute(`https://h/accounts/${G}/transactions?cursor=1`), "/accounts/{id}/transactions");
    assert.equal(horizonRoute("https://h/transactions/" + "ab".repeat(32)), "/transactions/{id}");
    assert.equal(horizonRoute("https://h/paths/strict-send?x=1"), "/paths/strict-send");
    assert.equal(horizonRoute("https://h/admin/secret"), "_OTHER");
    assert.equal(horizonRoute("https://h/accounts/x/y/z"), "_OTHER");
    assert.equal(horizonRoute("https://h/"), "/");
  });
});
