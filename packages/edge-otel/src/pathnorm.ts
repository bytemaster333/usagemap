// SPDX-License-Identifier: Apache-2.0
// Route normalisation for the edge: a port of the path and route modes of
// packages/pathnorm (scf-path-rules/1.1.0, ADR-0012). The output is the same
// route the UsageMap Collector would compute from the raw path, so the edge
// sends only folded, secret-free routes and the Collector's own pass over them
// is a no-op (every pathnorm output is a fixed point in route mode).
//
// Kept in lock-step by test/pathnorm.test.ts, which runs the shared corpus
// (packages/pathnorm/testdata/vectors*.json), and conformance/, which checks
// the outputs against the Go implementation itself. Rule IDs and redaction
// counters are not ported: they never change the route.
//
// Go operates on UTF-8 bytes; this port works on decoded strings and uses
// byte lengths wherever the Go code compares len().

import { b32Value, decodeStrKeyType, SIGNED_PAYLOAD_LENGTHS } from "./strkey.ts";

export const RULE_SET_VERSION = "scf-path-rules/1.1.0";

const MAX_INPUT_BYTES = 8192;
const MAX_DEPTH = 12;
const MAX_SEGMENT_RUNES = 256;
const MAX_LITERAL_RUNES = 64;
const MAX_OUTPUT_BYTES = 1024;
const MAX_PARAM_NAME = 32;

const PH = {
  account: "{account}",
  contract: "{contract}",
  pool: "{pool}",
  balance: "{balance}",
  signer: "{signer}",
  asset: "{asset}",
  hash: "{hash}",
  hex: "{hex}",
  int: "{int}",
  event: "{event}",
  cursor: "{cursor}",
  date: "{date}",
  uuid: "{uuid}",
  id: "{id}",
  token: "{token}",
  key: "{key}",
  static: "{static}",
  redacted: "{redacted}",
  invalid: "{invalid}",
  long: "{long}",
  rest: "{rest}",
  wildcard: "{wildcard}",
  overflow: "{overflow}",
  unknown: "{unknown}",
} as const;

export const UNKNOWN_ROUTE = PH.unknown;

// Regex catalogue (packages/pathnorm/rules.go). Go's \s is [\t\n\f\r ], spelled out here.
const rxSeedAnywhere = /[Ss][A-Da-d][A-Za-z2-7]{54}/;
const rxJWT = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;
const rxJWTEmbed = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./;
const rxAPIKey =
  /^(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|sk_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})$/;
const rxEmail = /^[^@\t\n\f\r /]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const rxEmailEmbed = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const rxFederation = /^[^*\t\n\f\r /]+\*[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const rxPhone = /^\+[0-9][0-9 ().-]{6,20}$/;
const rxIPv4 =
  /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const rxIPv6 = /^[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}$/;
const rxAsset = /^(?:stellar:)?([A-Za-z0-9]{1,12})[:-]([Gg][A-Da-d][A-Za-z2-7]{54})(?:-[12])?$/;
const rxAssetFiat = /^iso4217:[A-Za-z]{3}$/;
const rxDate =
  /^[0-9]{4}-[01][0-9]-[0-3][0-9](?:[Tt ][0-2][0-9]:[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,9})?)?(?:[Zz]|[+-][0-2][0-9]:?[0-5][0-9])?)?$/;
const rxVersion = /^[vV][0-9]{1,3}(?:[._][0-9]{1,3}){0,2}(?:[a-z]{1,8}[0-9]{0,3})?$/;
const rxSEP = /^(?:sep|SEP|cap|CAP)-?[0-9]{1,4}$/;
const rxUUID =
  /^(?:[Uu][Rr][Nn]:[Uu][Uu][Ii][Dd]:)?\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$/;
const rxULID = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
const rxB64Token = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const rxMethodPrefix = /^(?:GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH|QUERY|_OTHER) +\//;
const rxAbsolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;
const routeSyntaxes = [
  /^:([A-Za-z_][A-Za-z0-9_]{0,31})\??$/,
  /^\{([A-Za-z_][A-Za-z0-9_]{0,31})(?::[^}]*)?\}$/,
  /^<(?:[a-z]+:)?([A-Za-z_][A-Za-z0-9_]{0,31})>$/,
  /^\[{1,2}(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]{0,31})\]{1,2}$/,
];

