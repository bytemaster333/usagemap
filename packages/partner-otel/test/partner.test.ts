// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import axios from "axios";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  classifyUrl,
  instrumentPartnerAxios,
  METRIC_PARTNER_DURATION,
  NETWORKS,
  OUTCOMES,
  operationOf,
  outcomeOfError,
  outcomeOfStatus,
  PARTNER_IDS,
  PARTNERS,
  partnerFetch,
  partnerOfHost,
  recordPartnerCall,
} from "../src/index.ts";

const ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const KEY = "sk_live_0123456789abcdef";
const AMOUNT = "123456789";

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let provider: MeterProvider;
const meter = () => provider.getMeter("t");

beforeEach(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  provider = new MeterProvider({ readers: [reader] });
});

async function points(): Promise<Array<{ attributes: Record<string, unknown>; count: number }>> {
  await reader.forceFlush();
  const out: Array<{ attributes: Record<string, unknown>; count: number }> = [];
  for (const rm of exporter.getMetrics())
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics) {
        expect(m.descriptor.name).toBe(METRIC_PARTNER_DURATION);
        expect(m.descriptor.unit).toBe("s");
        for (const dp of m.dataPoints)
          out.push({ attributes: dp.attributes, count: (dp.value as { count: number }).count });
      }
  exporter.reset();
  const key = (a: Record<string, unknown>) => JSON.stringify(Object.entries(a).sort());
  return out.sort((a, b) => (key(a.attributes) < key(b.attributes) ? -1 : 1));
}

