// SPDX-License-Identifier: Apache-2.0
// SPDX header gate (licence.osi-only, security.supply-chain): every source file of ours carries `SPDX-License-Identifier: Apache-2.0` near
// its top, so each file states its licence on its own when copied out of the repository. Our own small checker —
// the REUSE tool itself is GPL-3.0 and is deliberately not a dependency (licence allow-list, ADR-0001).
//
//   node tools/spdx/check-headers.ts            check every tracked or new (not ignored) file; exit 1 on a miss
//   node tools/spdx/check-headers.ts --fix      insert the header where it is missing, then check again
//   node tools/spdx/check-headers.ts --list     print the files in scope and how each is treated
//
// In scope: Go, TypeScript/JavaScript (.ts .tsx .mts .cts .js .jsx .mjs .cjs), shell (.sh .bash and extensionless
// files starting with a `sh`/`bash` shebang), SQL and Dockerfiles. Exempt (each with its reason) are listed in
// tools/spdx/exemptions.json; generated files ("Code generated … DO NOT EDIT", `*.gen.ts`) are exempt by rule
// because their generator owns their first lines.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export const LICENCE = "Apache-2.0";
const TAG = "SPDX-License-Identifier:";
/** The identifier must appear within this many lines of the top (after a shebang / parser directives). */
export const HEAD_LINES = 10;

export type Style = "slash" | "hash" | "dash";

export interface Exemption {
  /** path prefix (ending in "/") or glob with `*` (any characters but "/") and `**` (anything) */
  pattern: string;
  reason: string;
}

const EXT_STYLE: Record<string, Style> = {
  ".go": "slash",
  ".ts": "slash",
  ".tsx": "slash",
  ".mts": "slash",
  ".cts": "slash",
  ".js": "slash",
  ".jsx": "slash",
  ".mjs": "slash",
  ".cjs": "slash",
  ".sh": "hash",
  ".bash": "hash",
  ".sql": "dash",
};