const ALLOW_LITERALS = new Set(
  (
    "ed25519 secp256k1 secp256r1 sha256 sha512 sha3 keccak256 base64 base32 base58 x509 utf8 utf-8 " +
    "oauth2 2fa i18n l10n k8s s3 web3 erc20 erc721 erc1155 h264 mp4 mp3 p2p b2b b2c ipv4 ipv6 html5 e2e x402"
  ).split(" "),
);
const STATIC_EXT = new Set(
  "js mjs cjs css map woff woff2 ttf otf eot png jpg jpeg gif webp avif svg ico wasm json txt html webm mp4".split(
    " ",
  ),
);

const enc = new TextEncoder();
const strictUTF8 = new TextDecoder("utf-8", { fatal: true });

const byteLen = (s: string): number => enc.encode(s).length;
const runeLen = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const isDigitC = (c: number) => c >= 48 && c <= 57;
const isUpperC = (c: number) => c >= 65 && c <= 90;
const isLowerC = (c: number) => c >= 97 && c <= 122;
const isLetterC = (c: number) => isUpperC(c) || isLowerC(c);
const isAlnumC = (c: number) => isLetterC(c) || isDigitC(c);
const isHexC = (c: number) => isDigitC(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
// '-' '.' '_' '~'
const isUnreservedC = (c: number) => isAlnumC(c) || c === 45 || c === 46 || c === 95 || c === 126;

function every(s: string, f: (c: number) => boolean): boolean {
  for (let i = 0; i < s.length; i++) if (!f(s.charCodeAt(i))) return false;
  return true;
}
function some(s: string, f: (c: number) => boolean): boolean {
  for (let i = 0; i < s.length; i++) if (f(s.charCodeAt(i))) return true;
  return false;
}
const allDigits = (s: string) => s !== "" && every(s, isDigitC);
const allHex = (s: string) => every(s, isHexC);
const allWord = (s: string) => every(s, (c) => isAlnumC(c) || c === 95);
const allLetters = (s: string) => every(s, isLetterC);
const hasDigit = (s: string) => some(s, isDigitC);
const hasLetter = (s: string) => some(s, isLetterC);
const hasMixedCase = (s: string) => some(s, isUpperC) && some(s, isLowerC);
const isSafeLiteral = (s: string) => s !== "" && every(s, isUnreservedC);

/** Decode %XX escapes once into bytes; malformed escapes are kept as text. */
function percentDecodeBytes(s: string): Uint8Array {
  const b = enc.encode(s);
  if (!b.includes(37)) return b;
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i] ?? 0;
    const h1 = b[i + 1] ?? 0;
    const h2 = b[i + 2] ?? 0;
    if (c === 37 && i + 2 < b.length && isHexC(h1) && isHexC(h2)) {
      out[n++] = (unhex(h1) << 4) | unhex(h2);
      i += 2;
      continue;
    }
    out[n++] = c;
  }
  return out.subarray(0, n);
}
function unhex(c: number): number {
  if (isDigitC(c)) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  return c - 55;
}

/** C0 controls, DEL and C1 controls. */
function hasControl(d: string): boolean {
  for (const ch of d) {
    const r = ch.codePointAt(0) ?? 0;
    if (r < 0x20 || r === 0x7f || (r >= 0x80 && r <= 0x9f)) return true;
  }
  return false;
}

// Go's unicode.IsSpace above Latin-1 (White_Space property); U+0085 and U+00A0 included.
const UNICODE_SPACE = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const SPECIAL_ASCII = ":@*+,=!$'()&;%\\{}[]<>|^`\" \t\n\v\f\r";

function hasSpecial(d: string): boolean {
  for (const ch of d) {
    if (ch.charCodeAt(0) < 0x80) {
      if (SPECIAL_ASCII.includes(ch)) return true;
    } else if (UNICODE_SPACE.test(ch)) {
      return true;
    }
  }
  return false;
}

/** Canonical percent-encoding of a literal: unreserved characters raw, all else %XX of the UTF-8 bytes. */
function encodeLiteral(d: string): string {
  if (isSafeLiteral(d)) return d;
  const hex = "0123456789ABCDEF";
  let out = "";
  for (const c of enc.encode(d)) {
    out += isUnreservedC(c) ? String.fromCharCode(c) : `%${hex[c >> 4]}${hex[c & 15]}`;
  }
  return out;
}

/** ^[A-Za-z_][A-Za-z0-9_]{0,31}$ */
function isIdent(s: string): boolean {
  if (s.length < 1 || s.length > MAX_PARAM_NAME) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isLetterC(c) || c === 95 || (i > 0 && isDigitC(c))) continue;
    return false;
  }
  return true;
}

