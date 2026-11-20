// SPDX-License-Identifier: Apache-2.0
// Test helpers: a tracker "dist" fixture made from the committed release files, a build into a temporary directory,
// and a small HTML tokenizer for the structural checks (no dependency on an HTML parser package).

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuildResult, build } from "../build.ts";
import { type LandingConfig, REPO_ROOT } from "../src/config.ts";

/** tracker/releases has the same layout as a tracker build's dist (`<semver>/{manifest.json,*.js}`) and is in git. */
export const RELEASES = join(REPO_ROOT, "tracker", "releases");
export const RELEASED_VERSION = "1.0.0";
export const SITE_KEY = "LandingTestKey00000000";

export const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `landing-${prefix}-`));

/** A writable copy of one released version, for tampering. */
export function releaseCopy(version = RELEASED_VERSION): string {
  const dir = tmp("dist");
  cpSync(join(RELEASES, version), join(dir, version), { recursive: true });
  return dir;
}

export function testConfig(over: Partial<LandingConfig> = {}): LandingConfig {
  return {
    trackerDist: RELEASES,
    trackerVersion: RELEASED_VERSION,
    siteKey: SITE_KEY,
    demoUrl: undefined,
    release: false,
    outDir: tmp("out"),
    repoRoot: REPO_ROOT,
    ...over,
  };
}

export const buildFor = (over: Partial<LandingConfig> = {}): BuildResult => build(testConfig(over));

export interface Tag {
  name: string;
  attrs: Map<string, string>;
  close: boolean;
  /** `<path … />`: an SVG element that closes itself */
  selfClosing: boolean;
  line: number;
}

const VOID = new Set(["meta", "link", "br", "hr", "img", "input", "source", "wbr", "area", "col"]);
const RAW = new Set(["style", "script"]);

/** Tokenises start/end tags; the content of raw-text elements (style, script) is skipped. Throws on malformed markup. */
export function tags(html: string): Tag[] {
  const out: Tag[] = [];
  const re =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  let last = 0;
  while (m !== null) {
    const between = html.slice(last, m.index);
    if (/<[a-zA-Z/!]/.test(between)) {
      throw new Error(`unparsed markup near: ${between.slice(between.search(/<[a-zA-Z/!]/), 60)}`);
    }
    last = re.lastIndex;
    if (m[2]) {
      const name = m[2].toLowerCase();
      const attrs = new Map<string, string>();
      const ar = /([^\s=>/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null = ar.exec(m[3] ?? "");
      while (a !== null) {
        const key = (a[1] as string).toLowerCase();
        if (attrs.has(key)) throw new Error(`duplicate attribute ${key} on <${name}>`);
        attrs.set(key, a[2] ?? a[3] ?? a[4] ?? "");
        a = ar.exec(m[3] ?? "");
      }
      const line = html.slice(0, m.index).split("\n").length;
      out.push({ name, attrs, close: m[1] === "/", selfClosing: m[4] === "/", line });
      if (!m[1] && RAW.has(name)) {
        const end = html.toLowerCase().indexOf(`</${name}>`, re.lastIndex);
        if (end < 0) throw new Error(`<${name}> is not closed`);
        re.lastIndex = end;
        last = end;
      }
    }
    m = re.exec(html);
  }
  if (/<[a-zA-Z/!]/.test(html.slice(last))) throw new Error("unparsed markup at the end");
  return out;
}

/** Checks that every non-void element is closed in order. Returns the problems found. */
export function balance(list: Tag[]): string[] {
  const stack: Tag[] = [];
  const problems: string[] = [];
  for (const t of list) {
    if (t.selfClosing && !t.close) continue;
    if (VOID.has(t.name)) {
      if (t.close) problems.push(`line ${t.line}: </${t.name}> on a void element`);
      continue;
    }
    if (!t.close) {
      stack.push(t);
      continue;
    }
    const top = stack.pop();
    if (!top || top.name !== t.name) {
      problems.push(`line ${t.line}: </${t.name}> closes <${top?.name ?? "nothing"}>`);
      if (top) stack.push(top);
    }
  }
  for (const t of stack) problems.push(`line ${t.line}: <${t.name}> never closed`);
  return problems;
}

/** Text content with tags removed and the five entities decoded (enough for the page's own escaping). */
export const text = (html: string): string =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
