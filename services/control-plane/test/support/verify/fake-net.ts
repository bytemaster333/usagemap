// SPDX-License-Identifier: Apache-2.0
// Local stand-ins for the internet the domain verifier talks to: a UDP DNS server (A, AAAA, TXT; NXDOMAIN, SERVFAIL)
// and an HTTPS server with certificates from a throwaway test CA (generated with openssl). Standard library only.

import { execFileSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { parseIPv6 } from "../../../src/verify/address.ts";

export type DnsAnswer =
  | { a?: string[]; aaaa?: string[]; txt?: string[][] }
  | "NXDOMAIN"
  | "SERVFAIL"
  | "DROP";

/** Minimal authoritative DNS over UDP: answers from `records` (lower-case names, no trailing dot). */
export class FakeDns {
  readonly records = new Map<string, DnsAnswer>();
  readonly queries: string[] = [];
  #sock: Socket | undefined;
  port = 0;

  async start(): Promise<void> {
    const sock = createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      const out = this.#answer(msg);
      if (out) sock.send(out, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
    this.#sock = sock;
    this.port = (sock.address() as AddressInfo).port;
  }

  get server(): string {
    return `127.0.0.1:${this.port}`;
  }

  #answer(msg: Buffer): Buffer | undefined {
    if (msg.length < 12) return undefined;
    let off = 12;
    const labels: string[] = [];
    while (off < msg.length && msg[off] !== 0) {
      const len = msg[off] as number;
      labels.push(msg.subarray(off + 1, off + 1 + len).toString("ascii"));
      off += 1 + len;
    }
    off += 1;
    const qtype = msg.readUInt16BE(off);
    const question = msg.subarray(12, off + 4);
    const name = labels.join(".").toLowerCase();
    this.queries.push(`${name}/${qtype}`);
    const rec = this.records.get(name);
    if (rec === "DROP") return undefined;
    let rcode = 0;
    const answers: Buffer[] = [];
    if (rec === undefined || rec === "NXDOMAIN") rcode = 3;
    else if (rec === "SERVFAIL") rcode = 2;
    else {
      const rr = (type: number, data: Buffer) => {
        const h = Buffer.alloc(12);
        h.writeUInt16BE(0xc00c, 0);
        h.writeUInt16BE(type, 2);
        h.writeUInt16BE(1, 4);
        h.writeUInt32BE(60, 6);
        h.writeUInt16BE(data.length, 10);
        answers.push(Buffer.concat([h, data]));
      };
      if (qtype === 1) for (const a of rec.a ?? []) rr(1, Buffer.from(a.split(".").map(Number)));
      if (qtype === 28)
        for (const a of rec.aaaa ?? []) rr(28, Buffer.from(parseIPv6(a) as Uint8Array));
      if (qtype === 16)
        for (const t of rec.txt ?? [])
          rr(
            16,
            Buffer.concat(
              t.map((chunk) => Buffer.concat([Buffer.from([chunk.length]), Buffer.from(chunk)])),
            ),
          );
    }
    const header = Buffer.alloc(12);
    header.writeUInt16BE(msg.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8180 | rcode, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    return Buffer.concat([header, question, ...answers]);
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.#sock?.close(() => r()));
  }
}

export interface TestPki {
  ca: string;
  /** Certificate + key for each requested host name. */
  leaf(host: string): { cert: string; key: string };
  cleanup(): void;
}

export function makeTestPki(hosts: string[]): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "scf-verify-pki-"));
  const ossl = (args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  ossl([
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    join(dir, "ca.key"),
  ]);
  ossl([
    "req",
    "-x509",
    "-new",
    "-key",
    join(dir, "ca.key"),
    "-sha256",
    "-days",
    "2",
    "-subj",
    "/CN=scf verify test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-out",
    join(dir, "ca.pem"),
  ]);
  const leaves = new Map<string, { cert: string; key: string }>();
  for (const h of hosts) {
    const key = join(dir, `${h}.key`);
    ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
    ossl(["req", "-new", "-key", key, "-subj", `/CN=${h}`, "-out", join(dir, `${h}.csr`)]);
    writeFileSync(join(dir, `${h}.ext`), `subjectAltName=DNS:${h}\nextendedKeyUsage=serverAuth\n`);
    ossl([
      "x509",
      "-req",
      "-in",
      join(dir, `${h}.csr`),
      "-CA",
      join(dir, "ca.pem"),
      "-CAkey",
      join(dir, "ca.key"),
      "-set_serial",
      "0x01",
      "-days",
      "2",
      "-sha256",
      "-extfile",
      join(dir, `${h}.ext`),
      "-out",
      join(dir, `${h}.pem`),
    ]);
    leaves.set(h, {
      cert: readFileSync(join(dir, `${h}.pem`), "utf8"),
      key: readFileSync(key, "utf8"),
    });
  }
  return {
    ca: readFileSync(join(dir, "ca.pem"), "utf8"),
    leaf: (h) => {
      const l = leaves.get(h);
      if (!l) throw new Error(`no test certificate for ${h}`);
      return l;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type Route = (
  path: string,
) => { status: number; body?: string; headers?: Record<string, string> } | "hang";

/** HTTPS server presenting the certificate for the requested SNI name; answers per host from `routes`. */
export class FakeHttps {
  readonly routes = new Map<string, Route>();
  readonly hosts: string[] = [];
  #server: Server | undefined;
  port = 0;

  readonly pki: TestPki;
  readonly certHosts: string[];

  constructor(pki: TestPki, certHosts: string[]) {
    this.pki = pki;
    this.certHosts = certHosts;
  }

  async start(): Promise<void> {
    const ctx = new Map(this.certHosts.map((h) => [h, this.pki.leaf(h)]));
    const first = this.pki.leaf(this.certHosts[0] as string);
    const server = createServer(
      {
        cert: first.cert,
        key: first.key,
        SNICallback: (name, cb) => {
          // A host without its own certificate gets the first one (a name mismatch for the client).
          const l = ctx.get(name) ?? first;
          cb(null, createSecureContext(l));
        },
      },
      (req, res) => {
        const host = String(req.headers.host ?? "");
        this.hosts.push(host);
        const route = this.routes.get(host);
        const r = route ? route(req.url ?? "/") : { status: 404 };
        if (r === "hang") return; // never answers
        res.writeHead(r.status, r.headers ?? { "content-type": "text/plain" });
        res.end(r.body ?? "");
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    this.#server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((r) => this.#server?.close(() => r()));
  }
}

/** Public-looking addresses the tests resolve hosts to; the dial hook sends them to the local HTTPS server. */
export const PUBLIC_V4 = "8.8.4.4";
export const PUBLIC_V6 = "2606:4700:4700::1111";
