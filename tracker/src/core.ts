// SPDX-License-Identifier: Apache-2.0
// Tracker core — protocol v1 (docs/contracts/wire-formats.md §a, §b).
//
// Least-power contract (ADR-0004): no eval/Function, no dynamic import, no remote configuration, no cookies, no web
// storage except the visitor's opt-out flag, no wallet objects, zero runtime dependencies. The profile, version,
// ingest hosts and proof-of-work limits are compile-time constants (see scripts/build-config.ts), so the `strict`
// build contains no code that reads client signals, the referrer, screen, language or Wallets Kit markers (C-33).

declare const __STRICT__: boolean;
declare const __VERSION__: string;
declare const __HOSTS__: readonly [string, string];
declare const __POW_MAX_WORK__: number;
declare const __POW_PARALLEL__: number;

/** Custom-event property values allowed by the wire contract. */
export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;

export interface Config {
  /** Public site key (22 alphanumeric characters). */
  site: string;
  /** `"required"`: send nothing until `grantConsent()` (C-55). */
  consent?: "required" | undefined;
}

export interface Tracker {
  /** Send a custom event. Returns false if refused by the guard or not sent because tracking is blocked. */
  track(name: string, props?: Props): boolean;
  /** Persist the visitor's opt-out (localStorage flag) and stop sending. */
  optOut(): void;
  /** Remove the opt-out flag. */
  optIn(): void;
  /** Consent-gated mode: start sending (and count the current page view). */
  grantConsent(): void;
  /** Consent-gated mode: stop sending. */
  revokeConsent(): void;
  /** Remove listeners, restore the History API and stop. */
  destroy(): void;
  /**
   * Stellar event schema v1 (wire-formats §a.3.1) — called by the adapters (`/wallets-kit`, `/wallets`,
   * `/passkey`), which map everything to the closed enums first. The core only re-checks the shape: a known name
   * shape, the schema keys, and short lower-case values (no StrKey, hash, amount or free text can pass).
   */
  stellar(name: string, fields?: Record<string, string>): boolean;
}

interface Ev {
  id: string;
  k: "pv" | "ev" | "wl";
  sv?: 1;
  u: string;
  r?: string;
  w?: string;
  l?: string;
  wk?: true;
  n?: string;
  d?: Props;
  [f: string]: unknown;
}

interface Challenge {
  t: string;
  pow: { alg: string; cost: number; max: number; pfx: string };
}

type Nav = Navigator & {
  globalPrivacyControl?: boolean;
  doNotTrack?: string | null;
  userActivation?: { hasBeenActive: boolean };
};

const PROFILE = __STRICT__ ? "strict" : "standard";
/** The only key the tracker ever writes to web storage. */
export const OPT_OUT_KEY = "scf_optout";
const INSTANCE = Symbol.for("scf.tracker");
const EVENT = "/v1/e";
/** Refresh the challenge when the token is older than 25 minutes (§a.3) or after 300 events (§b.3 cap). */
const TOKEN_AGE_MS = 15e5;
const TOKEN_EVENTS = 300;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$/;
const PROP_KEY = /^[a-z][a-z0-9_]{0,31}$/;
/**
 * Stellar v1 (§a.3.1), checked on the JSON of `{n, ...fields}`: the name is lower-case words, each field one of the
 * schema's keys with a string value of at most 20 [a-z0-9_] characters, or the `c` cells of the `stellar_rpc`
 * aggregate (§a.3.2: cells of five [a-z0-9_] strings of at most 40 characters and a count). The adapters send
 * closed enums; this re-check makes sure no StrKey, hash, amount or free text can pass through the core.
 */
const SV =
  /^\{"n":"[a-z_]{1,24}"(,"(wt|net|ck|sk|ec|rc|dur|out|po|fr|w[csm])":"[a-z0-9_]{1,20}")*(,"c":\[(\[("[a-z0-9_]{1,40}",){5}\d+\],?)+\])?\}$/;
/**
 * Client-side copy of the gateway guard (§a.4, C-52): e-mail addresses (also `%40`), JWTs, any run of 32 or more
 * base64/hex characters — which covers every StrKey type (G/C/M/S/T/X/P/B/W…, 56 or 69 chars of [A-Z2-7]) — and the
 * personal identifiers of the pathnorm rule set: IPv4 literals, IPv6 literals (two colons around at
 * most four hex digits, which also refuses `hh:mm:ss`, as the gateway does), phone numbers (`+`, a digit and six more
 * of `[0-9 ().-]`) and federation addresses (`name*domain.tld`).
 */
