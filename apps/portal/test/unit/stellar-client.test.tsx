// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// "Stellar RPC & Horizon (from your backend)" (C-153): every figure of the fixture on screen, outcome labels, the
// not-API-usage statement and the empty state with the instrumentation snippet.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { outcomeLabel, StellarClientView } from "../../src/components/StellarClientPanel.tsx";
import { emptyStellarClient, stellarClientFixture } from "../fixtures/stellar-client.ts";

afterEach(cleanup);
const range = {
  start: "2026-11-06T00:00:00Z",
  end: "2026-11-13T00:00:00Z",
  resolution: "1h" as const,
  label: "self-attested telemetry" as const,
};

describe("StellarClientView", () => {
  it("shows per RPC method and Horizon route: calls, error rate, p50/p95, outcomes", () => {
    render(<StellarClientView data={stellarClientFixture(range)} />);
    const rpc = screen.getByTestId("stellar-rpc-table");
    const send = within(rpc).getByText("sendTransaction").closest("tr") as HTMLElement;
    expect(send.textContent).toContain("mainnet");
    expect(send.textContent).toContain("1,200");
    expect(send.textContent).toContain("3.00%");
    expect(send.textContent).toContain("180 ms");
    expect(send.textContent).toContain("740 ms");
    expect(send.textContent).toContain("invalid params (-32602) 30");
    expect(send.textContent).toContain("timeout 6");
    const ll = within(rpc).getByText("getLatestLedger").closest("tr") as HTMLElement;
    expect(ll.textContent).toContain("≤ 5 ms"); // explicit15: the first bucket is "≤ 5 ms" (C-110(9))
    const hz = screen.getByTestId("stellar-horizon-table");
    const acc = within(hz).getByText("GET /accounts/{id}").closest("tr") as HTMLElement;
    expect(acc.textContent).toContain("5.00%");
    expect(acc.textContent).toContain("HTTP 404 45");
    expect(screen.getByTestId("stellar-submissions").textContent).toContain("bad_seq");
    expect(screen.getByTestId("stellar-polls").textContent).toContain("contract_error");
    expect(screen.getByTestId("stellar-simulations").textContent).toContain("restore_required");
    expect(screen.getByText(/Percentile accuracy: bucket width/)).toBeTruthy();
  });

  it("explains how to start when there is nothing", () => {
    render(<StellarClientView data={emptyStellarClient(range)} />);
    const empty = screen.getByTestId("stellar-client-empty");
    expect(empty.textContent).toContain("@usagemap/stellar-otel");
    expect(empty.textContent).toContain("instrumentStellarRpc(rpcServer");
    expect(empty.textContent).toMatch(/no URL, address, hash, key or error text/);
  });

  it("labels outcomes in plain language", () => {
    expect(outcomeLabel("ok")).toBe("ok");
    expect(outcomeLabel("-32603")).toBe("internal error (-32603)");
    expect(outcomeLabel("503")).toBe("HTTP 503");
    expect(outcomeLabel("network")).toBe("network error");
    expect(outcomeLabel("_OTHER")).toBe("other");
  });
});
