// SPDX-License-Identifier: Apache-2.0
// A fake sealing network for job daily_seal: Horizon (`GET /`, `GET /accounts/{G}`, `POST /transactions`,
// `GET /transactions/{hash}`) and friendbot (`GET /friendbot?addr=G…`). It checks every submitted envelope the way
// stellar-core would for a seal: the strict seal shape (BUMP_SEQUENCE to 0, MEMO_HASH, time bounds), an Ed25519
// signature by the source account over sha256(networkId ‖ ENVELOPE_TYPE_TX ‖ tx), sequence = account + 1 and
// maxTime not passed. `reset()` simulates a testnet reset (accounts and transactions gone, ledger numbers restart, and
// the new network's ledgers close later than any old one). Ledger close times (`GET /ledgers/{n}`, the root's
// `history_latest_ledger_closed_at`) and the account history (`GET /accounts/{G}/transactions`, paged, ascending) are
// served for the reset proof and the seal history walk; `state.lag` makes the Horizon look like one that is far behind
// (catching up): an old latest ledger and close time, no account, no transaction.

import { createPublicKey, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  accountKey,
  decodeSealEnvelope,
  networkIdOf,
  transactionHash,
} from "../../src/stellar/tx.ts";

export interface FakeTx {
  hash: string;
  ledger: number;
  createdAt: string;
  source: string;
  memoHex: string;
  bumpTo: bigint;
}

export interface FakeNetworkState {
  passphrase: string;
  ledger: number;
  accounts: Map<string, bigint>;
  txs: Map<string, FakeTx>;
  friendbotCalls: string[];
  /** "ok"; "down": 503 everywhere; "lose_response": apply a submission but answer 504. */
  mode: "ok" | "down" | "lose_response";
  /** Reject the next N submissions with this result code (without applying them). */
  rejectNext: { code: string; count: number } | null;
  submissions: number;
  requests: string[];
  /** Close time (ISO, seconds) of every ledger this network closed. */
  ledgerTimes: Map<number, string>;
  /** Added to the clock of every ledger closed from now on (a reset moves it forward). */
  clockOffsetMs: number;
  /** A Horizon far behind: answers with this latest ledger and close time, knows no account and no transaction. */
  lag: { latest: number; closedAt: string } | null;
}

