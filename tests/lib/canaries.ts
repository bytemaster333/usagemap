// SPDX-License-Identifier: Apache-2.0
// Canary values: unique, recognisable values the suites send through the public front doors where personal data
// could enter (User-Agent, query string, page title, path, referrer path, custom-event properties, OTLP attributes,
// tokens). The data-inventory suite then searches every store and log for them. They are recorded in
// <work>/canaries.json so a later process (the inventory suite, or a re-run) knows them.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Canary } from "./privacy-scan.ts";
import { randomStrKey } from "./stellar.ts";

export function tag(): string {
  return randomBytes(6).toString("hex");
}

export interface CanarySet {
  /** Token that ends the canary User-Agent (the whole UA must never be stored). */
  uaToken: string;
  userAgent: string;
  /** Query-string value (key scf_q). */
  queryValue: string;
  pageTitle: string;
  /** A checksum-valid secret seed placed in a path and in a custom-event property. */
  seed: string;
  /** An end user's account placed in a path and a property. */
  endUserAccount: string;
  /** Referrer path fragment (only the referrer host may be kept). */
  referrerPath: string;
  /** JWT-shaped value in a custom-event property. */
  jwt: string;
  /** E-mail address in a path. */
  email: string;
}

export function newCanaries(): CanarySet {
  const t = tag();
  const ua = `CanaryUA${t}`;
  return {
    uaToken: ua,
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ${ua}`,
    queryValue: `cq${tag()}${tag()}`,
    pageTitle: `CanaryTitle ${tag()}`,
    seed: randomStrKey("S"),
    endUserAccount: randomStrKey("G"),
    referrerPath: `refpath${tag()}`,
    jwt: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnk${tag()}.${tag()}${tag()}`,
    email: `canary.${tag()}@example.org`,
  };
}

export function asCanaries(c: CanarySet): Canary[] {
  return [
    { label: "user_agent (canary token)", value: c.uaToken },
    { label: "query_string", value: c.queryValue },
    { label: "page_title", value: c.pageTitle },
    { label: "seed", value: c.seed },
    { label: "end_user_g_address", value: c.endUserAccount },
    { label: "referrer_path", value: c.referrerPath },
    { label: "jwt", value: c.jwt },
    { label: "email", value: c.email },
  ];
}

/** Appends canaries (with their origin) to <work>/canaries.json. */
export function recordCanaries(workDir: string, origin: string, list: Canary[]): void {
  mkdirSync(workDir, { recursive: true });
  const f = join(workDir, "canaries.json");
  const all: (Canary & { origin: string })[] = existsSync(f)
    ? JSON.parse(readFileSync(f, "utf8"))
    : [];
  for (const c of list) all.push({ ...c, origin });
  writeFileSync(f, JSON.stringify(all, null, 2));
}

export function loadCanaries(workDir: string): (Canary & { origin: string })[] {
  const f = join(workDir, "canaries.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
}
