// SPDX-License-Identifier: Apache-2.0
// Transport (wire-formats §a.5): 3 s timeout, at most 2 retries alternating between the two hosts with backoff or
// Retry-After (≤ 30 s), same event ids on retry, no retry on 400, stop on 404/410, keepalive fetch on page hide, send
// without proof when hidden before the proof completes (C-35), challenge refresh after 25 minutes / 300 events.

import { describe, expect, it, vi } from "vitest";
import { HOST_A, HOST_B, isStrict, sentEvents, setProp, settle, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";

const ctx = trackerHarness();
const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
const hosts = () => ctx.gw.events().map((r) => r.host);

describe("pending-proof queue (C-112)", () => {
  it("keeps at most 30 events while the challenge is pending and drops the newest, keeping the landing page view", async () => {
    fake();
    ctx.gw.answer = (route, n) => (route === "/v1/c" && n === 0 ? "hang" : undefined);
    const t = ctx.start();
    await until(() => ctx.gw.challenges().length === 1);
    for (let i = 1; i <= 40; i++) t.track(`e${i}`);
    expect(ctx.gw.events()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000); // first challenge aborted after 3 s
    await settle(5);
    await vi.advanceTimersByTimeAsync(2000); // backoff, then the retry on the other host answers
    await until(() => sentEvents(ctx.gw).length === 30);
    await vi.advanceTimersByTimeAsync(5000);
    await settle(5);
    const sent = sentEvents(ctx.gw);
    expect(sent).toHaveLength(30);
    expect(sent[0]).toMatchObject({ k: "pv", u: "/start" });
    expect(sent.slice(1).map((e) => e.n)).toEqual(
      Array.from({ length: 29 }, (_, i) => `e${i + 1}`),
    );
    expect(ctx.gw.schemaErrors).toEqual([]);
  });
});

describe("retries and host rotation", () => {
  it("retries a 503 on the other host with the same event ids, then stays there", async () => {
    fake();
    ctx.gw.answer = (route, n) => (route === "/v1/e" && n === 0 ? 503 : undefined);
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    await vi.advanceTimersByTimeAsync(499 * 0.5);
    expect(ctx.gw.events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => ctx.gw.events().length === 2);
    const [a, b] = ctx.gw.events();
    expect([a?.host, b?.host]).toEqual([HOST_A, HOST_B]);
    expect(b?.raw).toBe(a?.raw);
    t.track("next");
    await until(() => ctx.gw.events().length === 3);
    expect(hosts()[2]).toBe(HOST_B);
  });

  it("gives up after two retries (three attempts: A, B, A) on network errors", async () => {
    fake();
    ctx.gw.answer = (route) => (route === "/v1/e" ? "network" : undefined);
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      await settle(5);
    }
    expect(hosts()).toEqual([HOST_A, HOST_B, HOST_A]);
    expect(new Set(ctx.gw.events().map((r) => r.raw)).size).toBe(1);
  });

  it("backs off exponentially with jitter (500 ms × 2ⁿ × [0.5, 1.5))", async () => {
    fake();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    ctx.gw.answer = (route) => (route === "/v1/e" ? 500 : undefined);
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    // 500 × 1.499 = 749.5 ms; timers truncate to whole milliseconds.
    await vi.advanceTimersByTimeAsync(748);
    expect(ctx.gw.events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await until(() => ctx.gw.events().length === 2);
    await vi.advanceTimersByTimeAsync(1497); // 1000 × 1.499 = 1499 ms
    expect(ctx.gw.events()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    await until(() => ctx.gw.events().length === 3);
  });

  it("aborts a request after 3 seconds and retries on the other host", async () => {
    fake();
    ctx.gw.answer = (route, n) => (route === "/v1/e" && n === 0 ? "hang" : undefined);
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    const signal = ctx.gw.events()[0]?.init.signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(2999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => ctx.gw.events().length === 2);
    expect(hosts()).toEqual([HOST_A, HOST_B]);
  });

  it("honours Retry-After on 429, capped at 30 s", async () => {
    fake();
    ctx.gw.answer = (route, n) =>
      route === "/v1/e" && n === 0
        ? { status: 429, headers: { "Retry-After": "120" } }
        : route === "/v1/e" && n === 1
          ? { status: 429, headers: { "Retry-After": "5" } }
          : undefined;
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(ctx.gw.events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => ctx.gw.events().length === 2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ctx.gw.events()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => ctx.gw.events().length === 3);
  });

  it("does not retry a 400", async () => {
    fake();
    ctx.gw.answer = (route) => (route === "/v1/e" ? 400 : undefined);
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.gw.events()).toHaveLength(1);
    expect(t.track("still_works")).toBe(true);
    await until(() => ctx.gw.events().length === 2);
  });

  it.each([404, 410])("stops for the page on %i", async (status) => {
    fake();
    ctx.gw.answer = (route) => (route === "/v1/e" ? status : undefined);
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.track("x")).toBe(false);
    history.pushState({}, "", "/more");
    await settle();
    expect(ctx.gw.requests).toHaveLength(2);
  });

  it("stops when the challenge says unknown site (404)", async () => {
    ctx.gw.answer = (route) => (route === "/v1/c" ? 404 : undefined);
    const t = ctx.start();
    await until(() => ctx.gw.challenges().length === 1);
    await settle();
    expect(t.track("x")).toBe(false);
    expect(ctx.gw.requests).toHaveLength(1);
  });

  it("retries a failed challenge on the other host", async () => {
    fake();
    ctx.gw.answer = (route, n) => (route === "/v1/c" && n === 0 ? 503 : undefined);
    ctx.start();
    await until(() => ctx.gw.challenges().length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => ctx.gw.events().length === 1);
    expect(ctx.gw.challenges().map((r) => r.host)).toEqual([HOST_A, HOST_B]);
    expect(ctx.gw.events()[0]?.body.c).toEqual(expect.any(Number));
  });

  it("does not loop on a malformed challenge response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
    );
    const t = ctx.start();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(t.track("x")).toBe(false);
  });
});