export const GUARD =
  /[^@\s]+(@|%40)[^@\s]+\.[A-Za-z]{2,}|eyJ[\w-]+\.[\w-]+\.|[A-Za-z0-9+/]{32,}|\d+(\.\d+){3}|:[\dA-Fa-f]{0,4}:|\+\d[\d ().-]{6}|\*[\w-]+\.\w/;

/**
 * Random per-event id, memory only (C-37): 16 random bytes as 22 base64 characters with `+` and `/` both written `_`
 * (≥ 127 bits). One id per action: every retry, on either host, resends the same body, so the gateways and the
 * engine proxy can drop the copies (plan C1 #11).
 */
export const eventId = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .slice(0, 22)
    .replace(/[+/]/g, "_");

/**
 * Proof-of-work (§b.2): find c in [0, max) with PBKDF2-SHA-256("scf-pow-v1" ‖ nonce ‖ uint32be(c), nonce, cost)[0..4]
 * = pfx. WebCrypto runs deriveBits off the main thread; `__POW_PARALLEL__` calls are kept in flight, and the main
 * thread only compares 32-bit integers between them. No Worker, so no `worker-src blob:` CSP is needed.
 * Returns undefined when the proof cannot or must not be computed (no WebCrypto, unknown algorithm, work above
 * the compiled ceiling, no solution) — events are then sent without proof.
 */
export const solve = async (ch: Challenge): Promise<number | undefined> => {
  const S = crypto.subtle;
  const { alg, cost, max, pfx } = ch.pow;
  if (!S || alg !== "pbkdf2-sha256" || cost * max > __POW_MAX_WORK__) {
    return;
  }
  // password(c) = "scf-pow-v1" ‖ nonce (token bytes 27…42) ‖ uint32be(c), salt = nonce (§b.2).
  const pw = Uint8Array.from(
    `scf-pow-v1${atob(ch.t.replace(/-/g, "+").replace(/_/g, "/")).slice(27, 43)}\0\0\0\0`,
    (x) => x.charCodeAt(0),
  );
  const salt = pw.slice(10, 26);
  const want = parseInt(pfx, 16);
  const one = async (c: number): Promise<boolean> => {
    const p = pw.slice();
    new DataView(p.buffer).setUint32(26, c);
    const key = await S.importKey("raw", p, "PBKDF2", false, ["deriveBits"]);
    // The first 32 bits of a 32-byte PBKDF2-SHA-256 output are the first 32 bits of block T1.
    const bits = await S.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: cost },
      key,
      32,
    );
    return new DataView(bits).getUint32(0) === want;
  };
  for (let c = 0; c < max; c += __POW_PARALLEL__) {
    const hit = (
      await Promise.all(
        Array.from({ length: __POW_PARALLEL__ }, (_, j) => c + j < max && one(c + j)),
      )
    ).indexOf(true);
    if (hit >= 0) return c + hit;
  }
};

const valid = (name: string, props?: Props): boolean => {
  if (typeof name !== "string" || !NAME.test(name) || GUARD.test(name)) return false;
  if (props == null) return true;
  // No separate object/array check: a string, array or other non-object with keys fails PROP_KEY (keys "0", "1", …);
  // one without keys is treated as "no properties".
  const keys = Object.keys(props);
  if (keys.length > 10) return false;
  for (const k of keys) {
    const v = props[k];
    if (
      !PROP_KEY.test(k) ||
      !(typeof v === "string"
        ? v.length <= 100 && !GUARD.test(v)
        : typeof v === "number"
          ? Math.abs(v) <= 1e15 // also false for NaN and ±Infinity
          : typeof v === "boolean")
    ) {
      return false;
    }
  }
  return true;
};

// ---- standard profile only: everything below is removed from the strict build by dead-code elimination ----

/** Client signal booleans (C-33): webdriver, visibility at send time, user activation. */
const signals = (): Record<string, unknown> => {
  const nav = navigator as Nav;
  const doc = document as Document & { prerendering?: boolean };
  const sg: Record<string, unknown> = {
    wd: nav.webdriver ? 1 : 0,
    vis: doc.prerendering ? "p" : doc.visibilityState === "hidden" ? "h" : "v",
  };
  if (nav.userActivation) sg.act = nav.userActivation.hasBeenActive ? 1 : 0;
  return sg;
};

/**
 * Page-view fields of the standard profile: referrer host (cross-site, first page view of the page load only),
 * screen-width class, primary language subtag, and passive Wallets Kit presence (C-93) — DOM markers only, never
 * kit or wallet objects.
 */
