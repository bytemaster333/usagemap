// SPDX-License-Identifier: Apache-2.0
// Payload shape against the wire-format JSON Schemas, proof-of-work correctness, profile differences (C-33),
// path-only (C-65), per-event ids (C-37), Wallets Kit presence (C-93), no titles (C-89).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eventId } from "../src/core.ts";
import {
  HOST_A,
  isStrict,
  SITE,
  sentEvents,
  setProp,
  setURL,
  until,
  verifyProof,
} from "./gateway.ts";
import { trackerHarness } from "./setup.ts";

const ctx = trackerHarness();
const PROFILE = isStrict ? "strict" : "standard";

describe("schemas", () => {
  it("fixtures are verbatim copies of docs/contracts/wire-formats.md §a", () => {
    const md = readFileSync(
      join(import.meta.dirname, "../../docs/contracts/wire-formats.md"),
      "utf8",
    );
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    for (const name of ["challenge-request", "challenge-response", "event-batch"]) {
      const doc = blocks.find((b) => b.includes(`/schemas/v1/${name}.json`));
      const fixture = readFileSync(
        join(import.meta.dirname, "fixtures", `${name}.schema.json`),
        "utf8",
      );
      expect(JSON.parse(fixture)).toEqual(JSON.parse(doc ?? "null"));
    }
  });
});

describe("challenge → proof → event", () => {
  it("fetches a challenge first, solves it, then sends a schema-valid page view with a valid proof", async () => {
    const { gw } = ctx;
    ctx.start();
    await until(() => gw.events().length === 1);
    expect(gw.requests.map((r) => r.route)).toEqual(["/v1/c", "/v1/e"]);
    expect(gw.schemaErrors).toEqual([]);

    const [c, e] = gw.requests;
    expect(c?.body).toEqual({ v: 1, s: SITE, p: PROFILE, tv: "1.2.0" });
    const batch = e?.body as Record<string, unknown>;
    expect(batch.t).toBe(gw.issued[0]?.token);
    expect(typeof batch.c).toBe("number");
    expect(verifyProof(gw.issued[0] as never, batch.c as number)).toBe(true);
    expect(batch.c).toBe(gw.issued[0]?.secret);
  });

  it("sends with fetch keepalive, no credentials, a text/plain string body and origin-only referrer", async () => {
    const { gw } = ctx;
    ctx.start();
    await until(() => gw.events().length === 1);
    for (const r of gw.requests) {
      expect(r.host).toBe(HOST_A);
      expect(r.init).toMatchObject({
        method: "POST",
        keepalive: true,
        credentials: "omit",
        referrerPolicy: "origin",
      });
      expect(typeof r.init.body).toBe("string"); // → Content-Type text/plain;charset=UTF-8, no preflight
      expect(r.init.headers).toBeUndefined();
      expect(new Blob([r.raw]).size).toBeLessThanOrEqual(8192);
    }
  });

  it("reuses token and proof for later events of the same page load", async () => {
    const { gw } = ctx;
    const t = ctx.start();
    await until(() => gw.events().length === 1);
    t.track("signup", { plan: "free" });
    await until(() => gw.events().length === 2);
    expect(gw.challenges()).toHaveLength(1);
    expect(gw.events()[1]?.body.c).toBe(gw.events()[0]?.body.c);
    expect(gw.schemaErrors).toEqual([]);
  });

  it("sends events without proof when the challenge asks for more work than the compiled ceiling", async () => {
    const { gw } = ctx;
    gw.cost = 65535;
    gw.max = 65535;
    ctx.start();
    await until(() => gw.events().length === 1);
    expect(gw.events()[0]?.body.c).toBeUndefined();
    expect(gw.schemaErrors).toEqual([]);
  });
});