// A local server stands in for the partner APIs: the fake fetch rewrites the partner host to it, so the real
// partner URL (host, path, query) is what the instrumentation classifies.
let srv: Server;
let base: string;
beforeAll(async () => {
  srv = createServer((req, res) => {
    const p = req.url ?? "/";
    const status = p.includes("/missing")
      ? 404
      : p.includes("/limited")
        ? 429
        : p.includes("/down")
          ? 503
          : 200;
    if (p.includes("/hang")) return; // never answers
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status === 200, account: ACCOUNT, amount: AMOUNT }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => {
  srv.closeAllConnections();
  srv.close();
});
const toLocal: typeof fetch = (input, init) => {
  const u = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  return fetch(`${base}${u.pathname}${u.search}`, init);
};

describe("classification", () => {
  it("maps exact hosts, environment and templates", () => {
    expect(
      classifyUrl(`https://api.soroswap.finance/quote?network=testnet&amount=${AMOUNT}`),
    ).toEqual({
      partner: "soroswap",
      operation: "/quote",
      network: "testnet",
    });
    expect(classifyUrl("https://API.DEFINDEX.IO:443/vault/CABC/deposit?network=mainnet")).toEqual({
      partner: "defindex",
      operation: "/vault/{id}/deposit",
      network: "mainnet",
    });
    expect(classifyUrl("https://api.defindex.io/vault/CABC")?.network).toBe("unknown"); // no network parameter
    expect(
      classifyUrl("https://dev.api.trustlesswork.com/escrow/multi-release/fund-escrow"),
    ).toEqual({
      partner: "trustless_work",
      operation: "/escrow/{type}/fund-escrow",
      network: "testnet",
    });
    expect(
      classifyUrl(`https://api.blindpay.com/v1/instances/in_1/payouts/stellar`)?.operation,
    ).toBe("/payouts/stellar");
    expect(classifyUrl(`https://api.blindpay.com/v1/instances/in_1/payouts/po_9`)?.operation).toBe(
      "/payouts/{id}",
    );
    expect(classifyUrl("https://api.sandbox.bridge.xyz/v0/customers/tos_links")).toEqual({
      partner: "bridge",
      operation: "/customers/tos_links",
      network: "testnet",
    });
    expect(classifyUrl(`https://api.core.allbridge.io/check/SRB/${ACCOUNT}`)?.operation).toBe(
      "/check/{id}/{id}",
    );
    expect(
      classifyUrl("https://api-sandbox.koywe.com/api/v1/organizations/o1/merchants/m1/quotes")
        ?.operation,
    ).toBe("/organizations/{id}/merchants/{id}/quotes");
    expect(classifyUrl("https://amm-api.aqua.network/api/external/v2/find-path/")?.operation).toBe(
      "/find-path",
    );
    expect(classifyUrl("https://api.sodax.com/v1/intent/user/0xabc")?.operation).toBe(
      "/intent/user/{id}",
    );
  });

  it("never measures other hosts, look-alikes or bad URLs", () => {
    for (const u of [
      "https://soroswap.finance/quote",
      "https://api.soroswap.finance.evil.example/quote",
      "https://evil.example/api.soroswap.finance/quote",
      "https://horizon.stellar.org/accounts",
      "not a url",
    ])
      expect(classifyUrl(u)).toBeUndefined();
  });

  it("unknown routes and a key in the path become _OTHER", () => {
    expect(operationOf("soroswap", `/${KEY}/not-a-route`)).toBe("_OTHER");
    expect(operationOf("soroswap", `/${KEY}/quote/build`)).toBe("/quote/build"); // the prefix is skipped
    expect(operationOf("soroswap", "/")).toBe("_OTHER");
    expect(operationOf("soroswap", `/${"a/".repeat(20)}quote`)).toBe("_OTHER");
  });

  it("forced partner and network", () => {
    expect(
      classifyUrl("https://partners.my-app.example/soroswap/quote", {
        partner: "soroswap",
        network: "Public Global Stellar Network ; September 2015",
      }),
    ).toEqual({ partner: "soroswap", operation: "/quote", network: "mainnet" });
    expect(
      classifyUrl("https://api.soroswap.finance/quote", { partner: "not-a-partner" }),
    ).toBeUndefined();
  });

  it("outcome classes", () => {
    expect(
      [200, 302, 401, 403, 404, 409, 429, 500, 503, 99, 600, 1.5].map(outcomeOfStatus),
    ).toEqual([
      "success",
      "success",
      "auth_error",
      "auth_error",
      "not_found",
      "client_error",
      "rate_limited",
      "server_error",
      "server_error",
      "_OTHER",
      "_OTHER",
      "_OTHER",
    ]);
    expect(outcomeOfError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(outcomeOfError({ code: "ECONNABORTED" })).toBe("timeout");
    expect(
      outcomeOfError(new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })),
    ).toBe("timeout");
    expect(outcomeOfError(new TypeError("fetch failed"))).toBe("network");
  });

  it("the table is well formed: snake_case ids, lowercase hosts, templates the Collector and storage accept", () => {
    const hosts = new Set<string>();
    for (const id of PARTNER_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      const p = PARTNERS[id];
      for (const [h, env] of Object.entries(p.hosts)) {
        expect(h).toMatch(/^[a-z0-9.-]+$/);
        expect(["mainnet", "testnet", "query", "unknown"]).toContain(env);
        expect(hosts.has(h)).toBe(false);
        hosts.add(h);
        expect(partnerOfHost(h)).toBe(id);
      }
      expect(new Set(p.operations).size).toBe(p.operations.length);
      for (const t of p.operations) {
        expect(t).toMatch(/^(\/([a-zA-Z0-9_.-]+|\{id\}|\{type\}))+$/); // storage: ^[A-Za-z0-9_./{}-]{1,64}$
        expect(t.length).toBeLessThanOrEqual(64);
        expect(t.split("/")[1]).not.toMatch(/^\{/); // a leading placeholder would swallow any prefix
        expect(operationOf(id, t)).toBe(t); // every template classifies to itself
      }
    }
    expect([...OUTCOMES, ...NETWORKS].every((v) => /^[a-z_]+$/.test(v))).toBe(true);
  });
});

describe("partnerFetch", () => {
  it("records partner calls with closed attributes and passes the response through", async () => {
    const f = partnerFetch(toLocal, { meter: meter() });
    const r = await f(`https://api.soroswap.finance/quote?network=testnet&apikey=${KEY}`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ amount: AMOUNT, to: ACCOUNT }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { account: string }).account).toBe(ACCOUNT);
    await f(new URL("https://api.bridge.xyz/v0/customers/cus_1/missing"));
    await f(new Request("https://api.bridge.xyz/v0/transfers/limited"));
    await f("https://api.sandbox.bridge.xyz/v0/transfers/tr_1");
    const pts = await points();
    expect(pts).toEqual([
      {
        attributes: {
          "stellar.partner": "bridge",
          "stellar.partner.operation": "/transfers/{id}",
          "stellar.partner.outcome": "rate_limited",
          "stellar.network": "mainnet",
        },
        count: 1,
      },
      {
        attributes: {
          "stellar.partner": "bridge",
          "stellar.partner.operation": "_OTHER",
          "stellar.partner.outcome": "not_found",
          "stellar.network": "mainnet",
        },
        count: 1,
      },
      {
        attributes: {
          "stellar.partner": "bridge",
          "stellar.partner.operation": "/transfers/{id}",
          "stellar.partner.outcome": "success",
          "stellar.network": "testnet",
        },
        count: 1,
      },
      {
        attributes: {
          "stellar.partner": "soroswap",
          "stellar.partner.operation": "/quote",
          "stellar.partner.outcome": "success",
          "stellar.network": "testnet",
        },
        count: 1,
      },
    ]);
    const all = JSON.stringify(pts);
    for (const leak of [KEY, ACCOUNT, AMOUNT, "cus_1", "tr_1", "127.0.0.1", "apikey"])
      expect(all).not.toContain(leak);
  });

  it("leaves other hosts untouched and unmeasured", async () => {
    const f = partnerFetch(toLocal, { meter: meter() });
    expect((await f("https://horizon.example/accounts")).status).toBe(200);
    expect(await points()).toEqual([]);
  });

  it("records transport failures and rethrows them unchanged", async () => {
    const f = partnerFetch(toLocal, { meter: meter() });
    await expect(
      f("https://api.koywe.com/api/v1/orders/hang", { signal: AbortSignal.timeout(100) }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    const refused = partnerFetch(
      (input, init) => fetch(`http://127.0.0.1:9${new URL(String(input)).pathname}`, init),
      { meter: meter() },
    );
    await expect(refused("https://api.koywe.com/api/v1/orders")).rejects.toThrow();
    expect((await points()).map((p) => p.attributes["stellar.partner.outcome"])).toEqual([
      "network",
      "timeout",
    ]);
  });

  it("a broken meter never breaks the call", async () => {
    const broken = {
      createHistogram: () => ({
        record() {
          throw new Error("meter broken");
        },
      }),
    } as unknown as ReturnType<typeof meter>;
    const f = partnerFetch(toLocal, { meter: broken });
    expect((await f("https://api.soroswap.finance/quote")).status).toBe(200);
  });
});

describe("instrumentPartnerAxios", () => {
  it("measures through the public interceptors, with baseURL, and detaches", async () => {
    const ax = axios.create({ baseURL: "https://api.etherfuse.com" });
    // Route the partner host to the local server without changing what the interceptor sees.
    ax.interceptors.request.use((c) => c); // an app interceptor of its own
    const h = instrumentPartnerAxios(ax, { meter: meter() });
    expect(h.instrumented).toBe(true);
    expect(instrumentPartnerAxios(ax, { meter: meter() })).toBe(h); // idempotent
    ax.defaults.adapter = async (config) => {
      const u = new URL(String(config.url), "https://x.invalid");
      const r = await fetch(`${base}${u.pathname}`);
      const data = await r.text();
      const resp = { data, status: r.status, statusText: "", headers: {}, config, request: {} };
      if (r.status >= 400)
        throw new axios.AxiosError("failed", "ERR_BAD_RESPONSE", config, {}, resp as never);
      return resp;
    };
    await ax.get(`/organization/org_1/order/ord_9?wallet=${ACCOUNT}`);
    await expect(ax.post("/organization/org_1/quote/down", { amount: AMOUNT })).rejects.toThrow();
    const failing = axios.create({ baseURL: "https://api.etherfuse.com", timeout: 50 });
    instrumentPartnerAxios(failing, { meter: meter() });
    failing.defaults.adapter = async (config) => {
      throw new axios.AxiosError("timeout", "ECONNABORTED", config);
    };
    await expect(failing.get("/me")).rejects.toThrow();
    const pts = await points();
    expect(pts.map((p) => p.attributes)).toEqual([
      {
        "stellar.partner": "etherfuse",
        "stellar.partner.operation": "/me",
        "stellar.partner.outcome": "timeout",
        "stellar.network": "mainnet",
      },
      {
        "stellar.partner": "etherfuse",
        "stellar.partner.operation": "/organization/{id}/order/{id}",
        "stellar.partner.outcome": "success",
        "stellar.network": "mainnet",
      },
      {
        "stellar.partner": "etherfuse",
        "stellar.partner.operation": "_OTHER",
        "stellar.partner.outcome": "server_error",
        "stellar.network": "mainnet",
      },
    ]);
    expect(JSON.stringify(pts)).not.toContain(ACCOUNT);
    h.detach();
    h.detach();
    await ax.get("/me");
    // Cumulative export: the three earlier series again, unchanged, and no new one.
    expect((await points()).map((p) => p.count)).toEqual([1, 1, 1]);
  });

  it("refuses non-axios objects", () => {
    expect(instrumentPartnerAxios({} as never).instrumented).toBe(false);
  });
});

describe("recordPartnerCall", () => {
  it("records a call measured elsewhere", async () => {
    expect(
      recordPartnerCall(
        { url: "https://api.abroad.finance/transaction/tx_1", durationSeconds: 0.2, status: 201 },
        { meter: meter() },
      ),
    ).toBe(true);
    expect(
      recordPartnerCall(
        { url: "https://example.com/x", durationSeconds: 0.2, status: 200 },
        { meter: meter() },
      ),
    ).toBe(false);
    expect(
      recordPartnerCall(
        { url: "https://api.abroad.finance/kyc", durationSeconds: Number.NaN, status: 200 },
        { meter: meter() },
      ),
    ).toBe(false);
    expect((await points()).map((p) => p.attributes)).toEqual([
      {
        "stellar.partner": "abroad",
        "stellar.partner.operation": "/transaction/{id}",
        "stellar.partner.outcome": "success",
        "stellar.network": "mainnet",
      },
    ]);
  });
});
