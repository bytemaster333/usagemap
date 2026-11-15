// SPDX-License-Identifier: Apache-2.0
// Generates TypeScript types and the parsed OpenAPI documents from docs/api/*.openapi.yaml.
//
//   node scripts/generate.ts           write src/*.gen.ts
//   node scripts/generate.ts --check   fail (exit 1) when a committed *.gen.ts differs from a fresh generation
//
// The generator is in-repo and deterministic (pinned by being committed). It covers the JSON Schema 2020-12 subset the
// contracts use: $ref, type (single or list), enum, const, properties/required, additionalProperties, items, allOf,
// oneOf, anyOf; validation-only keywords (pattern, minimum, if/then, not, …) do not change the TypeScript type.
// openapi-typescript was evaluated first and cannot run here: it needs TypeScript's JavaScript compiler API, which the
// native TypeScript 7 package no longer ships.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const outDir = join(here, "..", "src");

const documents = [
  {
    file: "docs/api/control-plane.openapi.yaml",
    base: "control-plane",
    constName: "controlPlaneOpenApi",
  },
  {
    file: "docs/api/operator-metrics.openapi.yaml",
    base: "operator-metrics",
    constName: "operatorMetricsOpenApi",
  },
] as const;

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

function isObj(v: Json | undefined): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ident(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function typeName(ref: string): string {
  const m = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m?.[1]) throw new Error(`unsupported $ref ${ref}`);
  return m[1];
}

function literal(v: Json): string {
  return JSON.stringify(v);
}

function schemaToTs(s: Json | undefined, indent: string): string {
  if (s === undefined || s === true || (isObj(s) && Object.keys(s).length === 0)) return "unknown";
  if (s === false) return "never";
  if (!isObj(s)) throw new Error(`schema is not an object: ${JSON.stringify(s)}`);
  const parts: string[] = [];
  if (typeof s.$ref === "string") parts.push(typeName(s.$ref));
  if ("const" in s) parts.push(literal(s.const as Json));
  else if (Array.isArray(s.enum)) parts.push(s.enum.map((e) => literal(e)).join(" | ") || "never");
  else if (s.type !== undefined || s.properties !== undefined || s.items !== undefined) {
    const types = Array.isArray(s.type)
      ? (s.type as string[])
      : s.type !== undefined
        ? [s.type as string]
        : s.properties !== undefined
          ? ["object"]
          : ["array"];
    const alts = types.map((t) => primitive(t, s, indent));
    parts.push(alts.length > 1 ? alts.join(" | ") : (alts[0] ?? "unknown"));
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const list = s[key];
    if (Array.isArray(list)) parts.push(`(${list.map((x) => schemaToTs(x, indent)).join(" | ")})`);
  }
  if (Array.isArray(s.allOf)) {
    for (const x of s.allOf) {
      const t = schemaToTs(x, indent);
      if (t !== "unknown") parts.push(`(${t})`); // validation-only members (if/then) add nothing to the type
    }
  }
  if (parts.length === 0) return "unknown";
  return parts.length === 1 ? (parts[0] as string) : parts.map((p) => wrap(p)).join(" & ");
}

function wrap(t: string): string {
  return t.includes("|") && !t.startsWith("(") ? `(${t})` : t;
}

function primitive(t: string, s: Obj, indent: string): string {
  switch (t) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = schemaToTs(s.items, indent);
      return `${wrap(item)}[]`;
    }
    case "object":
      return objectType(s, indent);
    default:
      throw new Error(`unknown type ${t}`);
  }
}

