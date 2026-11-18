// SPDX-License-Identifier: Apache-2.0
// A local OTLP/HTTP receiver and the canary request used by the runtime shims.
import { createServer, type Server } from "node:http";

export interface Received {
  path: string | undefined;
  auth: string | undefined;
  type: string | undefined;
  body: string;
}

export async function startReceiver(status = 200): Promise<{
  base: string;
  received: Received[];
  setStatus(s: number): void;
  close(): Promise<void>;
}> {
  const received: Received[] = [];
  let code = status;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      received.push({
        path: req.url,
        auth: req.headers.authorization,
        type: req.headers["content-type"],
        body,
      });
      res.writeHead(code, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    received,
    setStatus: (s) => {
      code = s;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const ACCOUNT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
export const CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

/** Values that must never leave the runtime. */
export const CANARIES = [
  "canary-ua",
  "203.0.113.9",
  "canary-cookie",
  "canary-token",
  "canary-header",
  "client_domain",
  "lang=",
  "wallet.example",
  ACCOUNT,
  CONTRACT,
  "7f8a2c1e",
  "alice@example.com",
];

export const CANARY_HEADERS = {
  "user-agent": "Mozilla/5.0 canary-ua",
  "cf-connecting-ip": "203.0.113.9",
  "x-forwarded-for": "203.0.113.9",
  cookie: "session=canary-cookie",
  authorization: "Bearer canary-token",
  "x-custom": "canary-header",
};

export function req(method: string, path: string): Request {
  return new Request(`https://anchor.example${path}`, { method, headers: CANARY_HEADERS });
}

export interface Point {
  key: string;
  count: number;
}

/** "METHOD route status" → count, from one OTLP/JSON body. */
export function points(body: string): Record<string, number> {
  const j = JSON.parse(body) as {
    resourceMetrics: {
      scopeMetrics: {
        metrics: {
          histogram: {
            dataPoints: { attributes: { value: Record<string, string> }[]; count: string }[];
          };
        }[];
      }[];
    }[];
  };
  const out: Record<string, number> = {};
  for (const rm of j.resourceMetrics)
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics)
        for (const p of m.histogram.dataPoints) {
          const key = p.attributes.map((a) => a.value.stringValue ?? a.value.intValue).join(" ");
          out[key] = (out[key] ?? 0) + Number(p.count);
        }
  return out;
}

export function assertNoLeak(body: string): string | undefined {
  return CANARIES.find((c) => body.includes(c));
}
