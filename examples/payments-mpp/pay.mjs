// SPDX-License-Identifier: Apache-2.0
// A paying agent for the demo: asks for the report, gets the 402 challenge, answers it with the demo payment.
// Run `node pay.mjs` (one paid request) or `node pay.mjs bad` (a payment the server refuses).
import { Challenge, Credential } from "mppx";
import { DEMO_TX } from "./stellar-charge.mjs";

const url = `${process.env.API_URL ?? "http://127.0.0.1:8403"}/report`;
const first = await fetch(url);
console.log(`GET /report → ${first.status}`);
const credential = Credential.serialize(
  Credential.from({
    challenge: Challenge.fromResponse(first),
    payload: { hash: process.argv[2] === "bad" ? "not-a-real-payment" : DEMO_TX, type: "hash" },
  }),
);
const paid = await fetch(url, { headers: { Authorization: credential } });
console.log(`GET /report with payment → ${paid.status}`);
