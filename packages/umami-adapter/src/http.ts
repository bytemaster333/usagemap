// SPDX-License-Identifier: Apache-2.0
// Minimal JSON-over-HTTP(S) client for Umami behind the engine proxy (wire-formats §c.5, §j). Standard library only:
// supports per-node mutual TLS (C-60) and a hard per-call timeout (C-112(6)). It never logs, and errors never carry
// response bodies, tokens or query strings — only the method, the path template and the status.

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface TlsOptions {
  /** PEM client certificate of this node (C-60). */
  cert: string | Buffer;
  /** PEM private key of this node. */
  key: string | Buffer;
  /** PEM CA bundle of the private CA. */
  ca: string | Buffer;
  /** Expected server name when it differs from the URL host. */
  servername?: string;
}

export interface HttpClientOptions {
  /** e.g. `https://core-a.internal:8443` (the engine proxy) or `http://127.0.0.1:3000` in tests. */
  baseUrl: string;
  tls?: TlsOptions;
  /** Per-call timeout in milliseconds; default 5000 (C-112(6)). */
  timeoutMs?: number;
  /** Upper bound for a response body; default 8 MiB. */
  maxResponseBytes?: number;
}

export interface CallOptions {
  method: "GET" | "POST" | "DELETE";
  /** Path with placeholders already substituted (used on the wire). */
  path: string;
  /** Path template (used in errors), e.g. `/api/websites/{websiteId}/stats`. */
  template: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  bearer?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** Base class: every adapter error names the call by template, never by concrete URL or body. */
export class UmamiError extends Error {
  readonly template: string;
  readonly method: string;
  constructor(message: string, method: string, template: string) {
    super(message);
    this.name = "UmamiError";
    this.method = method;
    this.template = template;
  }
}

/** Umami answered with an unexpected status. `status` 401/403 = the credential is not allowed (isolation). */
export class UmamiHttpError extends UmamiError {
  readonly status: number;
  /** Umami's `error.message` when it is one of a few known, non-sensitive strings; otherwise undefined. */
  readonly engineMessage: string | undefined;
  constructor(method: string, template: string, status: number, engineMessage?: string) {
    super(`umami ${method} ${template} answered ${status}`, method, template);
    this.name = "UmamiHttpError";
    this.status = status;
    this.engineMessage = engineMessage;
  }
}

/**
 * The engine already holds an object with our id but it belongs to another owner (a website id in use in
 * another team). Never treated as success: the caller reports it and does not use the object.
 */
export class UmamiConflictError extends UmamiError {
  constructor(method: string, template: string, what: string) {
    super(`umami ${method} ${template}: ${what}`, method, template);
    this.name = "UmamiConflictError";
  }
}

/** The call did not complete in time or the connection failed: callers fall back to the rollups (C-112(6)). */
export class UmamiUnavailableError extends UmamiError {
  readonly reason: "timeout" | "connection" | "too_large" | "bad_response";
  constructor(method: string, template: string, reason: UmamiUnavailableError["reason"]) {
    super(`umami ${method} ${template} unavailable (${reason})`, method, template);
    this.name = "UmamiUnavailableError";
    this.reason = reason;
  }
}

/** Engine messages we may surface (S-01). Anything else is dropped so no engine detail leaks into our logs. */
const KNOWN_ENGINE_MESSAGES = new Set([
  "ID already in use.",
  "Website not found.",
  "incorrect-username-password",
  "Unauthorized",
]);

export function engineMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as { error?: unknown; message?: unknown };
  const nested =
    typeof b.error === "object" && b.error !== null
      ? (b.error as { message?: unknown }).message
      : b.error;
  for (const c of [b.message, nested]) {
    if (typeof c === "string" && KNOWN_ENGINE_MESSAGES.has(c)) return c;
  }
  return undefined;
}

export class HttpClient {
  readonly #base: URL;
  readonly #tls: TlsOptions | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(opts: HttpClientOptions) {
    this.#base = new URL(opts.baseUrl);
    if (this.#base.protocol !== "http:" && this.#base.protocol !== "https:") {
      throw new Error("umami baseUrl must be http(s)");
    }
    if (opts.tls && this.#base.protocol !== "https:")
      throw new Error("mutual TLS needs an https baseUrl");
    this.#tls = opts.tls;
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#maxBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
  }

  /** Performs the call; resolves for every HTTP status (the caller decides), rejects with UmamiUnavailableError. */
  call(opts: CallOptions): Promise<HttpResponse> {
    const url = new URL(opts.path, this.#base);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { accept: "application/json" };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    const isHttps = url.protocol === "https:";
    const fail = (reason: UmamiUnavailableError["reason"]) =>
      new UmamiUnavailableError(opts.method, opts.template, reason);

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const onResponse = (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > this.#maxBytes) {
            req.destroy();
            done(() => reject(fail("too_large")));
            return;
          }
          chunks.push(c);
        });
        res.on("error", () => done(() => reject(fail("connection"))));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          const type = String(res.headers["content-type"] ?? "");
          if (
            text.length > 0 &&
            (type.includes("json") || text.startsWith("{") || text.startsWith("["))
          ) {
            try {
              body = JSON.parse(text);
            } catch {
              done(() => reject(fail("bad_response")));
              return;
            }
          }
          done(() => resolve({ status: res.statusCode ?? 0, body }));
        });
      };
      const common = { method: opts.method, headers, agent: false as const };
      const req = isHttps
        ? httpsRequest(
            url,
            {
              ...common,
              ...(this.#tls
                ? {
                    cert: this.#tls.cert,
                    key: this.#tls.key,
                    ca: this.#tls.ca,
                    ...(this.#tls.servername ? { servername: this.#tls.servername } : {}),
                  }
                : {}),
            },
            onResponse,
          )
        : httpRequest(url, common, onResponse);
      const timer = setTimeout(() => {
        req.destroy();
        done(() => reject(fail("timeout")));
      }, timeoutMs);
      req.on("error", () => done(() => reject(fail("connection"))));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Like call(), but rejects with UmamiHttpError unless the status is one of `ok`. */
  async expect(opts: CallOptions, ok: readonly number[] = [200]): Promise<unknown> {
    const res = await this.call(opts);
    if (!ok.includes(res.status)) {
      throw new UmamiHttpError(opts.method, opts.template, res.status, engineMessage(res.body));
    }
    return res.body;
  }
}
