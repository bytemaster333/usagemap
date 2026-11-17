// SPDX-License-Identifier: Apache-2.0
// The SSRF-safe domain verifier (ADR-0015 L1, data-model §8.4). Pure network code, no database. Proofs:
//   dns_txt     TXT at `_scf-verify.<host>` contains `scf-verify=<token>`
//   well_known  `https://<host>/.well-known/scf-verify.txt` answers 200 with body `<token>`
//   meta_tag    `https://<host>/` answers 200 with HTML containing `<meta name="scf-site-verification" content="<token>">`
// Rules for the HTTPS methods: HTTPS only; the host is resolved here (A and AAAA) and refused when ANY address is not a
// public unicast address (address.ts); the connection goes to the resolved address itself, with SNI and certificate
// validation against the host, so a second resolution cannot swap in another address; redirects are never followed;
// at most 64 KiB of body; one overall deadline (5 s). Bodies, tokens and addresses are never logged or returned —
// the result is one closed result code.

import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { cpMetrics } from "../obs/metrics.ts";
import { isPublicAddress } from "./address.ts";

export type VerifyMethod = "dns_txt" | "well_known" | "meta_tag";

export type ResultCode =
  | "OK"
  | "DNS_NXDOMAIN"
  | "DNS_NO_TXT"
  | "DNS_SERVFAIL"
  | "TOKEN_MISMATCH"
  | "HTTP_STATUS"
  | "HTTP_REDIRECT_REFUSED"
  | "PRIVATE_ADDRESS_REFUSED"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "TLS_ERROR"
  | "META_NOT_FOUND";

export interface VerifierOptions {
  /** Resolvers (`ip` or `ip:port`); default: the system's. */
  dnsServers?: string[] | undefined;
  /** Overall deadline per check (default 5000 ms). */
  timeoutMs?: number;
  /** Body limit (default 64 KiB). */
  maxBytes?: number;
  /** HTTPS port (default 443). */
  port?: number;
  /** Extra trusted CA bundle (tests). Default: the system's roots. */
  ca?: string | Buffer | undefined;
  /**
   * Tests only: where to open the TCP connection for an address that already passed the address policy. The policy
   * is always applied to the resolved address, never to the dial target.
   */
  dial?: ((address: string, port: number) => { host: string; port: number }) | undefined;
}

export interface Verifier {
  verify(method: VerifyMethod, host: string, token: string): Promise<ResultCode>;
}

/** One HTTPS GET under the verifier's rules (public addresses only, no redirects, size and time bounds). */
export type FetchResult = { kind: "ok"; body: string } | { kind: "code"; code: ResultCode };

export interface TextFetcher {
  fetchText(host: string, path: string): Promise<FetchResult>;
}

const META_NAME = "scf-site-verification";

class Deadline {
  readonly #until: number;
  constructor(ms: number) {
    this.#until = Date.now() + ms;
  }
  remaining(): number {
    return Math.max(0, this.#until - Date.now());
  }
  race<T>(p: Promise<T>): Promise<T | "timeout"> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), this.remaining());
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }
}

function dnsCode(err: unknown): ResultCode {
  const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
  if (code === "ENOTFOUND") return "DNS_NXDOMAIN";
  if (code === "ENODATA") return "DNS_NO_TXT";
  if (code === "ETIMEOUT") return "TIMEOUT";
  return "DNS_SERVFAIL";
}

/** Finds every `<meta …>` tag naming `scf-site-verification` and returns their `content` values. */
export function metaContents(html: string): string[] {
  const out: string[] = [];
  const tagRe = /<meta\b([^>]*)>/gi;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    const attrs = new Map<string, string>();
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    const body = m[1] as string;
    for (let a = attrRe.exec(body); a !== null; a = attrRe.exec(body)) {
      attrs.set((a[1] as string).toLowerCase(), (a[2] ?? a[3] ?? a[4] ?? "").trim());
    }
    if (attrs.get("name")?.toLowerCase() === META_NAME && attrs.has("content"))
      out.push(attrs.get("content") as string);
  }
  return out;
}

export class DomainVerifier implements Verifier, TextFetcher {
  readonly #opts: Required<Omit<VerifierOptions, "dnsServers" | "ca" | "dial">> &
    Pick<VerifierOptions, "dnsServers" | "ca" | "dial">;