function objectType(s: Obj, indent: string): string {
  const props = isObj(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const inner = `${indent}  `;
  const lines: string[] = [];
  for (const [name, ps] of Object.entries(props)) {
    const doc = isObj(ps) && typeof ps.description === "string" ? ps.description : undefined;
    if (doc)
      lines.push(`${inner}/** ${doc.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim()} */`);
    const ro = isObj(ps) && ps.readOnly === true ? "readonly " : "";
    lines.push(
      `${inner}${ro}${ident(name)}${required.has(name) ? "" : "?"}: ${schemaToTs(ps, inner)};`,
    );
  }
  const ap = s.additionalProperties;
  if (ap === true || isObj(ap)) {
    lines.push(`${inner}[key: string]: ${ap === true ? "unknown" : schemaToTs(ap, inner)};`);
  } else if (ap === undefined && Object.keys(props).length === 0) {
    lines.push(`${inner}[key: string]: unknown;`);
  }
  if (lines.length === 0) return "Record<string, never>";
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function resolveParam(doc: Obj, p: Json): Obj {
  if (isObj(p) && typeof p.$ref === "string") {
    const m = /^#\/components\/parameters\/(.+)$/.exec(p.$ref);
    const params =
      isObj(doc.components) && isObj(doc.components.parameters) ? doc.components.parameters : {};
    const r = m?.[1] ? params[m[1]] : undefined;
    if (!isObj(r)) throw new Error(`unresolved parameter ${p.$ref}`);
    return r;
  }
  if (!isObj(p)) throw new Error("bad parameter");
  return p;
}

function resolveResponse(doc: Obj, r: Json): Obj {
  if (isObj(r) && typeof r.$ref === "string") {
    const m = /^#\/components\/responses\/(.+)$/.exec(r.$ref);
    const rs =
      isObj(doc.components) && isObj(doc.components.responses) ? doc.components.responses : {};
    const x = m?.[1] ? rs[m[1]] : undefined;
    if (!isObj(x)) throw new Error(`unresolved response ${r.$ref}`);
    return x;
  }
  if (!isObj(r)) throw new Error("bad response");
  return r;
}

function contentType(content: Json | undefined, indent: string): string {
  if (!isObj(content)) return "never";
  const types: string[] = [];
  for (const [mt, body] of Object.entries(content)) {
    if (!isObj(body)) continue;
    if (mt.includes("json")) types.push(schemaToTs(body.schema, indent));
    else types.push("string");
  }
  return [...new Set(types)].join(" | ") || "never";
}

// A duplicate map key is a contract defect; it is reported, and the last value wins (as PyYAML and most OpenAPI
// tooling do), so generation is not blocked by it.
function parseLenient(source: string, sourceName: string): Obj {
  try {
    return parse(source) as Obj;
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "DUPLICATE_KEY") throw e;
    console.warn(
      `warning: ${sourceName}: ${e.message.split("\n")[0]} — last value wins; fix the contract`,
    );
    return parse(source, { uniqueKeys: false }) as Obj;
  }
}

export function generate(source: string, sourceName: string): { types: string; document: string } {
  const doc = parseLenient(source, sourceName);
  const sha = createHash("sha256").update(source).digest("hex");
  const header = `// Code generated by packages/api-types/scripts/generate.ts from ${sourceName} (sha256 ${sha}). DO NOT EDIT.\n`;
  const schemas =
    isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {};
  const out: string[] = [header, "/* eslint-disable */", ""];
  const names = Object.keys(schemas).sort();
  for (const name of names) {
    const s = schemas[name];
    if (isObj(s) && typeof s.description === "string") {
      out.push(`/** ${s.description.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim()} */`);
    }
    out.push(`export type ${name} = ${schemaToTs(s, "")};`, "");
  }
  out.push("export interface Schemas {");
  for (const name of names) out.push(`  ${name}: ${name};`);
  out.push("}", "");

  const ops: string[] = [];
  const opIds: string[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op) || typeof op.operationId !== "string") continue;
      opIds.push(op.operationId);
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map((p) =>
        resolveParam(doc, p),
      );
      const groups: Record<string, string[]> = { path: [], query: [], header: [] };
      for (const p of params) {
        const where = String(p.in);
        if (!(where in groups)) continue;
        const req = p.required === true ? "" : "?";
        groups[where]?.push(
          `      ${ident(String(p.name))}${req}: ${schemaToTs(p.schema, "      ")};`,
        );
      }
      const body =
        isObj(op.requestBody) && isObj(op.requestBody.content)
          ? contentType(op.requestBody.content, "    ")
          : "never";
      const responses: string[] = [];
      for (const [code, r] of Object.entries(isObj(op.responses) ? op.responses : {})) {
        const resp = resolveResponse(doc, r);
        responses.push(`      ${JSON.stringify(code)}: ${contentType(resp.content, "      ")};`);
      }
      const grp = (k: string) =>
        groups[k]?.length ? `{\n${groups[k]?.join("\n")}\n    }` : "Record<string, never>";
      ops.push(
        `  ${op.operationId}: {`,
        `    method: ${JSON.stringify(method)};`,
        `    path: ${JSON.stringify(path)};`,
        `    pathParams: ${grp("path")};`,
        `    query: ${grp("query")};`,
        `    headers: ${grp("header")};`,
        `    requestBody: ${body};`,
        `    responses: {\n${responses.join("\n")}\n    };`,
        "  };",
      );
    }
  }
  out.push("export interface Operations {", ...ops, "}", "");
  out.push(`export type OperationId = keyof Operations;`, "");
  out.push(
    `export const operationIds = ${JSON.stringify(opIds.sort(), null, 2).replace(/\n/g, "\n")} as const satisfies readonly OperationId[];`,
    "",
  );
  const document = `${header}\n// The parsed OpenAPI document (JSON), used for request validation and response validation in tests.\nexport const documentJson: string = ${JSON.stringify(JSON.stringify(doc))};\n`;
  return { types: out.join("\n"), document };
}

function main(): void {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const d of documents) {
    const source = readFileSync(join(repo, d.file), "utf8");
    const { types, document } = generate(source, d.file);
    const targets: Array<[string, string]> = [
      [join(outDir, `${d.base}.gen.ts`), types],
      [join(outDir, `${d.base}.openapi.gen.ts`), document],
    ];
    for (const [path, content] of targets) {
      if (check) {
        let current = "";
        try {
          current = readFileSync(path, "utf8");
        } catch {
          current = "";
        }
        if (current !== content) {
          stale++;
          console.error(`stale: ${path} (run: pnpm --filter @usagemap/api-types generate)`);
        }
      } else {
        writeFileSync(path, content);
        console.log(`wrote ${path}`);
      }
    }
  }
  if (check) {
    if (stale > 0) {
      console.error(`Result: FAIL — ${stale} generated file(s) out of date`);
      process.exit(1);
    }
    console.log("Result: PASS — generated files are current");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
