// SPDX-License-Identifier: Apache-2.0
// docs.quickstarts-run: the quickstart guides (docs/guides/quickstarts/*.md) are the source of the code the fixture suite runs. This
// module reads the fenced code blocks out of the Markdown and picks the runnable ones by a convention that needs no
// marker in the documents: (guide file, the `##` section the block is in, the block's language, its position in that
// section). A pick must match exactly one block — a renamed section, a changed language tag or an added/removed block
// fails the unit test (`extract.test.ts`) before any stack is started, so the guides and the fixtures cannot drift.
//
// Only the documented placeholders (docs/guides/quickstarts/README.md: ingest hosts, OTLP endpoint, site key, ingest
// token, and the tenant's own APM `https://apm.example`) are replaced; everything else runs exactly as written.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/env.ts";

export const QUICKSTART_DIR = join(REPO_ROOT, "docs/guides/quickstarts");

export interface CodeBlock {
  /** guide file name, e.g. `api-go.md` */
  file: string;
  /** text of the nearest preceding `##` heading ("" before the first one) */
  section: string;
  /** info string's first word (`js`, `sh`, `yaml`, …; "" when none) */
  lang: string;
  /** 0-based index of this block among the blocks of its section */
  index: number;
  /** 1-based line of the opening fence */
  line: number;
  code: string;
}

/** Every fenced code block of a Markdown document (``` or ~~~ fences, CommonMark rules for the closing fence). */
export function parseBlocks(file: string, markdown: string): CodeBlock[] {
  const lines = markdown.split(/\r?\n/);
  const out: CodeBlock[] = [];
  let section = "";
  let perSection = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(l);
    if (h && !/^###/.test(l)) {
      section = (h[1] as string).trim();
      perSection = 0;
      continue;
    }
    const open = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)/.exec(l);
    if (!open) continue;
    const fence = open[2] as string;
    const indent = (open[1] as string).length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const c = lines[j] as string;
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      if (close.test(c)) break;
      body.push(indent > 0 ? c.replace(new RegExp(`^ {0,${indent}}`), "") : c);
    }
    if (j >= lines.length) throw new Error(`${file}:${i + 1}: unclosed code fence`);
    out.push({
      file,
      section,
      lang: (open[3] as string).toLowerCase(),
      index: perSection++,
      line: i + 1,
      code: `${body.join("\n")}\n`,
    });
    i = j;
  }
  return out;
}

export function readGuide(file: string, dir = QUICKSTART_DIR): string {
  return readFileSync(join(dir, file), "utf8");
}

export function guideBlocks(file: string, dir = QUICKSTART_DIR): CodeBlock[] {
  return parseBlocks(file, readGuide(file, dir));
}

export interface Pick {
  file: string;
  /** the section heading must start with this text */
  section: string;
  lang: string;
  /** position among the blocks of this language in the section (default 0) */
  nth?: number;
}

/** The one block a pick names; throws (with what was found) when there is none. */
export function pick(p: Pick, dir = QUICKSTART_DIR): CodeBlock {
  const all = guideBlocks(p.file, dir);
  const inSection = all.filter((b) => b.section.startsWith(p.section));
  if (inSection.length === 0)
    throw new Error(
      `${p.file}: no section starting with "${p.section}" (sections: ${[...new Set(all.map((b) => b.section))].join(" | ")})`,
    );
  const ofLang = inSection.filter((b) => b.lang === p.lang);
  const b = ofLang[p.nth ?? 0];
  if (!b)
    throw new Error(
      `${p.file} § "${p.section}": no ${p.lang} block #${p.nth ?? 0} (found ${inSection.map((x) => x.lang || "plain").join(", ")})`,
    );
  return b;
}

// --- placeholders (docs/guides/quickstarts/README.md, "Placeholders used throughout") ---

export const PLACEHOLDER = {
  ingestA: "https://ingest-a.example-analytics.org",
  ingestB: "https://ingest-b.example-analytics.net",
  otlp: "https://ingest.scf.example",
  siteKey: "YOUR_22_CHAR_SITE_KEY",
  apm: "https://apm.example",
} as const;

/**
 * Replaces placeholders, longest first. Every key must occur at least once (a recipe whose placeholder disappeared
 * would otherwise silently keep talking to a host that does not exist).
 */
export function substitute(code: string, values: Record<string, string>): string {
  let out = code;
  for (const k of Object.keys(values).sort((a, b) => b.length - a.length)) {
    if (!out.includes(k)) throw new Error(`placeholder ${k} not found in the recipe`);
    out = out.split(k).join(values[k] as string);
  }
  return out;
}
