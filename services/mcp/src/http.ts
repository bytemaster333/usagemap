// SPDX-License-Identifier: Apache-2.0
// MCP Streamable HTTP transport of the hosted UsageMap MCP server (https://app.usagemap.dev/mcp).
//
// Spec basis (checked on modelcontextprotocol.io, 2026-11-19): "Streamable HTTP" of revision 2026-07-28 and of
// 2025-11-25. One endpoint, POST only; every reply is a single `application/json` body (a client MUST accept JSON or
// SSE; this server never streams, because every tool answers with one result and sends no server-to-client messages).
//
//   2026-07-28 (modern, stateless): no sessions; every POST carries `MCP-Protocol-Version` (equal to the body's
//     `_meta["io.modelcontextprotocol/protocolVersion"]`), `Mcp-Method` (equal to `method`) and, for tools/call,
//     `Mcp-Name` (equal to `params.name`, optionally `=?base64?…?=`). Missing or different → 400 + JSON-RPC -32020
//     (HeaderMismatch); unsupported version → 400 + -32022; unknown method → 404 + -32601. GET/DELETE → 405.
//   2025-11-25 and older (legacy): `initialize` answers without minting an `Mcp-Session-Id` (sessions are optional and
//     this server keeps no per-client state); later requests are identified by their `MCP-Protocol-Version` header
//     (absent: 2025-03-26, as that spec prescribes); an unsupported header version → 400.
//   Both: notifications (and, legacy, client responses) → 202 without a body; batches → 400; an `Origin` header that
//     is not allow-listed → 403 (DNS rebinding); a client that closes the connection cancels its upstream calls.
//
// Security: every request needs the caller's own key, or an OAuth access token for this server, as
// `Authorization: Bearer` (src/auth.ts, src/oauth.ts); each request gets its own tool registry bound to that credential
// (tools/mcp/src/tools.ts, hosted mode; src/tenant-tools.ts for a tenant OAuth grant), so a tool can only do what the
// key or grant can do at the control plane, which authorises, applies the tenant restriction and privacy rules, and
// audits operator reads again on every call. OAuth: protected resource metadata (RFC 9728) at
// /.well-known/oauth-protected-resource<path> and at the root; 401 answers carry `resource_metadata` and `scope`. Limits: per key, per client subnet for failed authentications, in-flight cap, 1 MiB bodies.
// Logs: one JSON line per request with method, tool name, key kind and public key id, status and duration — never a
// key, header, address, query string, tool argument or tool result.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { redact } from "../../../tools/mcp/src/api.ts";
import {
  ERR,
  handle,
  LEGACY_VERSIONS,
  MODERN_VERSIONS,
  type ServerSpec,
  type Session,
  SUPPORTED_VERSIONS,
} from "../../../tools/mcp/src/protocol.ts";
import { createServer as createSpec } from "../../../tools/mcp/src/tools.ts";
import { AuthError, Authenticator, bearer, type Caller } from "./auth.ts";
import type { Config } from "./config.ts";
import { Inflight, subnetKey, WindowLimiter } from "./limits.ts";
import { challenge, metadataPath, redactOAuth, resourceMetadata, TokenExchanger } from "./oauth.ts";
import { createTenantSpec } from "./tenant-tools.ts";

/** Operator tools an operator OAuth grant does not get: the share-key metrics document needs an API key. */
const OAUTH_OPERATOR_EXCLUDED = new Set(["project_metrics_document"]);
const OAUTH_OPERATOR_SCOPES = ["registry:read", "web:read", "api:read"];

/** `redact` of tools/mcp plus OAuth token shapes. */
function scrub(s: string): string {
  return redactOAuth(redact(s));
}

export const MAX_BODY = 1024 * 1024;
export const HEADER_MISMATCH = -32020;
const UNAUTHORIZED = -32001;
const RATE_LIMITED = -32002;
const UNAVAILABLE = -32003;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const NAMED_METHODS: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

export type Logger = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export function jsonLogger(out: NodeJS.WritableStream = process.stdout): Logger {
  return (level, msg, fields = {}) => {
    out.write(
      `${scrub(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }))}\n`,
    );
  };
}

export interface McpHttpDeps {
  config: Config;
  version: string;
  log: Logger;
  fetch?: typeof fetch | undefined;
  now?: () => number;
}

/** True when the raw URL, or its once-decoded form, carries something key-shaped. */
export function keyInUrl(url: string): boolean {
  const re = /scfa_(op|ing|pub|oat|ort|odt|oac)_/;
  if (re.test(url)) return true;
  try {
    return re.test(decodeURIComponent(url));
  } catch {
    return false;
  }
}

