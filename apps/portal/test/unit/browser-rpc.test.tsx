// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// "RPC calls from your users' browsers (daily totals)" (tracker 1.2.0): every figure of the fixture on screen, the
// aggregate-only and not-page-views/not-API-usage statements, labels of methods, routes and outcomes, the empty state
// with the tracker snippet, and the whole-UTC-day window (at most 400 days) the panel asks for.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserRpcView,
  dayWindow,
  operationLabel,
  rpcOutcomeLabel,
} from "../../src/components/BrowserRpcPanel.tsx";
import { browserRpcFixture, emptyBrowserRpc } from "../fixtures/browser-rpc.ts";

afterEach(cleanup);
const range = { start: "2026-11-06T00:00:00Z", end: "2026-11-13T00:00:00Z" };

describe("BrowserRpcView", () => {
  it("shows totals, a daily chart, methods and routes with outcomes and latency", () => {
    render(<BrowserRpcView data={browserRpcFixture(range)} />);
    const totals = screen.getByTestId("browser-rpc-totals").textContent ?? "";
    expect(totals).toContain("1,500");
    expect(totals).toMatch(/Stellar RPC\s*1,200/);
    expect(totals).toMatch(/Horizon\s*300/);
    expect(totals).toContain("mainnet 1,300 · testnet 200");
    const methods = screen.getByTestId("browser-rpc-methods");
    const sim = within(methods).getByText("simulateTransaction").closest("tr") as HTMLElement;
    expect(sim.textContent).toContain("800");
    expect(sim.textContent).toContain("JSON-RPC error 20");
    expect(sim.textContent).toContain("100–500 ms 600");
    const send = within(methods).getByText("sendTransaction").closest("tr") as HTMLElement;
    expect(send.textContent).toContain("HTTP 429 (rate limited) 30");
    const routes = screen.getByTestId("browser-rpc-routes");
    expect(within(routes).getByText("/accounts/{id}")).toBeTruthy();
    expect(within(routes).getByText("/paths/strict-send")).toBeTruthy();
    expect(screen.getAllByText("Calls per day").length).toBeGreaterThan(0);
  });

  it("explains how to start when there is nothing", () => {
    render(<BrowserRpcView data={emptyBrowserRpc(range)} />);
    const empty = screen.getByTestId("browser-rpc-empty").textContent ?? "";
    expect(empty).toContain("@usagemap/tracker/stellar-rpc");
    expect(empty).toContain("attachRpcTelemetry(rpcServer");
    expect(empty).toMatch(/No URL .* address, page or visitor is ever\s+sent/);
  });
});

describe("labels", () => {
  it("RPC methods in camel case, Horizon route templates, other", () => {
    expect(operationLabel("rpc", "get_latest_ledger")).toBe("getLatestLedger");
    expect(operationLabel("rpc", "other")).toBe("other methods");
    expect(operationLabel("horizon", "root")).toBe("/");
    expect(operationLabel("horizon", "accounts_id_data_key")).toBe("/accounts/{id}/data/{key}");
    expect(operationLabel("horizon", "claimable_balances_id_operations")).toBe(
      "/claimable_balances/{id}/operations",
    );
    expect(operationLabel("horizon", "liquidity_pools_id_trades")).toBe(
      "/liquidity_pools/{id}/trades",
    );
    expect(operationLabel("horizon", "paths_strict_receive")).toBe("/paths/strict-receive");
    expect(operationLabel("horizon", "fee_stats")).toBe("/fee_stats");
    expect(operationLabel("horizon", "transactions_async")).toBe("/transactions_async");
    expect(operationLabel("horizon", "other")).toBe("other routes");
  });

  it("outcomes in plain language", () => {
    expect(rpcOutcomeLabel("network_error")).toBe("network error");
    expect(rpcOutcomeLabel("http_5xx")).toBe("HTTP 5xx");
  });
});

describe("dayWindow", () => {
  it("covers the whole UTC days around the dashboard range", () => {
    expect(dayWindow("2026-10-14T00:00:00Z", "2026-11-12T13:20:00Z")).toEqual({
      start: "2026-10-14T00:00:00Z",
      end: "2026-11-13T00:00:00Z",
      clipped: false,
    });
    expect(dayWindow("2026-11-12T13:00:00Z", "2026-11-12T14:00:00Z")).toEqual({
      start: "2026-11-12T00:00:00Z",
      end: "2026-11-13T00:00:00Z",
      clipped: false,
    });
  });

  it("keeps at most 400 days, ending at the range's end", () => {
    expect(dayWindow("2020-01-01T00:00:00Z", "2026-11-13T00:00:00Z")).toEqual({
      start: "2025-10-09T00:00:00Z",
      end: "2026-11-13T00:00:00Z",
      clipped: true,
    });
  });
});
