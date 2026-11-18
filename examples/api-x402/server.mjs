// SPDX-License-Identifier: Apache-2.0
// A paid API on Stellar with x402: GET /report costs $0.01 in USDC on testnet, paid through a facilitator.
// Two lines make it measurable in UsageMap: `instrumentX402Http(httpServer)` before the middleware is built, and the
// OTel setup in otel.mjs. Nothing about the payer, the payee, the amount or the transaction leaves this process.
import { instrumentX402Http } from "@usagemap/payments-otel";
import { HTTPFacilitatorClient, x402HTTPResourceServer } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import express from "express";

const PAY_TO = process.env.PAY_TO; // your Stellar account (G…) that receives the USDC
const FACILITATOR_URL = process.env.FACILITATOR_URL; // e.g. the OpenZeppelin Channels x402 facilitator
const NETWORK = process.env.X402_NETWORK ?? "stellar:testnet";
if (!PAY_TO || !FACILITATOR_URL) {
  console.error("set PAY_TO and FACILITATOR_URL");
  process.exit(2);
}

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }));
resourceServer.register(NETWORK, new ExactStellarScheme());
const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /report": {
    accepts: { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0.01" },
    description: "One market report",
    mimeType: "application/json",
  },
});

// UsageMap: payment required / verified / settled / failed / canceled counts.
const payments = instrumentX402Http(httpServer);
if (!payments.instrumented) console.warn("payments-otel: x402 server without hook API");

const app = express();
app.use(paymentMiddlewareFromHTTPServer(httpServer));
app.get("/report", (_req, res) => {
  res.json({ report: "XLM/USDC daily summary" });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 8402);
const listener = app.listen(port, "127.0.0.1", () => {
  console.log(`listening on ${listener.address().port}`);
});