/** Decodes an `Mcp-Name`-style header value (`=?base64?…?=` or plain). */
export function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return Buffer.from(m[1] as string, "base64").toString("utf8");
  } catch {
    return null;
  }
}

class HttpError extends Error {
  readonly status: number;
  readonly code: number;
  readonly headers: Record<string, string>;
  readonly data: unknown;
  constructor(
    status: number,
    code: number,
    message: string,
    headers: Record<string, string> = {},
    data?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.data = data;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Status of a JSON-RPC error answer (2026-07-28 table; legacy: protocol-level errors 400, others 200). */
function statusOf(code: number, modern: boolean): number {
  if (
    code === ERR.parse ||
    code === ERR.invalidRequest ||
    code === HEADER_MISMATCH ||
    code === -32021 ||
    code === ERR.unsupportedVersion
  )
    return 400;
  if (!modern) return 200;
  if (code === ERR.methodNotFound) return 404;
  if (code === ERR.internal) return 500;
  return 200;
}

export function createMcpHttpServer(deps: McpHttpDeps): Server {
  const { config: cfg, log } = deps;
  const now = deps.now ?? Date.now;
  const exchanger = cfg.oauth
    ? new TokenExchanger({
        controlPlaneUrl: cfg.controlPlaneUrl,
        settings: cfg.oauth,
        cacheMs: cfg.introspectCacheMs,
        fetch: deps.fetch,
        now,
        onMisconfigured: () =>
          log(
            "error",
            "the control plane refused the OAuth exchange client (check MCP_OAUTH_EXCHANGE_SECRET)",
          ),
      })
    : null;
  const prmPaths = cfg.oauth
    ? new Set([metadataPath(cfg.oauth.resource), "/.well-known/oauth-protected-resource"])
    : new Set<string>();
  const auth = new Authenticator({
    controlPlaneUrl: cfg.controlPlaneUrl,
    allowInsecureUpstream: cfg.allowInsecureUpstream,
    cacheMs: cfg.introspectCacheMs,
    fetch: deps.fetch,
    now,
    exchanger,
  });
  const keyLimit = new WindowLimiter(cfg.keyRatePerMin, { now });
  const failLimit = new WindowLimiter(cfg.authFailPerMin, { now });
  const inflight = new Inflight(cfg.maxInflight);
  const trusted = new Set(cfg.trustProxy.map(normaliseIp));

  function clientAddress(req: IncomingMessage): string {
    const peer = normaliseIp(req.socket.remoteAddress ?? "");
    if (!trusted.has(peer)) return peer;
    const xff = header(req, "x-forwarded-for");
    const last = xff
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    return last && isIP(last) ? normaliseIp(last) : peer;
  }

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = header(req, "origin");
    if (!origin) return;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
    res.setHeader("Vary", "Origin");
  }

  function send(
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ): void {
    if (res.headersSent) return;
    const text = body === undefined ? "" : scrub(JSON.stringify(body));
    res.writeHead(status, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    });
    res.end(text);
  }

