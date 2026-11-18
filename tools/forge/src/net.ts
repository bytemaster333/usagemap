// SPDX-License-Identifier: Apache-2.0
// HTTPS client for the forge tool (Node standard library). Talks to the public ingest host exactly as a script on the
// internet would; for a local stack, `connect` sends the connection to another address while keeping the host name
// for SNI and the Host header (like `curl --resolve`), and `ca` trusts the stack's private CA.

import { readFileSync } from "node:fs";
import https from "node:https";

export interface Target {
  /** Base URL of the ingest host, e.g. https://e1.usagemap.dev */
  base: URL;
  /** host:port to connect to instead of resolving the base host (local stacks). */
  connect?: { host: string; port: number } | undefined;
  /** PEM CA bundle to trust in addition to nothing else (local stacks); default: the system roots. */
  ca?: string | undefined;
  /** Skip certificate verification (never against production; only for throwaway stacks). */
  insecure?: boolean;
}

export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The body bytes as received (hashing must not go through a string). */
  raw: Buffer;
  ms: number;
}

export function parseConnect(v: string | undefined): Target["connect"] {
  if (!v) return undefined;
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(v);
  if (!m) throw new Error(`--connect must be host:port, got ${v}`);
  return { host: (m[1] as string).replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

export function loadCa(file: string | undefined): string | undefined {
  return file ? readFileSync(file, "utf8") : undefined;
}

export function request(
  t: Target,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number } = {},
): Promise<Res> {
  const started = performance.now();
  const port = t.base.port ? Number(t.base.port) : 443;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        host: t.connect?.host ?? t.base.hostname,
        port: t.connect?.port ?? port,
        servername: t.base.hostname,
        path,
        headers: {
          host: t.base.port ? `${t.base.hostname}:${t.base.port}` : t.base.hostname,
          ...(opts.headers ?? {}),
          ...(opts.body !== undefined
            ? { "content-length": String(Buffer.byteLength(opts.body)) }
            : {}),
        },
        ...(t.ca ? { ca: t.ca } : {}),
        rejectUnauthorized: !t.insecure,
        agent: false,
        timeout: opts.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined)
              headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          }
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers,
            raw,
            body: raw.toString("utf8"),
            ms: performance.now() - started,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${method} ${path}: timed out`)));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Headers that describe the connection, not the answer (they legitimately differ between HTTP/1.1 and HTTP/2). */
export const TRANSPORT_HEADERS = new Set([
  "date",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "alt-svc",
  ":status",
]);

/** The parts of an answer a client could use to tell outcomes apart: status, body and non-transport headers. */
export function observable(r: { status: number; headers: Record<string, string>; body: string }): {
  status: number;
  body: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    const key = k.toLowerCase();
    if (!TRANSPORT_HEADERS.has(key)) headers[key] = v;
  }
  return {
    status: r.status,
    body: r.body,
    headers: Object.fromEntries(Object.entries(headers).sort()),
  };
}
