// SPDX-License-Identifier: Apache-2.0
// Debug mode (plan E1) and the client side of dev origins (plan E2, wire-formats §a.8): why nothing was sent or
// counted, in the console and on the page — and never a token, query string or identifier in that output.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTracker } from "../src/core.ts";
import { debug, explainDebugHeader, explainStatus } from "../src/debug.ts";
import { HOST_A, HOST_B, SITE, setProp, setURL, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";

const ctx = trackerHarness();
let off: (() => void) | undefined;
let logs: string[] = [];
let reachable = true;

beforeEach(() => {
  logs = [];
  reachable = true;
  vi.spyOn(console, "info").mockImplementation((m: string) => void logs.push(m));
  vi.spyOn(console, "warn").mockImplementation((m: string) => void logs.push(m));
  // the probe the debug module makes after a failed request
  const gwFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (u: string, i?: RequestInit) =>
    String(u).endsWith("/healthz")
      ? reachable
        ? Promise.resolve(new Response(null, { status: 200 }))
        : Promise.reject(new TypeError("Failed to fetch"))
      : gwFetch(u, i as RequestInit),
  );
});
afterEach(() => {
  off?.();
  off = undefined;
  for (const s of document.querySelectorAll("script[data-site]")) s.remove();
});

const panelText = (): string => document.getElementById("scf-debug")?.textContent ?? "";
const output = (): string => `${logs.join("\n")}\n${panelText()}`;
const waitFor = (re: RegExp) => until(() => re.test(output()));

describe("X-Scf-Debug (§a.8)", () => {
  it("outside the debug window a dev origin gets class=dev only, explained as never counted", () => {
    const f = explainDebugHeader("v=1; class=dev; reasons=dev_origin");
    expect(f.level).toBe("block");
    expect(f.text).toMatch(/dev origin — accepted \(202\) but never counted/);
    expect(f.text).toMatch(/first-event panel/);
    expect(explainDebugHeader("v=1; class=dev; reasons=dev_origin,dev_rate_limited").text).toMatch(
      /dev limit/,
    );
  });

  it("in the debug window: class and reasons explained", () => {
    expect(explainDebugHeader("v=1; class=verified; reasons=none")).toEqual({
      level: "ok",
      text: "counted (verified) — none: no reason: the event counts",
    });
    const s = explainDebugHeader("v=1; class=suspect; reasons=proof_missing,domain_unverified");
    expect(s.level).toBe("warn");
    expect(s.text).toMatch(/proof-of-work/);
    expect(s.text).toMatch(/verify it in the portal/);
    expect(explainDebugHeader("v=1; class=rejected; reasons=origin_mismatch").text).toMatch(
      /not a declared domain/,
    );
    expect(explainDebugHeader("v=1; class=dropped; reasons=gpc_dnt").text).toMatch(/Sec-GPC/);
    expect(explainDebugHeader("v=1; class=dev; reasons=dev_origin,proof_missing").text).toMatch(
      /NOT counted \(dev origin\).*proof_missing/,
    );
  });

  it("status codes without a header", () => {
    expect(explainStatus("/v1/e", 202).text).toMatch(/whatever the verdict/);
    expect(explainStatus("/v1/e", 404).text).toMatch(/unknown site/);
    expect(explainStatus("/v1/e", 410).text).toMatch(/withdrawn/);
    expect(explainStatus("/v1/c", 429).text).toMatch(/rate limited/);
  });
});