  const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });

  async function readBody(req: IncomingMessage): Promise<string> {
    const declared = Number(header(req, "content-length") ?? "0");
    if (declared > MAX_BODY)
      throw new HttpError(413, ERR.invalidRequest, "request body too large (max 1 MiB)");
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > MAX_BODY)
        throw new HttpError(413, ERR.invalidRequest, "request body too large (max 1 MiB)");
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function serveMcp(
    req: IncomingMessage,
    res: ServerResponse,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const address = clientAddress(req);
    const subnet = subnetKey(address);
    const blocked = failLimit.blocked(subnet);
    if (!blocked.allowed)
      throw new HttpError(
        429,
        RATE_LIMITED,
        "too many failed authentications from this network; try again later",
        {
          "retry-after": String(blocked.retryAfter),
        },
      );

    let caller: Caller;
    const upstreamHeaders: Record<string, string> = cfg.forwardClientAddress
      ? { "x-forwarded-for": address }
      : {};
    try {
      caller = await auth.authenticate(bearer(header(req, "authorization")), upstreamHeaders);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      if (e.status === 401) {
        failLimit.hit(subnet);
        const given = header(req, "authorization") !== undefined;
        throw new HttpError(401, UNAUTHORIZED, e.message, {
          "www-authenticate": cfg.oauth
            ? challenge(cfg.oauth, given)
            : given
              ? 'Bearer realm="usagemap", error="invalid_token"'
              : 'Bearer realm="usagemap"',
        });
      }
      throw new HttpError(e.status, e.status === 429 ? RATE_LIMITED : UNAVAILABLE, e.message, {
        "retry-after": String(e.retryAfter ?? 5),
      });
    }
    fields.key_kind = caller.kind;
    fields.key_id = caller.keyId;
    if (caller.grant) fields.grant_kind = caller.grant.kind;

    const rate = keyLimit.hit(`${caller.kind}:${caller.keyId}`);
    if (!rate.allowed)
      throw new HttpError(
        429,
        RATE_LIMITED,
        `rate limit of ${cfg.keyRatePerMin} requests per minute for this key`,
        {
          "retry-after": String(rate.retryAfter),
        },
      );

    const ctype = header(req, "content-type") ?? "";
    if (!/^application\/json\s*(;|$)/i.test(ctype))
      throw new HttpError(415, ERR.invalidRequest, "Content-Type must be application/json");
    const accept = header(req, "accept");
    if (accept && !/application\/json|text\/event-stream|\*\/\*|application\/\*/i.test(accept))
      throw new HttpError(
        406,
        ERR.invalidRequest,
        "Accept must allow application/json (and text/event-stream)",
      );

    const raw = await readBody(req);
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      throw new HttpError(400, ERR.parse, "Parse error");
    }
    if (Array.isArray(msg))
      throw new HttpError(400, ERR.invalidRequest, "JSON-RPC batches are not supported");
    if (typeof msg !== "object" || msg === null)
      throw new HttpError(400, ERR.invalidRequest, "not a JSON-RPC message");
    const m = msg as Record<string, unknown>;
    const method = typeof m.method === "string" ? m.method : undefined;
    fields.method = method?.slice(0, 64);

    const hv = header(req, "mcp-protocol-version");
    const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<
      string,
      unknown
    >;
    const meta = (
      typeof params._meta === "object" && params._meta !== null ? params._meta : {}
    ) as Record<string, unknown>;
    const bv = meta[META_VERSION];
    const modern =
      bv !== undefined || (hv !== undefined && (MODERN_VERSIONS as readonly string[]).includes(hv));

    // Client responses (legacy only) and notifications: accepted, nothing to answer.
    if (method === undefined && ("result" in m || "error" in m)) {
      if (modern)
        throw new HttpError(400, ERR.invalidRequest, "clients must not send JSON-RPC responses");
      fields.status = 202;
      return send(res, 202, undefined);
    }
    if (method !== undefined && !("id" in m)) {
      fields.status = 202;
      return send(res, 202, undefined);
    }

    const session: Session = {};
    if (bv !== undefined) {
      if (hv === undefined)
        throw new HttpError(
          400,
          HEADER_MISMATCH,
          "missing MCP-Protocol-Version header",
          {},
          { header: "MCP-Protocol-Version" },
        );
      if (hv !== bv)
        throw new HttpError(
          400,
          HEADER_MISMATCH,
          "MCP-Protocol-Version header does not match _meta protocolVersion",
          {},
          {
            header: "MCP-Protocol-Version",
          },
        );
      const mh = header(req, "mcp-method");
      if (mh !== method)
        throw new HttpError(
          400,
          HEADER_MISMATCH,
          mh === undefined
            ? "missing Mcp-Method header"
            : "Mcp-Method header does not match method",
          {},
          {
            header: "Mcp-Method",
          },
        );
      const field = method ? NAMED_METHODS[method] : undefined;
      if (field) {
        const nh = header(req, "mcp-name");
        const decoded = nh === undefined ? undefined : decodeHeaderValue(nh);
        if (decoded === undefined || decoded === null || decoded !== params[field])
          throw new HttpError(
            400,
            HEADER_MISMATCH,
            nh === undefined
              ? "missing Mcp-Name header"
              : "Mcp-Name header does not match the request",
            {},
            {
              header: "Mcp-Name",
            },
          );
      }
    } else if (method !== "initialize") {
      if (hv === undefined) session.legacyVersion = "2025-03-26";
      else if ((LEGACY_VERSIONS as readonly string[]).includes(hv)) session.legacyVersion = hv;
      else if (!(MODERN_VERSIONS as readonly string[]).includes(hv))
        throw new HttpError(
          400,
          ERR.unsupportedVersion,
          "Unsupported protocol version",
          {},
          {
            supported: SUPPORTED_VERSIONS,
            requested: hv.slice(0, 32),
          },
        );
      // a modern header without body metadata falls through: handle() answers -32602 (missing _meta), sent as 400
    }
    fields.version =
      (typeof bv === "string" ? bv : undefined) ??
      session.legacyVersion ??
      (method === "initialize" ? "initialize" : hv);
    if (method === "tools/call" && typeof params.name === "string")
      fields.tool = params.name.slice(0, 64);

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const spec = specFor(caller, upstreamHeaders, abort.signal, req);
    const answer = (await handle(spec, session, msg)) as {
      error?: { code: number };
      result?: { isError?: boolean };
    } | null;
    if (!answer) {
      fields.status = 202;
      return send(res, 202, undefined);
    }
    const status = answer.error ? statusOf(answer.error.code, modern) : 200;
    if (answer.error) fields.rpc_error = answer.error.code;
    if (answer.result?.isError) fields.tool_error = true;
    fields.status = status;
    send(res, status, answer);
  }

  /** The tool registry of one request, bound to its caller's credential. */
  function specFor(
    caller: Caller,
    upstreamHeaders: Record<string, string>,
    signal: AbortSignal,
    req: IncomingMessage,
  ): ServerSpec {
    const common = {
      baseUrl: cfg.controlPlaneUrl,
      fetch: deps.fetch,
      allowInsecureHttp: cfg.allowInsecureUpstream,
      headers: upstreamHeaders,
      signal,
      userAgent: "usagemap-mcp-hosted/1",
    };
    const g = caller.grant;
    if (g?.kind === "tenant" && g.tenantId) {
      const token = bearer(header(req, "authorization"));
      return createTenantSpec(
        {
          ...common,
          token: g.delegated,
          tenantId: g.tenantId,
          onUnauthorized: () => exchanger?.forget(token),
        },
        deps.version,
      );
    }
    if (g?.kind === "operator") {
      const full = createSpec(
        { ...common, mode: "hosted", operatorKey: g.delegated, scopes: OAUTH_OPERATOR_SCOPES },
        deps.version,
      );
      return {
        ...full,
        tools: full.tools.filter((t) => !OAUTH_OPERATOR_EXCLUDED.has(t.name)),
        call: (name, args) =>
          OAUTH_OPERATOR_EXCLUDED.has(name)
            ? Promise.resolve({
                content: [{ type: "text", text: `unknown tool ${name}` }],
                isError: true,
              })
            : full.call(name, args),
      };
    }
    if (caller.kind === "oauth") throw new HttpError(401, UNAUTHORIZED, "unusable grant");
    return createSpec(
      {
        ...common,
        mode: "hosted",
        ...(caller.kind === "op"
          ? { operatorKey: caller.key, scopes: caller.scopes }
          : { shareKey: caller.key }),
      },
      deps.version,
    );
  }

  const server = createHttpServer(async (req, res) => {
    const started = now();
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const fields: Record<string, unknown> = {};
    try {
      if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        return res.end(req.method === "HEAD" ? undefined : "ok");
      }
      if (prmPaths.has(path) && cfg.oauth) {
        if (req.method !== "GET" && req.method !== "HEAD")
          return send(res, 405, { error: "method not allowed" }, { allow: "GET, HEAD" });
        // RFC 9728 §3: public metadata; any origin may read it (browser-based MCP clients).
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
        });
        return res.end(
          req.method === "HEAD" ? undefined : JSON.stringify(resourceMetadata(cfg.oauth)),
        );
      }
      if (path !== cfg.path) return send(res, 404, { error: "not found" });
      if (keyInUrl(url)) {
        fields.status = 400;
        return send(
          res,
          400,
          rpcError(
            null,
            ERR.invalidRequest,
            "an API key was sent in the URL: it is to be treated as compromised — revoke it and send keys only in Authorization: Bearer",
          ),
        );
      }
      const origin = header(req, "origin");
      if (origin !== undefined && !cfg.allowedOrigins.includes(origin)) {
        fields.status = 403;
        return send(res, 403, rpcError(null, ERR.invalidRequest, "Origin not allowed"));
      }
      cors(req, res);
      if (req.method === "OPTIONS") {
        fields.status = 204;
        return send(res, 204, undefined, {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id",
          "access-control-max-age": "600",
        });
      }
      if (req.method !== "POST") {
        fields.status = 405;
        return send(
          res,
          405,
          rpcError(null, ERR.invalidRequest, "Method Not Allowed: this endpoint accepts POST only"),
          {
            allow: "POST, OPTIONS",
          },
        );
      }
      if (!inflight.enter()) {
        fields.status = 503;
        return send(res, 503, rpcError(null, UNAVAILABLE, "server busy; try again shortly"), {
          "retry-after": "1",
        });
      }
      try {
        await serveMcp(req, res, fields);
      } finally {
        inflight.leave();
      }
    } catch (e) {
      if (e instanceof HttpError) {
        fields.status = e.status;
        fields.rpc_error = e.code;
        send(res, e.status, rpcError(null, e.code, e.message, e.data), e.headers);
      } else {
        fields.status = 500;
        log("error", "internal error", { error: (e as Error).message });
        send(res, 500, rpcError(null, ERR.internal, "Internal error"));
      }
    } finally {
      if (path === cfg.path) log("info", "mcp request", { ...fields, ms: now() - started });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 90_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function normaliseIp(a: string): string {
  return a.startsWith("::ffff:") && isIP(a.slice(7)) === 4 ? a.slice(7) : a;
}
