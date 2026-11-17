// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// ops.end-of-window-read-only read-only mode in the portal: the mode published by /public/v1/thresholds, the client's notification on a
// read-only refusal, and the persistent banner.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, api, isReadOnlyRefusal, READ_ONLY_DETAIL } from "../../src/api/client.ts";
import { ReadOnlyBanner } from "../../src/components/ReadOnlyBanner.tsx";
import { NORMAL_MODE, platformModeOf, readOnlyText } from "../../src/lib/platformMode.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const setting = (value: unknown) => [
  { key: "op_min_count", value: 10, description: "k", public: true },
  { key: "read_only_mode", value, description: "ops.end-of-window-read-only", public: true },
];

describe("platformModeOf", () => {
  it("reads the read_only_mode setting", () => {
    expect(platformModeOf(setting({ enabled: true, ingest: "accept" }))).toEqual({
      readOnly: true,
      ingestPaused: false,
    });
    expect(platformModeOf(setting({ enabled: true, ingest: "pause" }))).toEqual({
      readOnly: true,
      ingestPaused: true,
    });
  });

  it("is off when the setting is absent, off or malformed", () => {
    expect(platformModeOf(setting({ enabled: false, ingest: "pause" }))).toEqual(NORMAL_MODE);
    expect(platformModeOf(setting("on"))).toEqual(NORMAL_MODE);
    expect(platformModeOf(setting({ enabled: "true" }))).toEqual(NORMAL_MODE);
    expect(platformModeOf([])).toEqual(NORMAL_MODE);
    expect(platformModeOf(null)).toEqual(NORMAL_MODE);
  });

  it("says whether data collection continues", () => {
    expect(readOnlyText({ readOnly: true, ingestPaused: true })).toMatch(
      /^Read-only mode: .*data collection is paused/,
    );
    expect(readOnlyText({ readOnly: true, ingestPaused: false })).toMatch(
      /^Read-only mode: .*Data collection continues/,
    );
  });
});

describe("read-only refusals in the client", () => {
  it("recognises only the read-only 403", () => {
    expect(isReadOnlyRefusal(403, { detail: READ_ONLY_DETAIL })).toBe(true);
    expect(isReadOnlyRefusal(403, { detail: "the tenant has been removed" })).toBe(false);
    expect(isReadOnlyRefusal(503, { detail: READ_ONLY_DETAIL })).toBe(false);
  });

  it("notifies listeners on a read-only refusal and not on other errors", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          type: "x",
          title: "Forbidden",
          status: 403,
          code: "forbidden",
          detail: READ_ONLY_DETAIL,
        }),
        { status: 403, headers: { "content-type": "application/problem+json" } },
      ),
      new Response(
        JSON.stringify({ type: "x", title: "Forbidden", status: 403, code: "forbidden" }),
        { status: 403, headers: { "content-type": "application/problem+json" } },
      ),
    ];
    const c = new ApiClient((async () => responses.shift() as Response) as typeof fetch);
    const seen = vi.fn();
    const off = c.onReadOnly(seen);
    await expect(c.call("createTenant", { body: { name: "x" } as never })).rejects.toThrow();
    expect(seen).toHaveBeenCalledTimes(1);
    await expect(c.call("createTenant", { body: { name: "x" } as never })).rejects.toThrow();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("ReadOnlyBanner", () => {
  const renderBanner = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReadOnlyBanner />
      </QueryClientProvider>,
    );

  it("shows a persistent status banner when the platform is read-only", async () => {
    vi.spyOn(api, "call").mockResolvedValue(setting({ enabled: true, ingest: "pause" }) as never);
    renderBanner();
    const b = await screen.findByRole("status");
    expect(b.textContent).toMatch(/^Read-only mode: .*paused/);
    expect(api.call).toHaveBeenCalledWith("getPublishedThresholds", {});
  });

  it("shows nothing in normal operation or when the thresholds cannot be read", async () => {
    const call = vi.spyOn(api, "call").mockResolvedValue(setting({ enabled: false }) as never);
    renderBanner();
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(screen.queryByTestId("read-only-banner")).toBeNull();
    cleanup();
    call.mockRejectedValue(new Error("offline"));
    renderBanner();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("read-only-banner")).toBeNull();
  });
});
