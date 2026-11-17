// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// Component tests of the usage pieces: the verified-vs-raw band chart (band, markers, keyboard reading and
// click-to-filter), the wallet funnel view, the privacy card and the demo banner.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BandChart, describePoint, suspectShare } from "../../src/components/BandChart.tsx";
import { DemoBanner, isDemoSlug, PrivacyCard } from "../../src/components/PrivacyCard.tsx";
import { NEVER_SHOWN, NEVER_STORED } from "../../src/lib/privacyCard.ts";
import { WalletFunnelView } from "../../src/pages/WalletFunnel.tsx";

afterEach(cleanup);

const points = [
  { t: "2026-11-08T00:00:00Z", verified: 1000, raw: 1050 },
  { t: "2026-11-09T00:00:00Z", verified: 1200, raw: 3100 },
  { t: "2026-11-10T00:00:00Z", verified: 1100, raw: 1150 },
];

describe("BandChart", () => {
  it("draws the suspect band between raw and verified, with a marker per flagged day", () => {
    const { container } = render(
      <BandChart
        title="Verified and raw page views per day"
        points={points}
        markers={[{ day: "2026-11-09", label: "step_change", explained: true }]}
      />,
    );
    const band = container.querySelector("path.band");
    expect(band?.getAttribute("d")).toMatch(/^M.+Z$/);
    expect(screen.getByTestId("band-marker-2026-11-09").getAttribute("class")).toBe(
      "marker explained",
    );
    expect(screen.getByRole("slider")).toBeTruthy();
    // the text alternative lists every day with its suspect share
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("61.3%")).toBeTruthy();
  });
  it("arrow keys read each day (with its flag); Enter filters to it", () => {
    const onSelectDay = vi.fn();
    render(
      <BandChart
        title="t"
        points={points}
        markers={[{ day: "2026-11-09", label: "step_change", explained: false }]}
        onSelectDay={onSelectDay}
      />,
    );
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByTestId("band-readout").textContent).toBe(describePoint(points[0] as never));
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByTestId("band-readout").textContent).toContain("anomaly flag: step_change");
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByTestId("band-hover")).toBeTruthy();
    fireEvent.keyDown(slider, { key: "Enter" });
    expect(onSelectDay).toHaveBeenCalledWith("2026-11-09");
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
  });
  it("suspect share is (raw − verified) / raw, null without raw page views", () => {
    expect(suspectShare({ t: "x", verified: 90, raw: 100 })).toBeCloseTo(0.1);
    expect(suspectShare({ t: "x", verified: 0, raw: 0 })).toBeNull();
    expect(suspectShare({ t: "x", verified: null, raw: 5 })).toBeNull();
  });
  it("says so when there is no data", () => {
    render(<BandChart title="t" points={[]} />);
    expect(screen.getByText("No data in this range.")).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("WalletFunnelView", () => {
  it("shows the funnel, the wallets and the rejections; withheld counts say so", () => {
    render(
      <WalletFunnelView
        funnel={{
          range: { start: "2026-10-14T00:00:00Z", end: "2026-11-13T00:00:00Z" },
          network: "testnet",
          variant: "verified",
          schema: "scf-stellar-events/1",
          steps: [
            { event: "wallet_modal_opened", count: 410, by_wallet: {}, by_property: {} },
            {
              event: "wallet_connect",
              count: 240,
              by_wallet: { freighter: 220, xbull: 20 },
              by_property: {},
            },
            {
              event: "sign_rejected",
              count: 10,
              by_wallet: { freighter: 9 },
              by_property: { error_class: { user_rejected: 10 } },
            },
            {
              event: "passkey_used",
              count: null as unknown as number,
              by_wallet: {},
              by_property: {},
            },
          ],
          daily: [
            { day: "2026-11-12", wallet_connect: 8, sign_approved: 6, tx_submitted_success: 5 },
          ],
        }}
      />,
    );
    expect(within(screen.getByTestId("funnel-wallet_connect")).getByText(/240/)).toBeTruthy();
    expect(within(screen.getByTestId("funnel-wallet_connect")).getByText("58.5%")).toBeTruthy();
    expect(within(screen.getByTestId("wallet-freighter")).getByText("Freighter")).toBeTruthy();
    expect(screen.getByTestId("funnel-rejections").textContent).toContain("user rejected 10");
    expect(document.body.textContent).toContain("Passkey used: withheld");
    expect(screen.getByTestId("funnel-daily")).toBeTruthy();
  });
});

describe("PrivacyCard and DemoBanner", () => {
  it("shows the Stellar statement, everything never shown and the full never-stored list", () => {
    render(<PrivacyCard />);
    expect(screen.getByTestId("privacy-stellar").textContent).toContain(
      "No visitor's address is ever collected.",
    );
    expect(within(screen.getByTestId("privacy-never-shown")).getAllByRole("listitem")).toHaveLength(
      NEVER_SHOWN.length,
    );
    expect(
      within(screen.getByTestId("privacy-never-stored")).getAllByRole("listitem"),
    ).toHaveLength(NEVER_STORED.length - 1);
  });
  it("labels demo projects only", () => {
    expect(isDemoSlug("demo-ramp-one")).toBe(true);
    expect(isDemoSlug("stellar-docs")).toBe(false);
    const { rerender } = render(<DemoBanner slug="demo-x" />);
    expect(screen.getByTestId("demo-banner").textContent).toContain("DEMO");
    rerender(<DemoBanner slug="stellar-docs" />);
    expect(screen.queryByTestId("demo-banner")).toBeNull();
  });
});
