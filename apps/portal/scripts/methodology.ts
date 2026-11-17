// SPDX-License-Identifier: Apache-2.0
// Build-time rendering of the published measurement methodology (plan C1 #6, feature.signed-snapshot-v2). Every
// `docs/methodology/scf-methodology-<semver>.md` becomes the static, read-only page `/docs/methodology/<semver>` (the
// URL every v2 traction snapshot signs: services/control-plane/src/programme/snapshot-v2.ts), served by Caddy under the
// portal's own CSP: no script, no inline style, one same-origin stylesheet.
//
// The renderer handles the Markdown subset the methodology uses (ATX headings, paragraphs, pipe tables, nested
// bullet/numbered lists, indented code, code spans, **strong**, *em*, links) and escapes ALL text: no HTML in the
// source survives. Links: in-page anchors and https only; relative links to other repository documents become text
// naming the document (those documents are not served by the portal). No dependency.

import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] as string);
}

/** GitHub-style heading slug (the anchors the methodology's own links use). */
export function slugOf(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/\*\*|\*/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Inline Markdown → HTML. `base` is the repository directory of the source (for relative document references). */
export function renderInline(src: string, base = "docs/methodology"): string {
  const codes: string[] = [];
  // Code spans first: their content is literal (escaped, never formatted).
  let s = src.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, rawUrl: string) => {
    // rawUrl is already escaped; un-escape &amp; only to classify it.
    const url = rawUrl.replace(/&amp;/g, "&");
    if (/^#[A-Za-z0-9_-]+$/.test(url)) return `<a href="${rawUrl}">${text}</a>`;
    if (/^https:\/\/[^\s"'<>]+$/.test(url))
      return `<a href="${rawUrl}" rel="noreferrer">${text}</a>`;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return text; // any other scheme: text only
    const target = posix.normalize(posix.join(base, url));
    return `${text} (<span class="docref">${escapeHtml(target)}</span>)`;
  });
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![\w*])/g, "$1<em>$2</em>");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder delimiter chosen because text cannot hold it
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] as string);
}

interface Line {
  n: number;
  text: string;
}

const MARKER = /^(?:([-*+])|(\d+)[.)])\s+(.*)$/;

function indentOf(raw: string): number {
  return raw.length - raw.trimStart().length;
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (const ch of r) {
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function renderList(lines: Line[], base: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i] as Line;
    const indent = first.n;
    const ordered = Boolean(MARKER.exec(first.text)?.[2]);
    const tag = ordered ? "ol" : "ul";
    const start = i;
    out.push(`<${tag}>`);
    while (i < lines.length) {
      const l = lines[i] as Line;
      const m = MARKER.exec(l.text);
      if (!m || l.n !== indent || Boolean(m[2]) !== ordered) break;
      i++;
      const text = [m[3] ?? ""];
      const nested: Line[] = [];
      while (i < lines.length) {
        const s = lines[i] as Line;
        if (s.n <= indent && MARKER.test(s.text)) break;
        if (nested.length === 0 && !(s.n > indent && MARKER.test(s.text))) text.push(s.text);
        else nested.push(s);
        i++;
      }
      out.push(
        `<li>${renderInline(text.join(" "), base)}${nested.length ? renderList(nested, base) : ""}</li>`,
      );
    }
    out.push(`</${tag}>`);
    if (i === start) {
      // Not a list item at this level (malformed indentation): keep its text rather than loop.
      out.splice(out.length - 2, 2, `<p>${renderInline(first.text, base)}</p>`);
      i++;
      continue;
    }
    if (i < lines.length && (lines[i] as Line).n < indent) break;
  }
  return out.join("");
}

