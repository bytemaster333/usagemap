// SPDX-License-Identifier: Apache-2.0
// The subset of Adblock Plus / uBlock Origin / AdGuard network-filter syntax needed to decide whether a request
// would be blocked: `||host^` and `|` anchors, `*` and `^`, regular-expression filters, `@@` exceptions, hosts-file
// lines, and the options that decide whether a filter applies to a request (`$script`, `$xhr`, `$ping`, `$3p`,
// `domain=`/`from=`, `to=`, `denyallow=`, `method=`, `important`, `match-case`, `badfilter`, …). Cosmetic and
// scriptlet filters never block a request and are ignored; filters with an option that does not block requests
// (`$removeparam`, `$csp`, `$redirect-rule`, …) are ignored; filters with an option this matcher does not know are
// counted as unsupported and reported, never silently dropped. Self-contained (no dependencies) and conservative:
// where the matcher has to approximate, it errs towards reporting a block.

/** Request types as Adblock filters name them. `fetch()` is `xmlhttprequest`, `sendBeacon()` is `ping`. */
export type RequestType = "script" | "xmlhttprequest" | "ping" | "document" | "other";

export interface Request {
  url: string;
  type: RequestType;
  method: "GET" | "POST";
  /** Host of the page that makes the request (a tenant page). */
  pageHost: string;
  /** Addresses the request host resolves to, if known (for uBO `ipaddress=`; unknown → such filters do not apply). */
  ips?: readonly string[];
}

export interface Filter {
  raw: string;
  list: string;
  line: number;
  exception: boolean;
  important: boolean;
  re: RegExp;
  /** A lower-cased literal the URL must contain for the filter to possibly match (speed only). */
  literal: string;
  types?: Set<string>;
  notTypes?: Set<string>;
  party?: "1p" | "3p";
  from?: DomainList;
  top?: DomainList;
  to?: DomainList;
  methods?: { include: Set<string>; exclude: Set<string> };
  /** uBO `ipaddress=` value. */
  ip?: string;
}

interface DomainList {
  include: string[];
  exclude: string[];
}

export type Parsed =
  | { kind: "filter"; filter: Filter }
  | { kind: "badfilter"; key: string }
  | { kind: "ignored" }
  | { kind: "unsupported"; reason: string };

const TYPE_ALIASES: Record<string, string> = {
  script: "script",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  ping: "ping",
  beacon: "ping",
  document: "document",
  doc: "document",
  other: "other",
  image: "image",
  img: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  subdocument: "subdocument",
  frame: "subdocument",
  font: "font",
  media: "media",
  object: "object",
  "object-subrequest": "object",
  websocket: "websocket",
  webrtc: "webrtc",
  popup: "popup",
  webtransport: "webtransport",
};

/** Options that make a filter do something other than block the request: such filters never block. */
const NOT_BLOCKING = new Set([
  "removeparam",
  "queryprune",
  "csp",
  "permissions",
  "redirect-rule",
  "urlskip",
  "removeheader",
  "responseheader",
  "cookie",
  "replace",
  "urltransform",
  "uritransform",
  "jsonprune",
  "xmlprune",
  "hls",
  "stealth",
  "content",
  "extension",
  "jsinject",
  "urlblock",
  "elemhide",
  "ehide",
  "generichide",
  "ghide",
  "specifichide",
  "shide",
  "genericblock",
  "inline-script",
  "inline-font",
  "cname",
  "network",
  "app",
  "referrerpolicy",
  "sitekey",
  "popunder",
]);

/**
 * Options that do not restrict which requests match, or that restrict it on something this check cannot know
 * (`header=`: a response header). The latter is assumed to hold, so such a filter is reported if everything else
 * matches — conservative.
 */
const NEUTRAL = new Set(["redirect", "rewrite", "empty", "mp4", "reason", "match-case", "header"]);

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd]|fe80:|::1$)/i;

