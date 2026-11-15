// SPDX-License-Identifier: Apache-2.0
// Opt-out, GPC, DNT and consent-gated mode send nothing — not even a challenge (ADR-0004, C-55).
// No cookies; the opt-out flag is the only thing ever written to web storage.

import { describe, expect, it } from "vitest";
import { OPT_OUT_KEY } from "../src/core.ts";
import { sentEvents, setProp, settle, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";

const ctx = trackerHarness();

describe("privacy signals send nothing", () => {
  it("Global Privacy Control", async () => {
    setProp(navigator, "globalPrivacyControl", true);
    const t = ctx.start();
    expect(t.track("x")).toBe(false);
    history.pushState({}, "", "/y");
    await settle();
    expect(ctx.gw.requests).toEqual([]);
  });

  it("Do Not Track", async () => {
    setProp(navigator, "doNotTrack", "1");
    const t = ctx.start();
    expect(t.track("x")).toBe(false);
    history.pushState({}, "", "/y");
    await settle();
    expect(ctx.gw.requests).toEqual([]);
  });

  it("DNT unset or '0' does not block", async () => {
    setProp(navigator, "doNotTrack", "0");
    setProp(navigator, "globalPrivacyControl", false);
    ctx.start();
    await until(() => ctx.gw.events().length === 1);
  });
});

describe("optOut() / optIn()", () => {
  it("a stored opt-out flag blocks everything from the first moment", async () => {
    localStorage.setItem(OPT_OUT_KEY, "1");
    const t = ctx.start();
    t.track("x");
    await settle();
    expect(ctx.gw.requests).toEqual([]);
  });

  it("optOut() stores only the flag, stops sending, and optIn() resumes", async () => {
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    t.optOut();
    expect(localStorage.getItem(OPT_OUT_KEY)).toBe("1");
    expect(localStorage.length).toBe(1);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(t.track("after_opt_out")).toBe(false);
    history.pushState({}, "", "/hidden");
    await settle();
    expect(ctx.gw.events()).toHaveLength(1);

    t.optIn();
    expect(localStorage.getItem(OPT_OUT_KEY)).toBeNull();
    expect(t.track("back")).toBe(true);
    await until(() => ctx.gw.events().length === 2);
  });

  it("optOut() still blocks when storage is unavailable (in-memory flag)", async () => {
    const t = ctx.start();
    await until(() => ctx.gw.events().length === 1);
    const set = Storage.prototype.setItem;
    const get = Storage.prototype.getItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    Storage.prototype.getItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    try {
      t.optOut();
      expect(t.track("x")).toBe(false);
    } finally {
      Storage.prototype.setItem = set;
      Storage.prototype.getItem = get;
    }
  });

  it("an opted-out page drops events queued before the challenge answered", async () => {
    const t = ctx.start();
    t.track("queued");
    t.optOut();
    await settle(200);
    expect(ctx.gw.events()).toEqual([]);
  });
});

describe('consent-gated mode (consent: "required", C-55)', () => {
  it("sends nothing — no challenge, no event — before grantConsent()", async () => {
    const t = ctx.start({ consent: "required" });
    expect(t.track("x")).toBe(false);
    history.pushState({}, "", "/b");
    await settle();
    expect(ctx.gw.requests).toEqual([]);
  });

  it("grantConsent() counts the current page and later events; revokeConsent() stops", async () => {
    const t = ctx.start({ consent: "required" });
    history.pushState({}, "", "/b");
    t.grantConsent();
    await until(() => ctx.gw.events().length === 1);
    expect(sentEvents(ctx.gw).map((e) => e.u)).toEqual(["/b"]);
    expect(t.track("ok")).toBe(true);
    await until(() => sentEvents(ctx.gw).length === 2);

    t.revokeConsent();
    expect(t.track("no")).toBe(false);
    history.pushState({}, "", "/c");
    await settle();
    expect(sentEvents(ctx.gw)).toHaveLength(2);
    expect(localStorage.length).toBe(0);
  });

  it("GPC wins over consent", async () => {
    setProp(navigator, "globalPrivacyControl", true);
    const t = ctx.start({ consent: "required" });
    t.grantConsent();
    await settle();
    expect(ctx.gw.requests).toEqual([]);
  });

  it("calls queued before the script loaded are replayed (grant → page view, then the event)", async () => {
    // <script>window.scf=[["grantConsent"],["track","early"]]</script> … then the tracker script
    ctx.start({ consent: "required" }, [["grantConsent"], ["track", "early"], ["destroy"], "junk"]);
    await until(() => sentEvents(ctx.gw).length === 2);
    await settle();
    expect(sentEvents(ctx.gw).map((e) => e.k)).toEqual(["pv", "ev"]);
  });

  it("an opt-out queued before load means nothing is ever sent", async () => {
    ctx.start({}, [["optOut"]]);
    await settle();
    expect(ctx.gw.requests).toEqual([]);
  });
});
