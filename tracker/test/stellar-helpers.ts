// SPDX-License-Identifier: Apache-2.0
// Shared assertions for the Stellar event adapters: what left the browser (the mock gateway's recorded bodies) must
// contain no StrKey, transaction hash, XDR, amount, signature, passphrase or wallet error text (ADR-0029, C-45,
// C-136; review-architecture-d1 §5 item 6: "the existing StrKey test, per adapter").

import { expect } from "vitest";
import { CANARY } from "./canary.ts";
import { type Gateway, sentEvents, until } from "./gateway.ts";

export { CANARY } from "./canary.ts";

const FORBIDDEN: RegExp[] = [
  /[GCMSTXPLBW][A-Z2-7]{55}/, // every 56-char StrKey (SEP-23)
  /[MW][A-Z2-7]{68}/, // muxed / 69-char StrKeys
  /[0-9a-f]{64}/i, // hashes
  /AAAA[A-Za-z0-9+/]{16,}/, // base64 XDR
  /1234\.5678901/, // the amount
  /September 2015|October 2022|February 2017/, // passphrases
  /declined|signature|signed/i, // wallet error and result text
];

/** Fail if any request body ever sent contains a canary or a StrKey/hash/XDR shape. */
export function assertNoCanary(gw: Gateway): void {
  expect(gw.requests.length).toBeGreaterThan(0);
  for (const r of gw.requests) {
    for (const re of FORBIDDEN) expect(r.raw, `${r.route} body matches ${re}`).not.toMatch(re);
    for (const v of Object.values(CANARY)) expect(r.raw).not.toContain(v);
  }
  expect(gw.schemaErrors).toEqual([]);
}

export type Wl = Record<string, unknown>;

/** The Stellar v1 events sent, without id/k/u/sv (each checked to be a v1 `wl` event first). */
export function stellarSent(gw: Gateway): Wl[] {
  return sentEvents(gw)
    .filter((e) => e.k === "wl")
    .map((e) => {
      expect(e.sv).toBe(1);
      const { id: _id, k: _k, u: _u, sv: _sv, ...rest } = e;
      return rest;
    });
}

/** Wait until `n` Stellar events were sent. */
export async function waitStellar(gw: Gateway, n: number): Promise<Wl[]> {
  await until(() => stellarSent(gw).length >= n);
  return stellarSent(gw);
}

/** Let promise callbacks of wrapped calls run. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
