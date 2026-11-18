// SPDX-License-Identifier: Apache-2.0
// Tenant documentation (docs/onboarding, docs/methodology) read as data, for onboarding-docs.test.ts: the documents,
// their code blocks (the quickstart extractor's parser), their links and headings, and the contracts they must agree
// with — the Stellar event schema v1 (wire-formats §a.3 / §a.3.1), the public paths of the control-plane OpenAPI and
// the portal's public routes. No network, no Docker.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/env.ts";
import { type CodeBlock, parseBlocks } from "../quickstarts/extract.ts";

export const ONBOARDING_DIR = join(REPO_ROOT, "docs/onboarding");
export const METHODOLOGY_DIR = join(REPO_ROOT, "docs/methodology");

export interface Doc {
  /** repository-relative path, e.g. `docs/onboarding/wallets.md` */
  rel: string;
  abs: string;
  text: string;
  blocks: CodeBlock[];
}

export function docsIn(dir: string): Doc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const abs = join(dir, f);
      const text = readFileSync(abs, "utf8");
      return { rel: abs.slice(REPO_ROOT.length + 1), abs, text, blocks: parseBlocks(f, text) };
    });
}

/** The tenant documents: every page of docs/onboarding and docs/methodology. */
export function tenantDocs(): Doc[] {
  return [...docsIn(ONBOARDING_DIR), ...docsIn(METHODOLOGY_DIR)];
}

/** The document text with fenced code blocks removed (prose, tables, inline code). */
export function prose(d: Doc): string {
  const lines = d.text.split("\n");
  const skip = new Set<number>();
  for (const b of d.blocks) {
    const n = b.code.split("\n").length; // body lines + 1 (trailing newline) = body + closing fence
    for (let i = b.line - 1; i < b.line + n; i++) skip.add(i);
  }
  return lines.filter((_, i) => !skip.has(i)).join("\n");
}

