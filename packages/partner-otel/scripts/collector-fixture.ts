// SPDX-License-Identifier: Apache-2.0
// Writes collector/processor/scfsanitizeprocessor/testdata/sdk/partner-otel.metrics.json: one OTLP/HTTP JSON export
// request exactly as this package + the OTel JS SDK send it, for a backend session calling several partner APIs
// (success, 4xx, 5xx, timeout, an unknown route, a forced partner). The partner hosts are answered locally: the
// fetch below rewrites them to a local server, so the classified URL is the real partner URL. The Collector's golden
// test sanitises the file (go test -run TestPartnerFixtureGolden -update). Run: node scripts/collector-fixture.ts
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { partnerFetch, SCOPE_NAME, SCOPE_VERSION } from "../src/index.ts";

const ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const KEY = "sk_live_0123456789abcdef";

const bodies: string[] = [];
const srv = createServer((req, res) => {
  let s = "";
  req.on("data", (c) => {
    s += c;
  });
  req.on("end", () => {
    if (req.url === "/v1/metrics") bodies.push(s);
    const p = req.url ?? "/";
    if (p.includes("hang")) return;
    const status = p.includes("missing")
      ? 404
      : p.includes("down")
        ? 503
        : p.includes("limited")
          ? 429
          : 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const exporter = new OTLPMetricExporter({ url: `${base}/v1/metrics` });
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
const provider = new MeterProvider({
  readers: [reader],
  resource: resourceFromAttributes({
    "service.name": "partner-dapp-api",
    "deployment.environment.name": "test",
  }),
});
const meter = provider.getMeter(SCOPE_NAME, SCOPE_VERSION);
const local: typeof fetch = (input, init) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  return fetch(`${base}${u.pathname}${u.search}`, init);
};
const f = partnerFetch(local, { meter });
try {
  await f(`https://api.soroswap.finance/quote?network=testnet&apikey=${KEY}`, {
    method: "POST",
    body: "{}",
  });
  await f("https://api.soroswap.finance/quote/build?network=mainnet", { method: "POST" });
  await f(`https://api.defindex.io/vault/CAVAULT/deposit?network=mainnet&caller=${ACCOUNT}`, {
    method: "POST",
  });
  await f("https://dev.api.trustlesswork.com/escrow/single-release/fund-escrow", {
    method: "POST",
  });
  await f("https://api.bridge.xyz/v0/customers/cus_1/missing");
  await f("https://api.sandbox.bridge.xyz/v0/transfers/limited");
  await f("https://api.koywe.com/api/v1/orders/down");
  await f("https://api.koywe.com/api/v1/orders/hang", { signal: AbortSignal.timeout(100) }).catch(
    () => {},
  );
  await f(`https://api.core.allbridge.io/check/SRB/${ACCOUNT}`);
  await partnerFetch(local, { meter, partner: "aquarius", network: "testnet" })(
    "https://aqua-proxy.my-app.example/api/external/v2/find-path/",
    { method: "POST" },
  );
  await f("https://horizon.stellar.org/accounts"); // not a partner: not measured
  await provider.forceFlush();
} finally {
  await provider.shutdown();
  srv.closeAllConnections();
  srv.close();
}
const body = bodies[0] ?? "";
for (const leak of [ACCOUNT, KEY, "cus_1", "CAVAULT", "127.0.0.1", "apikey", "aqua-proxy"])
  if (body.includes(leak)) throw new Error(`leak in export: ${leak}`);
const out = new URL(
  "../../../collector/processor/scfsanitizeprocessor/testdata/sdk/partner-otel.metrics.json",
  import.meta.url,
);
writeFileSync(out, `${JSON.stringify(JSON.parse(body), null, 1)}\n`);
console.log("wrote", out.pathname);