/** Route mode (R1): framework placeholders → {lower-cased name}; catch-alls → {wildcard}. */
function routePlaceholder(d: string): string | undefined {
  if (d === "") return undefined;
  switch (d[0]) {
    case "*":
      return d === "*" || d === "**" || isIdent(d.slice(1)) ? PH.wildcard : undefined;
    case "(":
      return d === "(.*)" ? PH.wildcard : undefined;
    case ":":
    case "{":
    case "<":
    case "[":
      break;
    default:
      return undefined;
  }
  for (const rx of routeSyntaxes) {
    const m = rx.exec(d);
    if (!m) continue;
    const name = (m[1] ?? "").toLowerCase();
    if (name === "unknown" || name === "overflow") return undefined;
    return `{${name}}`;
  }
  return undefined;
}

function isPlaceholderName(s: string): boolean {
  if (s.length < 1 || s.length > MAX_PARAM_NAME) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isLowerC(c) || c === 95 || (i > 0 && isDigitC(c))) continue;
    return false;
  }
  return true;
}

/** S0: our own placeholders pass unchanged (idempotence). */
function isOwnPlaceholder(d: string): boolean {
  if (d.length < 3 || d[0] !== "{") return false;
  if (d.startsWith("{static}.")) {
    const ext = d.slice("{static}.".length);
    return ext.length >= 1 && ext.length <= 8 && every(ext, (c) => isLowerC(c) || isDigitC(c));
  }
  if (d[d.length - 1] !== "}") return false;
  return isPlaceholderName(d.slice(1, -1)) && d !== PH.unknown && d !== PH.overflow;
}

/** S1 secrets and S2 personal identifiers. */
function isSensitive(d: string): boolean {
  if (d.length >= 56 && rxSeedAnywhere.test(d)) return true;
  if (d.includes("eyJ") && (rxJWT.test(d) || rxJWTEmbed.test(d))) return true;
  if (d.length >= 16 && rxAPIKey.test(d)) return true;
  if (d.includes("@") && (rxEmail.test(d) || rxEmailEmbed.test(d))) return true;
  if (d.includes("*") && rxFederation.test(d)) return true;
  if (d[0] === "+" && rxPhone.test(d)) return true;
  return isIP(d);
}

function isIP(d: string): boolean {
  if (d.length >= 7 && d.length <= 15 && isDigitC(d.charCodeAt(0)) && rxIPv4.test(d)) return true;
  if ((d.match(/:/g)?.length ?? 0) >= 2 && rxIPv6.test(d)) return some(d, isAlnumC);
  return false;
}

/** S4: StrKey shape (upper-cased) → strict decode → typed placeholder; a bad checksum → {id}. */
function classifyStrKey(d: string): string | undefined {
  const n = d.length; // ASCII-only below, so length = byte length
  if (n < 56 || n > 165) return undefined;
  let u = "";
  for (let i = 0; i < n; i++) {
    let c = d.charCodeAt(i);
    if (isLowerC(c)) c -= 32;
    if (b32Value(c) < 0) return undefined;
    u += String.fromCharCode(c);
  }
  if (u[1] === undefined || u[1] < "A" || u[1] > "D") return undefined;
  let shape = false;
  if (n === 56) shape = "GCTXL".includes(u[0] ?? "");
  else if (n === 58) shape = u.startsWith("BAA") && "AEIMQUY4".includes(u[57] ?? "");
  if (!shape && n === 69 && (u[0] === "M" || u[0] === "W")) {
    shape = "ACEGIKMOQSUWY246".includes(u[68] ?? "");
  }
  if (!shape && u[0] === "P" && SIGNED_PAYLOAD_LENGTHS.has(n)) shape = true;
  if (!shape) return undefined;
  switch (decodeStrKeyType(u)) {
    case undefined:
      return PH.id;
    case "G":
    case "M":
      return PH.account;
    case "C":
    case "W":
      return PH.contract;
    case "L":
      return PH.pool;
    case "B":
      return PH.balance;
    default:
      return PH.signer;
  }
}

/** S5: CODE:ISSUER, CODE-ISSUER[-1|2], stellar:CODE:ISSUER; the issuer must decode as G. */
function isAsset(d: string): boolean {
  if (d.length < 58 || d.length > 80) return false;
  const m = rxAsset.exec(d);
  if (!m || m[2] === undefined) return false;
  return decodeStrKeyType(m[2].toUpperCase()) === "G";
}

