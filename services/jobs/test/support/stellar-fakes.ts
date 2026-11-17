// SPDX-License-Identifier: Apache-2.0
// Fake Horizon (`GET /accounts/{G}/operations`, paged) and fake Stellar RPC (`getLedgerEntries`) for the contract
// verification tests, plus an encoder for contract instance entries with an `Admin` account (the inverse of the
// decoder in src/stellar/xdr.ts, so the decoder is exercised on bytes it did not produce itself only through the live
// vector in test/unit/stellar.test.ts).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { strkeyDecode, VERSION } from "../../src/stellar/xdr.ts";

const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const sym = (s: string) => {
  const raw = Buffer.from(s, "latin1");
  return Buffer.concat([i32(15), i32(raw.length), raw, Buffer.alloc((4 - (raw.length % 4)) % 4)]);
};

/** LedgerEntryData CONTRACT_DATA of a contract instance whose storage maps Vec[Symbol("Admin")] → account. */
export function instanceEntryXdr(contract: string, admin: string | null): string {
  const storage = admin
    ? Buffer.concat([
        i32(1),
        i32(1),
        Buffer.concat([i32(16), i32(1), i32(1), sym("Admin")]),
        Buffer.concat([i32(18), i32(0), i32(0), strkeyDecode(admin, VERSION.account)]),
      ])
    : i32(0);
  return Buffer.concat([
    i32(6),
    i32(0),
    i32(1),
    strkeyDecode(contract, VERSION.contract),
    i32(20),
    i32(1),
    i32(19),
    i32(0),
    Buffer.alloc(32, 7),
    storage,
  ]).toString("base64");
}

export interface FakeLedgerState {
  /** account → create-contract operations (address, decimal salt) */
  creations: Map<string, Array<{ salt: string }>>;
  /** contract → admin account (null: instance without admin) */
  admins: Map<string, string | null>;
  down: boolean;
  requests: string[];
  /** Horizon's history_elder_ledger (2: full history; higher: bounded history). */
  elder: number;
  /** Unrelated operations before the creations (paging); default 250. */
  filler: number;
  /** Accounts whose history starts with their create_account operation. */
  created: Set<string>;
}

export async function startFakeLedger(
  port: number,
): Promise<{ url: string; state: FakeLedgerState; close(): Promise<void> }> {
  const state: FakeLedgerState = {
    creations: new Map(),
    admins: new Map(),
    down: false,
    requests: [],
    elder: 2,
    filler: 250,
    created: new Set(),
  };
  let url = "";
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    state.requests.push(`${req.method} ${u.pathname}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.down) return json(503, {});
    if (u.pathname === "/horizon/") return json(200, { history_elder_ledger: state.elder });
    const m = /^\/horizon\/accounts\/(G[A-Z2-7]{55})\/operations$/.exec(u.pathname);
    if (m) {
      const acct = m[1] as string;
      const ops = state.creations.get(acct);
      if (!ops) return json(404, { status: 404 });
      // 250 unrelated payments first (two pages), then the creations: exercises paging.
      const all = [
        ...(state.created.has(acct) ? [{ id: "c", type: "create_account", account: acct }] : []),
        ...Array.from({ length: state.filler }, (_, i) => ({ id: String(i), type: "payment" })),
        ...ops.map((o, i) => ({
          id: String(1000 + i),
          type: "invoke_host_function",
          function: "HostFunctionTypeHostFunctionTypeCreateContract",
          address: acct,
          salt: o.salt,
        })),
      ];
      const cursor = Number(u.searchParams.get("cursor") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 10);
      const page = all.slice(cursor, cursor + limit);
      return json(200, {
        _embedded: { records: page },
        _links: {
          next: {
            href: `${url}/horizon/accounts/${acct}/operations?limit=${limit}&order=asc&cursor=${cursor + limit}`,
          },
        },
      });
    }
    if (u.pathname === "/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const q = JSON.parse(body) as { params: { keys: string[] } };
        const key = Buffer.from(q.params.keys[0] as string, "base64");
        const contractHash = key.subarray(8, 40).toString("hex");
        const entries = [...state.admins.entries()]
          .filter(([c]) => strkeyDecode(c, VERSION.contract).toString("hex") === contractHash)
          .map(([c, a]) => ({
            key: q.params.keys[0],
            xdr: instanceEntryXdr(c, a),
            lastModifiedLedgerSeq: 1,
          }));
        json(200, { jsonrpc: "2.0", id: 1, result: { entries, latestLedger: 2 } });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, close: () => new Promise((r) => server.close(() => r())) };
}
