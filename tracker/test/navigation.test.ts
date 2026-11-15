// SPDX-License-Identifier: Apache-2.0
// Page views on load and on History API navigation; hydration / double-init never double-counts (tracker.spa, tracker.ssr-frameworks).

import { describe, expect, it } from "vitest";
import { createTracker } from "../src/core.ts";
import { init } from "../src/npm.ts";
import { isStrict, SITE, sentEvents, setProp, settle, setURL, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";

const ctx = trackerHarness();
const paths = (): unknown[] => sentEvents(ctx.gw).map((e) => e.u);

describe("static page", () => {
  it("sends exactly one page view on load", async () => {
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
    await settle();
    expect(paths()).toEqual(["/start"]);
  });

  it("does not start without a valid site key", () => {
    expect(createTracker({ site: "short" })).toBeUndefined();
    expect(createTracker({ site: "Q4mZ8bS1pTn0aR7cLx2VwE!" })).toBeUndefined();
  });
});

describe("History API SPA", () => {
  it("counts pushState, replaceState to a new path, and popstate", async () => {
    ctx.start();
    history.pushState({}, "", "/a");
    history.replaceState({}, "", "/b");
    setURL("https://site.test/a");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await until(() => sentEvents(ctx.gw).length === 4);
    await settle();
    expect(paths()).toEqual(["/start", "/a", "/b", "/a"]);
  });

  it("ignores query-only and fragment-only changes and same-path replaceState", async () => {
    ctx.start();
    history.pushState({}, "", "/start?tab=2");
    history.replaceState({}, "", "/start#section");
    history.replaceState({ scroll: 10 }, "");
    await until(() => ctx.gw.events().length === 1);
    await settle();
    expect(paths()).toEqual(["/start"]);
  });

  it("keeps the router working: state and URL are applied, return values preserved", () => {
    ctx.start();
    expect(history.pushState({ n: 1 }, "", "/x")).toBeUndefined();
    expect(location.pathname).toBe("/x");
    expect(history.state).toEqual({ n: 1 });
  });

  it.runIf(!isStrict)("sends the referrer host on the first page view only", async () => {
    setProp(document, "referrer", "https://search.example/");
    ctx.start();
    history.pushState({}, "", "/next");
    await until(() => sentEvents(ctx.gw).length === 2);
    expect(sentEvents(ctx.gw).map((e) => e.r)).toEqual(["search.example", undefined]);
  });

  it("destroy() restores the History API and stops counting", async () => {
    const before = history.pushState;
    const t = ctx.start();
    expect(history.pushState).not.toBe(before);
    t.destroy();
    expect(history.pushState).toBe(before);
    history.pushState({}, "", "/after");
    await settle();
    expect(paths()).not.toContain("/after");
  });
});

describe("SSR hydration (no double count)", () => {
  it("framework hydration (same-URL replaceState/pushState) and a second init() count once", async () => {
    // e.g. Next.js: server HTML loads the script, then the client router hydrates and re-writes the same URL;
    // React StrictMode runs the init effect twice.
    const first = init({ site: SITE });
    const second = init({ site: SITE });
    expect(second).toBe(first);
    history.replaceState({ __N: true, key: "k1" }, "", location.href);
    history.pushState({ __N: true, key: "k2" }, "", "/start");
    history.replaceState({ __N: true, key: "k2" }, "", "/start");
    await until(() => ctx.gw.events().length === 1);
    await settle();
    expect(paths()).toEqual(["/start"]);
    expect(ctx.gw.challenges()).toHaveLength(1);
    first?.destroy();
  });

  it("classic script plus npm init on the same page share one instance", async () => {
    const a = ctx.start();
    expect(init({ site: SITE })).toBe(a);
    await until(() => ctx.gw.events().length === 1);
    await settle();
    expect(paths()).toEqual(["/start"]);
  });

  it("init() is a no-op during server-side rendering", async () => {
    const w = globalThis.window;
    // @ts-expect-error simulate a server runtime
    delete globalThis.window;
    try {
      expect(init({ site: SITE })).toBeUndefined();
    } finally {
      globalThis.window = w;
    }
  });
});
