// SPDX-License-Identifier: Apache-2.0
// Mock of the gateway's protocol v1 for the Playwright fixture suites (wire-formats §a, §b). Every request the page
// makes to either ingest host is intercepted: tracker files are served from dist/<semver>/, `POST /v1/c` issues a
// real §b.1-shaped token with a real §b.2 proof-of-work target, and `POST /v1/e` is answered 202. Every request body
// — and every challenge response — is validated against the §a JSON Schemas; violations are collected in
// `problems` and fail the test through `expectClean()`. The proof submitted with each batch is verified the way the
// gateway does it (one PBKDF2 for the counter).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { DEFAULT_HOSTS, ROOT } from "../../scripts/build-config.ts";
import {
  type Issued,
  issue,
  validateChallengeRequest,
  validateChallengeResponse,
  validateEventBatch,
  verifyProof,
} from "../../test/protocol.ts";

export { SITE } from "../../test/protocol.ts";

export const [HOST_A, HOST_B] = DEFAULT_HOSTS;
export const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

interface ManifestFile {
  path: string;
  integrity: string;
}
const manifest = (): { files: ManifestFile[] } =>
  JSON.parse(readFileSync(join(ROOT, "dist", VERSION, "manifest.json"), "utf8")) as {
    files: ManifestFile[];
  };

/** The SRI string of a released classic-script file (`standard` or `strict`). */
export const integrity = (profile: "standard" | "strict"): string => {
  const f = manifest().files.find((x) => x.path === `${profile}.js`);
  if (!f) throw new Error(`manifest has no ${profile}.js — run the tracker build first`);
  return f.integrity;
};

/** The `<script>` tag a tenant pastes for a released file (README "Static HTML"). */
export const scriptTag = (profile: "standard" | "strict", site: string, extra = ""): string =>
  `<script src="${HOST_A}/lib/${VERSION}/${profile}.js" integrity="${integrity(profile)}" ` +
  `crossorigin="anonymous" data-site="${site}" ${extra} defer></script>`;

export type Event = Record<string, unknown> & { id: string; k: string; u: string };

