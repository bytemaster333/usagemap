// SPDX-License-Identifier: Apache-2.0
// Issue forms and labels of the public tracker (docs/sla.md §9.1–9.2; support.first-response, support.resolution).
//
//   node tools/support/labels.ts --check     offline: the label set, the issue forms and the SLA automation agree
//   node tools/support/labels.ts --plan      read the repository's labels, print what --apply would create or update
//   node tools/support/labels.ts --apply     create missing labels and fix colour/description (never deletes)
//     (--plan/--apply need GITHUB_TOKEN and GITHUB_REPOSITORY)
//
// --check enforces: every label an issue form sets and every label the SLA automation uses exists in labels.json;
// blank issues are disabled; security reports are routed to private vulnerability reporting, never a public form;
// every form makes the reporter confirm that no personal data, keys or tokens are included.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LABELS } from "./sla.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface Label {
  name: string;
  color: string;
  description: string;
}

export function loadLabels(file = join(ROOT, "tools/support/labels.json")): Label[] {
  const { labels } = JSON.parse(readFileSync(file, "utf8")) as { labels: Label[] };
  return labels;
}

/** Labels a form sets: its top-level `labels: ["a", "b"]` line (flow style, the only style the forms use). */
export function formLabels(yaml: string): string[] {
  const m = /^labels:\s*\[(.*)\]\s*$/m.exec(yaml);
  if (!m) return [];
  return (m[1] as string)
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function check(
  templateDir = join(ROOT, ".github/ISSUE_TEMPLATE"),
  labels = loadLabels(),
): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const l of labels) {
    if (names.has(l.name)) problems.push(`labels.json: ${l.name} twice`);
    names.add(l.name);
    if (!/^[0-9a-f]{6}$/.test(l.color)) problems.push(`labels.json: ${l.name} colour ${l.color}`);
    if (!l.description || l.description.length > 100)
      problems.push(`labels.json: ${l.name} description missing or over GitHub's 100 characters`);
  }
  for (const l of Object.values(LABELS))
    if (!names.has(l)) problems.push(`labels.json lacks ${l}, which the SLA automation uses`);
  const files = readdirSync(templateDir).filter((f) => /\.ya?ml$/.test(f));
  const config = files.find((f) => /^config\.ya?ml$/.test(f));
  if (!config) problems.push("ISSUE_TEMPLATE/config.yml missing");
  else {
    const c = readFileSync(join(templateDir, config), "utf8");
    if (!/^blank_issues_enabled:\s*false\s*$/m.test(c))
      problems.push("config.yml: blank issues must be disabled (every ticket goes through a form)");
    if (!/url:\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/security\/advisories\/new\s*$/m.test(c))
      problems.push("config.yml: no contact link to private vulnerability reporting");
  }
  const forms = files.filter((f) => f !== config);
  if (forms.length === 0) problems.push("no issue forms");
  for (const f of forms) {
    const y = readFileSync(join(templateDir, f), "utf8");
    if (!/^name:\s*\S/m.test(y) || !/^description:\s*\S/m.test(y) || !/^body:\s*$/m.test(y))
      problems.push(`${f}: not an issue form (name, description, body)`);
    const ls = formLabels(y);
    if (ls.length === 0) problems.push(`${f}: sets no label`);
    for (const l of ls) if (!names.has(l)) problems.push(`${f}: label ${l} is not in labels.json`);
    if (ls.includes("security"))
      problems.push(`${f}: a public form must not collect security reports`);
    if (!/id:\s*privacy[\s\S]*?required:\s*true/.test(y))
      problems.push(`${f}: no required "no personal or secret data" confirmation`);
  }
  return problems;
}

async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "scf-support-labels",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Changes needed to make the repository's labels a superset of the label set. */
export function plan(want: Label[], have: Label[]): { create: Label[]; update: Label[] } {
  const by = new Map(have.map((l) => [l.name.toLowerCase(), l]));
  const create: Label[] = [];
  const update: Label[] = [];
  for (const w of want) {
    const h = by.get(w.name.toLowerCase());
    if (!h) create.push(w);
    else if (h.color.toLowerCase() !== w.color || (h.description ?? "") !== w.description)
      update.push(w);
  }
  return { create, update };
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--check")) {
    const p = check();
    for (const x of p) process.stdout.write(`FAIL ${x}\n`);
    process.stdout.write(
      p.length ? `labels/forms: ${p.length} problem(s)\n` : "labels/forms: ok\n",
    );
    return p.length ? 1 : 0;
  }
  const apply = argv.includes("--apply");
  if (!apply && !argv.includes("--plan")) {
    process.stderr.write("usage: labels.ts --check | --plan | --apply\n");
    return 2;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!process.env.GITHUB_TOKEN || !repo) {
    process.stderr.write("GITHUB_TOKEN and GITHUB_REPOSITORY are required\n");
    return 2;
  }
  const have = await gh<Label[]>("GET", `/repos/${repo}/labels?per_page=100`);
  const { create, update } = plan(loadLabels(), have);
  for (const l of create) {
    process.stdout.write(`create ${l.name}\n`);
    if (apply) await gh("POST", `/repos/${repo}/labels`, l);
  }
  for (const l of update) {
    process.stdout.write(`update ${l.name}\n`);
    if (apply)
      await gh("PATCH", `/repos/${repo}/labels/${encodeURIComponent(l.name)}`, {
        color: l.color,
        description: l.description,
      });
  }
  process.stdout.write(
    `${create.length} to create, ${update.length} to update${apply ? " (applied)" : ""}\n`,
  );
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e: unknown) => {
      process.stderr.write(`FAIL ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
