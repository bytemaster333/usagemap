// SPDX-License-Identifier: Apache-2.0
// A real `@x402/core` 2.31.0 x402HTTPResourceServer with the real `@x402/stellar` 2.31.0 exact scheme (server side),
// driven through `processHTTPRequest` / `processSettlement` as `@x402/express` does. Only the facilitator is local:
// an in-process FacilitatorClient whose answers are chosen by a marker in the (fake) signed transaction.

import type { Meter } from "@opentelemetry/api";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  FacilitatorTimeoutError,
  type HTTPAdapter,
  x402HTTPResourceServer,
} from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { describe, expect, it } from "vitest";
import {
  instrumentX402,
  instrumentX402Http,
  type X402HttpServerLike,
  type X402ResourceServerLike,
} from "../src/index.ts";
import { assertClosed, count, points, setup } from "./helpers.ts";

const NET = "stellar:testnet" as const;
const PAYEE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAYER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TX = "b".repeat(64);

class MockFacilitator {
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { areFeesSponsored: true } }],
      extensions: [],
      signers: {},
    };
  }
  async verify(p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
    const m = String(p.payload.transaction);
    if (m.includes("verify-throw")) throw new FacilitatorTimeoutError("verify", 5000);
    if (m.includes("verify-bad"))
      return {
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_wrong_amount",
        invalidMessage: `amount mismatch for ${PAYER}`,
        payer: PAYER,
      };
    return { isValid: true, payer: PAYER };
  }
  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    const m = String(p.payload.transaction);
    if (m.includes("settle-fail"))
      return {
        success: false,
        errorReason: "settle_exact_stellar_transaction_failed",
        errorMessage: `tx ${TX} failed`,
        payer: PAYER,
        transaction: TX,
        network: NET,
      };
    if (m.includes("settle-throw")) throw new Error(`socket hang up for ${PAYER}`);
    return { success: true, payer: PAYER, transaction: TX, network: NET, amount: r.amount };
  }
}

function adapter(headers: Record<string, string> = {}): HTTPAdapter {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    getHeader: (n) => h.get(n.toLowerCase()),
    getMethod: () => "GET",
    getPath: () => "/report",
    getUrl: () => "https://api.example.test/report?key=SECRETQUERY",
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "agent/1.0",
  };
}

async function build(price: unknown = "$0.01") {
  const resource = new x402ResourceServer(new MockFacilitator());
  resource.register(NET, new ExactStellarScheme());
  const http = new x402HTTPResourceServer(resource, {
    "GET /report": {
      accepts: { scheme: "exact", network: NET, payTo: PAYEE, price: price as "$0.01" },
      description: "one report",
    },
  });
  await http.initialize();
  return { resource, http };
}

/** One request through the server the way @x402/express runs it; returns the outcome. */
async function request(http: x402HTTPResourceServer, marker?: string, handlerFails = false) {
  if (!marker) {
    const r = await http.processHTTPRequest({ adapter: adapter(), path: "/report", method: "GET" });
    return { r, required: r.type === "payment-error" ? r.response : undefined };
  }
  const unpaid = await http.processHTTPRequest({
    adapter: adapter(),
    path: "/report",
    method: "GET",
  });
  if (unpaid.type !== "payment-error") throw new Error("expected a 402");
  const pr = decodePaymentRequiredHeader(String(unpaid.response.headers["PAYMENT-REQUIRED"]));
  const accepted = pr.accepts[0];
  if (!accepted) throw new Error("no accepts");
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: { transaction: `AAAAAgAAAAD${marker}` },
  };
  const header = encodePaymentSignatureHeader(payload);
  let r: Awaited<ReturnType<typeof http.processHTTPRequest>>;
  try {
    r = await http.processHTTPRequest({
      adapter: adapter({ "PAYMENT-SIGNATURE": header }),
      path: "/report",
      method: "GET",
      paymentHeader: header,
    });
  } catch (e) {
    // a facilitator failure (e.g. timeout) is rethrown; the middleware answers 5xx
    return { e };
  }
  if (r.type !== "payment-verified") return { r };
  if (handlerFails) {
    await r.cancellationDispatcher.cancel({ reason: "handler_threw", responseStatus: 500 });
    return { r };
  }
  try {
    const s = await http.processSettlement(
      r.paymentPayload,
      r.paymentRequirements,
      r.declaredExtensions,
    );
    return { r, s };
  } catch (e) {
    return { r, e };
  }
}

