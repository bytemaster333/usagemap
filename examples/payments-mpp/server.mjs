// SPDX-License-Identifier: Apache-2.0
// A paid API with MPP (mppx): GET /report costs 0.01 USDC on Stellar testnet. One line makes it measurable in
// UsageMap — `instrumentMppx(mppx)` — plus the OTel setup in otel.mjs. Payment required / paid / failed counts leave
// this process; payers, recipients, amounts, hashes and credentials never do.
import "./otel.mjs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { instrumentMppx } from "@usagemap/payments-otel";
import { Mppx } from "mppx/server";
import { demoStellarCharge } from "./stellar-charge.mjs";

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = process.env.PAY_TO ?? "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"; // your G… account
// signs challenges; in production set MPP_SECRET_KEY (`openssl rand -base64 32`), here a fresh one per start
const SECRET = process.env.MPP_SECRET_KEY ?? randomBytes(32).toString("base64");

const mppx = Mppx.create({ methods: [demoStellarCharge("stellar:testnet")], secretKey: SECRET });

// UsageMap: payment required / paid / failed counts.
instrumentMppx(mppx);

const charge = Mppx.toNodeListener(
  mppx.charge({
    amount: "100000",
    currency: USDC_TESTNET,
    recipient: PAY_TO,
    description: "One report",
  }),
);

const server = createServer(async (req, res) => {
  if (req.url !== "/report") return res.writeHead(404).end();
  const paid = await charge(req, res);
  if (paid.status === 402) return; // the challenge has been sent
  res
    .writeHead(200, { "content-type": "application/json" })
    .end('{"report":"XLM/USDC daily summary"}');
});
server.listen(Number(process.env.PORT ?? 8403), "127.0.0.1", () => {
  console.log(`listening on ${server.address().port}`);
});
