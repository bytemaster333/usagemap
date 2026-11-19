// SPDX-License-Identifier: Apache-2.0
// A backend that calls an SCF Integration List partner (here Soroswap's quote and price API). Wrapping `fetch` once
// records every call's latency per route template and its outcome class; the URL, query, API key, body and amounts
// are never recorded. Calls to other hosts go through unmeasured.

import { partnerFetch } from "@usagemap/partner-otel";
import { shutdown } from "./otel.mjs";

const SOROSWAP = process.env.SOROSWAP_API_URL ?? "https://api.soroswap.finance";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"; // native XLM contract (testnet)
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"; // USDC contract (testnet)

// UsageMap: wrap fetch once. `partner` is only needed when the partner API is reached through another host (your
// own proxy, or the local stand-in of the tests); on api.soroswap.finance the host says it.
const opts = { network: "testnet" };
if (process.env.SOROSWAP_API_URL) opts.partner = "soroswap";
const fetch = partnerFetch(globalThis.fetch, opts);

const headers = {
  authorization: `Bearer ${process.env.SOROSWAP_API_KEY ?? ""}`,
  "content-type": "application/json",
};
const quote = await fetch(`${SOROSWAP}/quote?network=testnet`, {
  method: "POST",
  headers,
  body: JSON.stringify({ assetIn: XLM, assetOut: USDC, amount: "10000000", tradeType: "EXACT_IN" }),
});
console.log(`POST /quote → ${quote.status}`);
const price = await fetch(`${SOROSWAP}/price?network=testnet&asset=${USDC}`, { headers });
console.log(`GET /price → ${price.status}`);

await shutdown(); // export now; a long-running backend exports every 60 s instead