describe("instrumentX402Http", () => {
  it("counts required, verified, settled, failed and canceled with closed attributes only", async () => {
    const { reader, meter } = setup();
    const { http } = await build();
    const h = instrumentX402Http(http, { meter });
    expect(h.instrumented).toBe(true);

    const unpaid = await request(http);
    expect(unpaid.required?.status).toBe(402);
    const ok = await request(http, "ok");
    expect(ok.s?.success).toBe(true);
    const bad = await request(http, "verify-bad");
    expect(bad.r?.type).toBe("payment-error");
    expect(((await request(http, "verify-throw")).e as Error | undefined)?.name).toBe(
      "FacilitatorTimeoutError",
    );
    const sf = await request(http, "settle-fail");
    expect(sf.s?.success).toBe(false);
    await request(http, "settle-throw");
    await request(http, "ok", true);

    const ps = await points(reader);
    assertClosed(ps);
    const base = {
      "payment.protocol": "x402",
      "payment.scheme": "exact",
      "payment.network": "stellar:testnet",
    };
    // every paid request first got its own 402 (request() fetches the requirements), so 7 unpaid in all
    expect(count(ps, { ...base, "payment.stage": "required" })).toBe(7);
    // verified: ok, settle-fail, settle-throw, and the canceled one
    expect(count(ps, { ...base, "payment.stage": "verified", "payment.asset": "USDC" })).toBe(4);
    expect(count(ps, { ...base, "payment.stage": "settled", "payment.asset": "USDC" })).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "failed",
        "error.type": "invalid_exact_stellar_payload_wrong_amount",
        "payment.reason_class": "wrong_amount",
      }),
    ).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "failed",
        "error.type": "timeout",
        "payment.reason_class": "timeout",
      }),
    ).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "failed",
        "error.type": "settle_exact_stellar_transaction_failed",
        "payment.reason_class": "settle_failed",
      }),
    ).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "failed",
        "error.type": "facilitator_error",
        "payment.reason_class": "facilitator_error",
      }),
    ).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "canceled",
        "error.type": "handler_threw",
        "payment.reason_class": "handler_failed",
      }),
    ).toBe(1);
    expect(ps.some((p) => "payment.amount_bucket" in p.attrs)).toBe(false);
  });

  it("buckets the amount on request (explicit asset price on the 402, scheme-resolved price after)", async () => {
    const { reader, meter } = setup();
    const { http } = await build({
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "50000",
    });
    instrumentX402Http(http, { meter, amountBuckets: true });
    await request(http, "ok");
    const ps = await points(reader);
    assertClosed(ps);
    // 50000 / 10^7 = 0.005 USDC
    expect(
      count(ps, {
        "payment.stage": "required",
        "payment.asset": "USDC",
        "payment.amount_bucket": "0.001_0.01",
      }),
    ).toBe(1);
    expect(
      count(ps, {
        "payment.stage": "settled",
        "payment.asset": "USDC",
        "payment.amount_bucket": "0.001_0.01",
      }),
    ).toBe(1);
  });

  it("is idempotent, detaches to no-ops, and rejects foreign objects", async () => {
    const { reader, meter } = setup();
    const { http, resource } = await build();
    const a = instrumentX402Http(http, { meter });
    expect(instrumentX402Http(http, { meter })).toBe(a);
    // the inner resource-server handle is shared: instrumenting it again does not double count
    expect(instrumentX402(resource, { meter }).instrumented).toBe(true);
    await request(http, "ok");
    a.detach();
    await request(http, "ok");
    const ps = await points(reader);
    expect(count(ps, { "payment.stage": "settled" })).toBe(1);
    expect(count(ps, { "payment.stage": "required" })).toBe(1);
    expect(instrumentX402({} as X402ResourceServerLike).instrumented).toBe(false);
    expect(instrumentX402Http({} as X402HttpServerLike).instrumented).toBe(false);
    expect(instrumentX402Http(null as unknown as X402HttpServerLike).instrumented).toBe(false);
  });

  it("never changes the payment flow, even when recording throws", async () => {
    const meter = {
      createCounter: () => ({
        add() {
          throw new Error("exporter down");
        },
      }),
    } as unknown as Meter;
    const { http } = await build();
    instrumentX402Http(http, { meter });
    expect((await request(http)).required?.status).toBe(402);
    expect((await request(http, "ok")).s?.success).toBe(true);
    expect((await request(http, "verify-bad")).r?.type).toBe("payment-error");
    expect((await request(http, "settle-fail")).s?.success).toBe(false);
  });
});
