// SPDX-License-Identifier: Apache-2.0
// The Horizon side of the day-anchor check of job onchain_correlation (register C-144): GET /ledgers/{seq}, the hash
// of exactly that ledger, 404 → "not known", anything else that is not a well-formed record → unavailable.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HorizonLedgerHashes,
  LedgerHashUnavailableError,
} from "../../src/onchain/ledger-hashes.ts";

const H = "0f".repeat(32);
let srv: Server;
let url: string;
const seen: string[] = [];

beforeAll(async () => {
  srv = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const m = /^\/ledgers\/(\d+)$/.exec(req.url ?? "");
    const seq = Number(m?.[1]);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (seq === 100) json(200, { sequence: 100, hash: H.toUpperCase(), closed_at: "x" });
    else if (seq === 101) json(404, { status: 404 });
    else if (seq === 102) json(503, {});
    else if (seq === 103)
      json(200, { sequence: 999, hash: H }); // another ledger's record
    else if (seq === 104) json(200, { sequence: 104, hash: "zz" });
    else if (seq === 105) {
      res.writeHead(200);
      res.end("not json");
    } else if (seq === 106) {
      res.writeHead(302, { location: "http://elsewhere.example/ledgers/106" });
      res.end();
    } else json(500, {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

describe("HorizonLedgerHashes", () => {
  const sig = () => new AbortController().signal;
  it("returns the lower-case hash of exactly the ledger asked for", async () => {
    const h = new HorizonLedgerHashes({ horizonUrl: url });
    expect(await h.ledgerHash(100, sig())).toBe(H);
    expect(seen).toContain("GET /ledgers/100");
  });
  it("answers null for a ledger Horizon does not have (404)", async () => {
    expect(await new HorizonLedgerHashes({ horizonUrl: url }).ledgerHash(101, sig())).toBeNull();
  });
  it.each([
    [102, "a 5xx"],
    [103, "a record of another ledger"],
    [104, "a malformed hash"],
    [105, "a body that is not JSON"],
    [106, "a redirect"],
  ])("treats %s (%s) as unavailable, never as a hash", async (seq) => {
    await expect(
      new HorizonLedgerHashes({ horizonUrl: url }).ledgerHash(seq, sig()),
    ).rejects.toBeInstanceOf(LedgerHashUnavailableError);
  });
  it("reports an unreachable Horizon as unavailable and refuses an impossible sequence", async () => {
    const h = new HorizonLedgerHashes({ horizonUrl: "http://127.0.0.1:1", timeoutMs: 2000 });
    await expect(h.ledgerHash(5, sig())).rejects.toBeInstanceOf(LedgerHashUnavailableError);
    await expect(h.ledgerHash(0, sig())).rejects.toBeInstanceOf(RangeError);
    await expect(h.ledgerHash(2 ** 32, sig())).rejects.toBeInstanceOf(RangeError);
  });
});