describe("page hide", () => {
  it("sends with the token and no proof when hidden before the proof completes (C-35)", async () => {
    vi.spyOn(crypto.subtle, "deriveBits").mockReturnValue(new Promise(() => {}));
    ctx.start();
    await until(() => ctx.gw.issued.length === 1);
    await settle();
    expect(ctx.gw.events()).toHaveLength(0);
    setProp(document, "visibilityState", "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ctx.gw.events()).toHaveLength(1);
    const r = ctx.gw.events()[0];
    expect(r?.via).toBe("fetch");
    expect(r?.init.keepalive).toBe(true);
    expect(r?.body.t).toBe(ctx.gw.issued[0]?.token);
    expect(r?.body).not.toHaveProperty("c");
    if (!isStrict) expect(r?.body.sg).toMatchObject({ vis: "h" });
    expect(ctx.gw.schemaErrors).toEqual([]);
  });

  it("sends pending retries at once on pagehide (keepalive fetch, no further retry) and cancels their timers", async () => {
    fake();
    ctx.gw.answer = (route, n) => (route === "/v1/e" && n === 0 ? 503 : undefined);
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    window.dispatchEvent(new Event("pagehide"));
    expect(ctx.gw.events()).toHaveLength(2);
    expect(ctx.gw.events()[1]?.via).toBe("fetch");
    expect(ctx.gw.events()[1]?.init.keepalive).toBe(true);
    expect(ctx.gw.events()[1]?.raw).toBe(ctx.gw.events()[0]?.raw);
    expect(ctx.gw.events()[1]?.host).toBe(HOST_B);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.gw.events()).toHaveLength(2);
  });

  // EasyPrivacy blocks every third-party `ping` (`*$ping,third-party`, filter-list check): a beacon would be lost.
  it("never uses navigator.sendBeacon, on hide or otherwise", async () => {
    vi.spyOn(crypto.subtle, "deriveBits").mockReturnValue(new Promise(() => {}));
    ctx.start();
    await until(() => ctx.gw.issued.length === 1);
    await settle();
    window.dispatchEvent(new Event("pagehide"));
    expect(ctx.gw.events()).toHaveLength(1);
    expect(ctx.gw.events()[0]?.via).toBe("fetch");
    expect(ctx.gw.events()[0]?.init.keepalive).toBe(true);
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it("a visible visibilitychange does not flush", async () => {
    vi.spyOn(crypto.subtle, "deriveBits").mockReturnValue(new Promise(() => {}));
    ctx.start();
    await until(() => ctx.gw.issued.length === 1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ctx.gw.events()).toHaveLength(0);
  });
});

describe("challenge lifetime", () => {
  it("fetches a new challenge when the token is older than 25 minutes", async () => {
    fake();
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    vi.setSystemTime(Date.now() + 24 * 60_000);
    t.track("a");
    await until(() => ctx.gw.events().length === 2);
    expect(ctx.gw.challenges()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    t.track("b");
    await until(() => ctx.gw.events().length === 3);
    expect(ctx.gw.challenges()).toHaveLength(2);
    const [, e2, e3] = ctx.gw.events();
    expect(e3?.body.t).not.toBe(e2?.body.t);
  });

  it("fetches a new challenge after 300 events on one token", async () => {
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    for (let i = 0; i < 299; i++) {
      t.track("e");
      await until(() => sentEvents(ctx.gw).length === i + 2);
    }
    expect(ctx.gw.challenges()).toHaveLength(1);
    t.track("over");
    await until(() => sentEvents(ctx.gw).length === 301);
    expect(ctx.gw.challenges()).toHaveLength(2);
  });
});

describe.runIf(!isStrict)("client signals (standard)", () => {
  it("reports webdriver and missing user activation as booleans", async () => {
    setProp(navigator, "webdriver", true);
    setProp(navigator, "userActivation", { hasBeenActive: false });
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    expect(ctx.gw.events()[0]?.body.sg).toEqual({ wd: 1, vis: "v", act: 0 });
  });

  it("omits act when the browser has no userActivation API", async () => {
    setProp(navigator, "webdriver", false);
    setProp(navigator, "userActivation", undefined);
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    expect(ctx.gw.events()[0]?.body.sg).toEqual({ wd: 0, vis: "v" });
  });
});