  constructor(opts: VerifierOptions = {}) {
    this.#opts = {
      timeoutMs: opts.timeoutMs ?? 5000,
      maxBytes: opts.maxBytes ?? 64 * 1024,
      port: opts.port ?? 443,
      dnsServers: opts.dnsServers,
      ca: opts.ca,
      dial: opts.dial,
    };
  }

  #resolver(deadline: Deadline): Resolver {
    const r = new Resolver({
      timeout: Math.max(100, Math.min(deadline.remaining(), 2000)),
      tries: 2,
    });
    if (this.#opts.dnsServers?.length) r.setServers(this.#opts.dnsServers);
    return r;
  }

  async verify(method: VerifyMethod, host: string, token: string): Promise<ResultCode> {
    const deadline = new Deadline(this.#opts.timeoutMs);
    try {
      if (method === "dns_txt") return await this.#dnsTxt(host, token, deadline);
      const path = method === "well_known" ? "/.well-known/scf-verify.txt" : "/";
      const r = await this.#fetch(host, path, deadline);
      if (r.kind === "code") return r.code;
      if (method === "well_known") return r.body.trim() === token ? "OK" : "TOKEN_MISMATCH";
      const contents = metaContents(r.body);
      if (contents.length === 0) return "META_NOT_FOUND";
      return contents.includes(token) ? "OK" : "TOKEN_MISMATCH";
    } catch {
      return "TIMEOUT";
    }
  }

  /** `https://<host><path>` under the same SSRF rules as the HTTPS proofs (used for `stellar.toml`, SEP-1). */
  async fetchText(host: string, path: string): Promise<FetchResult> {
    try {
      return await this.#fetch(host, path, new Deadline(this.#opts.timeoutMs));
    } catch {
      return { kind: "code", code: "TIMEOUT" };
    }
  }

  async #dnsTxt(host: string, token: string, deadline: Deadline): Promise<ResultCode> {
    const res = await deadline.race(
      this.#resolver(deadline)
        .resolveTxt(`_scf-verify.${host}`)
        .then(
          (records) => ({ records }),
          (err: unknown) => ({ code: dnsCode(err) }),
        ),
    );
    if (res === "timeout") return "TIMEOUT";
    if ("code" in res) return res.code;
    if (res.records.length === 0) return "DNS_NO_TXT";
    const want = `scf-verify=${token}`;
    return res.records.some((chunks) => chunks.join("").trim() === want) ? "OK" : "TOKEN_MISMATCH";
  }

  /** A and AAAA of the host; every address must be public. */
  async #addresses(host: string, deadline: Deadline): Promise<string[] | ResultCode> {
    if (isIP(host) !== 0) return "PRIVATE_ADDRESS_REFUSED"; // hosts are names; never a literal address
    const r = this.#resolver(deadline);
    const settle = (p: Promise<string[]>) =>
      p.then(
        (a) => ({ a, err: undefined as unknown }),
        (err: unknown) => ({ a: [] as string[], err }),
      );
    const both = await deadline.race(
      Promise.all([settle(r.resolve4(host)), settle(r.resolve6(host))]),
    );
    if (both === "timeout") return "TIMEOUT";
    const [v4, v6] = both;
    const all = [...v4.a, ...v6.a];
    if (all.length === 0) {
      const codes = [v4.err, v6.err].filter((e) => e !== undefined).map(dnsCode);
      if (codes.includes("TIMEOUT")) return "TIMEOUT";
      if (codes.includes("DNS_SERVFAIL")) return "DNS_SERVFAIL";
      return "DNS_NXDOMAIN";
    }
    if (!all.every(isPublicAddress)) {
      const loopback = all.some((a) => a === "::1" || a.startsWith("127."));
      cpMetrics.verifierBlocked(loopback ? "loopback" : "private");
      return "PRIVATE_ADDRESS_REFUSED";
    }
    return all;
  }

  async #fetch(host: string, path: string, deadline: Deadline): Promise<FetchResult> {
    const addrs = await this.#addresses(host, deadline);
    if (typeof addrs === "string") return { kind: "code", code: addrs };
    let last: FetchResult = { kind: "code", code: "TIMEOUT" };
    for (const address of addrs) {
      if (deadline.remaining() <= 0) return { kind: "code", code: "TIMEOUT" };
      last = await this.#get(host, address, path, deadline);
      // Only a connection that never got established moves on to the next address.
      if (!(last.kind === "code" && last.code === "TIMEOUT" && deadline.remaining() > 0))
        return last;
    }
    return last;
  }

  #get(host: string, address: string, path: string, deadline: Deadline): Promise<FetchResult> {
    const target = this.#opts.dial?.(address, this.#opts.port) ?? {
      host: address,
      port: this.#opts.port,
    };
    return new Promise<FetchResult>((resolve) => {
      let done = false;
      let tlsUp = false;
      const finish = (r: FetchResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        req.destroy();
        resolve(r);
      };
      const req = request(
        {
          host: target.host,
          port: target.port,
          path,
          method: "GET",
          servername: host, // SNI and certificate identity: the host, never the address
          headers: {
            host,
            accept: path === "/" ? "text/html" : "text/plain",
            "accept-encoding": "identity",
            "user-agent": "scf-domain-verifier/1",
          },
          agent: false,
          rejectUnauthorized: true,
          ...(this.#opts.ca ? { ca: this.#opts.ca } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400)
            return finish({ kind: "code", code: "HTTP_REDIRECT_REFUSED" });
          if (status !== 200) return finish({ kind: "code", code: "HTTP_STATUS" });
          const declared = Number(res.headers["content-length"] ?? "0");
          if (declared > this.#opts.maxBytes) return finish({ kind: "code", code: "TOO_LARGE" });
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > this.#opts.maxBytes) return finish({ kind: "code", code: "TOO_LARGE" });
            chunks.push(c);
          });
          res.on("end", () => finish({ kind: "ok", body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", () => finish({ kind: "code", code: "TIMEOUT" }));
        },
      );
      req.on("socket", (s) => {
        s.once("secureConnect", () => {
          tlsUp = true;
        });
      });
      req.on("error", (err: NodeJS.ErrnoException) => {
        const code = String(err.code ?? "");
        const tls =
          tlsUp ||
          /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_|HOSTNAME|ALTNAME|EPROTO/.test(code) ||
          /certificate|tls|ssl/i.test(err.message);
        finish({ kind: "code", code: tls && !tlsUp ? "TLS_ERROR" : "TIMEOUT" });
      });
      const timer = setTimeout(
        () => finish({ kind: "code", code: "TIMEOUT" }),
        deadline.remaining(),
      );
      req.end();
    });
  }
}
