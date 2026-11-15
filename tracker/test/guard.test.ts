// SPDX-License-Identifier: Apache-2.0
// track(name, props): wire-contract shape plus the client-side copy of the gateway guard (feature.custom-events, C-52, §a.4).

import { describe, expect, it } from "vitest";
import { GUARD } from "../src/core.ts";
import { sentEvents, settle, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";

const ctx = trackerHarness();

// Shapes only — none of these is a real key or address.
const G_KEY = `G${"A".repeat(55)}`;
const C_KEY = `C${"B".repeat(55)}`;
const S_SEED = `S${"C".repeat(55)}`;
const M_MUXED = `M${"D".repeat(68)}`;
const JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.";
const HEX64 = "ab".repeat(32);

const refused: [string, string, Record<string, unknown> | undefined][] = [
  ["email in value", "signup", { who: "alice@example.com" }],
  ["url-encoded email", "signup", { who: "alice%40example.com" }],
  ["G strkey", "connect", { account: G_KEY }],
  ["C strkey", "invoke", { contract: C_KEY }],
  ["secret seed", "oops", { s: S_SEED }],
  ["muxed account", "pay", { to: M_MUXED }],
  ["G strkey embedded", "pay", { note: `to ${G_KEY} now` }],
  ["JWT", "auth", { token: JWT }],
  ["long hex", "tx", { hash: HEX64 }],
  ["email as name", "a@b.co", undefined],
  ["strkey as name", G_KEY.slice(0, 50), undefined],
  ["empty name", "", undefined],
  ["name too long", "n".repeat(51), undefined],
  ["name with space", "sign up", undefined],
  ["name starting with symbol", "_x", undefined],
  ["11 properties", "many", Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]))],
  ["upper-case key", "x", { Plan: "free" }],
  ["key too long", "x", { [`k${"a".repeat(32)}`]: 1 }],
  ["string over 100", "x", { s: "a".repeat(101) }],
  ["object value", "x", { o: { nested: 1 } }],
  ["array value", "x", { a: [1] }],
  ["null value", "x", { n: null }],
  ["NaN", "x", { n: Number.NaN }],
  ["Infinity", "x", { n: Number.POSITIVE_INFINITY }],
  ["number out of range", "x", { n: 1e16 }],
  ["props not an object", "x", "plan" as unknown as Record<string, unknown>],
  ["props an array", "x", [1] as unknown as Record<string, unknown>],
];

describe("custom-event guard", () => {
  it.each(refused)("refuses %s", async (_why, name, props) => {
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    expect(t.track(name, props as never)).toBe(false);
    await settle();
    expect(sentEvents(ctx.gw)).toHaveLength(1);
    expect(ctx.gw.requests.map((r) => r.raw).join()).not.toMatch(/@|%40|[A-Z2-7]{55}|eyJ/);
  });

  it("accepts ordinary names and properties and sends them unchanged", async () => {
    const t = ctx.start();
    const props = {
      plan: "pro",
      seats: 3,
      price: -12.5,
      trial: false,
      ref_code: "spring-2026",
      page_section: "hero_banner",
    };
    expect(t.track("checkout.completed", props)).toBe(true);
    expect(t.track("Video:play")).toBe(true);
    expect(t.track("swap", {})).toBe(true);
    await until(() => sentEvents(ctx.gw).length === 4);
    const [, a, b, c] = sentEvents(ctx.gw);
    expect(a).toMatchObject({ k: "ev", n: "checkout.completed", d: props, u: "/start" });
    expect(b).toEqual({ id: expect.any(String), k: "ev", n: "Video:play", u: "/start" });
    expect(c).not.toHaveProperty("d");
    expect(ctx.gw.schemaErrors).toEqual([]);
  });

  it("copies props at call time (later mutation by the page is not sent)", async () => {
    const t = ctx.start();
    const props: Record<string, string> = { plan: "free" };
    t.track("signup", props);
    props.plan = "alice@example.com";
    await until(() => sentEvents(ctx.gw).length === 2);
    expect(sentEvents(ctx.gw)[1]?.d).toEqual({ plan: "free" });
  });

  it("matches the gateway guard's shapes", () => {
    for (const v of [
      "x@y.io",
      "x%40y.io",
      G_KEY,
      `T${"A".repeat(55)}`,
      `X${"A".repeat(55)}`,
      `P${"A".repeat(55)}`,
      `B${"A".repeat(55)}`,
      `W${"A".repeat(68)}`,
      JWT,
      HEX64,
      "A".repeat(32),
      // personal identifiers of the pathnorm rule set
      "203.0.113.5",
      "from 198.51.100.7 today",
      "2001:db8:1:2::77",
      "::1",
      "10:30:00",
      "+4915112345678",
      "+49 151 1234 5678",
      "+1 (555) 123-4567",
      "alice*example.com",
    ]) {
      expect(GUARD.test(v), v).toBe(true);
    }
    for (const v of [
      "free",
      "checkout_completed_successfully_today_now",
      "spring-2026",
      "/docs/getting-started",
      "A".repeat(31),
      "1.2.3",
      "10:30",
      "price +100.00",
      "3*4",
      "rating 4.5/5",
    ]) {
      expect(GUARD.test(v), v).toBe(false);
    }
  });
});
