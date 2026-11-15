// SPDX-License-Identifier: Apache-2.0
// `@usagemap/tracker/debug` — the tracker's debug mode (plan E1; dev origins, plan E2, wire-formats §a.8).
//
//   import { debug } from "@usagemap/tracker/debug";
//   debug();                         // before the tracker starts; returns a function that switches it off again
//
// For developers only, never in production: it explains in the console and in a small on-page panel WHY nothing was
// sent or counted — Global Privacy Control (on by default in Brave) or Do Not Track, the visitor's opt-out,
// consent-gated mode, the tracker not running (ad blocker, CSP, SRI mismatch), a Content Security Policy that blocks
// the ingest hosts, an ad blocker or network error, a page origin that is not a declared domain of the site (the
// gateway then sends no CORS headers), a challenge or token failure, and the gateway's answer: `X-Scf-Debug` when
// present (§a.8: a dev origin outside the site's debug window gets only `class=dev`), else the status code.
//
// How: the tracker core stays unchanged and silent (its size budget, C-32); this module observes the core's requests
// by wrapping `window.fetch` for the two compiled ingest hosts only, and reads what the browser itself knows. It
// prints event kinds, names and paths — never the token, a query string, an identifier or a request header.

declare const __HOSTS__: readonly [string, string];

export interface DebugOptions {
  /** Show the on-page panel (default true). */
  panel?: boolean;
  /** Write to the console (default true). */
  console?: boolean;
  /** Seconds after which "nothing was sent" is diagnosed if the tracker made no request at all (default 3). */
  quietAfter?: number;
}

/** One explained finding. `level`: "ok" counted or sent; "warn" not counted; "block" nothing sent. */
export interface Finding {
  level: "ok" | "warn" | "block";
  text: string;
}

/** §h.2 reason codes, `drop` labels and dev codes, explained for developers. */
const REASONS: Record<string, string> = {
  none: "no reason: the event counts",
  dev_origin:
    "this page's origin is one of the site's dev origins — accepted, never counted (the would-be verdict is in the portal's first-event panel)",
  dev_rate_limited: "more dev events than the per-minute dev limit — dropped",
  gpc_dnt: "the browser sent Sec-GPC: 1 or DNT: 1 — dropped by design",
  ua_bot: "the User-Agent is a known bot",
  origin_mismatch:
    "this page's origin is not a declared domain of the site — add it in the portal (or add it as a dev origin)",
  fetch_impossible: "request headers a browser cannot produce",
  challenge_missing: "no or malformed challenge token",
  challenge_invalid:
    "the token is invalid for this site (or a dev token used on a production origin)",
  challenge_expired: "the token is older than 30 minutes",
  proof_invalid: "the proof-of-work answer is wrong",
  token_flood: "too many events on one token",
  tenant_pending: "the project is awaiting approval",
  tenant_suspended: "the project is suspended",
  proof_missing:
    "no proof-of-work (the page was hidden before it was solved, or WebCrypto is missing) — counted as suspect",
  challenge_unverifiable: "the token's key is unknown to this gateway node",
  ctx_moved: "the network or browser changed since the challenge",
  domain_unverified: "the domain is declared but not yet verified — verify it in the portal",
  automation_flag: "the browser reports automation (navigator.webdriver) or a headless User-Agent",
  hidden_or_prerender: "the page was hidden or prerendering when it sent",
  net_datacenter: "the address belongs to a datacenter network",
  multiplicity_high: "many visitors share this network with low engagement",
  transport_mismatch: "the TLS/HTTP-2 fingerprint does not match the claimed browser",
  header_inconsistent: "request headers are inconsistent with the browser",
  origin_missing: "neither Origin nor Referer was sent",
  rate_anomaly: "the site's event rate is far above its usual level",
  rate_limited: "rate limited",
  quota_exceeded: "the project's daily quota is used up",
  country_excluded: "the visitor's country is excluded in the site's settings",
  duplicate_event_id: "a repeat of an event already received",
  profile_field_stripped: "a field the site's profile does not allow was removed",
};