export interface FakeNetwork {
  url: string;
  horizonUrl: string;
  friendbotUrl: string;
  state: FakeNetworkState;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeNetwork(port: number, passphrase: string): Promise<FakeNetwork> {
  const state: FakeNetworkState = {
    passphrase,
    ledger: 5_000,
    accounts: new Map(),
    txs: new Map(),
    friendbotCalls: [],
    mode: "ok",
    rejectNext: null,
    submissions: 0,
    requests: [],
    ledgerTimes: new Map(),
    clockOffsetMs: 0,
    lag: null,
  };
  const iso = () =>
    new Date(Date.now() + state.clockOffsetMs).toISOString().replace(/\.\d+Z$/, "Z");
  const epoch = iso();
  const close = (): number => {
    state.ledger += 1;
    state.ledgerTimes.set(state.ledger, iso());
    return state.ledger;
  };
  const closedAt = (n: number): string => {
    for (let i = n; i >= 1; i--) {
      const t = state.ledgerTimes.get(i);
      if (t) return t;
    }
    return epoch;
  };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    state.requests.push(`${req.method} ${u.pathname}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.mode === "down") return json(503, { status: 503 });
    if (req.method === "GET" && u.pathname === "/horizon/") {
      const latest = state.lag?.latest ?? state.ledger;
      return json(200, {
        history_latest_ledger: latest,
        history_latest_ledger_closed_at: state.lag?.closedAt ?? closedAt(latest),
        core_latest_ledger: latest,
        history_elder_ledger: 2,
        network_passphrase: state.passphrase,
      });
    }
    const led = /^\/horizon\/ledgers\/(\d+)$/.exec(u.pathname);
    if (req.method === "GET" && led) {
      const n = Number(led[1]);
      if (n < 2 || n > (state.lag?.latest ?? state.ledger)) return json(404, { status: 404 });
      return json(200, { sequence: n, closed_at: closedAt(n) });
    }
    const hist = /^\/horizon\/accounts\/(G[A-Z2-7]{55})\/transactions$/.exec(u.pathname);
    if (req.method === "GET" && hist) {
      const a = hist[1] as string;
      if (state.lag || !state.accounts.has(a)) return json(404, { status: 404 });
      const limit = Math.min(Number(u.searchParams.get("limit") ?? 10), 200);
      const cursor = Number(u.searchParams.get("cursor") ?? 0);
      const all = [...state.txs.values()]
        .filter((t) => t.source === a && t.ledger > cursor)
        .sort((x, y) => x.ledger - y.ledger);
      const page = all.slice(0, limit);
      const last = page.at(-1);
      return json(200, {
        _embedded: {
          records: page.map((t) => ({
            hash: t.hash,
            ledger: t.ledger,
            created_at: t.createdAt,
            successful: true,
            source_account: t.source,
            memo_type: "hash",
            memo: Buffer.from(t.memoHex, "hex").toString("base64"),
            paging_token: String(t.ledger),
          })),
        },
        _links: {
          next: {
            href: `http://${req.headers.host}/horizon/accounts/${a}/transactions?order=asc&limit=${limit}&cursor=${last?.ledger ?? cursor}`,
          },
        },
      });
    }
    const acct = /^\/horizon\/accounts\/(G[A-Z2-7]{55})$/.exec(u.pathname);
    if (req.method === "GET" && acct) {
      if (state.lag) return json(404, { status: 404 });
      const seq = state.accounts.get(acct[1] as string);
      if (seq === undefined) return json(404, { status: 404 });
      return json(200, { account_id: acct[1], sequence: seq.toString() });
    }
    const txm = /^\/horizon\/transactions\/([0-9a-f]{64})$/.exec(u.pathname);
    if (req.method === "GET" && txm) {
      const t = state.lag ? undefined : state.txs.get(txm[1] as string);
      if (!t) return json(404, { status: 404 });
      return json(200, {
        hash: t.hash,
        ledger: t.ledger,
        created_at: t.createdAt,
        successful: true,
        source_account: t.source,
        memo_type: "hash",
        memo: Buffer.from(t.memoHex, "hex").toString("base64"),
      });
    }
    if (req.method === "POST" && u.pathname === "/horizon/transactions") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        state.submissions += 1;
        const reject = (code: string) =>
          json(400, { status: 400, extras: { result_codes: { transaction: code } } });
        if (state.rejectNext && state.rejectNext.count > 0) {
          state.rejectNext.count -= 1;
          return reject(state.rejectNext.code);
        }
        let d: ReturnType<typeof decodeSealEnvelope>;
        try {
          d = decodeSealEnvelope(new URLSearchParams(body).get("tx") ?? "");
        } catch {
          return reject("tx_malformed");
        }
        const seq = state.accounts.get(d.source);
        if (seq === undefined) return reject("tx_no_source_account");
        const pub = accountKey(d.source);
        const hash = transactionHash(networkIdOf(state.passphrase), d.tx);
        const key = createPublicKey({
          key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]),
          format: "der",
          type: "spki",
        });
        if (!d.hint.equals(pub.subarray(28)) || !verify(null, hash, key, d.signature))
          return reject("tx_bad_auth");
        if (d.sequence !== seq + 1n) return reject("tx_bad_seq");
        if (d.maxTime !== 0n && d.maxTime < BigInt(Math.floor(Date.now() / 1000)))
          return reject("tx_too_late");
        if (d.bumpTo !== 0n || d.fee < 100) return reject("tx_malformed");
        const ledgerSeq = close();
        state.accounts.set(d.source, d.sequence);
        const t: FakeTx = {
          hash: hash.toString("hex"),
          ledger: ledgerSeq,
          createdAt: state.ledgerTimes.get(ledgerSeq) as string,
          source: d.source,
          memoHex: d.memoHash.toString("hex"),
          bumpTo: d.bumpTo,
        };
        state.txs.set(t.hash, t);
        if (state.mode === "lose_response") return json(504, { status: 504 });
        return json(200, {
          hash: t.hash,
          ledger: t.ledger,
          successful: true,
          created_at: t.createdAt,
        });
      });
      return;
    }
    if (req.method === "GET" && u.pathname === "/friendbot/") {
      const addr = u.searchParams.get("addr") ?? "";
      if (!/^G[A-Z2-7]{55}$/.test(addr)) return json(400, { detail: "bad address" });
      state.friendbotCalls.push(addr);
      if (state.accounts.has(addr)) return json(400, { detail: "createAccountAlreadyExist" });
      close();
      state.accounts.set(addr, BigInt(state.ledger) << 32n);
      return json(200, { successful: true, ledger: state.ledger });
    }
    json(404, { status: 404 });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    horizonUrl: `${url}/horizon`,
    friendbotUrl: `${url}/friendbot`,
    state,
    reset: () => {
      state.accounts.clear();
      state.txs.clear();
      state.ledgerTimes.clear();
      state.clockOffsetMs += 3_600_000; // the new network's ledgers close after every old one
      state.ledger = 10;
      state.ledgerTimes.set(10, iso());
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
