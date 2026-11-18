// SPDX-License-Identifier: Apache-2.0
// @ts-check
// GitHub Action entry point (also runnable locally: tools/pin-action/run check). Reads the inputs from INPUT_*
// variables, loads the tracker release list (one GET of `manifest-url`, or `manifest-file` with no network at all),
// scans the repository, prints annotations and a job summary, and writes a patch with the proposed pins. It never
// pushes, commits or opens pull requests; nothing in it uses a token.

import { appendFileSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fixText, parseVersions, scanText, unifiedDiff } from "./pins.mjs";

const EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".php",
  ".erb",
  ".hbs",
  ".handlebars",
  ".njk",
  ".liquid",
  ".ejs",
  ".pug",
  ".twig",
  ".md",
  ".mdx",
  ".cshtml",
  ".jinja",
  ".j2",
  ".tmpl",
  ".gohtml",
]);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_MANIFEST = 1024 * 1024;

/** @param {string} name @param {string} [def] */
function input(name, def = "") {
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v.trim() === "" ? def : v.trim();
}

/** Workflow-command escaping (data and properties). @param {string} s */
const escData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** @param {string} s */
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** @param {string} raw */
function checkUrl(raw) {
  const u = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error("manifest-url must use https");
  }
  if (u.username || u.password) throw new Error("manifest-url must not carry credentials");
  return u;
}

/** @param {string} url */
async function fetchManifest(url) {
  const res = await fetch(checkUrl(url), {
    redirect: "error",
    headers: { accept: "application/json", "user-agent": "usagemap-pin-action/1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_MANIFEST) throw new Error(`${url}: release list larger than 1 MiB`);
  return text;
}

/**
 * @param {string} root
 * @param {Set<string>} exclude directory names never entered
 * @returns {string[]} absolute paths
 */
export function walk(root, exclude) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the repository
      if (e.isDirectory()) {
        if (!exclude.has(e.name)) visit(p);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        if (dot >= 0 && EXTENSIONS.has(e.name.slice(dot).toLowerCase())) out.push(p);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Runs the check. Returns the process exit code.
 * @param {{ log?: (s: string) => void }} [io]
 */
export async function main(io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const root = resolve(input("path", "."));
  const manifestFile = input("manifest-file");
  const manifestUrl = input("manifest-url", "https://app.usagemap.dev/v1/tracker/versions");
  const hosts = input("hosts", "e1.usagemap.dev,e2.usagemap.dev")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const exclude = new Set(
    input("exclude", "node_modules,.git")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const patchPath = resolve(input("patch-file", "usagemap-tracker-pins.patch"));
  const failOnOutdated = input("fail-on-outdated", "false") === "true";
  const upgrade = input("upgrade", "true") !== "false";

  let text;
  let source;
  try {
    if (manifestFile) {
      text = readFileSync(resolve(manifestFile), "utf8");
      source = manifestFile;
    } else {
      text = await fetchManifest(manifestUrl);
      source = manifestUrl;
    }
  } catch (e) {
    log(
      `::error::could not read the tracker release list: ${escData(String(/** @type {Error} */ (e).message))}`,
    );
    return 2;
  }
  const versions = parseVersions(text);

  /** @type {import("./pins.mjs").Finding[]} */
  const findings = [];
  let patch = "";
  for (const abs of walk(root, exclude)) {
    if (abs === patchPath) continue;
    if (lstatSync(abs).size > MAX_FILE) continue;
    const body = readFileSync(abs, "utf8");
    if (!body.includes("/lib/")) continue;
    const rel = relative(root, abs).split(sep).join("/");
    const fs = scanText(rel, body, versions, hosts, { upgrade });
    if (fs.length === 0) continue;
    findings.push(...fs);
    patch += unifiedDiff(rel, body, fixText(body, fs));
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  for (const f of [...errors, ...warnings]) {
    const kind = f.severity === "error" ? "error" : "warning";
    const fix = f.proposed ? ` Proposed: ${f.proposed.src} with ${f.proposed.integrity}.` : "";
    log(
      `::${kind} file=${escProp(f.file)},line=${f.line},col=${f.column},title=${escProp(`UsageMap tracker ${f.codes.join(", ")}`)}::${escData(f.message + fix)}`,
    );
  }
  for (const f of findings.filter((x) => x.severity === "ok")) {
    log(`ok  ${f.file}:${f.line} ${f.profile} ${f.version}`);
  }
  log(
    `UsageMap tracker pins: ${findings.length} tag(s), ${errors.length} error(s), ${warnings.length} warning(s); release list: ${source}`,
  );

  if (patch) {
    writeFileSync(patchPath, patch);
    log(
      `Proposed changes written to ${relative(process.cwd(), patchPath) || patchPath} (git apply it, or let a later step open a PR).`,
    );
  }
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(
      out,
      [
        `tags=${findings.length}`,
        `errors=${errors.length}`,
        `warnings=${warnings.length}`,
        `patch-file=${patch ? patchPath : ""}`,
        "",
      ].join("\n"),
    );
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = findings.map(
      (f) =>
        `| \`${f.file}:${f.line}\` | ${f.profile} | ${f.version} | ${f.severity} | ${f.codes.join(", ") || "-"} | ${f.proposed ? f.proposed.version : "-"} |`,
    );
    appendFileSync(
      summary,
      [
        "### UsageMap tracker pins",
        "",
        findings.length
          ? "| Tag | Profile | Version | Result | Codes | Proposed |"
          : "No UsageMap tracker tag found.",
        findings.length ? "|---|---|---|---|---|---|" : "",
        ...rows,
        "",
        patch ? "A patch with the proposed pins is in the `patch-file` output." : "",
        "",
      ].join("\n"),
    );
  }
  if (errors.length > 0) return 1;
  if (failOnOutdated && warnings.length > 0) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stdout.write(`::error::${escData(String(e?.stack ?? e))}\n`);
      process.exitCode = 2;
    },
  );
}
