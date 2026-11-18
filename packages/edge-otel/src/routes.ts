// SPDX-License-Identifier: Apache-2.0
// Route templates: the developer lists the app's routes once, in the syntax of
// their framework, and each request is reported under its template instead of
// its raw path. The reported route is the template normalised exactly as the
// UsageMap Collector normalises an http.route (pathnorm route mode), e.g.
// "/sep24/transactions/:id" → "/sep24/transactions/{id}", "/files/*" →
// "/files/{wildcard}", "/api/items/[id]" → "/api/items/{id}".

import { normalize } from "./pathnorm.ts";

type Seg =
  | { kind: "literal"; value: string }
  | { kind: "param"; optional: boolean }
  | { kind: "rest"; min: 0 | 1 };

export interface CompiledRoute {
  /** The template as written. */
  readonly template: string;
  /** The route sent as http.route (pathnorm route mode of the template). */
  readonly route: string;
  readonly segments: readonly Seg[];
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]{0,31}";
const PARAM = [
  new RegExp(`^:${IDENT}$`), // Express, Hono, itty-router, Workers URLPattern
  new RegExp(`^\\{${IDENT}(?::[^}]*)?\\}$`), // OpenAPI, chi
  new RegExp(`^\\[${IDENT}\\]$`), // Next.js
  new RegExp(`^<(?:[a-z]+:)?${IDENT}>$`), // Flask-style
];
const OPTIONAL_PARAM = new RegExp(`^:${IDENT}\\?$`);
const REST_ZERO = new RegExp(
  `^(?:\\*|\\*\\*|\\*${IDENT}|\\(\\.\\*\\)|\\[\\[\\.\\.\\.${IDENT}\\]\\])$`,
);
const REST_ONE = new RegExp(`^(?:\\[\\.\\.\\.${IDENT}\\]|:${IDENT}\\+)$`);

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseSegment(s: string): Seg {
  if (PARAM.some((rx) => rx.test(s))) return { kind: "param", optional: false };
  if (OPTIONAL_PARAM.test(s)) return { kind: "param", optional: true };
  if (REST_ZERO.test(s) || new RegExp(`^:${IDENT}\\*$`).test(s)) return { kind: "rest", min: 0 };
  if (REST_ONE.test(s)) return { kind: "rest", min: 1 };
  return { kind: "literal", value: decodeSegment(s) };
}

/** Compile one template. Throws TypeError on a template that cannot be matched. */
export function compileRoute(template: string): CompiledRoute {
  if (typeof template !== "string" || !template.startsWith("/")) {
    throw new TypeError(`route template must start with "/": ${String(template)}`);
  }
  if (/[?#]/.test(template.replace(/:[A-Za-z_][A-Za-z0-9_]{0,31}\?/g, ""))) {
    throw new TypeError(`route template must not contain a query or fragment: ${template}`);
  }
  const segments = template
    .split("/")
    .filter((s) => s !== "")
    .map(parseSegment);
  segments.forEach((s, i) => {
    const last = i === segments.length - 1;
    if (s.kind === "rest" && !last) {
      throw new TypeError(`a catch-all must be the last segment: ${template}`);
    }
    if (s.kind === "param" && s.optional && !last) {
      throw new TypeError(`an optional parameter must be the last segment: ${template}`);
    }
  });
  // A ":name+" / ":name*" suffix (path-to-regexp) is not a pathnorm placeholder; report it as {wildcard}.
  const forRoute = template.replace(/\/:[A-Za-z_][A-Za-z0-9_]{0,31}[+*]$/, "/*");
  return { template, route: normalize(forRoute, "route"), segments };
}

const rank = (s: Seg | undefined): number =>
  s === undefined ? 3 : s.kind === "literal" ? 0 : s.kind === "param" ? (s.optional ? 2 : 1) : 4;

/** Most specific first: literal before parameter before catch-all, segment by segment. */
function compareSpecificity(a: CompiledRoute, b: CompiledRoute): number {
  const n = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const d = rank(a.segments[i]) - rank(b.segments[i]);
    if (d !== 0) return d;
  }
  return 0;
}

export function matches(r: CompiledRoute, parts: readonly string[]): boolean {
  const segs = r.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as Seg;
    const p = parts[i];
    if (s.kind === "rest") return parts.length - i >= s.min;
    if (p === undefined) return s.kind === "param" && s.optional && i === parts.length;
    if (s.kind === "literal" && decodeSegment(p) !== s.value) return false;
  }
  return parts.length === segs.length;
}

/** A matcher over a set of templates. Ties keep the declared order. */
export function createMatcher(
  templates: readonly string[],
): (pathname: string) => string | undefined {
  const compiled = templates
    .map(compileRoute)
    .map((r, i) => ({ r, i }))
    .sort((x, y) => compareSpecificity(x.r, y.r) || x.i - y.i)
    .map(({ r }) => r);
  return (pathname) => {
    const parts = pathname.split("/").filter((s) => s !== "");
    for (const r of compiled) if (matches(r, parts)) return r.route;
    return undefined;
  };
}
