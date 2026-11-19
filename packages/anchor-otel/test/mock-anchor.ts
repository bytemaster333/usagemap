// SPDX-License-Identifier: Apache-2.0
// A small in-process anchor speaking enough SEP-1/6/10/12/24/31/38 for the real Wallet SDK, reachable under a public
// looking host name (`dns.lookup` is redirected to 127.0.0.1 for it while the test runs).

import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";

export const ANCHOR_HOST = "anchor.example.org";

export interface MockAnchor {
  readonly base: string;
  /** host:port, the Wallet SDK's home domain for this anchor. */
  readonly homeDomain: string;
  readonly requests: string[];
  /** Status the SEP-24 `tx-dep` transaction reports next (a test advances it). */
  depositStatus: string;
  close(): Promise<void>;
}

let lookupPatched = 0;
const originalLookup = dns.lookup;

function patchLookup() {
  if (lookupPatched++ > 0) return;
  // biome-ignore lint/suspicious/noExplicitAny: dns.lookup has several overloads.
  (dns as any).lookup = (host: string, opts: any, cb: any) => {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    if (host === ANCHOR_HOST) {
      if (opts?.all) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
      return cb(null, "127.0.0.1", 4);
    }
    return originalLookup(host, opts, cb);
  };
}
function unpatchLookup() {
  if (--lookupPatched === 0) dns.lookup = originalLookup;
}

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Unsigned JWT-shaped token (the Wallet SDK only decodes it). */
function token(sub: string) {
  const iat = Math.floor(Date.now() / 1000);
  return `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ iss: "x", sub, iat, exp: iat + 3600 })}.c2ln`;
}

async function body(req: http.IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

export async function startMockAnchor(): Promise<MockAnchor> {
  patchLookup();
  const signer = Keypair.random();
  const requests: string[] = [];
  const state = { depositStatus: "incomplete" };
  let homeDomain = "";
  let base = "";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    requests.push(`${req.method} ${path}`);
    const json = (status: number, o: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    await body(req);
    const m = `${req.method} ${path}`;
    switch (m) {
      case "GET /.well-known/stellar.toml":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(
          [
            `NETWORK_PASSPHRASE="${Networks.TESTNET}"`,
            `SIGNING_KEY="${signer.publicKey()}"`,
            `WEB_AUTH_ENDPOINT="${base}/auth"`,
            `TRANSFER_SERVER="${base}/sep6"`,
            `TRANSFER_SERVER_SEP0024="${base}/sep24"`,
            `KYC_SERVER="${base}/sep12"`,
            `DIRECT_PAYMENT_SERVER="${base}/sep31"`,
            `ANCHOR_QUOTE_SERVER="${base}/sep38"`,
            "[DOCUMENTATION]",
            'ORG_NAME="Test Anchor"',
            "",
          ].join("\n"),
        );
        return;
      case "GET /auth": {
        const account = url.searchParams.get("account") ?? "";
        const tx = WebAuth.buildChallengeTx(
          signer,
          account,
          homeDomain,
          300,
          Networks.TESTNET,
          ANCHOR_HOST,
        );
        return json(200, { transaction: tx, network_passphrase: Networks.TESTNET });
      }
      case "POST /auth":
        return json(200, { token: token("GACCOUNT") });
      case "GET /sep12/customer":
        return json(200, {
          id: "cust-1",
          status: "NEEDS_INFO",
          fields: { first_name: { type: "string", description: "Jane" } },
        });
      case "PUT /sep12/customer":
        return json(202, { id: "cust-1" });
      case "GET /sep24/info":
        return json(200, {
          deposit: { USDC: { enabled: true } },
          withdraw: { USDC: { enabled: true } },
          fee: { enabled: false },
        });
      case "POST /sep24/transactions/deposit/interactive":
        return json(200, {
          type: "interactive_customer_info_needed",
          url: `${base}/kyc?token=${token("GACCOUNT")}`,
          id: "tx-dep",
        });
      case "POST /sep24/transactions/withdraw/interactive":
        return json(503, { error: "maintenance" });
      case "GET /sep24/transaction":
        return json(200, {
          transaction: {
            id: "tx-dep",
            kind: "deposit",
            status: state.depositStatus,
            amount_in: "100.25",
            memo: "secret-memo",
            more_info_url: `${base}/more?token=x`,
          },
        });
      case "GET /sep24/transactions":
        return json(200, {
          transactions: [
            { id: "tx-dep", kind: "deposit", status: state.depositStatus, amount_in: "100.25" },
            { id: "tx-wd", kind: "withdrawal", status: "error", amount_in: "7.5" },
            { id: "tx-odd", kind: "teleport", status: "completed" },
          ],
        });
      case "GET /sep6/info":
        return json(200, {
          deposit: { USDC: { enabled: true } },
          withdraw: { USDC: { enabled: true } },
        });
      case "GET /sep6/deposit":
        return json(403, { type: "non_interactive_customer_info_needed", fields: ["first_name"] });
      case "GET /sep6/withdraw":
        return json(200, {
          account_id: signer.publicKey(),
          memo_type: "id",
          memo: "123",
          id: "tx-w6",
        });
      case "GET /sep38/info":
        return json(200, { assets: [{ asset: "iso4217:USD" }] });
      case "GET /sep38/prices":
        return json(200, { buy_assets: [{ asset: "iso4217:USD", price: "1.01", decimals: 2 }] });
      case "POST /sep38/quote":
        return json(400, { error: "sell_amount too large" });
      default:
        return json(404, { error: "not found" });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  homeDomain = `${ANCHOR_HOST}:${port}`;
  base = `http://${homeDomain}`;
  return {
    base,
    homeDomain,
    requests,
    get depositStatus() {
      return state.depositStatus;
    },
    set depositStatus(s: string) {
      state.depositStatus = s;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => {
          unpatchLookup();
          r();
        });
      }),
  };
}
