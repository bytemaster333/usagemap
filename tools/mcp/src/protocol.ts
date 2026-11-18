// SPDX-License-Identifier: Apache-2.0
// Model Context Protocol over stdio, implemented directly on JSON-RPC 2.0 (no SDK dependency).
//
// Dual-era server (spec 2026-07-28, "Versioning and Compatibility"; checked against modelcontextprotocol.io on
// 2026-11-19):
//   - modern (2026-07-28): stateless; every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and
//     `…/clientCapabilities`; `server/discover` is implemented; results carry `resultType: "complete"` and
//     `_meta["io.modelcontextprotocol/serverInfo"]`; an unsupported version is answered `-32022` with
//     `data: {supported, requested}`; a request missing a required `_meta` field is `-32602`.
//   - legacy (2025-11-25 and earlier): the `initialize` handshake selects legacy semantics for this stdio process.
// Framing (stdio transport): one JSON-RPC message per line, UTF-8, no embedded newlines; stdout carries only protocol
// messages, diagnostics go to stderr.

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_VERSIONS: string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedVersion: -32022,
} as const;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ServerSpec {
  name: string;
  version: string;
  instructions: string;
  tools: ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

type Id = string | number;
interface Msg {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface Session {
  /** Version negotiated by `initialize` (legacy era), if any. */
  legacyVersion?: string;
}

function rpcError(id: Id | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function isId(v: unknown): v is Id {
  return (typeof v === "string" && v.length > 0) || (typeof v === "number" && Number.isInteger(v));
}

/**
 * Handles one decoded JSON-RPC message; returns the response object, or `null` when nothing is to be sent
 * (notifications, responses to requests we never send).
 */
export async function handle(spec: ServerSpec, s: Session, msg: unknown): Promise<object | null> {
  if (Array.isArray(msg))
    return rpcError(null, ERR.invalidRequest, "JSON-RPC batches are not supported");
  if (typeof msg !== "object" || msg === null)
    return rpcError(null, ERR.invalidRequest, "not a JSON-RPC message");
  const m = msg as Msg;
  if (m.jsonrpc !== "2.0")
    return rpcError(isId(m.id) ? m.id : null, ERR.invalidRequest, 'jsonrpc must be "2.0"');
  if (typeof m.method !== "string") {
    // A response from the client (we never send requests) — ignore.
    if ("result" in m || "error" in m) return null;
    return rpcError(isId(m.id) ? m.id : null, ERR.invalidRequest, "missing method");
  }
  const isNotification = !("id" in m);
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, …: nothing to answer
  if (!isId(m.id))
    return rpcError(null, ERR.invalidRequest, "id must be a non-empty string or an integer");
  const id = m.id;
  const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<
    string,
    unknown
  >;
  const meta = (
    typeof params._meta === "object" && params._meta !== null ? params._meta : {}
  ) as Record<string, unknown>;

  if (m.method === "initialize") {
    const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const v = (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LEGACY_VERSIONS[0];
    s.legacyVersion = v;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: spec.name, version: spec.version },
        instructions: spec.instructions,
      },
    };
  }

  // Era of this request: modern when it carries the per-request version, legacy after `initialize`.
  const modernVersion = meta[META_VERSION];
  let modern: boolean;
  if (modernVersion !== undefined) {
    if (typeof modernVersion !== "string")
      return rpcError(id, ERR.invalidParams, `${META_VERSION} must be a string`);
    if (!(MODERN_VERSIONS as readonly string[]).includes(modernVersion))
      return rpcError(id, ERR.unsupportedVersion, "Unsupported protocol version", {
        supported: SUPPORTED_VERSIONS,
        requested: modernVersion,
      });
    if (typeof meta[META_CAPS] !== "object" || meta[META_CAPS] === null)
      return rpcError(id, ERR.invalidParams, `missing required _meta field ${META_CAPS}`);
    modern = true;
  } else if (s.legacyVersion) {
    modern = false;
  } else if (m.method === "server/discover") {
    return rpcError(id, ERR.invalidParams, `missing required _meta field ${META_VERSION}`);
  } else {
    return rpcError(
      id,
      ERR.invalidParams,
      `missing required _meta field ${META_VERSION} (or send initialize first); supported versions: ${SUPPORTED_VERSIONS.join(", ")}`,
    );
  }

  const ok = (result: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    result: modern
      ? {
          resultType: "complete",
          ...result,
          _meta: { [META_SERVER]: { name: spec.name, version: spec.version } },
        }
      : result,
  });

  switch (m.method) {
    case "server/discover":
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        instructions: spec.instructions,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: spec.tools });
    case "tools/call": {
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== "string" || !spec.tools.some((t) => t.name === name))
        return rpcError(id, ERR.invalidParams, `Unknown tool: ${String(name).slice(0, 64)}`);
      if (typeof args !== "object" || args === null || Array.isArray(args))
        return rpcError(id, ERR.invalidParams, "arguments must be an object");
      const r = await spec.call(name, args as Record<string, unknown>);
      return ok({ ...r, isError: r.isError ?? false });
    }
    default:
      return rpcError(id, ERR.methodNotFound, `Method not found: ${m.method.slice(0, 64)}`);
  }
}

/**
 * Runs the stdio loop: reads newline-delimited JSON from `input`, writes one line per response to `output`.
 * Requests are processed concurrently; each response is written whole (no interleaving within a line).
 */
export function serveStdio(
  spec: ServerSpec,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  log: (s: string) => void,
): Promise<void> {
  const session: Session = {};
  let buf = "";
  const pending = new Set<Promise<void>>();
  const write = (o: object) => output.write(`${JSON.stringify(o)}\n`);
  const onLine = (line: string) => {
    if (line.trim() === "") return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write(rpcError(null, ERR.parse, "Parse error"));
      return;
    }
    const p = handle(spec, session, msg)
      .then((r) => {
        if (r) write(r);
      })
      .catch((e: unknown) => {
        log(`internal error: ${(e as Error).message}`);
        const id = (msg as Msg)?.id;
        write(rpcError(isId(id) ? id : null, ERR.internal, "Internal error"));
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  input.setEncoding?.("utf8");
  return new Promise((resolve) => {
    input.on("data", (chunk: string | Buffer) => {
      buf += chunk.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        onLine(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 4 * 1024 * 1024) {
        write(rpcError(null, ERR.invalidRequest, "message too large"));
        buf = "";
      }
    });
    input.on("end", () => {
      if (buf.trim()) onLine(buf);
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