function isAllowLiteral(t: string): boolean {
  return t.length <= 9 && ALLOW_LITERALS.has(asciiLower(t));
}
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** S8: versions, SEP/CAP names, technical tokens. */
function isAllowed(d: string): boolean {
  if (d === "") return false;
  const c = d[0];
  if ((c === "v" || c === "V") && rxVersion.test(d)) return true;
  if ((c === "s" || c === "S" || c === "c" || c === "C") && rxSEP.test(d)) return true;
  return isAllowLiteral(d);
}

const isEvent = (d: string) =>
  d.length === 30 && d[19] === "-" && allDigits(d.slice(0, 19)) && allDigits(d.slice(20));

function isCursor(d: string): boolean {
  const i = d.indexOf("-");
  if (i < 1 || i > 20) return false;
  const r = d.slice(i + 1);
  return r.length >= 1 && r.length <= 10 && allDigits(d.slice(0, i)) && allDigits(r);
}

const isDate = (d: string) =>
  d.length >= 10 && d[4] === "-" && allDigits(d.slice(0, 4)) && rxDate.test(d);

function isDecimal(d: string): boolean {
  if (d === "") return false;
  const neg = d[0] === "-";
  const s = neg ? d.slice(1) : d;
  const i = s.indexOf(".");
  if (i < 0) return neg && s.length > 0 && allDigits(s);
  return i > 0 && i < s.length - 1 && allDigits(s.slice(0, i)) && allDigits(s.slice(i + 1));
}

/** S7: UUID, 72-hex claimable balance, 64-hex hash, long hex, mid-length mixed hex. */
function classifyHex(d: string): string | undefined {
  const n = d.length;
  if (n >= 36 && n <= 47 && d.includes("-") && rxUUID.test(d)) return PH.uuid;
  if (n === 72 && d.startsWith("00000000") && allHex(d)) return PH.balance;
  const ox = n > 2 && d[0] === "0" && (d[1] === "x" || d[1] === "X");
  const body = ox ? d.slice(2) : d;
  if (body === "" || !allHex(body)) return undefined;
  if (body.length === 64) return PH.hash;
  if (body.length >= 16 || ox) return PH.hex;
  if (body.length >= 7 && body.length <= 15 && hasDigit(body) && hasLetter(body)) return PH.hex;
  return undefined;
}

/** Tokens of s split on . _ ~ - (empty tokens skipped). */
function tokens(s: string): string[] {
  return s.split(/[._~-]/).filter((t) => t !== "");
}

/** S9: content-hashed static names fold to {static}.<ext>; other safe static names stay literal. */
function classifyStatic(d: string, n: number): [string, boolean] | undefined {
  const dot = d.lastIndexOf(".");
  const extLen = d.length - dot - 1;
  if (dot < 1 || extLen < 1 || extLen > 8) return undefined;
  const ext = d.slice(dot + 1);
  if (!every(ext, isAlnumC)) return undefined;
  const lext = asciiLower(ext);
  if (!STATIC_EXT.has(lext)) return undefined;
  const hashed = tokens(d.slice(0, dot)).some(
    (t) =>
      (t.length >= 6 && allHex(t) && hasDigit(t)) ||
      (t.length >= 8 && allWord(t) && hasDigit(t) && hasLetter(t)) ||
      (t.length >= 2 && allDigits(t)) ||
      rxUUID.test(t),
  );
  if (hashed) return [`${PH.static}.${lext}`, false];
  if (n <= MAX_LITERAL_RUNES && isSafeLiteral(d)) return [d, true];
  return undefined;
}

/** S12: generic mixed identifiers. */
function isMixedID(d: string): boolean {
  for (const t of tokens(d)) {
    if (isAllowLiteral(t) || ((t[0] === "v" || t[0] === "V") && rxVersion.test(t))) continue;
    let run = 0;
    let maxRun = 0;
    let digit = false;
    let alpha = false;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (isDigitC(c)) {
        digit = true;
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
        if (isLetterC(c)) alpha = true;
      }
    }
    if (maxRun >= 3 || (t.length >= 8 && digit && alpha)) return true;
    if (t.length >= 16 && !digit && allLetters(t)) {
      let trans = 0;
      for (let i = 1; i < t.length; i++) {
        if (isLowerC(t.charCodeAt(i - 1)) !== isLowerC(t.charCodeAt(i))) trans++;
      }
      if (trans >= 6) return true;
    }
  }
  return false;
}

