// SPDX-License-Identifier: Apache-2.0
// A real mppx server (Mppx.create from mppx/server, HTTP transport) with a Stellar charge method whose schema mirrors
// `@stellar/mpp` 0.7.1 `charge` (name `stellar`, intent `charge`, request {amount, currency, recipient, description,
// externalId, methodDetails.network}). Its verify is local: no chain. The client side builds credentials with mppx's
// own Challenge/Credential helpers, as a paying agent would.

import type { Meter } from "@opentelemetry/api";
import { Challenge, Credential, Errors, Method, Receipt, z } from "mppx";
import { Mppx } from "mppx/server";
import { describe, expect, it } from "vitest";
import { instrumentMppx, type MppxLike } from "../src/index.ts";
import { assertClosed, count, points, setup } from "./helpers.ts";

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYEE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAYER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TX = "a".repeat(64);

const stellarCharge = Method.from({
  name: "stellar",
  intent: "charge",
  schema: {
    credential: {
      payload: z.object({ hash: z.string(), type: z.literal("hash") }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      methodDetails: z.optional(z.object({ network: z.string() })),
    }),
  },
});

function server(network = "stellar:testnet") {
  const method = Method.toServer(stellarCharge, {
    defaults: { methodDetails: { network } },
    async verify({ credential }) {
      const hash = credential.payload.hash;
      if (hash === "replay") throw new Errors.CredentialReplayedError({ reason: "seen" });
      if (hash === "short")
        throw new Errors.PaymentInsufficientError({ reason: "amount below price" });
      if (hash !== TX) throw new Errors.VerificationFailedError({ reason: "tx not found" });
      return Receipt.from({
        method: "stellar",
        reference: hash,
        status: "success",
        timestamp: new Date().toISOString(),
        externalId: "order-42",
      });
    },
  });
  return Mppx.create({
    methods: [method],
    secretKey: "test-secret-key-0123456789abcdef",
    realm: "api.test",
  });
}

const URL_ = "https://api.example.test/paid?key=SECRETQUERY";
async function call(
  mppx: ReturnType<typeof server>,
  auth?: string,
): Promise<{ status: number; res: Response }> {
  const handler = mppx.charge({
    amount: "100000",
    currency: USDC_TESTNET,
    recipient: PAYEE,
    description: "one report",
    externalId: "order-42",
  });
  const req = new Request(URL_, { headers: auth ? { Authorization: auth } : {} });
  const r = await handler(req);
  if (r.status === 402) return { status: 402, res: r.challenge };
  return { status: 200, res: r.withReceipt(new Response("ok")) };
}
const pay = (challenge: Response, hash: string) =>
  Credential.serialize(
    Credential.from({
      challenge: Challenge.fromResponse(challenge),
      payload: { hash, type: "hash" },
      source: PAYER,
    }),
  );

describe("instrumentMppx", () => {
  it("counts required, paid and failed with closed attributes only", async () => {
    const { reader, meter } = setup();
    const mppx = server();
    const h = instrumentMppx(mppx, { meter });
    expect(h.instrumented).toBe(true);

    const first = await call(mppx);
    expect(first.status).toBe(402);
    const ok = await call(mppx, pay(first.res, TX));
    expect(ok.status).toBe(200);
    for (const bad of ["nope", "short", "replay"]) {
      const c = await call(mppx);
      expect((await call(mppx, pay(c.res, bad))).status).toBe(402);
    }

    const ps = await points(reader);
    assertClosed(ps);
    const base = {
      "payment.protocol": "mpp",
      "payment.method": "stellar",
      "payment.intent": "charge",
      "payment.network": "stellar:testnet",
      "payment.asset": "USDC",
    };
    // 1 initial + 3 fresh challenges, plus mppx re-challenges after each failed credential
    expect(count(ps, { ...base, "payment.stage": "required" })).toBeGreaterThanOrEqual(4);
    expect(count(ps, { ...base, "payment.stage": "paid" })).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "failed",
        "error.type": "verification-failed",
        "payment.reason_class": "verification_failed",
      }),
    ).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "failed",
        "error.type": "payment-insufficient",
        "payment.reason_class": "wrong_amount",
      }),
    ).toBe(1);
    expect(
      count(ps, {
        ...base,
        "payment.stage": "failed",
        "error.type": "credential-replayed",
        "payment.reason_class": "replayed",
      }),
    ).toBe(1);
    // amount buckets are opt-in
    expect(ps.some((p) => "payment.amount_bucket" in p.attrs)).toBe(false);
  });

  it("adds the amount bucket only on request, never on failures", async () => {
    const { reader, meter } = setup();
    const mppx = server("stellar:pubnet");
    instrumentMppx(mppx, { meter, amountBuckets: true });
    const c = await call(mppx);
    await call(mppx, pay(c.res, TX));
    const c2 = await call(mppx);
    await call(mppx, pay(c2.res, "nope"));
    const ps = await points(reader);
    assertClosed(ps);
    // 100000 base units of a 7-decimal asset = 0.01 → "0.01_0.1"; USDC_TESTNET is still USDC on any network
    expect(
      count(ps, {
        "payment.stage": "paid",
        "payment.amount_bucket": "0.01_0.1",
        "payment.network": "stellar:pubnet",
      }),
    ).toBe(1);
    expect(
      ps
        .filter((p) => p.attrs["payment.stage"] === "failed")
        .every((p) => !("payment.amount_bucket" in p.attrs)),
    ).toBe(true);
  });

  it("is idempotent, detaches, and never throws on foreign objects", async () => {
    const { reader, meter } = setup();
    const mppx = server();
    const a = instrumentMppx(mppx, { meter });
    expect(instrumentMppx(mppx, { meter })).toBe(a);
    await call(mppx);
    a.detach();
    a.detach();
    await call(mppx);
    expect(count(await points(reader), { "payment.stage": "required" })).toBe(1);
    expect(instrumentMppx({} as MppxLike).instrumented).toBe(false);
    expect(instrumentMppx(null as unknown as MppxLike).instrumented).toBe(false);
    const hostile = {
      onChallengeCreated() {
        throw new Error("boom");
      },
      onPaymentSuccess: () => () => {},
      onPaymentFailed: () => () => {},
    };
    expect(instrumentMppx(hostile).instrumented).toBe(false);
  });

  it("keeps the payment flow intact when the meter throws", async () => {
    const meter = {
      createCounter: () => ({
        add() {
          throw new Error("exporter down");
        },
      }),
    } as unknown as Meter;
    const mppx = server();
    instrumentMppx(mppx, { meter });
    const c = await call(mppx);
    expect(c.status).toBe(402);
    expect((await call(mppx, pay(c.res, TX))).status).toBe(200);
  });
});
