// SPDX-License-Identifier: Apache-2.0
// UsageMap MCP server (plan E8): a local stdio Model Context Protocol server over the read-only metrics APIs.
// Node standard library only; JSON-RPC implemented in src/protocol.ts (MCP 2026-07-28, with the 2025-11-25 initialize
// handshake for older clients). Configuration (environment):
//   USAGEMAP_API_URL            control-plane origin (default https://app.usagemap.dev); the only host contacted
//   USAGEMAP_OPERATOR_KEY_FILE  file holding an SCF-operator key scfa_op_… (preferred; or USAGEMAP_OPERATOR_KEY)
//   USAGEMAP_SHARE_KEY_FILE     file holding a tenant share key scfa_pub_… (or USAGEMAP_SHARE_KEY), optional
// Keys are never printed; stdout carries only protocol messages, diagnostics go to stderr.

import { loadKey, redact } from "./src/api.ts";
import { serveStdio } from "./src/protocol.ts";
import { createServer } from "./src/tools.ts";

const log = (s: string) => process.stderr.write(`usagemap-mcp: ${redact(s)}\n`);
const env = process.env;

function optionalKey(fileVar: string, valueVar: string, kind: "op" | "pub"): string | undefined {
  const file = env[fileVar];
  const value = env[valueVar];
  if (!file && !value) return undefined;
  return loadKey({ file, value }, kind);
}

let operatorKey: string | undefined;
let shareKey: string | undefined;
try {
  operatorKey = optionalKey("USAGEMAP_OPERATOR_KEY_FILE", "USAGEMAP_OPERATOR_KEY", "op");
  shareKey = optionalKey("USAGEMAP_SHARE_KEY_FILE", "USAGEMAP_SHARE_KEY", "pub");
} catch (e) {
  log((e as Error).message);
  process.exit(2);
}
const baseUrl = env.USAGEMAP_API_URL ?? "https://app.usagemap.dev";
let spec: ReturnType<typeof createServer>;
try {
  spec = createServer({ baseUrl, operatorKey, shareKey });
} catch (e) {
  log((e as Error).message);
  process.exit(2);
}
log(
  `serving ${spec.tools.length} read-only tools for ${new URL(baseUrl).origin} (operator key: ${operatorKey ? "yes" : "no"}, share key: ${shareKey ? "yes" : "no"})`,
);
await serveStdio(spec, process.stdin, process.stdout, log);
