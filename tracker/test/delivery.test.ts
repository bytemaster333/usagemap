// SPDX-License-Identifier: Apache-2.0
// Idempotent delivery and body size (plan C1 #11): one event id per action, reused on every retry
// on either host (also after the 3 s abort); batches are split so no body exceeds the gateway's 8 KiB limit.

import { describe, expect, it, vi } from "vitest";
import { HOST_A, HOST_B, sentEvents, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";

const ctx = trackerHarness();
const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
const ids = (raw: string): string[] => (JSON.parse(raw).e as { id: string }[]).map((e) => e.id);

describe("one event id per action", () => {
  it("the retry after the 3 s abort, on the other host, carries the same event ids", async () => {
    fake();
    ctx.gw.answer = (route, n) => (route === "/v1/e" && n === 0 ? "hang" : undefined);
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => ctx.gw.events().length === 2);
    const [a, b] = ctx.gw.events();
    expect([a?.host, b?.host]).toEqual([HOST_A, HOST_B]);
    expect(ids(b?.raw ?? "")).toEqual(ids(a?.raw ?? ""));
    // A new action gets a new id.
    t.track("next");
    await until(() => ctx.gw.events().length === 3);
    expect(ids(ctx.gw.events()[2]?.raw ?? "")[0]).not.toBe(ids(a?.raw ?? "")[0]);
  });

  it("ids are 22 characters of the wire alphabet", async () => {
    const t = ctx.start();
    for (let i = 0; i < 20; i++) t.track(`e${i}`);
    await until(() => sentEvents(ctx.gw).length === 21);
    const all = sentEvents(ctx.gw).map((e) => e.id as string);
    expect(new Set(all).size).toBe(21);
    for (const id of all) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("8 KiB body limit", () => {
  it("splits a batch of large custom events so every body fits, keeping order and losing nothing", async () => {
    fake();
    ctx.gw.answer = (route, n) => (route === "/v1/c" && n === 0 ? "hang" : undefined);
    const t = ctx.start();
    await until(() => ctx.gw.challenges().length === 1);
    // Ten properties of 100 two-byte characters: ~2.2 KB per event in UTF-8.
    const big = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, "é".repeat(100)]),
    );
    for (let i = 0; i < 9; i++) expect(t.track(`big${i}`, big)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => sentEvents(ctx.gw).length === 10);
    const bodies = ctx.gw.events().map((r) => r.raw);
    expect(bodies.length).toBeGreaterThan(1);
    for (const b of bodies) expect(new TextEncoder().encode(b).length).toBeLessThanOrEqual(8192);
    const names = sentEvents(ctx.gw)
      .filter((e) => e.k === "ev")
      .map((e) => e.n);
    expect(names).toEqual(Array.from({ length: 9 }, (_, i) => `big${i}`));
    expect(ctx.gw.schemaErrors).toEqual([]);
  });
});
