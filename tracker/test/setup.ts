// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, vi } from "vitest";
import { type Config, createTracker, type Tracker } from "../src/core.ts";
import { type Gateway, installGateway, restoreProps, SITE, setURL } from "./gateway.ts";

export interface Ctx {
  gw: Gateway;
  start(cfg?: Partial<Config>, pre?: unknown): Tracker;
}

/** Fresh page, fresh mock gateway and fresh tracker per test; everything undone afterwards. */
export function trackerHarness(): Ctx {
  const started: Tracker[] = [];
  const ctx = {
    gw: undefined as unknown as Gateway,
    start(cfg: Partial<Config> = {}, pre?: unknown): Tracker {
      const t = createTracker({ site: SITE, ...cfg }, pre);
      if (!t) throw new Error("tracker not created");
      started.push(t);
      return t;
    },
  };
  beforeEach(() => {
    localStorage.clear();
    setURL("https://site.test/start");
    ctx.gw = installGateway();
  });
  afterEach(() => {
    for (const t of started.splice(0)) t.destroy();
    restoreProps();
    vi.useRealTimers();
  });
  return ctx;
}
