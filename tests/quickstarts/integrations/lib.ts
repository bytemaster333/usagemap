// SPDX-License-Identifier: Apache-2.0
// Shared helpers of the integration-example suite (integrations/*.spec.ts): start an example as its README says, wait
// for it, stop it with SIGTERM; a recording HTTP stand-in for any endpoint (UsageMap's app-events edge, the control
// plane, a Stellar RPC, a partner API, an anchor); which examples a run selects.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "../../lib/env.ts";

export const EXAMPLES = join(REPO_ROOT, "examples");
export const exec = promisify(execFile);

/** QS_INTEGRATIONS=a,b limits a run to those examples (default: all). */
export function selected(id: string): boolean {
  const only = (process.env.QS_INTEGRATIONS ?? "").split(",").filter(Boolean);
  return only.length === 0 || only.includes(id);
}

/** A missing toolchain fails the example, unless QS_INTEGRATIONS_ALLOW_SKIP=1. */
export const allowSkip = process.env.QS_INTEGRATIONS_ALLOW_SKIP === "1";

export async function has(cmd: string, args = ["--version"]): Promise<boolean> {
  try {
    await exec(cmd, args, { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

export interface Proc {
  child: ChildProcess;
  /** stdout and stderr so far */
  log: () => string;
  /** resolves once the output matches, rejects on exit or timeout */
  waitFor: (re: RegExp, timeoutMs?: number) => Promise<void>;
  /** resolves with the exit code */
  exited: Promise<number | null>;
  /** SIGTERM (for a container: `docker stop`), then wait for the exit */
  stop: () => Promise<number | null>;
}

/** Starts a process (or a foreground `docker run --name <container>`). */
export function start(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; container?: string } = {},
): Proc {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const listeners = new Set<() => void>();
  const onData = (b: Buffer) => {
    out += b.toString();
    for (const l of listeners) l();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  let done = false;
  void exited.then(() => {
    done = true;
    for (const l of listeners) l();
  });
  const waitFor = (re: RegExp, timeoutMs = 60_000) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (re.test(out)) {
          cleanup();
          resolve();
        } else if (done) {
          cleanup();
          reject(new Error(`exited before ${re}:\n${out}`));
        }
      };
      const t = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${re}:\n${out}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(t);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });
  const stop = async () => {
    if (!done) {
      if (opts.container)
        await exec("docker", ["stop", "-t", "20", opts.container]).catch(() => {});
      else child.kill("SIGTERM");
    }
    const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const code = await exited;
    clearTimeout(t);
    return code;
  };
  return { child, log: () => out, waitFor, exited, stop };
}

/** Runs a command to completion; rejects with its output on a non-zero exit. */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = start(cmd, args, opts);
  const t = setTimeout(() => p.child.kill("SIGKILL"), opts.timeoutMs ?? 600_000);
  const code = await p.exited;
  clearTimeout(t);
  const log = p.log();
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}:\n${log}`);
  return { stdout: log, stderr: "", code: code ?? 0 };
}

/** Runs a command with `input` on stdin; resolves with stdout, stderr and the exit code (never rejects on exit). */
export function runWithInput(
  cmd: string,
  args: string[],
  input: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const t = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}

export interface Hit {
  method: string;
  path: string;
  /** lower-case header names */
  headerNames: string[];
  headers: Record<string, string>;
  body: string;
  /** parsed JSON body, when it parsed */
  json?: unknown;
}

export interface StandIn {
  url: string;
  port: number;
  hits: Hit[];
  close: () => Promise<void>;
}

export type Handler = (
  hit: Hit,
  res: ServerResponse,
  req: IncomingMessage,
) => void | boolean | Promise<void | boolean>;

/**
 * A recording HTTP server. `handler` answers a request (return `false` to fall through to the default `404`);
 * every request is recorded first. `host` defaults to 127.0.0.1; containers on the host network reach it there.
 */
export async function standIn(handler: Handler, port = 0, host = "127.0.0.1"): Promise<StandIn> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      const hit: Hit = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headerNames: Object.keys(req.headers).sort(),
        headers,
        body,
      };
      try {
        hit.json = JSON.parse(body);
      } catch {
        /* not JSON */
      }
      hits.push(hit);
      try {
        const handled = await handler(hit, res, req);
        if (handled === false && !res.headersSent)
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      } catch (e) {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

/** Polls `cond` until it is true (or throws after `timeoutMs`). */
export async function until(cond: () => boolean, timeoutMs = 30_000, what = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** `docker run` arguments for a short-lived container on the host network, as the backends suite runs them. */
export function dockerRun(name: string, env: Record<string, string>, extra: string[]): string[] {
  const uidgid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "host",
    "--user",
    uidgid,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    "HOME=/tmp",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...extra,
  ];
}
