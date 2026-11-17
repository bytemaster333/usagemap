// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AnchorFunnelView,
  AppEventsView,
  fmtSeconds,
  PartnerCallsView,
  PaymentsView,
  shareOf,
} from "../../src/components/IntegrationPanels.tsx";
import {
  anchorFunnelFixture,
  appEventsFixture,
  emptyAnchorFunnel,
  emptyAppEvents,
  emptyPartnerCalls,
  emptyPayments,
  partnerCallsFixture,
  paymentsFixture,
} from "../fixtures/integration-metrics.ts";

const range = {
  start: "2026-11-12T00:00:00Z",
  end: "2026-11-20T00:00:00Z",
  resolution: "1d" as const,
  label: "self-attested telemetry" as const,
};
const days = {
  start: "2026-11-13",
  end: "2026-11-20",
  label: "self-attested (app events are not verified)" as const,
};

describe("integration panels", () => {
  it("formats durations and funnel shares", () => {
    expect(fmtSeconds(null)).toBe("—");
    expect(fmtSeconds(42)).toBe("42 s");
    expect(fmtSeconds(420)).toBe("7 min");
    expect(fmtSeconds(5400)).toBe("1.5 h");
    expect(fmtSeconds(3 * 86_400)).toBe("3.0 d");
    expect(shareOf(4, 10)).toBe("40 %");
    expect(shareOf(1, 0)).toBe("—");
  });

  it("partner calls: a row per route with percentiles and outcomes; an empty state says how to start", () => {
    const { unmount } = render(<PartnerCallsView data={partnerCallsFixture(range)} />);
    const t = screen.getByTestId("partner-calls-table");
    expect(within(t).getByText("/quote")).toBeTruthy();
    expect(t.textContent).toContain("rate limited 6");
    unmount();
    render(<PartnerCallsView data={emptyPartnerCalls(range)} />);
    expect(screen.getByTestId("partner-calls-empty").textContent).toContain(
      "@usagemap/partner-otel",
    );
  });

  it("payments: totals, stages, rails and failures", () => {
    const { unmount } = render(<PaymentsView data={paymentsFixture(range)} />);
    expect(screen.getByTestId("payments-totals").textContent).toContain("8");
    expect(screen.getByTestId("payments-stages").textContent).toContain("Settled (x402)");
    expect(screen.getByTestId("payments-failures").textContent).toContain(
      "invalid_exact_stellar_payload_wrong_amount",
    );
    unmount();
    render(<PaymentsView data={emptyPayments(range)} />);
    expect(screen.getByTestId("payments-empty")).toBeTruthy();
  });

  it("anchor funnel: the wallet funnel with shares, the anchor side with mean durations", () => {
    const { unmount } = render(<AnchorFunnelView data={anchorFunnelFixture(range)} />);
    const dep = screen.getByTestId("anchor-funnel-deposit");
    expect(dep.textContent).toContain("40 %");
    expect(screen.queryByTestId("anchor-funnel-withdraw")).toBeNull(); // nothing reported for it
    expect(screen.getByTestId("anchor-side").textContent).toContain("1.5 h");
    expect(screen.getByTestId("anchor-clients").textContent).toContain("wallet.example.org");
    unmount();
    render(<AnchorFunnelView data={emptyAnchorFunnel(range)} />);
    expect(screen.getByTestId("anchor-funnel-empty")).toBeTruthy();
  });

  it("app events: per platform, labelled as an upper bound for sessions", () => {
    const { unmount } = render(<AppEventsView data={appEventsFixture(days)} />);
    expect(screen.getByTestId("app-events-totals").textContent).toContain("upper bound");
    expect(screen.getByTestId("app-events-table").textContent).toContain("app_open");
    unmount();
    render(<AppEventsView data={emptyAppEvents(days)} />);
    expect(screen.getByTestId("app-events-empty")).toBeTruthy();
  });
});
