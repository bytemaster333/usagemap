// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createUsageMapApp, SDK_VERSION, tmaPlatform } from "../src/index.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAA";

function harness(statuses: number[] = []) {
  const bodies: Record<string, unknown>[] = [];
  let t = Date.UTC(2026, 10, 19, 10, 0, 0);
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const s = statuses.shift() ?? 202;
    if (s === 0) throw new TypeError("network down");
    return new Response("{}", { status: s });
  }) as unknown as typeof globalThis.fetch;
  const clock = { advance: (ms: number) => (t += ms), now: () => t };
  return { bodies, fetch, clock };
}

describe("@usagemap/mobile-rn", () => {
  it("sends the §a.9 batch shape with no identifier beyond the rotating session", async () => {
    const h = harness();
    const app = createUsageMapApp({
      siteKey: KEY,
      platform: "ios",
      appVersion: "1.4.2",
      fetch: h.fetch,
      now: h.clock.now,
    });
    expect(app.track("swap_started", { tier: "pro" })).toBe(true);
    expect(app.track("app_open")).toBe(true);
    await app.flush();
    expect(h.bodies).toHaveLength(1);
    const b = h.bodies[0] as { events: { session: string }[] };
    expect(Object.keys(b).sort()).toEqual([
      "app_version",
      "events",
      "k",
      "platform",
      "sdk_version",
      "v",
    ]);
    expect(b).toMatchObject({
      v: 1,
      k: KEY,
      platform: "ios",
      app_version: "1.4.2",
      sdk_version: SDK_VERSION,
    });
    expect(b.events[0]).toEqual({
      ts: h.clock.now(),
      session: b.events[0]?.session,
      name: "swap_started",
      props: { tier: "pro" },
    });
    expect(b.events[1]).toEqual({
      ts: h.clock.now(),
      session: b.events[0]?.session,
      name: "app_open",
    });
    expect(b.events[0]?.session).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(app.pending()).toBe(0);
  });

  it("rotates the session at 30 minutes", async () => {
    const h = harness();
    const app = createUsageMapApp({
      siteKey: KEY,
      platform: "android",
      appVersion: "2.0",
      fetch: h.fetch,
      now: h.clock.now,
    });
    app.track("a");
    h.clock.advance(29 * 60_000);
    app.track("b");
    h.clock.advance(60_000);
    app.track("c");
    await app.flush();
    const s = (h.bodies[0] as { events: { session: string }[] }).events.map((e) => e.session);
    expect(s[0]).toBe(s[1]);
    expect(s[2]).not.toBe(s[1]);
  });

  it("refuses names and values the edge would refuse (no free text, ids or numbers)", () => {
    const app = createUsageMapApp({
      siteKey: KEY,
      platform: "ios",
      appVersion: "1.0",
      fetch: harness().fetch,
    });
    expect(app.track("_private")).toBe(false);
    expect(app.track("a b")).toBe(false);
    expect(app.track("ok", { memo: "Hello world" })).toBe(false);
    expect(app.track("ok", { Tier: "pro" })).toBe(false);
    expect(app.track("ok", { n: 5 as unknown as string })).toBe(false);
    expect(
      app.track("ok", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v"]))),
    ).toBe(false);
    expect(app.pending()).toBe(0);
  });

  it("keeps events on network errors, 429 and 5xx; drops them on 2xx and other 4xx", async () => {
    const h = harness([0, 429, 503, 400]);
    const app = createUsageMapApp({
      siteKey: KEY,
      platform: "ios",
      appVersion: "1.0",
      fetch: h.fetch,
      batchSize: 20,
    });
    app.track("a");
    for (let i = 0; i < 3; i++) {
      await app.flush();
      expect(app.pending()).toBe(1);
    }
    await app.flush();
    expect(app.pending()).toBe(0);
  });

  it("batches by 20, auto-flushes at batchSize and caps the queue at 100", async () => {
    const h = harness([500]);
    const app = createUsageMapApp({
      siteKey: KEY,
      platform: "ios",
      appVersion: "1.0",
      fetch: h.fetch,
      batchSize: 20,
    });
    for (let i = 0; i < 130; i++) app.track(`e_${i % 7}`);
    await app.flush(); // the auto-flush in flight (500: kept)
    expect(app.pending()).toBe(100);
    await app.flush();
    expect(app.pending()).toBe(0);
    const sizes = h.bodies.map((b) => (b as { events: unknown[] }).events.length);
    expect(sizes[0]).toBe(20); // the auto-flush that failed with 500
    expect(sizes.slice(1).reduce((a, n) => a + n, 0)).toBe(100);
    expect(Math.max(...sizes)).toBe(20);
  });

  it("maps Telegram's WebApp.platform to the closed class and sends it with platform web", async () => {
    expect(
      [
        "android",
        "android_x",
        "ios",
        "macos",
        "tdesktop",
        "unigram",
        "weba",
        "webk",
        "web",
        "unknown",
        undefined,
      ].map(tmaPlatform),
    ).toEqual([
      "android",
      "android",
      "ios",
      "macos",
      "desktop",
      "desktop",
      "web",
      "web",
      "web",
      "other",
      "other",
    ]);
    const h = harness();
    const app = createUsageMapApp({
      siteKey: KEY,
      platform: "web",
      appVersion: "3.1.0",
      tmaPlatform: tmaPlatform("tdesktop"),
      fetch: h.fetch,
    });
    app.track("mini_app_open");
    await app.flush();
    expect(h.bodies[0]).toMatchObject({ platform: "web", tma_platform: "desktop" });
    expect(JSON.stringify(h.bodies[0])).not.toMatch(/init|user|hash/i);
  });

  it("produces exactly the conformance fixture the gateway's Go parser is tested with", async () => {
    const h = harness();
    const app = createUsageMapApp({
      siteKey: KEY,
      platform: "web",
      appVersion: "1.4.2-beta.3",
      tmaPlatform: "desktop",
      fetch: h.fetch,
      now: () => Date.UTC(2026, 10, 19, 10),
    });
    app.track("swap_started", { tier: "pro" });
    app.track("app_open");
    await app.flush();
    const body = JSON.stringify(h.bodies[0]).replace(
      /"session":"[A-Za-z0-9_-]+"/g,
      '"session":"SESSIONSESSIONSESSION0"',
    );
    expect(JSON.parse(body)).toEqual(
      JSON.parse(readFileSync(new URL("./fixtures/batch.json", import.meta.url), "utf8")),
    );
  });
});