/** Inline code spans of the prose. */
export function inlineCode(d: Doc): string[] {
  return [...prose(d).matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
}

/** GitHub's heading anchor: lower case, punctuation other than `-` and `_` removed, spaces to `-`. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const l of markdown.split("\n")) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(l)) inFence = !inFence;
    if (inFence) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) out.add(slug(h[1] as string));
  }
  return out;
}

/** Markdown links `[text](target)` of the prose (not inside code). */
export function links(d: Doc): string[] {
  return [...prose(d).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
}

// --- Stellar event schema v1 (wire-formats §a.3, §a.3.1) ---

export interface StellarSchema {
  /** wire field → allowed values (`null` = no enum, e.g. id/u) */
  fields: Record<string, string[] | null>;
  events: string[];
  /** event → wire fields allowed on it (from the §a.3.1 table) */
  placement: Record<string, string[]>;
  /** rollup keys (`ck → connect_kind`, …) */
  rollupKeys: string[];
  /** counted-only events (§a.3.1 "Counted-only events") */
  countedOnly: string[];
  /** legacy (ADR-0029, schema version 0) names that are not v1 names */
  legacyOnly: string[];
  customName: RegExp;
  propKey: RegExp;
}

const WIRE = join(REPO_ROOT, "docs/contracts/wire-formats.md");

export function wireFormats(): string {
  return readFileSync(WIRE, "utf8");
}

function section(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`wire-formats.md: section "${start}" … "${end}" not found`);
  return text.slice(a, b);
}

export function stellarSchema(text = wireFormats()): StellarSchema {
  const blocks = parseBlocks("wire-formats.md", text);
  const batch = blocks.find(
    (b) =>
      b.lang === "json" &&
      b.code.includes('"$id": "https://<domain-a>/schemas/v1/event-batch.json"'),
  );
  if (!batch) throw new Error("wire-formats.md: the EventBatch schema block is missing");
  const schema = JSON.parse(batch.code) as {
    $defs: Record<
      string,
      { properties: Record<string, { enum?: string[]; const?: unknown; pattern?: string }> }
    >;
  };
  const st = schema.$defs.stellar;
  const custom = schema.$defs.custom;
  if (!st || !custom) throw new Error("wire-formats.md: $defs.stellar or $defs.custom missing");
  const fields: Record<string, string[] | null> = {};
  for (const [k, v] of Object.entries(st.properties)) fields[k] = v.enum ?? null;
  const events = fields.n ?? [];

  const s31 = section(text, "### a.3.1 Stellar event schema v1", "### a.4 ");
  const placement: Record<string, string[]> = {};
  const rollupKeys = new Set<string>();
  // a row may name the tracker release that added the event: | `wallet_connect_failed` (1.2.0) | …
  for (const row of s31.matchAll(/^\| `([a-z_]+)`(?: \(\d+\.\d+\.\d+\))? \| ([^|]+) \|/gm)) {
    const ev = row[1] as string;
    if (!events.includes(ev)) continue;
    const cell = row[2] as string;
    placement[ev] = [...cell.matchAll(/`([a-z]{2,3})`(?:\s*→\s*`([a-z_]+)`)?/g)]
      .filter((m) => (m[1] as string) in fields)
      .map((m) => {
        if (m[2]) rollupKeys.add(m[2]);
        return m[1] as string;
      });
  }
  const para = section(s31, "**Counted-only events", "- The other v1 events");
  const countedOnly = [
    ...new Set([...para.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string)),
  ].filter((n) => events.includes(n));
  // `sign_*` in the paragraph stands for the three sign events
  for (const n of events)
    if (n.startsWith("sign_") && !countedOnly.includes(n)) countedOnly.push(n);

  const legacy = schema.$defs.wallet?.properties.n?.enum ?? [];
  const customPattern = custom.properties.n?.pattern;
  if (!customPattern) throw new Error("wire-formats.md: custom event name pattern missing");
  return {
    fields,
    events,
    placement,
    rollupKeys: [
      ...rollupKeys,
      "outcome",
      "wallet",
      "duration",
      "error_class",
      "result_class",
      "passkey_op",
      "sign_kind",
      "connect_kind",
    ].filter((k, i, a) => a.indexOf(k) === i),
    countedOnly: countedOnly.sort(),
    legacyOnly: legacy.filter((n) => !events.includes(n)),
    customName: new RegExp(customPattern),
    propKey: /^[a-z][a-z0-9_]{0,31}$/,
  };
}

// --- Public URLs the platform serves ---

/** Path templates of the control-plane OpenAPI document (`/public/v1/projects/{slug}/metrics.json`, …). */
export function openApiPaths(): string[] {
  const y = readFileSync(join(REPO_ROOT, "docs/api/control-plane.openapi.yaml"), "utf8");
  return [...y.matchAll(/^ {2}(\/[^:\s]*):\s*$/gm)].map((m) => m[1] as string);
}

/** The OpenAPI servers' first URL (the portal placeholder host). */
export function openApiServer(): string {
  const y = readFileSync(join(REPO_ROOT, "docs/api/control-plane.openapi.yaml"), "utf8");
  const m = /^servers:\n- url: (\S+)/m.exec(y);
  if (!m) throw new Error("control-plane.openapi.yaml: no servers entry");
  return m[1] as string;
}

/** Does a concrete path match a template (`{x}` = one non-empty segment)? */
export function matchesTemplate(path: string, template: string): boolean {
  const re = new RegExp(
    `^${template
      .split(/(\{[^}]+\})/)
      .map((p) => (p.startsWith("{") ? "[^/]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );
  return re.test(path);
}

/** Path patterns of the portal router (`/p/$slug` → `/p/{slug}`). */
export function portalRoutes(): string[] {
  const r = readFileSync(join(REPO_ROOT, "apps/portal/src/router.tsx"), "utf8");
  return [...r.matchAll(/path:\s*"([^"]+)"/g)].map((m) =>
    (m[1] as string).replace(/\$([A-Za-z]+)/g, "{$1}"),
  );
}
