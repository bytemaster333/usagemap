// SPDX-License-Identifier: Apache-2.0
// A strict parser for the subset of TOML 1.0 a SEP-1 stellar.toml uses (no dependency): comments, `key = value`
// (bare or quoted keys, no dotted keys), `[table]`, `[[array of tables]]`, basic and literal strings, integers,
// floats, booleans, and arrays of these (also over several lines). Anything outside the subset — inline tables,
// multi-line strings, dates, dotted keys — is an error, never a guess: the published file must stay inside what this
// parser and every TOML parser read the same way. test/stellar-toml.test.ts cross-checks with Python's tomllib.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable | TomlTable[];
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const defined = new Set<string>(); // [table] headers already seen
  let i = 0;
  let line = 1;

  const peek = () => src[i];
  const fail = (m: string): never => {
    throw new TomlError(line, m);
  };
  const skipSpaces = () => {
    while (peek() === " " || peek() === "\t") i++;
  };
  const skipComment = () => {
    if (peek() === "#") {
      while (i < src.length && peek() !== "\n") {
        const c = src.charCodeAt(i);
        if ((c < 0x20 && c !== 0x09) || c === 0x7f) fail("control character in a comment");
        i++;
      }
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (i >= src.length) return;
    if (peek() === "\r" && src[i + 1] === "\n") i++;
    if (peek() !== "\n") fail(`unexpected "${peek()}" after a value`);
    i++;
    line++;
  };
  /** Whitespace, newlines and comments inside an array. */
  const skipArrayGap = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (peek() === "\r" && src[i + 1] === "\n") i++;
      if (peek() === "\n") {
        i++;
        line++;
        continue;
      }
      return;
    }
  };

  const basicString = (): string => {
    i++; // opening quote
    if (src.startsWith('""', i)) fail("multi-line strings are not supported");
    let out = "";
    for (;;) {
      if (i >= src.length || peek() === "\n") fail("unterminated string");
      const c = src[i] as string;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = src[i + 1];
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          b: "\b",
          t: "\t",
          n: "\n",
          f: "\f",
          r: "\r",
        };
        if (e !== undefined && simple[e] !== undefined) {
          out += simple[e];
          i += 2;
          continue;
        }
        if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = src.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail("bad unicode escape");
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail("escape is not a scalar value");
          out += String.fromCodePoint(cp);
          i += 2 + len;
          continue;
        }
        fail(`bad escape \\${e ?? ""}`);
      }
      const code = src.charCodeAt(i);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) fail("control character in a string");
      out += c;
      i++;
    }
  };

  const literalString = (): string => {
    i++;
    if (src.startsWith("''", i)) fail("multi-line strings are not supported");
    const end = src.indexOf("'", i);
    const nl = src.indexOf("\n", i);
    if (end < 0 || (nl >= 0 && nl < end)) fail("unterminated literal string");
    const s = src.slice(i, end);
    i = end + 1;
    return s;
  };

  const key = (): string => {
    skipSpaces();
    let k: string;
    if (peek() === '"') k = basicString();
    else if (peek() === "'") k = literalString();
    else {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i] as string)) i++;
      k = src.slice(start, i);
      if (!BARE_KEY.test(k)) fail("expected a key");
    }
    skipSpaces();
    if (peek() === ".") fail("dotted keys are not supported");
    return k;
  };

  const value = (): TomlValue => {
    skipSpaces();
    const c = peek();
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        skipArrayGap();
        if (peek() === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        skipArrayGap();
        if (peek() === ",") {
          i++;
          continue;
        }
        if (peek() === "]") {
          i++;
          return arr;
        }
        fail("expected , or ] in an array");
      }
    }
    if (c === "{") fail("inline tables are not supported");
    const start = i;
    while (i < src.length && /[^\s,\]#]/.test(src[i] as string)) i++;
    const raw = src.slice(start, i);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(raw)) {
      const n = Number(raw.replace(/_/g, ""));
      if (!Number.isSafeInteger(n)) fail("integer out of range");
      return n;
    }
    if (
      /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/.test(
        raw,
      )
    ) {
      return Number(raw.replace(/_/g, ""));
    }
    return fail(raw ? `unsupported value ${raw}` : "expected a value");
  };

  const assign = (t: TomlTable, k: string, v: TomlValue) => {
    if (Object.hasOwn(t, k)) fail(`duplicate key ${k}`);
    t[k] = v;
  };

  while (i < src.length) {
    skipSpaces();
    const c = peek();
    if (c === "\n" || c === "\r" || c === "#" || c === undefined) {
      endOfLine();
      continue;
    }
    if (c === "[") {
      const array = src[i + 1] === "[";
      i += array ? 2 : 1;
      const name = key();
      if (array ? !src.startsWith("]]", i) : peek() !== "]") fail("unterminated table header");
      i += array ? 2 : 1;
      if (array) {
        const existing = root[name];
        if (existing !== undefined && !(Array.isArray(existing) && defined.has(`[[${name}]]`)))
          fail(`${name} is already defined`);
        const list = (existing as TomlTable[] | undefined) ?? [];
        const t: TomlTable = {};
        list.push(t);
        root[name] = list;
        defined.add(`[[${name}]]`);
        current = t;
      } else {
        if (defined.has(name) || root[name] !== undefined) fail(`table ${name} is defined twice`);
        const t: TomlTable = {};
        root[name] = t;
        defined.add(name);
        current = t;
      }
      endOfLine();
      continue;
    }
    const k = key();
    if (peek() !== "=") fail(`expected = after ${k}`);
    i++;
    assign(current, k, value());
    endOfLine();
  }
  return root;
}