const CLASSES: Record<string, string> = {
  verified: "counted (verified)",
  suspect: "counted, marked suspect",
  rejected: "NOT counted (rejected)",
  dropped: "NOT counted (dropped)",
  dev: "NOT counted (dev origin)",
  challenge: "challenge issued",
};

/**
 * Explain an `X-Scf-Debug` header (§a.8): `v=1; class=<class>; reasons=<code>[,<code>…]`. Unknown codes are shown
 * as they are (they are closed codes, never identifiers).
 */
export function explainDebugHeader(header: string): Finding {
  const parts: Record<string, string> = {};
  for (const p of header.split(";")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const cls = parts.class ?? "";
  const reasons = (parts.reasons ?? "").split(",").filter((r) => /^[a-z_]{1,40}$/.test(r));
  const devOnly =
    cls === "dev" && reasons.every((r) => r === "dev_origin" || r === "dev_rate_limited");
  const why = reasons.map((r) => `${r}: ${REASONS[r] ?? "see wire-formats §h.2"}`).join("; ");
  const text = devOnly
    ? `dev origin — accepted (202) but never counted. ${why}. The would-be verdict is shown only in the portal's ` +
      "first-event panel, or here while the site's debug mode is switched on."
    : `${CLASSES[cls] ?? cls}${why ? ` — ${why}` : ""}`;
  return {
    level: cls === "verified" || cls === "challenge" ? "ok" : cls === "suspect" ? "warn" : "block",
    text,
  };
}

const STATUS: Record<number, string> = {
  400: "400 malformed — the gateway refused the batch (schema violation or > 8 KiB); not retried",
  404: "404 unknown site — wrong data-site key, or the site is not active (archived, removed); the tracker stops on this page",
  410: "410 withdrawn — this tracker version was withdrawn; upgrade the script URL and integrity hash",
  429: "429 rate limited or daily quota used up — retried after Retry-After",
  503: "503 the gateway cannot store events right now — retried on the other host",
};

const isLocal = (h: string): boolean => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

/** Classify `/v1/e` and `/v1/c` answers without a debug header. */
export function explainStatus(route: string, status: number): Finding {
  if (status === 202 || (route === "/v1/c" && status === 200)) {
    return {
      level: "ok",
      text:
        route === "/v1/c"
          ? "challenge received; solving the proof-of-work"
          : "accepted (202). The gateway answers 202 whatever the verdict (no oracle): switch on the site's debug " +
            "mode in the portal to see here whether it counted",
    };
  }
  return { level: "block", text: STATUS[status] ?? `${status} from the gateway` };
}

type Sink = (f: Finding) => void;

/** Reasons the tracker sends nothing at all, from what the browser knows (the same checks as the core). */
export function blockedReasons(): Finding[] {
  const out: Finding[] = [];
  const nav = navigator as Navigator & {
    globalPrivacyControl?: boolean;
    doNotTrack?: string | null;
  };
  if (nav.globalPrivacyControl === true) {
    out.push({
      level: "block",
      text:
        "Global Privacy Control is on (Brave turns it on by default; also a setting or extension in other " +
        "browsers): the tracker sends nothing, by design. Test in a browser profile without GPC.",
    });
  }
  if (nav.doNotTrack === "1") {
    out.push({ level: "block", text: "Do Not Track is on: the tracker sends nothing, by design." });
  }
  let optedOut = false;
  try {
    optedOut = localStorage.getItem("scf_optout") === "1";
  } catch {}
  if (optedOut) {
    out.push({
      level: "block",
      text: "this browser opted out (the scf_optout flag in local storage): call optIn() or clear site data.",
    });
  }
  return out;
}

const summary = (body: unknown): string => {
  if (typeof body !== "string") return "";
  try {
    const b = JSON.parse(body) as { e?: { k?: unknown; n?: unknown; u?: unknown }[] };
    if (!Array.isArray(b.e)) return "";
    const s = b.e
      .map((e) =>
        [
          e.k === "pv" ? "pageview" : e.k === "wl" ? "stellar" : "event",
          typeof e.n === "string" ? e.n : "",
          e.u,
        ]
          .filter((x) => typeof x === "string" && x)
          .join(" "),
      )
      .join(", ");
    return s ? ` [${s}]` : "";
  } catch {
    return "";
  }
};

/**
 * Switch the debug mode on. Returns `off()`, which restores `fetch`, removes the listeners and the panel.
 * Load it before the tracker (an earlier `<script type="module">`, or the first import of the app) so it sees the
 * first requests; it also explains a tracker that never started.
 */
export function debug(opts: DebugOptions = {}): () => void {
  const hosts = [...__HOSTS__];
  const lines: Finding[] = [];
  let panel: HTMLElement | undefined;
  let list: HTMLElement | undefined;
  let seen = 0;
  let lastCsp = 0;

  const render = (f: Finding): void => {
    if (opts.console !== false) {
      (f.level === "ok" ? console.info : console.warn)(`[scf debug] ${f.text}`);
    }
    if (opts.panel === false || typeof document === "undefined") return;
    if (!panel) {
      panel = document.createElement("aside");
      panel.setAttribute("role", "status");
      panel.setAttribute("aria-label", "UsageMap debug");
      panel.id = "scf-debug";
      const s = panel.style;
      s.position = "fixed";
      s.right = "8px";
      s.bottom = "8px";
      s.zIndex = "2147483647";
      s.maxWidth = "min(32rem, calc(100vw - 16px))";
      s.maxHeight = "40vh";
      s.overflow = "auto";
      s.font = "12px/1.4 ui-monospace, monospace";
      s.background = "#111";
      s.color = "#eee";
      s.padding = "8px 10px";
      s.borderRadius = "6px";
      s.boxShadow = "0 2px 12px rgba(0,0,0,.4)";
      const head = document.createElement("div");
      head.textContent = "UsageMap — debug mode (developers only)";
      head.style.fontWeight = "bold";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close debug panel");
      close.style.float = "right";
      close.addEventListener("click", () => panel?.remove());
      head.append(close);
      list = document.createElement("ol");
      list.style.margin = "4px 0 0";
      list.style.paddingLeft = "18px";
      panel.append(head, list);
      (document.body ?? document.documentElement).append(panel);
    }
    const li = document.createElement("li");
    li.textContent = f.text;
    li.style.color = f.level === "ok" ? "#9e9" : f.level === "warn" ? "#fd6" : "#f88";
    list?.append(li);
  };
  const say: Sink = (f) => {
    lines.push(f);
    render(f);
  };

  const route = (url: string): { host: string; route: string } | undefined => {
    for (const h of hosts) {
      if (url.startsWith(`${h}/v1/`)) {
        const r = url.slice(h.length);
        if (r === "/v1/c" || r === "/v1/e") return { host: h, route: r };
      }
    }
    return undefined;
  };

  const host = location.hostname;
  if (isLocal(host) || location.protocol === "http:") {
    say({
      level: "warn",
      text:
        `${location.origin} looks like a development origin. Events from a site's dev origins (§a.8: localhost and ` +
        "127.0.0.1 on any port, exact hosts, preview patterns) are accepted and shown in the portal's first-event " +
        "panel but never counted. Add the origin under the site's dev origins, or the gateway sends no CORS headers.",
    });
  }
  for (const f of blockedReasons()) say(f);

  const orig = window.fetch;
  // A no-cors GET of the gateway's health route (no tenant data, not rate limited): an opaque answer means the host
  // is reachable, so a failed CORS request was refused for this origin; a failure means it is blocked or offline.
  const probe = (h: string): Promise<boolean> =>
    new Promise<Response>((resolve) =>
      resolve(
        orig.call(window, `${h}/healthz`, {
          mode: "no-cors",
          credentials: "omit",
          cache: "no-store",
        }),
      ),
    ).then(
      () => true,
      () => false,
    );

  const onError = (r: { host: string; route: string }, err: unknown): void => {
    if ((err as { name?: unknown } | null)?.name === "AbortError") {
      say({
        level: "block",
        text: `${r.route} to ${r.host}: no answer within 3 s (timeout) — retried on the other host`,
      });
      return;
    }
    if (Date.now() - lastCsp < 2000) return; // already explained by the CSP report
    if (navigator.onLine === false) {
      say({ level: "block", text: `${r.route} failed: the browser is offline` });
      return;
    }
    void probe(r.host).then((reachable) => {
      if (Date.now() - lastCsp < 2000) return;
      say({
        level: "block",
        text: reachable
          ? `${r.route} to ${r.host} was refused by the browser although the host is reachable: most likely this ` +
            `page's origin (${location.origin}) is neither a declared domain nor a dev origin of the site, so the ` +
            "gateway sent no CORS headers. Add it in the portal."
          : `${r.route} to ${r.host} failed and the host cannot be reached: an ad blocker or privacy extension ` +
            "blocks it, or the network does. Try with extensions off.",
      });
    });
  };

  const onResponse = (r: { host: string; route: string }, res: Response, body: unknown): void => {
    const h = res.headers.get("X-Scf-Debug");
    const base = h ? explainDebugHeader(h) : explainStatus(r.route, res.status);
    say({ level: base.level, text: `${r.route}${summary(body)}: ${base.text}` });
    if (r.route === "/v1/c" && res.status === 200) {
      res
        .clone()
        .json()
        .then((c: { t?: unknown; pow?: { alg?: unknown } }) => {
          if (typeof c?.t !== "string" || !/^[\w-]{123}$/.test(c.t)) {
            say({
              level: "block",
              text: "the challenge answer has no valid v1 token: the tracker stops on this page (wrong ingest host or a proxy in between?)",
            });
          } else if (c.pow?.alg !== "pbkdf2-sha256") {
            say({
              level: "warn",
              text: "unknown proof-of-work algorithm: events go without proof (suspect)",
            });
          }
        })
        .catch(() =>
          say({
            level: "block",
            text: "the challenge answer is not JSON: the tracker stops on this page",
          }),
        );
    }
  };

  const wrapped = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = route(url);
    const p = orig.call(this ?? window, input, init);
    if (r) {
      seen++;
      p.then(
        (res) => onResponse(r, res, init?.body),
        (err) => onError(r, err),
      );
    }
    return p;
  };
  window.fetch = wrapped as typeof fetch;

  const onCsp = (e: SecurityPolicyViolationEvent): void => {
    const blocked = e.blockedURI || "";
    const h = hosts.find((x) => blocked.startsWith(x));
    if (!h) return;
    lastCsp = Date.now();
    say({
      level: "block",
      text:
        `the page's Content Security Policy (${e.effectiveDirective || e.violatedDirective}) blocks ${h}: add both ` +
        `ingest hosts to connect-src (and the script host to script-src) — ${hosts.join(" ")}`,
    });
  };
  document.addEventListener("securitypolicyviolation", onCsp);

  const quiet = setTimeout(
    () => {
      if (seen) return;
      const tracker = (window as unknown as Record<symbol, unknown>)[Symbol.for("scf.tracker")];
      const reasons = blockedReasons();
      if (reasons.length) return; // already explained above
      if (!tracker) {
        say({
          level: "block",
          text:
            "no tracker is running on this page: the script was blocked (ad blocker, CSP script-src), its " +
            "integrity hash does not match (the browser console shows an SRI error), data-site is not a 22-character " +
            "key, or init() was not called.",
        });
        return;
      }
      const tag = document.querySelector("script[data-site]");
      const gated = tag?.getAttribute("data-consent") === "required";
      say({
        level: "block",
        text: gated
          ? 'consent-gated mode (data-consent="required"): nothing is sent until your consent tool calls grantConsent().'
          : 'the tracker is running but sent nothing: in consent-gated mode (init({consent: "required"})) nothing ' +
            "is sent before grantConsent(); otherwise it was stopped (destroy(), or an earlier 404/410).",
      });
    },
    (opts.quietAfter ?? 3) * 1000,
  );

  return () => {
    clearTimeout(quiet);
    if (window.fetch === (wrapped as typeof fetch)) window.fetch = orig;
    document.removeEventListener("securitypolicyviolation", onCsp);
    panel?.remove();
  };
}
