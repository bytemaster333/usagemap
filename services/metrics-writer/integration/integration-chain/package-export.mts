// SPDX-License-Identifier: Apache-2.0
// Records one live OTLP/HTTP JSON export of the three integration packages in one backend process, through the OTel
// JS SDK's OTLPMetricExporter into a local sink (usage: node package-export.mts <out.json>):
//   - @usagemap/partner-otel: partnerFetch over a fetch that answers locally (the classified URL is the real
//     partner URL), success / 4xx / 5xx / an unknown route;
//   - @usagemap/payments-otel: instrumentX402 and instrumentMppx on servers that expose the real hook API
//     (registration methods only); the scenario fires the hooks with x402 / MPP contexts shaped like the real ones;
//   - @usagemap/anchor-otel: the real Wallet SDK 6.x against the package's in-process mock anchor (SEP-1/10/12/
//     24/6), as packages/anchor-otel/test/wallet-sdk.test.ts.
// The anchor side (tools/ap-listener) needs Kafka; it is covered by the writer's Collector test with its shapes.

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(import.meta.dirname, "../../../..");
const out = process.argv[2];
if (!out) throw new Error("usage: node package-export.mts <out.json>");

const from = (pkg: string) => createRequire(join(repo, "packages", pkg, "package.json"));
const load = async (pkg: string, mod: string) => import(pathToFileURL(from(pkg).resolve(mod)).href);
const { OTLPMetricExporter } = await load(
  "partner-otel",
  "@opentelemetry/exporter-metrics-otlp-http",
);
const { resourceFromAttributes } = await load("partner-otel", "@opentelemetry/resources");
const { MeterProvider, PeriodicExportingMetricReader } = await load(
  "partner-otel",
  "@opentelemetry/sdk-metrics",
);
const partner = await import(pathToFileURL(join(repo, "packages/partner-otel/src/index.ts")).href);
const payments = await import(
  pathToFileURL(join(repo, "packages/payments-otel/src/index.ts")).href
);
const anchorOtel = await import(
  pathToFileURL(join(repo, "packages/anchor-otel/src/index.ts")).href
);
const mock = await import(
  pathToFileURL(join(repo, "packages/anchor-otel/test/mock-anchor.ts")).href
);
const walletSdk = await load("anchor-otel", "@stellar/typescript-wallet-sdk");
const { Keypair } = await load("anchor-otel", "@stellar/stellar-sdk");
const axios = (await load("anchor-otel", "axios")).default;

const ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"; // testnet USDC SAC