const standardFields = (e: Ev, first: boolean): void => {
  const doc = document;
  if (first) {
    try {
      const h = new URL(doc.referrer).hostname.toLowerCase();
      if (h !== location.hostname && /^[a-z0-9.-]{1,253}$/.test(h)) e.r = h;
    } catch {}
  }
  const sw = screen.width;
  e.w = sw <= 480 ? "s" : sw <= 1024 ? "m" : sw <= 1920 ? "l" : "x";
  const l = (navigator.language || "").split("-")[0]?.toLowerCase() ?? "";
  if (/^[a-z]{2,3}$/.test(l)) e.l = l;
  if (
    doc.querySelector(
      "stellar-wallets-modal,stellar-wallets-button,stellar-selector-modal,section.stellar-wallets-kit",
    ) ||
    doc.documentElement.style.getPropertyValue("--swk-background")
  ) {
    e.wk = true;
  }
};

/**
 * Create (or return the existing) tracker for this window. `pre` replays calls queued by the page before the script
 * loaded (`window.scf = [["grantConsent"], …]`) before the first page view is considered.
 */
export function createTracker(cfg: Config, pre?: unknown): Tracker | undefined {
  const w = window as unknown as Record<symbol, Tracker | undefined>;
  const prior = w[INSTANCE];
  if (prior) return prior;
  const site = cfg.site;
  if (!/^[0-9A-Za-z]{22}$/.test(site)) return;

  const doc = document;
  const nav = navigator as Nav;
  const H = history;
  const gated = cfg.consent === "required";
  let consent = false;
  let out = false;
  let dead = false;
  let host = 0;
  let token: string | undefined;
  let tokenAt = 0;
  let tokenUses = 0;
  let proof: number | undefined;
  let solving = false;
  let queue: Ev[] = [];
  let last: string | undefined;
  const retries = new Map<ReturnType<typeof setTimeout>, string>();
  const head = { v: 1, s: site, p: PROFILE, tv: __VERSION__ };

  const optedOut = (): boolean => {
    try {
      return out || localStorage.getItem(OPT_OUT_KEY) === "1";
    } catch {
      return out;
    }
  };
  const blocked = (): boolean =>
    dead || (gated && !consent) || nav.globalPrivacyControl || nav.doNotTrack === "1" || optedOut();

  const stop = (): void => {
    queue = [];
    for (const t of retries.keys()) clearTimeout(t);
    retries.clear();
  };

  /** location.pathname only — never the query string or fragment (C-65). */
  const path = (): string => {
    const p = location.pathname;
    return p && p[0] === "/" ? p.slice(0, 500) : "/";
  };

  const post = (
    route: string,
    body: string,
    n = 0,
    ok?: (r: Response) => void,
    fail?: () => void,
  ): void => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    fetch(__HOSTS__[host] + route, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "omit",
      referrerPolicy: "origin",
      signal: ac.signal,
    })
      .then((r) => {
        const s = r.status;
        if (s < 300) return ok?.(r);
        if (s === 404 || s === 410) {
          dead = true;
          stop();
        } else if (s === 429 || s > 499) {
          throw r;
        }
        fail?.();
      })
      .catch((x: unknown) => {
        if (dead || n > 1) return fail?.();
        host ^= 1;
        // A thrown Response (429, 5xx) may carry Retry-After; a network error or abort has no headers (NaN → back-off).
        const after = +((x as Response).headers?.get("Retry-After") as string);
        const t = setTimeout(
          () => {
            retries.delete(t);
            post(route, body, n + 1, ok, fail);
          },
          after > 0 ? Math.min(after, 30) * 1e3 : 500 * 2 ** n * (0.5 + Math.random()),
        );
        if (route === EVENT) retries.set(t, body);
      })
      .finally(() => clearTimeout(timer));
  };

  // Page hide uses the same keepalive fetch, never navigator.sendBeacon: EasyPrivacy (on by default in uBlock Origin
  // and Brave) blocks every third-party `ping` request (`*$ping,third-party`), which is what a beacon is.
  const flush = (): void => {
    if (!token || !queue.length || blocked()) return;
    const e = queue.splice(0, 10);
    // `c: undefined` (no proof) is left out by JSON.stringify.
    const batch: Record<string, unknown> = { ...head, t: token, c: proof, e };
    if (!__STRICT__) batch.sg = signals();
    // The gateway refuses bodies over 8 KiB (§a.1): events that do not fit go back to the front of the queue for the
    // next batch.
    let body = JSON.stringify(batch);
    while (new Blob([body]).size > 8192 && e.length > 1) {
      queue.unshift(e.pop() as Ev);
      body = JSON.stringify(batch);
    }
    tokenUses += e.length;
    post(EVENT, body);
    if (queue.length) flush();
  };

  const challenge = (): void => {
    if (solving) return;
    solving = true;
    post(
      "/v1/c",
      JSON.stringify(head),
      0,
      (r) => {
        r.json()
          .then(async (ch: Challenge) => {
            const t = ch.t;
            // test() stringifies a non-string, which never has 123 such characters.
            if (!/^[\w-]{123}$/.test(t)) throw 0;
            token = t;
            tokenAt = Date.now();
            tokenUses = 0;
            proof = undefined;
            const c = await solve(ch).catch(() => undefined);
            if (token === t) proof = c;
          })
          .catch(() => {
            // Not a v1 challenge: stop for this page instead of looping.
            dead = true;
          })
          .then(() => {
            solving = false;
            go();
          });
      },
      () => {
        solving = false;
      },
    );
  };

  const go = (): void => {
    if (blocked()) {
      stop();
      return;
    }
    // A stale token is kept until its replacement arrives, so a page hidden meanwhile can still send.
    if (!token || Date.now() - tokenAt > TOKEN_AGE_MS || tokenUses >= TOKEN_EVENTS) challenge();
    else if (!solving) flush();
  };

  const push = (e: Ev): void => {
    // Bounded while the proof is pending: at most 30 events (three batches) wait; beyond that the newest is dropped,
    // so the landing page view and its referrer are kept (wire-formats §a.1, C-112).
    if (queue.length < 30) queue.push(e);
    go();
  };

  /** Page view; de-duplicated by path so hydration and same-path replaceState never double-count. */
  const pageview = (): void => {
    const u = path();
    if (u === last || blocked()) return;
    const e: Ev = { id: eventId(), k: "pv", u };
    // The referrer only on the first page view of the page load (no earlier `last`).
    if (!__STRICT__) standardFields(e, last === undefined);
    last = u;
    push(e);
  };

  const onNav = (): void => {
    try {
      pageview();
    } catch {}
  };
  const onHide = (ev: Event): void => {
    if (ev.type !== "pagehide" && doc.visibilityState !== "hidden") return;
    // Pending retries go now, once (the page may be gone before their timers fire).
    for (const [t, body] of retries) {
      clearTimeout(t);
      post(EVENT, body, 2);
    }
    retries.clear();
    // Proof still running: send now with the token and no proof (C-35).
    flush();
  };

  const origPush = H.pushState;
  const origReplace = H.replaceState;
  H.pushState = function (this: History, ...a: Parameters<History["pushState"]>) {
    origPush.apply(this, a);
    onNav();
  };
  H.replaceState = function (this: History, ...a: Parameters<History["replaceState"]>) {
    origReplace.apply(this, a);
    onNav();
  };
  addEventListener("popstate", onNav);
  addEventListener("pagehide", onHide);
  doc.addEventListener("visibilitychange", onHide);

  const api: Tracker = {
    track(name, props) {
      if (!valid(name, props) || blocked()) return false;
      const e: Ev = { id: eventId(), k: "ev", u: path(), n: name };
      if (props && Object.keys(props).length) e.d = { ...props };
      push(e);
      return true;
    },
    stellar(n, f) {
      // Checked on exactly what will be sent: the name, then only schema keys with short [a-z0-9_] string values.
      const d = { n, ...f };
      if (!SV.test(JSON.stringify(d))) return false;
      // When tracking is blocked, push() → go() drops the queue, so nothing is sent (no separate check here).
      push({ id: eventId(), k: "wl", sv: 1, u: path(), ...d });
      return true;
    },
    optOut() {
      out = true;
      try {
        localStorage.setItem(OPT_OUT_KEY, "1");
      } catch {}
      stop();
    },
    optIn() {
      out = false;
      try {
        localStorage.removeItem(OPT_OUT_KEY);
      } catch {}
    },
    grantConsent() {
      consent = true;
      onNav();
    },
    revokeConsent() {
      consent = false;
      stop();
    },
    destroy() {
      dead = true;
      stop();
      H.pushState = origPush;
      H.replaceState = origReplace;
      removeEventListener("popstate", onNav);
      removeEventListener("pagehide", onHide);
      doc.removeEventListener("visibilitychange", onHide);
      delete w[INSTANCE];
    },
  };
  w[INSTANCE] = api;

  if (Array.isArray(pre)) {
    for (const call of pre) {
      if (!Array.isArray(call)) continue;
      const [m, ...args] = call as [keyof Tracker, ...unknown[]];
      if (m !== "destroy" && typeof api[m] === "function") {
        (api[m] as (...x: unknown[]) => unknown)(...args);
      }
    }
  }
  onNav();
  return api;
}
