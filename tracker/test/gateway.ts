// SPDX-License-Identifier: Apache-2.0
// A mock of the gateway's v1 protocol for unit tests: issues real §b.1-shaped tokens with a real §b.2 proof-of-work
// target, verifies the submitted counter, validates every body against the wire-format JSON Schemas (copied into
// test/fixtures from docs/contracts/wire-formats.md), and records every request the tracker makes.

import { vi } from "vitest";
import {
  type Issued,
  issue,
  validateChallengeRequest,
  validateChallengeResponse,
  validateEventBatch,
} from "./protocol.ts";

export * from "./protocol.ts";

export interface Req {
  url: string;
  host: string;
  route: string;
  raw: string;
  body: Record<string, unknown>;
  init: RequestInit;
  via: "fetch" | "beacon";
}

/** What the mock answers: a status (+ headers), a network error, or a request that never completes. */
export type Answer =
  | number
  | { status: number; headers?: Record<string, string> }
  | "network"
  | "hang";

export interface Gateway {
  requests: Req[];
  issued: Issued[];
  events(): Req[];
  challenges(): Req[];
  /** Answer for the n-th request to a route (0-based); default 200/202. */
  answer: (route: string, n: number, host: string) => Answer | undefined;
  cost: number;
  max: number;
  schemaErrors: string[];
}

export function installGateway(): Gateway {
  const counts: Record<string, number> = {};
  const gw: Gateway = {
    requests: [],
    issued: [],
    events: () => gw.requests.filter((r) => r.route === "/v1/e"),
    challenges: () => gw.requests.filter((r) => r.route === "/v1/c"),
    answer: () => undefined,
    cost: 1,
    max: 16,
    schemaErrors: [],
  };
  const record = (url: string, raw: string, init: RequestInit, via: Req["via"]): Req => {
    const u = new URL(url);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const route = u.pathname;
    const ok = route === "/v1/c" ? validateChallengeRequest(body) : validateEventBatch(body);
    if (!ok) {
      const errs = (route === "/v1/c" ? validateChallengeRequest : validateEventBatch).errors;
      gw.schemaErrors.push(`${route} ${raw} ${JSON.stringify(errs)}`);
    }
    const r: Req = { url, host: u.origin, route, raw, body, init, via };
    gw.requests.push(r);
    return r;
  };

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      const req = record(String(input), String(init.body), init, "fetch");
      const n = counts[req.route] ?? 0;
      counts[req.route] = n + 1;
      const a = gw.answer(req.route, n, req.host);
      if (a === "network") return Promise.reject(new TypeError("Failed to fetch"));
      if (a === "hang") {
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      const status = typeof a === "number" ? a : a ? a.status : req.route === "/v1/c" ? 200 : 202;
      const headers = typeof a === "object" && a.headers ? a.headers : {};
      if (req.route === "/v1/c" && status === 200) {
        const iss = issue(gw.cost, gw.max);
        gw.issued.push(iss);
        const res = {
          v: 1,
          t: iss.token,
          pow: { alg: "pbkdf2-sha256", cost: iss.cost, max: iss.max, pfx: iss.pfx },
          ttl: 1800,
        };
        if (!validateChallengeResponse(res)) throw new Error("mock challenge response invalid");
        return Promise.resolve(new Response(JSON.stringify(res), { status, headers }));
      }
      return Promise.resolve(new Response(null, { status, headers }));
    }),
  );
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: vi.fn((url: string, data: string) => {
      record(url, data, {}, "beacon");
      return true;
    }),
  });
  return gw;
}

/** Wait (in real time) until `pred` holds; WebCrypto completes on the thread pool, not on fake timers. */
export async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!pred()) {
    if (performance.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setImmediate(r));
  }
}

/** Let pending promises and WebCrypto calls settle without advancing fake timers. */
export async function settle(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

type HappyWindow = Window & { happyDOM: { setURL(url: string): void } };
export const setURL = (url: string): void =>
  (window as unknown as HappyWindow).happyDOM.setURL(url);

const overridden: [object, string][] = [];

/** Override a (possibly inherited) property for one test; undone by `restoreProps()`. */
export function setProp(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { configurable: true, get: () => value });
  overridden.push([obj, key]);
}

export function restoreProps(): void {
  for (const [obj, key] of overridden.splice(0)) delete (obj as Record<string, unknown>)[key];
}

/** The page-view and custom events in all sent batches, in order. */
export const sentEvents = (gw: Gateway): Record<string, unknown>[] =>
  gw.events().flatMap((r) => r.body.e as Record<string, unknown>[]);

export const isStrict = __STRICT__;
declare const __STRICT__: boolean;