/** uBO `ipaddress=`: exact address, `prefix*`, `/regex/`, `lan` or `loopback`. */
export function ipMatches(ip: string, spec: string): boolean {
  if (spec === "lan") return PRIVATE.test(ip);
  if (spec === "loopback") return ip.startsWith("127.") || ip === "::1";
  if (spec.length > 2 && spec.startsWith("/") && spec.endsWith("/")) {
    try {
      return new RegExp(spec.slice(1, -1)).test(ip);
    } catch {
      return false;
    }
  }
  if (spec.endsWith("*")) return ip.startsWith(spec.slice(0, -1));
  return ip === spec;
}

const escapeRe = (s: string): string => s.replace(/[.+?${}()[\]\\/]/g, "\\$&");

/** Adblock pattern → RegExp source (`||`, `|`, `*`, `^`). */
export function patternToRegExp(pattern: string): string {
  let p = pattern;
  let prefix = "";
  let suffix = "";
  if (p.startsWith("||")) {
    prefix = "^[a-z][a-z0-9+.-]*:\\/+(?:[^\\/?#]*\\.)?";
    p = p.slice(2);
  } else if (p.startsWith("|")) {
    prefix = "^";
    p = p.slice(1);
  }
  if (p.endsWith("|") && !p.endsWith("\\|")) {
    suffix = "$";
    p = p.slice(0, -1);
  }
  let src = "";
  for (const ch of p) {
    if (ch === "*") src += ".*";
    else if (ch === "^") src += "(?:[^\\w.%-]|$)";
    else if (ch === "|") src += "\\|";
    else src += escapeRe(ch);
  }
  return prefix + src + suffix;
}

const longestLiteral = (pattern: string): string => {
  let best = "";
  for (const part of pattern.replace(/^\|\|?/, "").split(/[*^|]/)) {
    if (part.length > best.length) best = part;
  }
  return best.toLowerCase();
};

const domainList = (value: string, sep: string): DomainList => {
  const d: DomainList = { include: [], exclude: [] };
  for (const raw of value.split(sep)) {
    const x = raw.trim().toLowerCase();
    if (!x) continue;
    if (x.startsWith("~")) d.exclude.push(x.slice(1));
    else d.include.push(x);
  }
  return d;
};

/** `host` is `d` or a subdomain of it; `d` may end in `.*` (any public suffix) or be a uBO `/regex/`. */
export function hostMatches(host: string, d: string): boolean {
  if (d.startsWith("/") && d.endsWith("/") && d.length > 2) {
    try {
      return new RegExp(d.slice(1, -1)).test(host);
    } catch {
      return false;
    }
  }
  if (d.endsWith(".*")) {
    // `example.*`: `example` followed by any suffix, at a label boundary (conservative: any suffix, not only PSL).
    const base = d.slice(0, -2);
    const labels = host.split(".");
    for (let i = 0; i < labels.length; i++) {
      if (labels.slice(i).join(".").startsWith(`${base}.`)) return true;
    }
    return false;
  }
  return host === d || host.endsWith(`.${d}`);
}

const inList = (host: string, l: DomainList | undefined): boolean => {
  if (!l) return true;
  if (l.exclude.some((d) => hostMatches(host, d))) return false;
  return l.include.length === 0 || l.include.some((d) => hostMatches(host, d));
};

/**
 * Registrable domain, approximated as the last two labels (three under a two-letter second-level label such as
 * `co.uk`). Enough to tell a tenant page from an ingest host on another domain.
 */
export const site = (host: string): string => {
  const l = host.split(".");
  const n =
    l.length >= 3 && (l[l.length - 2] ?? "").length <= 3 && (l.at(-1) ?? "").length === 2 ? 3 : 2;
  return l.slice(-n).join(".");
};

