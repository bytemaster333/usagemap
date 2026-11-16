// SPDX-License-Identifier: Apache-2.0
// Fastify instances for the public listener and the internal (edge) listener, with privacy-preserving logging:
// one line per request with the route TEMPLATE (never the concrete URL, so no ids or query strings), the method, the
// status and the duration. No IP address, no User-Agent, no header, no cookie, no token is ever logged.

import { randomUUID } from "node:crypto";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import Fastify, { type FastifyError, type FastifyInstance, LogController } from "fastify";
import { DB_UNAVAILABLE, pgCode } from "../db/database.ts";
import { ApiError, problemBody } from "./problem.ts";

export interface LogSink {
  write(line: string): void;
}

export interface ServerOptions {
  logLevel: string;
  problemBase: string;
  bodyLimit: number;
  trustProxy: string | boolean;
  /** Where log lines go (default: stdout). Tests capture it. */
  logStream?: LogSink;
  https?: HttpsServerOptions;
}

/** Maps database errors to problems without echoing constraint names or values. */
function fromPgError(err: unknown): ApiError | undefined {
  switch (pgCode(err)) {
    case "23505":
      return new ApiError("conflict");
    case "23514":
      return new ApiError("conflict");
    case "23503":
      return new ApiError("not_found");
    case "42501":
      return new ApiError("forbidden");
    case "22023":
    case "22P02":
      return new ApiError("validation_failed");
    // Statement or lock timeout, lost or refused connection, server shutdown, and no pooled connection within the pool
    // wait (DbUnavailableError): transient — 503 with Retry-After, never a bare 500.
    case "57014":
    case "55P03":
    case DB_UNAVAILABLE:
    case "08006":
    case "08003":
    case "08001":
    case "57P01":
      return new ApiError("unavailable", undefined, { retryAfter: 5 });
    default:
      return undefined;
  }
}

export function createServer(opts: ServerOptions): FastifyInstance {
  const options: Record<string, unknown> = {
    logger: {
      level: opts.logLevel,
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      // Replace Fastify's default serializers (which include the client address and the URL).
      serializers: {
        req: () => ({}),
        res: () => ({}),
        err: (e: Error & { code?: string }) => ({ type: e.name, code: e.code }),
      },
      base: { service: "control-plane" },
    },
    // Fastify's own request/response lines would include the URL and client address: off; onResponse logs instead.
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: opts.bodyLimit,
    trustProxy: opts.trustProxy,
    ...(opts.https ? { https: opts.https } : {}),
  };
  // The options object is assembled dynamically (https or not); Fastify's overloads cannot express that union.
  const app = Fastify(options) as unknown as FastifyInstance;

  // The request id is random per request (never taken from the client); it is echoed so support can correlate a
  // problem report with the audit row and the log line.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.addHook("onResponse", async (req, reply) => {
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? "unmatched",
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      "request",
    );
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    let api: ApiError;
    if (err instanceof ApiError) api = err;
    else if (
      err.code?.startsWith("FST_ERR_CTP") ||
      err.statusCode === 400 ||
      err.statusCode === 413 ||
      err.statusCode === 415
    ) {
      api = new ApiError("validation_failed", "malformed request body");
    } else {
      api = fromPgError(err) ?? new ApiError("internal_error");
      if (api.status >= 500) req.log.error({ err }, "request failed");
    }
    if (api.retryAfter) reply.header("Retry-After", String(api.retryAfter));
    for (const [k, v] of Object.entries(api.headers ?? {})) reply.header(k, v);
    void reply
      .code(api.status)
      .type("application/problem+json")
      .send(problemBody(api, opts.problemBase, req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .type("application/problem+json")
      .send(problemBody(new ApiError("not_found"), opts.problemBase, req.id));
  });

  return app;
}
