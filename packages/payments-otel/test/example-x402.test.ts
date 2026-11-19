// SPDX-License-Identifier: Apache-2.0
// Runs examples/api-x402 as a real process (Express + @x402/express + the built package + the OTLP/HTTP exporter)
// against a local facilitator stand-in and a local OTLP receiver, pays like an agent would, stops it with SIGTERM
// and checks exactly what arrived. Needs `pnpm install` in examples/ (own workspace): `pnpm run test:example`.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertClean } from "./helpers.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../../../examples/api-x402/", import.meta.url));
const PAYEE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAYER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TX = "c".repeat(64);

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
const listen = async (s: Server) => {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return (s.address() as AddressInfo).port;
};

let facilitator: Server;
let otlp: Server;
let app: ChildProcess;
let base = "";
const otlpBodies: string[] = [];
const facilitatorCalls: string[] = [];

beforeAll(async () => {
  if (!existsSync(`${EXAMPLE}node_modules/@x402/express`))
    throw new Error("examples/api-x402 is not installed: run `pnpm install` in examples/");
  execFileSync(
    process.execPath,
    [`${PKG}node_modules/typescript/bin/tsc`, "-p", "tsconfig.build.json"],
    {
      cwd: PKG,
      stdio: "inherit",
    },
  );

  facilitator = createServer(async (req, res) => {
    const path = req.url ?? "";
    facilitatorCalls.push(`${req.method} ${path}`);
    const send = (o: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (path === "/supported")
      return send({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "stellar:testnet",
            extra: { areFeesSponsored: true },
          },
        ],
        extensions: [],
        signers: {},
      });
    const b = JSON.parse(await body(req)) as { paymentPayload: PaymentPayload };
    const marker = String(b.paymentPayload.payload.transaction);
    if (path === "/verify")
      return send(
        marker.includes("bad")
          ? {
              isValid: false,
              invalidReason: "invalid_exact_stellar_payload_wrong_amount",
              payer: PAYER,
            }
          : { isValid: true, payer: PAYER },
      );
    if (path === "/settle")
      return send({
        success: true,
        payer: PAYER,
        transaction: TX,
        network: "stellar:testnet",
        amount: "100000",
      });
    res.writeHead(404).end();
  });
  otlp = createServer(async (req, res) => {
    otlpBodies.push(await body(req));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const fPort = await listen(facilitator);
  const oPort = await listen(otlp);

  app = spawn(process.execPath, ["--import", "./otel.mjs", "server.mjs"], {
    cwd: EXAMPLE,
    env: {
      PATH: process.env.PATH ?? "",
      PORT: "0",
      PAY_TO: PAYEE,
      FACILITATOR_URL: `http://127.0.0.1:${fPort}`,
      OTEL_SERVICE_NAME: "paid-api",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${oPort}/v1/metrics`,
      OTEL_METRIC_EXPORT_INTERVAL: "600000",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    app.stdout?.on("data", (d: Buffer) => {
      const m = /listening on (\d+)/.exec(d.toString());
      if (m) resolve(Number(m[1]));
    });
    app.once("exit", (c) => reject(new Error(`example exited ${c}`)));
  });
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(() => {
  app?.kill("SIGKILL");
  facilitator?.close();
  otlp?.close();
});

async function pay(marker: string) {
  const unpaid = await fetch(`${base}/report?session=abc`);
  expect(unpaid.status).toBe(402);
  const pr = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
  const accepted = pr.accepts[0];
  if (!accepted) throw new Error("no accepts");
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: { transaction: `AAAA${marker}` },
  };
  return fetch(`${base}/report`, {
    headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
  });
}

describe("examples/api-x402", () => {
  it("exports exact payment counts over OTLP on SIGTERM, with nothing identifying", async () => {
    const ok = await pay("ok");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ report: "XLM/USDC daily summary" });
    expect((await pay("bad")).status).toBe(402);
    expect((await fetch(`${base}/health`)).status).toBe(200);

    app.kill("SIGTERM");
    const [code] = (await once(app, "exit")) as [number | null];
    expect(code).toBe(0);
    expect(facilitatorCalls).toContain("POST /settle");

    const raw = otlpBodies.join("\n");
    // no payer, payee, hash, amount, URL or query (timestamps are the only long digit strings OTLP itself sends)
    const untimed = raw.replace(/"(startTime|time)UnixNano":"\d+"/g, "");
    assertClean(untimed.replaceAll(`"service.name"`, ""));
    for (const s of [PAYER, PAYEE, TX, "100000", "session=abc", "/report"])
      expect(untimed).not.toContain(s);
    type KV = { key: string; value: { stringValue?: string } };
    type DP = { attributes: KV[]; asInt?: string | number; asDouble?: number };
    const dps: Record<string, number> = {};
    for (const b of otlpBodies) {
      const j = JSON.parse(b) as {
        resourceMetrics: {
          scopeMetrics: {
            scope: { name: string };
            metrics: { name: string; sum?: { dataPoints: DP[] } }[];
          }[];
        }[];
      };
      for (const rm of j.resourceMetrics)
        for (const sm of rm.scopeMetrics)
          for (const m of sm.metrics) {
            if (m.name !== "payment.server.events") continue;
            expect(sm.scope.name).toBe("@usagemap/payments-otel");
            for (const dp of m.sum?.dataPoints ?? []) {
              const a = Object.fromEntries(
                dp.attributes.map((kv) => [kv.key, kv.value.stringValue]),
              );
              const key = `${a["payment.stage"]}|${a["payment.network"]}|${a["payment.asset"] ?? ""}|${a["error.type"] ?? ""}`;
              dps[key] = Number(dp.asInt ?? dp.asDouble ?? 0);
            }
          }
    }
    expect(dps).toEqual({
      "required|stellar:testnet||": 2,
      "verified|stellar:testnet|USDC|": 1,
      "settled|stellar:testnet|USDC|": 1,
      "failed|stellar:testnet|USDC|invalid_exact_stellar_payload_wrong_amount": 1,
    });
  });
});