export interface Seen {
  kind: "script" | "challenge" | "event";
  host: string;
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface MockGateway {
  seen: Seen[];
  issued: Issued[];
  /** Schema violations, unverifiable proofs and unexpected requests. Must stay empty. */
  problems: string[];
  /** All event batches, in arrival order. */
  batches(): Record<string, unknown>[];
  /** All events of all batches, in order. */
  events(): Event[];
  pageviews(): string[];
  challenges(): Seen[];
}

export interface GatewayOptions {
  /** Proof-of-work difficulty per challenge; default the contract's 512 × 1024 (§b.2). */
  cost?: number;
  max?: number;
}

/** Install the mock on both ingest hosts of the release build. Call before `page.goto`. */
export async function mockGateway(page: Page, opts: GatewayOptions = {}): Promise<MockGateway> {
  const seen: Seen[] = [];
  const issued: Issued[] = [];
  const problems: string[] = [];
  const cost = opts.cost ?? 512;
  const max = opts.max ?? 1024;
  const byToken = new Map<string, Issued>();

  const gw: MockGateway = {
    seen,
    issued,
    problems,
    batches: () => seen.filter((s) => s.kind === "event").map((s) => s.body ?? {}),
    events: () => gw.batches().flatMap((b) => (b.e as Event[] | undefined) ?? []),
    pageviews: () =>
      gw
        .events()
        .filter((e) => e.k === "pv")
        .map((e) => e.u),
    challenges: () => seen.filter((s) => s.kind === "challenge"),
  };

  for (const host of [HOST_A, HOST_B]) {
    await page.route(`${host}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const headers = await req.allHeaders();
      const origin = headers.origin ?? "";
      const cors = { "access-control-allow-origin": origin, vary: "Origin" };
      // Every version in the build output is served, as the gateways do (tracker.intentional-upgrade): the current one and the archived
      // releases (`releases/<semver>`, byte-identical), so pages pinned to an earlier release keep working.
      const lib = /^\/lib\/(\d+\.\d+\.\d+)\/(standard|strict)\.js$/.exec(url.pathname);
      if (req.method() === "GET" && url.pathname.startsWith("/lib/")) {
        seen.push({ kind: "script", host, method: "GET", url: req.url(), headers });
        const version = lib?.[1] ?? "";
        const file = `${lib?.[2]}.js`;
        if (!lib || !existsSync(join(ROOT, "dist", version, file)))
          return route.fulfill({ status: 404 });
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=31536000, immutable",
          },
          body: readFileSync(join(ROOT, "dist", version, file)),
        });
      }
      if (req.method() !== "POST" || (url.pathname !== "/v1/c" && url.pathname !== "/v1/e")) {
        problems.push(`unexpected request ${req.method()} ${req.url()}`);
        return route.fulfill({ status: 404 });
      }
      if (url.search || url.hash) problems.push(`query or fragment on ${req.url()}`);
      // Only fetch(): a sendBeacon() request is type `ping`, which EasyPrivacy blocks for third parties.
      if (req.resourceType() !== "fetch") {
        problems.push(`${url.pathname} sent as ${req.resourceType()}, not fetch`);
      }
      const raw = req.postData() ?? "";
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        problems.push(`not JSON: ${raw.slice(0, 200)}`);
        return route.fulfill({ status: 400, headers: cors, body: '{"error":"malformed"}' });
      }
      if (new TextEncoder().encode(raw).length > 8192) problems.push(`body > 8 KiB on ${url}`);
      if (headers.cookie !== undefined) problems.push(`cookie header sent to ${url}`);

      if (url.pathname === "/v1/c") {
        seen.push({ kind: "challenge", host, method: "POST", url: req.url(), body, headers });
        if (!validateChallengeRequest(body)) {
          problems.push(`/v1/c schema: ${JSON.stringify(validateChallengeRequest.errors)}`);
          return route.fulfill({ status: 400, headers: cors, body: '{"error":"malformed"}' });
        }
        const iss = issue(cost, max);
        issued.push(iss);
        byToken.set(iss.token, iss);
        const res = {
          v: 1,
          t: iss.token,
          pow: { alg: "pbkdf2-sha256", cost: iss.cost, max: iss.max, pfx: iss.pfx },
          ttl: 1800,
        };
        if (!validateChallengeResponse(res)) problems.push("mock challenge response invalid");
        return route.fulfill({
          status: 200,
          headers: { ...cors, "cache-control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify(res),
        });
      }

      seen.push({ kind: "event", host, method: "POST", url: req.url(), body, headers });
      if (!validateEventBatch(body)) {
        problems.push(`/v1/e schema: ${raw} ${JSON.stringify(validateEventBatch.errors)}`);
        return route.fulfill({ status: 400, headers: cors, body: '{"error":"malformed"}' });
      }
      const iss = byToken.get(body.t as string);
      if (!iss) problems.push(`/v1/e with a token this gateway never issued`);
      else if (typeof body.c === "number" && !verifyProof(iss, body.c)) {
        problems.push(`/v1/e with a wrong proof counter ${body.c}`);
      }
      return route.fulfill({ status: 202, headers: cors, body: "" });
    });
  }
  return gw;
}

/** Strings that must never appear in anything sent to the gateway. */
export const FORBIDDEN = /\?|#|utm_|token=|Fixture title|@|%40/;
/** StrKeys (account, contract, muxed, seed, …) and base64 XDR envelope prefixes (wire-formats §a.3, ADR-0029). */
export const STELLAR = /[GCMSTXPLBW][A-Z2-7]{55}|AAAAA[A-Za-z0-9+/]{20,}/;

/**
 * The common assertions on everything a page sent: no schema or proof problem, each event id unique (C-37), only
 * paths (no query string, fragment or title — C-65, C-89), JSON sent as text/plain without credentials.
 */
export function expectClean(gw: MockGateway): void {
  expect(gw.problems, gw.problems.join("\n")).toEqual([]);
  const ids = gw.events().map((e) => e.id);
  expect(new Set(ids).size, "event ids are unique").toBe(ids.length);
  for (const s of gw.seen) {
    if (s.kind === "script") continue;
    expect(JSON.stringify(s.body)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(s.body)).not.toMatch(STELLAR);
    expect(s.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(s.headers.cookie).toBeUndefined();
    // referrerPolicy "origin": the Referer header carries the origin only, never the page path
    if (s.headers.referer !== undefined) expect(new URL(s.headers.referer).pathname).toBe("/");
  }
}

/** Collect console errors and uncaught exceptions (hydration mismatches, CSP violations, tracker errors). */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** Wait until the mock has seen exactly `n` page views, then a little longer to catch a late double count. */
export async function expectPageviews(gw: MockGateway, paths: string[]): Promise<void> {
  await expect
    .poll(() => gw.pageviews().length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(paths.length);
  await new Promise((r) => setTimeout(r, 400));
  expect(gw.pageviews()).toEqual(paths);
}
