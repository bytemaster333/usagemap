// SPDX-License-Identifier: Apache-2.0
// Processes of the alert-mailer integration tests: a capture server standing in for the mail system, and workerd
// running the two production modules with test/workerd/config.capnp.

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const HERE = import.meta.dirname;
// The platform binary itself (not the bin shim, which would outlive kill()).
const WORKERD = (createRequire(import.meta.url)("workerd") as { default: string }).default;

export interface Captured {
  from: string;
  to: string;
  raw: string;
}

/** A capture server standing in for the mail system; `mode.unavailable` makes it answer 503. */
export async function startCapture(): Promise<{
  server: Server;
  port: number;
  messages: Captured[];
  mode: { unavailable: boolean };
}> {
  const messages: Captured[] = [];
  const mode = { unavailable: false };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      if (mode.unavailable) {
        res.writeHead(503).end();
        return;
      }
      messages.push(JSON.parse(body) as Captured);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, messages, mode };
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Starts workerd with the test configuration; resolves once it answers. */
export async function startWorkerd(
  capturePort: number,
): Promise<{ proc: ChildProcess; url: string; output: () => string }> {
  const port = await freePort();
  let out = "";
  const proc = spawn(
    WORKERD,
    [
      "serve",
      join(HERE, "workerd", "config.capnp"),
      `--socket-addr=http=127.0.0.1:${port}`,
      `--external-addr=capture=127.0.0.1:${capturePort}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stdout?.on("data", (c: Buffer) => {
    out += c.toString();
  });
  proc.stderr?.on("data", (c: Buffer) => {
    out += c.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`workerd exited: ${out}`);
    try {
      await fetch(`${url}/healthz`);
      return { proc, url, output: () => out };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proc.kill();
  throw new Error(`workerd did not start: ${out}`);
}