/** Block Markdown → HTML (the subset described above). */
export function renderMarkdown(md: string, base = "docs/methodology"): string {
  const raw = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const used = new Map<string, number>();
  let i = 0;
  const blank = (k: number) => (raw[k] ?? "").trim() === "";
  while (i < raw.length) {
    const line = raw[i] as string;
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Indented code (only at block start: never a list continuation, lists consume their own lines).
    if (indentOf(line) >= 4) {
      const code: string[] = [];
      while (i < raw.length && (indentOf(raw[i] as string) >= 4 || blank(i))) {
        code.push((raw[i] as string).slice(4));
        i++;
      }
      while (code.length && (code[code.length - 1] as string).trim() === "") code.pop();
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) {
      const level = (h[1] as string).length;
      const text = h[2] as string;
      let id = slugOf(text);
      const seen = used.get(id) ?? 0;
      used.set(id, seen + 1);
      if (seen > 0) id = `${id}-${seen}`;
      out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(text, base)}</h${level}>`);
      i++;
      continue;
    }
    if (line.trimStart().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(raw[i + 1] ?? "")) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < raw.length && (raw[i] as string).trimStart().startsWith("|")) {
        rows.push(splitRow(raw[i] as string));
        i++;
      }
      const cells = (r: string[], t: "td" | "th") =>
        `<tr>${r.map((c) => `<${t}>${renderInline(c, base)}</${t}>`).join("")}</tr>`;
      const thead = head.every((c) => c === "") ? "" : `<thead>${cells(head, "th")}</thead>`;
      out.push(`<table>${thead}<tbody>${rows.map((r) => cells(r, "td")).join("")}</tbody></table>`);
      continue;
    }
    if (MARKER.test(line.trimStart())) {
      const items: Line[] = [];
      while (i < raw.length && !blank(i)) {
        const l = raw[i] as string;
        items.push({ n: indentOf(l), text: l.trim() });
        i++;
      }
      out.push(renderList(items, base));
      continue;
    }
    const para: string[] = [];
    while (
      i < raw.length &&
      !blank(i) &&
      !/^#{1,6}\s/.test(raw[i] as string) &&
      !(raw[i] as string).trimStart().startsWith("|") &&
      !MARKER.test((raw[i] as string).trimStart())
    ) {
      para.push((raw[i] as string).trim());
      i++;
    }
    out.push(`<p>${renderInline(para.join(" "), base)}</p>`);
  }
  return out.join("\n");
}

export interface MethodologyPage {
  version: string;
  /** Output path inside dist/ (served as `/docs/methodology/<version>`). */
  fileName: string;
  html: string;
}

export const METHODOLOGY_CSS_PATH = "docs/methodology/methodology.css";

export const METHODOLOGY_CSS = `:root{color-scheme:light dark;--fg:#1b1f24;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--link:#0b57d0}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--code:#151b23;--link:#7cb3ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header,main,footer{max-width:60rem;margin:0 auto;padding:0 16px}
header{padding-top:1rem;color:var(--muted)}
a{color:var(--link)}
h1{font-size:1.8rem;line-height:1.25}
h2{margin-top:2.2rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:var(--code);padding:.1em .3em;border-radius:4px}
pre{background:var(--code);padding:1rem;overflow-x:auto;border-radius:6px}
pre code{padding:0;background:none}
table{border-collapse:collapse;display:block;overflow-x:auto;margin:1rem 0}
th,td{border:1px solid var(--line);padding:.35rem .6rem;text-align:left;vertical-align:top}
.docref{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;color:var(--muted)}
footer{color:var(--muted);font-size:.9rem;padding-bottom:2rem;margin-top:2rem;border-top:1px solid var(--line)}
`;

/** Renders every `scf-methodology-<semver>.md` of `dir`; the file's title must name the same version. */
export function methodologyPages(dir: string, cssIntegrity?: string): MethodologyPage[] {
  const pages: MethodologyPage[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^scf-methodology-(\d+\.\d+\.\d+)\.md$/.exec(f);
    if (!m) continue;
    const version = m[1] as string;
    const md = readFileSync(join(dir, f), "utf8");
    const title = /^# (.*)$/m.exec(md)?.[1] ?? "";
    const named = /scf-methodology\/(\d+\.\d+\.\d+)/.exec(title)?.[1];
    if (named !== version)
      throw new Error(`${f}: title names version ${named ?? "none"}, file name says ${version}`);
    const integrity = cssIntegrity ? ` integrity="${cssIntegrity}"` : "";
    const html = [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>Measurement methodology scf-methodology/${version} · UsageMap</title>`,
      `<link rel="stylesheet" href="/${METHODOLOGY_CSS_PATH}"${integrity}>`,
      "</head>",
      "<body>",
      `<header><a href="/">UsageMap</a> · published methodology, version ${version} (read-only)</header>`,
      "<main>",
      renderMarkdown(md),
      "</main>",
      `<footer>Source: <span class="docref">docs/methodology/${escapeHtml(f)}</span>. Published versions never change; a new version is a new page.</footer>`,
      "</body>",
      "</html>",
      "",
    ].join("\n");
    pages.push({ version, fileName: `docs/methodology/${version}.html`, html });
  }
  return pages;
}