/** Comment style of a file in scope, or null when the file is not source code we check. */
export function styleOf(path: string, firstLine: string): Style | null {
  const name = basename(path);
  if (/^(Dockerfile|Containerfile)(\..+)?$/.test(name) && !name.endsWith(".dockerignore"))
    return "hash";
  const ext = extname(name);
  if (ext in EXT_STYLE) return EXT_STYLE[ext] as Style;
  if (ext === "" && /^#!.*\b(ba)?sh\b/.test(firstLine)) return "hash";
  return null;
}

export function globToRegExp(pattern: string): RegExp {
  if (pattern.endsWith("/")) pattern = `${pattern}**`;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function exemptionFor(path: string, exemptions: readonly Exemption[]): Exemption | null {
  return exemptions.find((e) => globToRegExp(e.pattern).test(path)) ?? null;
}

export function isGenerated(path: string, text: string): boolean {
  if (/\.gen\.ts$/.test(path)) return true;
  const head = text.split("\n", HEAD_LINES).join("\n");
  return /Code generated .* DO NOT EDIT/.test(head) || /@generated\b/.test(head);
}

export function hasHeader(text: string): boolean {
  const head = text.split("\n", HEAD_LINES);
  return head.some((l) => l.includes(`${TAG} ${LICENCE}`));
}

/** Another SPDX identifier near the top (third-party code kept under its own licence): reported, never rewritten. */
export function foreignHeader(text: string): string | null {
  for (const l of text.split("\n", HEAD_LINES)) {
    const m = l.match(/SPDX-License-Identifier:\s*([^\s*]+)/);
    if (m && m[1] !== LICENCE) return m[1] as string;
  }
  return null;
}

const COMMENT: Record<Style, string> = {
  slash: `// ${TAG} ${LICENCE}`,
  hash: `# ${TAG} ${LICENCE}`,
  dash: `-- ${TAG} ${LICENCE}`,
};

/**
 * Inserts the header line. It goes after a shebang, after Dockerfile parser directives (`# syntax=…`, `# escape=…`,
 * `# check=…` must stay first or Docker ignores them) and otherwise on the first line. Line endings are preserved.
 */
export function withHeader(text: string, style: Style, dockerfile: boolean): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  let at = 0;
  if (lines[0]?.startsWith("#!")) at = 1;
  if (dockerfile) {
    while (at < lines.length && /^#\s*(syntax|escape|check)\s*=/i.test(lines[at] as string)) at++;
  }
  lines.splice(at, 0, COMMENT[style]);
  return lines.join(eol);
}

export interface FileResult {
  path: string;
  status: "ok" | "missing" | "foreign" | "exempt" | "generated" | "fixed";
  detail?: string;
}

export function checkFile(
  path: string,
  text: string,
  exemptions: readonly Exemption[],
): FileResult | null {
  const style = styleOf(path, text.split("\n", 1)[0] ?? "");
  if (!style) return null;
  const ex = exemptionFor(path, exemptions);
  if (ex) return { path, status: "exempt", detail: ex.reason };
  if (isGenerated(path, text)) return { path, status: "generated" };
  if (hasHeader(text)) return { path, status: "ok" };
  const foreign = foreignHeader(text);
  if (foreign) return { path, status: "foreign", detail: foreign };
  return { path, status: "missing" };
}

export function listFiles(root: string): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\0")
    .filter((p) => p !== "")
    .sort();
}

export function loadExemptions(file: string): Exemption[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { exemptions: Exemption[] };
  for (const e of raw.exemptions) {
    if (typeof e.pattern !== "string" || typeof e.reason !== "string" || e.reason.trim() === "")
      throw new Error(`exemption without pattern or reason: ${JSON.stringify(e)}`);
  }
  return raw.exemptions;
}

export function run(
  root: string,
  opts: { fix?: boolean; list?: boolean; files?: string[]; exemptionsFile?: string } = {},
): { results: FileResult[]; failures: FileResult[] } {
  const exemptions = loadExemptions(
    opts.exemptionsFile ?? join(root, "tools", "spdx", "exemptions.json"),
  );
  const results: FileResult[] = [];
  for (const path of opts.files ?? listFiles(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // deleted in the working tree, a submodule or a dangling link
    }
    const r = checkFile(path, text, exemptions);
    if (!r) continue;
    if (r.status === "missing" && opts.fix) {
      const style = styleOf(path, text.split("\n", 1)[0] ?? "") as Style;
      writeFileSync(
        join(root, path),
        withHeader(text, style, /^(Dockerfile|Containerfile)/.test(basename(path))),
      );
      results.push({ path, status: "fixed" });
    } else results.push(r);
  }
  const failures = results.filter((r) => r.status === "missing" || r.status === "foreign");
  return { results, failures };
}

if (import.meta.main) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const fix = process.argv.includes("--fix");
  const list = process.argv.includes("--list");
  const { results, failures } = run(root, { fix, list });
  if (list)
    for (const r of results)
      console.log(`${r.status}\t${r.path}${r.detail ? `\t${r.detail}` : ""}`);
  const count = (s: FileResult["status"]) => results.filter((r) => r.status === s).length;
  for (const f of failures) {
    console.error(
      f.status === "foreign"
        ? `${f.path}: licensed ${f.detail}, not ${LICENCE} — add it to tools/spdx/exemptions.json with the reason if it is third-party code`
        : `${f.path}: no "${TAG} ${LICENCE}" in the first ${HEAD_LINES} lines (fix: node tools/spdx/check-headers.ts --fix)`,
    );
  }
  console.log(
    `spdx: ${count("ok")} with header, ${count("fixed")} fixed, ${count("generated")} generated, ${count("exempt")} exempt, ${failures.length} failing`,
  );
  process.exit(failures.length > 0 ? 1 : 0);
}