/** Parse one line of a filter list. */
export function parseLine(line: string, list = "", lineNo = 0): Parsed {
  let s = line.trim();
  if (!s || s.startsWith("!") || s.startsWith("[") || s.startsWith("#")) return { kind: "ignored" };
  // Cosmetic, scriptlet and HTML filters (`##`, `#@#`, `#?#`, `#$#`, `#%#`, `$$`, `$@$`): never block a request.
  if (/#[@?$%]?#|#@?[$%?]#|\$@?\$/.test(s)) return { kind: "ignored" };
  // hosts-file line → `||host^`
  const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([^\s#]+)/.exec(s);
  if (hosts) {
    const h = (hosts[1] ?? "").toLowerCase();
    if (h === "localhost" || h === "0.0.0.0" || h.includes("localhost")) return { kind: "ignored" };
    s = `||${h}^`;
  }

  const raw = s;
  let exception = false;
  if (s.startsWith("@@")) {
    exception = true;
    s = s.slice(2);
  }

  // Split pattern and options. A regex filter `/…/` may contain `$`; options follow the closing slash.
  let pattern = s;
  let opts = "";
  let isRegex = false;
  if (s.startsWith("/") && !s.startsWith("//")) {
    // `/regex/$options`: the first `/$` followed by option syntax (option values may contain `/` and `$`) …
    for (let i = s.indexOf("/$", 1); i > 0; i = s.indexOf("/$", i + 1)) {
      if (/^[\w~-]+(=|,|$)/.test(s.slice(i + 2))) {
        isRegex = true;
        pattern = s.slice(0, i + 1);
        opts = s.slice(i + 2);
        break;
      }
    }
    // … else `/regex/` without options, if it is a valid expression (otherwise a plain path pattern).
    if (!isRegex && s.length > 2 && s.endsWith("/")) {
      try {
        new RegExp(s.slice(1, -1));
        isRegex = true;
      } catch {}
    }
  }
  if (!isRegex) {
    const i = s.lastIndexOf("$");
    if (i >= 0 && /^[\w~-]+(=|,|$)/.test(s.slice(i + 1))) {
      pattern = s.slice(0, i);
      opts = s.slice(i + 1);
    }
  }

  const f: Partial<Filter> & { raw: string } = { raw, exception, important: false };
  let matchCase = false;
  let badfilter = false;
  const types = new Set<string>();
  const notTypes = new Set<string>();
  // Options are comma-separated, but `domain=` values never contain commas; uBO regex values may.
  const optList = opts ? opts.split(/,(?=~?[\w-]+(?:=|,|$))/) : [];
  for (const opt of optList) {
    const neg = opt.startsWith("~");
    const [k0, ...rest] = (neg ? opt.slice(1) : opt).split("=");
    const k = (k0 ?? "").toLowerCase();
    const v = rest.join("=");
    if (k in TYPE_ALIASES) {
      (neg ? notTypes : types).add(TYPE_ALIASES[k] as string);
    } else if (k === "all") {
      for (const t of Object.values(TYPE_ALIASES)) types.add(t);
    } else if (k === "third-party" || k === "3p" || k === "strict3p") {
      f.party = neg ? "1p" : "3p";
    } else if (k === "first-party" || k === "1p" || k === "strict1p") {
      f.party = neg ? "3p" : "1p";
    } else if (k === "domain" || k === "from") {
      f.from = domainList(v, "|");
    } else if (k === "ipaddress") {
      f.ip = v;
    } else if (k === "top") {
      f.top = domainList(v, "|"); // uBO: the top-level page; our requests come from the top-level page
    } else if (/^_+$/.test(k)) {
      // uBO no-op separator
    } else if (k === "to") {
      f.to = domainList(v, "|");
    } else if (k === "denyallow") {
      f.to = { include: [], exclude: domainList(v, "|").include };
    } else if (k === "method") {
      const m = domainList(v.toUpperCase(), "|");
      f.methods = {
        include: new Set(m.include.map((x) => x.toUpperCase())),
        exclude: new Set(m.exclude.map((x) => x.toUpperCase())),
      };
    } else if (k === "important") {
      f.important = true;
    } else if (k === "match-case") {
      matchCase = true;
    } else if (k === "badfilter") {
      badfilter = true;
    } else if (NOT_BLOCKING.has(k)) {
      return { kind: "ignored" };
    } else if (!NEUTRAL.has(k)) {
      return { kind: "unsupported", reason: `option ${k}` };
    }
  }
  if (badfilter) {
    // The filter this one disables: the same text without the `badfilter` option.
    const rest = optList.filter((o) => o.toLowerCase() !== "badfilter");
    const key = `${exception ? "@@" : ""}${pattern}${rest.length ? `$${rest.join(",")}` : ""}`;
    return { kind: "badfilter", key };
  }
  if (types.size) f.types = types;
  if (notTypes.size) f.notTypes = notTypes;

  let src: string;
  if (isRegex) {
    src = pattern.slice(1, -1);
    f.literal = "";
  } else {
    if (pattern === "" || pattern === "*") pattern = "*";
    src = patternToRegExp(pattern);
    f.literal = longestLiteral(pattern);
  }
  try {
    f.re = new RegExp(src, matchCase ? "" : "i");
  } catch {
    return { kind: "unsupported", reason: "invalid regular expression" };
  }
  f.list = list;
  f.line = lineNo;
  return { kind: "filter", filter: f as Filter };
}

/** Whether the filter's options and pattern apply to the request. */
export function applies(f: Filter, r: Request, lowerUrl = r.url.toLowerCase()): boolean {
  if (f.literal && !lowerUrl.includes(f.literal)) return false;
  if (f.types && !f.types.has(r.type)) return false;
  if (f.notTypes?.has(r.type)) return false;
  // A filter without a type option does not apply to the main document (ABP/uBO semantics).
  if (!f.types && r.type === "document") return false;
  const reqHost = new URL(r.url).hostname.toLowerCase();
  if (f.party) {
    const third = site(reqHost) !== site(r.pageHost);
    if ((f.party === "3p") !== third) return false;
  }
  if (!inList(r.pageHost.toLowerCase(), f.from)) return false;
  if (!inList(r.pageHost.toLowerCase(), f.top)) return false;
  if (!inList(reqHost, f.to)) return false;
  if (f.ip !== undefined && !(r.ips ?? []).some((ip) => ipMatches(ip, f.ip as string)))
    return false;
  if (f.methods) {
    if (f.methods.exclude.has(r.method)) return false;
    if (f.methods.include.size && !f.methods.include.has(r.method)) return false;
  }
  return f.re.test(r.url);
}

export interface Verdict {
  blocked: boolean;
  /** The blocking filter that matched (also set when an exception overrides it). */
  by?: Filter;
  /** The exception that allowed a request a blocking filter matched — fragile, so it is reported. */
  allowedBy?: Filter;
}

/** One filter list (or a group of files loaded as one list), evaluated on its own. */
export class FilterSet {
  readonly blocking: Filter[] = [];
  readonly exceptions: Filter[] = [];
  readonly unsupported = new Map<string, number>();
  private readonly bad = new Set<string>();
  rules = 0;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  add(text: string, file = this.name): this {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const p = parseLine(lines[i] ?? "", file, i + 1);
      if (p.kind === "filter") {
        this.rules++;
        (p.filter.exception ? this.exceptions : this.blocking).push(p.filter);
      } else if (p.kind === "badfilter") {
        this.bad.add(p.key);
      } else if (p.kind === "unsupported") {
        this.unsupported.set(p.reason, (this.unsupported.get(p.reason) ?? 0) + 1);
      }
    }
    return this;
  }

  match(r: Request): Verdict {
    const lower = r.url.toLowerCase();
    const live = (f: Filter) => !this.bad.has(f.raw) && applies(f, r, lower);
    const block = this.blocking.filter(live);
    if (!block.length) return { blocked: false };
    const important = block.find((f) => f.important);
    const exception = this.exceptions.find(live);
    if (important) return { blocked: true, by: important };
    if (exception) return { blocked: false, by: block[0] as Filter, allowedBy: exception };
    return { blocked: true, by: block[0] as Filter };
  }
}