describe("debug(): why nothing was sent", () => {
  it("Global Privacy Control (Brave's default)", async () => {
    setProp(navigator, "globalPrivacyControl", true);
    off = debug();
    ctx.start();
    await waitFor(/Global Privacy Control is on \(Brave/);
    expect(ctx.gw.requests).toEqual([]);
  });

  it("Do Not Track and the visitor's opt-out", async () => {
    setProp(navigator, "doNotTrack", "1");
    localStorage.setItem("scf_optout", "1");
    off = debug();
    await waitFor(/Do Not Track is on/);
    await waitFor(/opted out/);
  });

  it("consent-gated mode before grantConsent()", async () => {
    const tag = document.createElement("script");
    tag.setAttribute("data-site", SITE);
    tag.setAttribute("data-consent", "required");
    document.head.append(tag);
    off = debug({ quietAfter: 0.05 });
    ctx.start({ consent: "required" });
    await waitFor(/consent-gated mode \(data-consent="required"\)/);
  });

  it("no tracker running (ad blocker, CSP, SRI)", async () => {
    off = debug({ quietAfter: 0.05 });
    await waitFor(/no tracker is running on this page/);
  });

  it("network failure with the host reachable → the page origin is not declared (no CORS)", async () => {
    ctx.gw.answer = () => "network";
    off = debug();
    ctx.start();
    await waitFor(/refused by the browser although the host is reachable/);
    expect(output()).toContain("https://site.test");
  });

  it("network failure with the host unreachable → ad blocker or network", async () => {
    ctx.gw.answer = () => "network";
    reachable = false;
    off = debug();
    ctx.start();
    await waitFor(/ad blocker or privacy extension/);
  });

  it("a Content Security Policy that blocks the ingest host", async () => {
    ctx.gw.answer = () => "network";
    off = debug();
    const ev = new Event("securitypolicyviolation") as Event & Record<string, unknown>;
    Object.assign(ev, { blockedURI: `${HOST_A}/v1/c`, effectiveDirective: "connect-src" });
    document.dispatchEvent(ev);
    ctx.start();
    await waitFor(/Content Security Policy \(connect-src\) blocks/);
    expect(output()).toContain(HOST_B);
    await new Promise((r) => setTimeout(r, 30));
    expect(output()).not.toMatch(/ad blocker or privacy extension|although the host is reachable/);
  });

  it("an answer that is not a v1 challenge (token failure)", async () => {
    off = debug();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (u: string, i: RequestInit) =>
      String(u).endsWith("/v1/c")
        ? Promise.resolve(new Response('{"v":1,"t":"short"}'))
        : real(u, i),
    );
    off();
    off = debug();
    ctx.start();
    await waitFor(/no valid v1 token: the tracker stops/);
  });

  it("404 unknown site key", async () => {
    ctx.gw.answer = (route) => (route === "/v1/e" ? 404 : undefined);
    off = debug();
    ctx.start();
    await waitFor(/404 unknown site/);
  });
});

describe("debug(): what was sent and whether it counted", () => {
  it("dev origin (localhost): the client runs the full path; class=dev explained; nothing private printed", async () => {
    setURL("http://localhost:5173/app/page?token=SECRETQ#SECRETF");
    ctx.gw.answer = (route) => ({
      status: route === "/v1/c" ? 200 : 202,
      headers: {
        "X-Scf-Debug": "v=1; class=dev; reasons=dev_origin",
        "Access-Control-Expose-Headers": "X-Scf-Debug",
      },
    });
    off = debug();
    const t = ctx.start();
    t.track("signup", { plan: "free" });
    await waitFor(
      /\/v1\/e \[pageview \/app\/page.*: dev origin — accepted \(202\) but never counted/,
    );
    expect(output()).toMatch(/looks like a development origin/);
    expect(ctx.gw.challenges()).toHaveLength(1); // same challenge → proof → event path as production
    const all = output();
    expect(all).not.toMatch(/SECRET|token=|\?|#/);
    for (const iss of ctx.gw.issued) expect(all).not.toContain(iss.token);
    expect(all).not.toMatch(/[A-Za-z0-9_-]{100,}/);
    // the panel is text only
    expect(
      document.getElementById("scf-debug")?.querySelectorAll("script,iframe,img"),
    ).toHaveLength(0);
  });

  it("production origin: accepted, verdict hidden without the site's debug mode", async () => {
    off = debug();
    ctx.start();
    await waitFor(/accepted \(202\).*switch on the site's debug mode/);
  });

  it("panel and console can be switched off; off() restores fetch and removes the panel", async () => {
    const before = window.fetch;
    off = debug({ panel: false });
    expect(window.fetch).not.toBe(before);
    ctx.start();
    await waitFor(/accepted/);
    expect(document.getElementById("scf-debug")).toBeNull();
    off();
    off = undefined;
    expect(window.fetch).toBe(before);
    const quiet = debug({ console: false });
    setProp(navigator, "globalPrivacyControl", true);
    quiet();
    expect(document.getElementById("scf-debug")).toBeNull();
  });

  it("a second tracker start does not double-report (one instance per page)", async () => {
    off = debug();
    const t = ctx.start();
    expect(createTracker({ site: SITE })).toBe(t);
    await until(() => ctx.gw.events().length === 1);
    await waitFor(/accepted/);
    expect(logs.filter((l) => l.includes("/v1/e")).length).toBe(1);
  });
});