describe("profiles (C-33)", () => {
  it.runIf(!isStrict)(
    "standard: referrer host, width class, language and client signals",
    async () => {
      const { gw } = ctx;
      setProp(document, "referrer", "https://news.ycombinator.com/item?id=1#x");
      setProp(navigator, "webdriver", false);
      setProp(navigator, "userActivation", { hasBeenActive: true });
      ctx.start();
      await until(() => gw.events().length === 1);
      const b = gw.events()[0]?.body as Record<string, unknown>;
      expect(b.sg).toEqual({ wd: 0, vis: "v", act: 1 });
      const pv = (b.e as Record<string, unknown>[])[0];
      expect(pv).toMatchObject({ k: "pv", u: "/start", r: "news.ycombinator.com", l: "en" });
      expect(["s", "m", "l", "x"]).toContain(pv?.w);
      expect(JSON.stringify(b)).not.toContain("item?id");
    },
  );

  it.runIf(!isStrict)("standard: self-referral is not sent", async () => {
    const { gw } = ctx;
    setProp(document, "referrer", "https://site.test/other");
    ctx.start();
    await until(() => gw.events().length === 1);
    expect(sentEvents(gw)[0]).not.toHaveProperty("r");
  });

  it.runIf(isStrict)(
    "strict: no referrer, no width/language, no client signals, no kit probe",
    async () => {
      const { gw } = ctx;
      setProp(document, "referrer", "https://news.ycombinator.com/");
      document.documentElement.style.setProperty("--swk-background", "#fff");
      try {
        const t = ctx.start();
        await until(() => gw.events().length === 1);
        t.track("x");
        await until(() => gw.events().length === 2);
        for (const r of gw.events()) {
          expect(Object.keys(r.body).sort()).toEqual(["c", "e", "p", "s", "t", "tv", "v"]);
          expect(r.body.p).toBe("strict");
        }
        expect(sentEvents(gw)[0]).toEqual({ id: expect.any(String), k: "pv", u: "/start" });
      } finally {
        document.documentElement.style.removeProperty("--swk-background");
      }
    },
  );

  it.runIf(!isStrict)(
    "standard: Wallets Kit presence is a page-view boolean from DOM markers only",
    async () => {
      const { gw } = ctx;
      const t0 = ctx.start();
      await until(() => gw.events().length === 1);
      expect(sentEvents(gw)[0]).not.toHaveProperty("wk");

      document.documentElement.style.setProperty("--swk-background", "#fcfcfcff"); // v2 theme variable
      history.pushState(null, "", "/v2");
      document.documentElement.style.removeProperty("--swk-background");
      const el = document.createElement("stellar-wallets-button"); // v1 custom element
      document.body.append(el);
      history.pushState(null, "", "/v1");
      el.remove();
      history.pushState(null, "", "/none");
      t0.track("custom");
      await until(() => sentEvents(gw).length === 5);
      const ev = sentEvents(gw);
      expect(ev.map((e) => e.wk)).toEqual([undefined, true, true, undefined, undefined]);
      expect(gw.schemaErrors).toEqual([]);
    },
  );
});

describe("path only (C-65) and no title (C-89)", () => {
  it("never sends the query string, fragment or title", async () => {
    const { gw } = ctx;
    setURL("https://site.test/account/settings?email=a%40b.io&token=SECRETQ#frag-SECRETF");
    document.title = "Title-SECRETT";
    const t = ctx.start();
    await until(() => gw.events().length === 1);
    history.pushState(null, "", "/next?utm_source=SECRETU#h");
    t.track("clicked", { where: "header" });
    await until(() => sentEvents(gw).length === 3);
    const all = gw.requests.map((r) => r.raw).join("\n");
    expect(all).not.toMatch(/SECRET|utm_|\?|#|email/);
    expect(sentEvents(gw).map((e) => e.u)).toEqual(["/account/settings", "/next", "/next"]);
  });

  it("truncates very long paths to the schema limit", async () => {
    const { gw } = ctx;
    setURL(`https://site.test/${"a".repeat(800)}`);
    ctx.start();
    await until(() => gw.events().length === 1);
    expect(String(sentEvents(gw)[0]?.u).length).toBe(500);
    expect(gw.schemaErrors).toEqual([]);
  });
});

describe("per-event ids (C-37)", () => {
  it("are 22-char base64url and unique", () => {
    const ids = new Set(Array.from({ length: 5000 }, eventId));
    expect(ids.size).toBe(5000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("differ for every event sent", async () => {
    const { gw } = ctx;
    const t = ctx.start();
    for (let i = 0; i < 20; i++) t.track(`e${i}`);
    await until(() => sentEvents(gw).length === 21);
    const ids = sentEvents(gw).map((e) => e.id);
    expect(new Set(ids).size).toBe(21);
    expect(gw.schemaErrors).toEqual([]);
    for (const r of gw.events()) expect((r.body.e as unknown[]).length).toBeLessThanOrEqual(10);
  });
});
