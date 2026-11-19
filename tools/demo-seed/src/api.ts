// SPDX-License-Identifier: Apache-2.0
// A minimal client of the public control-plane API through the portal origin (which proxies /v1/*): SEP-53 wallet
// sign-in, then the same calls the portal makes, with the CSRF rules of C-20 (Origin + `X-SCF-Request: 1` on every
// state-changing call). One session cookie per client; nothing is logged except the method and path of a failure.

import type { DemoKey } from "./stellar.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ApiClient {
  readonly base: string;
  #cookie = "";
  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Accept: "application/json", Origin: this.base };
      if (method !== "GET") headers["X-SCF-Request"] = "1";
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (this.#cookie) headers.Cookie = this.#cookie;
      const init: RequestInit = { method, headers, redirect: "manual" };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(`${this.base}${path}`, init);
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0];
        if (pair?.includes("=")) this.#cookie = pair;
      }
      if (res.status === 429 && attempt < 8) {
        const wait = Number(res.headers.get("retry-after") ?? "2");
        await sleep(Math.min(60, Number.isFinite(wait) ? wait : 2) * 1000 + 250);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new HttpError(method, path, res.status, text);
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  /** SEP-53 sign-in with a demo key (the "any wallet" path of the portal). */
  async signIn(key: DemoKey): Promise<void> {
    const ch = await this.call<{ challenge_id: string; message: string }>(
      "POST",
      "/v1/auth/stellar/challenge",
      { account: key.account, method: "sep53" },
    );
    await this.call("POST", "/v1/auth/stellar/verify", {
      challenge_id: ch.challenge_id,
      signature: key.signMessage(ch.message),
    });
  }
}

export interface TenantSummary {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  role: string;
}
