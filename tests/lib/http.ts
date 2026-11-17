// SPDX-License-Identifier: Apache-2.0
// Minimal HTTP client with full control over the request headers (node:http/https; no dependency). Scripted
// clients need exactly the headers they choose — fetch() adds its own (User-Agent, Sec-Fetch-*, Accept-Language).

import { readFileSync } from "node:fs";
import http, { type OutgoingHttpHeaders } from "node:http";
import https from "node:https";

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  ms: number;
}

export interface ReqOpts {
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer | undefined;
  timeoutMs?: number;
  /** TLS: CA file to trust ("" = accept any certificate — throwaway test stacks only). */
  caFile?: string;
  /** TLS SNI and Host header (the gateway's certificate names the public ingest hosts). */
  servername?: string;
  agent?: http.Agent | https.Agent;
}

const caCache = new Map<string, Buffer>();
function ca(file: string): Buffer {
  let b = caCache.get(file);
  if (!b) {
    b = readFileSync(file);
    caCache.set(file, b);
  }
  return b;
}

export function request(url: string, o: ReqOpts = {}): Promise<Res> {
  const u = new URL(url);
  const isTls = u.protocol === "https:";
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { ...(o.headers ?? {}) };
    if (o.servername) headers.host = o.servername;
    if (o.body !== undefined) headers["content-length"] = Buffer.byteLength(o.body);
    const opts: https.RequestOptions = {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      host: u.hostname,
      port: u.port || (isTls ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: o.timeoutMs ?? 10_000,
      ...(o.agent ? { agent: o.agent } : {}),
    };
    if (isTls) {
      if (o.servername) opts.servername = o.servername;
      if (o.caFile) opts.ca = ca(o.caFile);
      else opts.rejectUnauthorized = false;
    }
    const req = (isTls ? https : http).request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          ms: performance.now() - t0,
        }),
      );
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${o.timeoutMs ?? 10_000} ms`)));
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

export function insecureGet(url: string, timeoutMs = 5000): Promise<Res> {
  return request(url, { timeoutMs, caFile: "" });
}