// --- the sink and partner answers
const bodies: string[] = [];
const srv = createServer((req, res) => {
  let s = "";
  req.on("data", (c) => {
    s += c;
  });
  req.on("end", () => {
    if (req.url === "/v1/metrics") bodies.push(s);
    const p = req.url ?? "/";
    res.writeHead(p.includes("missing") ? 404 : p.includes("down") ? 503 : 200, {
      "content-type": "application/json",
    });
    res.end("{}");
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const reader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
  exportIntervalMillis: 3_600_000,
});
const provider = new MeterProvider({
  readers: [reader],
  resource: resourceFromAttributes({ "service.name": "integration-dapp-api" }),
});

const anchorSrv = await mock.startMockAnchor();
try {
  // --- partner calls
  const local: typeof fetch = (input, init) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    return fetch(`${base}${u.pathname}${u.search}`, init);
  };
  const pf = partner.partnerFetch(local, {
    meter: provider.getMeter(partner.SCOPE_NAME, partner.SCOPE_VERSION),
  });
  await pf("https://api.soroswap.finance/quote?network=mainnet", { method: "POST", body: "{}" });
  await pf("https://api.soroswap.finance/quote?network=mainnet", { method: "POST", body: "{}" });
  await pf("https://api.bridge.xyz/v0/customers/cus_1/missing");
  await pf("https://api.koywe.com/api/v1/orders/down");
  await pf(`https://api.core.allbridge.io/check/SRB/${ACCOUNT}`);

  // --- payments: servers exposing the real hook registration API
  const pm = provider.getMeter(payments.SCOPE_NAME, payments.SCOPE_VERSION);
  type Hook = (ctx: unknown) => Promise<void> | void;
  const hooks: Record<string, Hook[]> = {};
  const reg = (k: string) => (h: Hook) => {
    hooks[k] = [...(hooks[k] ?? []), h];
    return () => {};
  };
  const x402 = {
    onAfterVerify: reg("afterVerify"),
    onVerifyFailure: reg("verifyFailure"),
    onAfterSettle: reg("afterSettle"),
    onSettleFailure: reg("settleFailure"),
    onVerifiedPaymentCanceled: reg("canceled"),
  };
  const http = { server: x402, onProtectedRequest: reg("protected") };
  if (!payments.instrumentX402Http(http, { meter: pm, amountBuckets: true }).instrumented)
    throw new Error("x402 not instrumented");
  const mppx = {
    onChallengeCreated: reg("challenge"),
    onPaymentSuccess: reg("success"),
    onPaymentFailed: reg("failed"),
  };
  if (!payments.instrumentMppx(mppx, { meter: pm, amountBuckets: true }).instrumented)
    throw new Error("mppx not instrumented");
  const fire = async (k: string, ...args: unknown[]) => {
    for (const h of hooks[k] ?? []) await (h as (...a: unknown[]) => unknown)(...args);
  };
  const USDC = USDC_SAC;
  const requirements = {
    scheme: "exact",
    network: "stellar:testnet",
    asset: USDC,
    amount: "50000",
  };
  await fire("protected", { paymentHeader: undefined }, { accepts: [requirements] });
  await fire("protected", { paymentHeader: undefined }, { accepts: [requirements] });
  await fire("afterVerify", { requirements, result: { isValid: true } });
  await fire("afterSettle", { requirements, result: { amount: "50000" } });
  await fire("afterVerify", {
    requirements,
    result: { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" },
  });
  const mppReq = {
    amount: "1000000",
    currency: "XLM",
    methodDetails: { network: "stellar:testnet" },
  };
  await fire("challenge", { method: { name: "stellar", intent: "charge" }, request: mppReq });
  await fire("success", { method: { name: "stellar", intent: "charge" }, request: mppReq });

  // --- anchors: the real Wallet SDK against the mock anchor
  const client = axios.create();
  const wallet = new walletSdk.Wallet({
    stellarConfiguration: walletSdk.StellarConfiguration.TestNet(),
    applicationConfiguration: new walletSdk.ApplicationConfiguration(
      walletSdk.DefaultSigner,
      client,
    ),
  });
  const am = provider.getMeter(anchorOtel.SCOPE_NAME, anchorOtel.SCOPE_VERSION);
  if (!anchorOtel.instrumentWalletSdk(wallet, { meter: am }).instrumented)
    throw new Error("wallet not instrumented");
  const anchor = wallet.anchor({ homeDomain: anchorSrv.homeDomain, allowHttp: true });
  const kp = walletSdk.SigningKeypair.fromSecret(Keypair.random().secret());
  const authToken = await (await anchor.sep10()).authenticate({ accountKp: kp });
  const sep24 = anchor.sep24();
  await sep24.deposit({ assetCode: "USDC", authToken });
  await sep24.getTransactionBy({ authToken, id: "tx-dep" });
  anchorSrv.depositStatus = "completed";
  await sep24.getTransactionBy({ authToken, id: "tx-dep" });

  await provider.forceFlush();
} finally {
  await provider.shutdown();
  await anchorSrv.close();
  srv.closeAllConnections();
  srv.close();
}
const body = bodies[0];
if (!body) throw new Error("the packages exported nothing");
for (const leak of [ACCOUNT, USDC_SAC, "cus_1", "127.0.0.1", "tx-dep", '"50000"'])
  if (body.includes(leak)) throw new Error(`leak in export: ${leak}`);
writeFileSync(out, body);
console.log(`package export: ${body.length} bytes`);