/** Per-segment classifier (S0–S14, full folding). Returns [segment, isLiteral]. */
function classify(d: string): [string, boolean] {
  if (isOwnPlaceholder(d)) return [d, false];
  if (isSensitive(d)) return [PH.redacted, false];
  const n = runeLen(d);
  if (n > MAX_SEGMENT_RUNES) return [PH.long, false];
  const sk = classifyStrKey(d);
  if (sk) return [sk, false];
  if (isAsset(d)) return [PH.asset, false];
  if (d.length === 11 && d.startsWith("iso4217:") && rxAssetFiat.test(d)) return [PH.asset, false];
  if (isAllowed(d)) return [d, true];
  if (isEvent(d)) return [PH.event, false];
  if (isDate(d)) return [PH.date, false];
  if (isCursor(d)) return [PH.cursor, false];
  if (allDigits(d)) return [PH.int, false];
  if (isDecimal(d)) return [PH.id, false];
  const hx = classifyHex(d);
  if (hx) return [hx, false];
  const st = classifyStatic(d, n);
  if (st) return st;
  if (d.length === 26 && rxULID.test(d)) return [PH.id, false];
  if (d.length >= 32 && rxB64Token.test(d)) {
    if (hasDigit(d) || hasMixedCase(d) || /[+/]/.test(d) || d.endsWith("=")) {
      return [PH.token, false];
    }
  }
  if (isSafeLiteral(d) && isMixedID(d)) return [PH.id, false];
  if (hasSpecial(d)) return [PH.id, false];
  if (n > MAX_LITERAL_RUNES) return [PH.long, false];
  return [d, true];
}

type Item = { fixed: string } | { dec: string };

/**
 * Normalise a raw path ("path") or a tenant http.route template ("route") exactly
 * as pathnorm.Normalize does (FoldingFull). Query strings and fragments are always
 * removed; secrets and personal identifiers become {redacted}; Stellar identifiers,
 * hashes, numbers and opaque ids become placeholders.
 */
export function normalize(input: string, mode: "path" | "route" = "path"): string {
  const route = mode === "route";
  let s = input;
  if (s === "") return "/";
  if (byteLen(s) > MAX_INPUT_BYTES) return `/${PH.long}`;
  const abs = rxAbsolute.exec(s);
  if (abs) s = s.slice(abs[0].length);
  if (route && s.length > 4 && s[0] !== undefined && s[0] >= "A" && s[0] <= "_") {
    if (rxMethodPrefix.test(s)) s = s.slice(s.indexOf("/"));
  }
  if (s === "*") return "*";
  const q = /[?#]/.exec(s)?.index ?? -1;
  if (q >= 0) s = s.slice(0, q);
  if (!s.startsWith("/")) s = `/${s}`;

  const items: Item[] = [];
  for (let seg of s.slice(1).split("/")) {
    if (seg === "") continue;
    if (!route) {
      const j = seg.indexOf(";");
      if (j >= 0) {
        seg = seg.slice(0, j);
        if (seg === "") continue;
      }
    }
    let d: string;
    try {
      d = strictUTF8.decode(percentDecodeBytes(seg));
    } catch {
      items.push({ fixed: PH.invalid });
      continue;
    }
    if (hasControl(d)) {
      items.push({ fixed: PH.invalid });
      continue;
    }
    if (d === ".") continue;
    if (d === "..") {
      items.pop();
      continue;
    }
    items.push({ dec: d });
  }
  if (items.length > MAX_DEPTH) {
    items.length = MAX_DEPTH;
    items.push({ fixed: PH.rest });
  }

  const out: string[] = [];
  for (const it of items) {
    if ("fixed" in it) {
      out.push(it.fixed);
      continue;
    }
    const d = it.dec;
    if (route) {
      const ph = routePlaceholder(d);
      if (ph) {
        out.push(ph);
        continue;
      }
    }
    const k = out.length;
    if (k >= 3 && out[k - 1] === "data" && out[k - 2] === PH.account && out[k - 3] === "accounts") {
      if (isOwnPlaceholder(d)) out.push(d);
      else if (isSensitive(d)) out.push(PH.redacted);
      else out.push(PH.key);
      continue;
    }
    const [seg, literal] = classify(d);
    out.push(literal ? encodeLiteral(seg) : seg);
  }

  let size = 0;
  for (const x of out) size += 1 + byteLen(x);
  if (size > MAX_OUTPUT_BYTES) {
    let keep = 0;
    let total = 0;
    while (
      keep < out.length &&
      total + 1 + byteLen(out[keep] ?? "") + 1 + PH.rest.length <= MAX_OUTPUT_BYTES
    ) {
      total += 1 + byteLen(out[keep] ?? "");
      keep++;
    }
    out.length = keep;
    out.push(PH.rest);
  }
  return out.length === 0 ? "/" : `/${out.join("/")}`;
}
