// SPDX-License-Identifier: Apache-2.0
// `/stellar-rpc`: browser-side RPC/Horizon telemetry, aggregate only (§a.3.2). Against a mock of js-stellar-sdk's
// HttpClient with the public interceptor API (axios shape: `interceptors.request/response.use/eject`), carrying
// canary URLs (an API key in the path), params, hashes and XDR that must never leave the browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachHorizonTelemetry,
  attachRpcTelemetry,
  countCall,
  flushRpcTelemetry,
  HORIZON_TEMPLATES,
  horizonOperation,
  latency,
  MAX_CELLS,
  rpcTelemetryCells,
  templateOperation,
} from "../src/stellar-rpc.ts";
import { sentEvents, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";
import { assertNoCanary, CANARY } from "./stellar-helpers.ts";
import { TESTNET } from "./wallet-mocks.ts";

const ctx = trackerHarness();

type Handler = [(v: unknown) => unknown, ((e: unknown) => unknown) | undefined];
interface Answer {
  status?: number;
  data?: unknown;
  error?: { code?: string; name?: string };
  ms?: number;
}

/** js-stellar-sdk HttpClient stand-in: request interceptors, a scripted transport, response interceptors. */
function makeClient() {
  const req = new Map<number, Handler>();
  const res = new Map<number, Handler>();
  let id = 0;
  const mgr = (m: Map<number, Handler>) => ({
    use(f: (v: unknown) => unknown, r?: (e: unknown) => unknown) {
      m.set(++id, [f, r]);
      return id;
    },
    eject(i: number) {
      m.delete(i);
    },
  });
  const client = {
    interceptors: { request: mgr(req), response: mgr(res) },
    answer: (_c: Record<string, unknown>): Answer => ({ status: 200, data: {} }),
    async send(config: Record<string, unknown>) {
      let c: unknown = config;
      for (const [f] of req.values()) c = await f(c);
      const a = client.answer(c as Record<string, unknown>);
      if (a.ms) vi.advanceTimersByTime?.(a.ms);
      if (a.error || (a.status ?? 200) >= 400) {
        let err: unknown = Object.assign(new Error(CANARY.MESSAGE), {
          config: c,
          ...(a.error ?? {}),
          ...(a.status && { response: { status: a.status, data: { detail: CANARY.MESSAGE } } }),
        });
        for (const [, r] of res.values()) {
          try {
            await r?.(err);
          } catch (e) {
            err = e;
          }
        }
        throw err;
      }
      let r: unknown = { status: a.status ?? 200, data: a.data, config: c };
      for (const [f] of res.values()) r = await f(r);
      return r;
    },
    rpc(method: string, params: unknown = {}) {
      return client.send({
        method: "post",
        url: `https://rpc.example/${CANARY.HASH}/`,
        data: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    },
    get(url: string) {
      return client.send({ method: "get", url });
    },
    handlers: () => req.size + res.size,
  };
  return client;
}

beforeEach(() => {
  flushRpcTelemetry(); // nothing left from another test
});
afterEach(() => vi.useRealTimers());

async function aggregates(gw: typeof ctx.gw, n = 1) {
  await until(() => sentEvents(gw).filter((e) => e.n === "stellar_rpc").length >= n);
  return sentEvents(gw).filter((e) => e.n === "stellar_rpc");
}

describe("operation and bucket vocabularies", () => {
  it("Horizon templates map to snake-case operations of at most 40 characters", () => {
    const ops = HORIZON_TEMPLATES.map(templateOperation);
    expect(new Set(ops).size).toBe(HORIZON_TEMPLATES.length);
    for (const o of ops) expect(o).toMatch(/^[a-z0-9_]{1,40}$/);
    expect(templateOperation("/")).toBe("root");
    expect(templateOperation("/accounts/{id}/data/{key}")).toBe("accounts_id_data_key");
    expect(templateOperation("/paths/strict-receive")).toBe("paths_strict_receive");
  });

  it.each([
    [
      `https://h.example/${CANARY.HASH}/accounts/${CANARY.G}/payments?cursor=1`,
      "accounts_id_payments",
    ],
    ["https://h.example/", "root"],
    [`https://h.example/transactions/${CANARY.HASH}`, "transactions_id"],
    ["https://h.example/paths/strict-send?x=1", "paths_strict_send"],
    ["https://h.example/accounts/x/data/secret-key", "accounts_id_data_key"],
    ["https://h.example/nope/thing", "other"],
  ])("%s → %s (a base-path prefix such as an API key is skipped)", (u, op) => {
    expect(horizonOperation(u)).toBe(op);
  });

  it.each([
    [0, "lt100ms"],
    [99, "lt100ms"],
    [100, "100_500ms"],
    [499, "100_500ms"],
    [500, "500_2000ms"],
    [2000, "gt2000ms"],
  ])("%d ms → %s", (ms, b) => {
    expect(latency(ms)).toBe(b);
  });
});

describe("RPC", () => {
  it("counts per method, network and outcome; flushes ONE aggregate without address, hash, URL or params", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { gw } = ctx;
    ctx.start();
    const c = makeClient();
    const t = attachRpcTelemetry({ httpClient: c });
    expect(t.attached).toBe(true);
    expect(attachRpcTelemetry({ httpClient: c })).toBe(t); // idempotent per client
    c.answer = (cfg) => {
      const m = JSON.parse(String(cfg.data)).method;
      if (m === "getNetwork") return { data: { result: { passphrase: TESTNET } } };
      if (m === "sendTransaction")
        return { data: { error: { code: -32602, message: CANARY.MESSAGE } } };
      if (m === "simulateTransaction") return { status: 503 };
      if (m === "getLedgerEntries") return { error: { code: "ECONNABORTED" } };
      if (m === "getEvents") return { error: { name: "TypeError" } };
      return { data: { result: { hash: CANARY.HASH, xdr: CANARY.XDR } }, ms: 150 };
    };
    await c.rpc("getNetwork");
    await c.rpc("getLatestLedger");
    await c.rpc("getLatestLedger");
    await c.rpc("getTransaction", { hash: CANARY.HASH });
    await c.rpc("sendTransaction", { transaction: CANARY.XDR });
    await c.rpc("simulateTransaction", { transaction: CANARY.XDR }).catch(() => {});
    await c.rpc("getLedgerEntries", { keys: [CANARY.XDR] }).catch(() => {});
    await c.rpc("getEvents").catch(() => {});
    await c.rpc("someNewMethod");
    expect(rpcTelemetryCells()).toEqual([
      ["rpc", "get_events", "testnet", "network_error", "lt100ms", 1],
      ["rpc", "get_latest_ledger", "testnet", "ok", "100_500ms", 2],
      ["rpc", "get_ledger_entries", "testnet", "timeout", "lt100ms", 1],
      ["rpc", "get_network", "unknown", "ok", "lt100ms", 1],
      ["rpc", "get_transaction", "testnet", "ok", "100_500ms", 1],
      ["rpc", "other", "testnet", "ok", "100_500ms", 1],
      ["rpc", "send_transaction", "testnet", "rpc_error", "lt100ms", 1],
      ["rpc", "simulate_transaction", "testnet", "http_5xx", "lt100ms", 1],
    ]);
    t.detach();
    expect(c.handlers()).toBe(0);
    await c.rpc("getLatestLedger"); // detached: not counted
    expect(flushRpcTelemetry()).toBe(true);
    expect(rpcTelemetryCells()).toEqual([]);
    const [ag, ...more] = await aggregates(gw);
    expect(more).toEqual([]);
    expect(ag).toMatchObject({ k: "wl", sv: 1, n: "stellar_rpc" });
    expect(Object.keys(ag as object).sort()).toEqual(["c", "id", "k", "n", "sv", "u"]);
    expect((ag as { c: unknown[] }).c).toHaveLength(8);
    assertNoCanary(gw);
    expect(flushRpcTelemetry()).toBe(false); // nothing held: nothing sent
  });

  it("a fixed network option; SDK 13.x–14.3.0 namespace; anything without interceptors is untouched", () => {
    const c = makeClient();
    expect(attachRpcTelemetry({ AxiosClient: c }, { network: "mainnet" }).attached).toBe(true);
    expect(attachRpcTelemetry({} as never).attached).toBe(false);
    expect(attachRpcTelemetry({ httpClient: {} }).attached).toBe(false);
    expect(attachRpcTelemetry(null as never).attached).toBe(false);
  });

  it("is sent when the page is hidden; nothing while tracking is blocked (opt-out)", async () => {
    const { gw } = ctx;
    const tr = ctx.start();
    const c = makeClient();
    attachRpcTelemetry({ httpClient: c }, { network: "testnet" });
    await c.rpc("getHealth");
    dispatchEvent(new Event("pagehide"));
    expect(await aggregates(gw)).toHaveLength(1);
    tr.optOut();
    await c.rpc("getHealth");
    dispatchEvent(new Event("pagehide"));
    expect(rpcTelemetryCells()).toEqual([]); // cleared, never kept for later
    expect(sentEvents(gw).filter((e) => e.n === "stellar_rpc")).toHaveLength(1);
  });
});

describe("Horizon", () => {
  it("route templates, HTTP classes and timeouts; the key in the base path never leaves", async () => {
    const { gw } = ctx;
    ctx.start();
    const c = makeClient();
    attachHorizonTelemetry({ httpClient: c }, { network: "mainnet" });
    const base = `https://horizon.example/${CANARY.HASH}`;
    c.answer = (cfg) => {
      const u = String(cfg.url);
      if (u.includes("offers")) return { status: 404 };
      if (u.includes("trades")) return { status: 429 };
      if (u.includes("ledgers")) return { error: { name: "TimeoutError" } };
      return { status: 200, data: { id: CANARY.G } };
    };
    await c.get(`${base}/accounts/${CANARY.G}`);
    await c.get(`${base}/accounts/${CANARY.G}/payments?cursor=${CANARY.HASH}`);
    await c.get(`${base}/offers/123`).catch(() => {});
    await c.get(`${base}/trades`).catch(() => {});
    await c.get(`${base}/ledgers/1`).catch(() => {});
    expect(rpcTelemetryCells()).toEqual([
      ["horizon", "accounts_id_payments", "mainnet", "ok", "lt100ms", 1],
      ["horizon", "accounts_id", "mainnet", "ok", "lt100ms", 1],
      ["horizon", "ledgers_id", "mainnet", "timeout", "lt100ms", 1],
      ["horizon", "offers_id", "mainnet", "http_4xx", "lt100ms", 1],
      ["horizon", "trades", "mainnet", "http_429", "lt100ms", 1],
    ]);
    flushRpcTelemetry();
    await aggregates(gw);
    assertNoCanary(gw);
  });
});

describe("bounds", () => {
  it(`at most ${MAX_CELLS} cells: once the named ones are near the cap, new operations fold into \`other\``, async () => {
    const { gw } = ctx;
    ctx.start();
    for (let i = 0; i < MAX_CELLS + 20; i++) countCall("rpc", `op_${i}`, "testnet", "ok", 1);
    countCall("rpc", "op_0", "testnet", "ok", 1);
    countCall("rpc", "op_new", "mainnet", "ok", 1);
    let cells = rpcTelemetryCells();
    expect(cells).toHaveLength(92); // 90 named + `other` on testnet + `other` on mainnet
    expect(cells.find((x) => x[1] === "op_0")?.[5]).toBe(2);
    expect(cells.find((x) => x[1] === "other" && x[2] === "testnet")?.[5]).toBe(30);
    expect(cells.find((x) => x[1] === "other" && x[2] === "mainnet")?.[5]).toBe(1);
    // every further `other` combination until the hard cap, then calls that fit no cell are not counted
    for (const o of [
      "rpc_error",
      "http_4xx",
      "http_429",
      "http_5xx",
      "timeout",
      "network_error",
    ] as const)
      for (const ms of [1, 200, 900, 3000]) countCall("rpc", "op_x", "local", o, ms);
    cells = rpcTelemetryCells();
    expect(cells).toHaveLength(MAX_CELLS);
    flushRpcTelemetry();
    const [ag] = await aggregates(gw);
    expect(gw.requests.at(-1)?.raw.length).toBeLessThan(8192);
    expect((ag as { c: unknown[] }).c).toHaveLength(MAX_CELLS);
    expect(gw.schemaErrors).toEqual([]);
  });

  it("a new UTC day flushes the previous day's cells first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T23:59:59Z"));
    const { gw } = ctx;
    ctx.start();
    countCall("horizon", "root", "testnet", "ok", 1);
    vi.setSystemTime(new Date("2026-11-20T00:00:01Z"));
    countCall("horizon", "root", "testnet", "ok", 1);
    expect(rpcTelemetryCells()).toEqual([["horizon", "root", "testnet", "ok", "lt100ms", 1]]);
    vi.useRealTimers();
    flushRpcTelemetry();
    expect(await aggregates(gw, 2)).toHaveLength(2);
  });
});
