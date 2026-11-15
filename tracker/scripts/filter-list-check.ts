// SPDX-License-Identifier: Apache-2.0
// Filter-list check (web.adblock-safe-script-name, web.adblock-safe-endpoints): would a popular ad or tracker blocker block the tracker's file or its API
// requests? Downloads the lists named in scripts/filter-lists.json and evaluates, for a generic tenant page, every
// request the tracker makes — the script file of each profile, the challenge and event POSTs (fetch with keepalive)
// and the manifest — on both ingest hosts. Each list is evaluated on its own (exceptions from one list never excuse
// a block in another). Prints every matching rule; exits 1 if any request is blocked. A sendBeacon() of the event
// POST (type `ping`) is evaluated too but only reported: the tracker does not use sendBeacon, because EasyPrivacy
// blocks every third-party ping (`*$ping,third-party`); this probe keeps the reason visible.
//
//   node scripts/filter-list-check.ts [--mode=pinned|live|both] [--hosts=https://a.x,https://b.y]
//                                     [--page-host=tenant.example] [--report=file.json] [--repin]
//
// pinned  the lists at the commits pinned in filter-lists.json; each file's SHA-256 and size must match (a change
//         is an error, exit 2). Reproducible: the same answer on every run until the pins are updated.
// live    the same files at the head of their branch (EasyList/EasyPrivacy from easylist.to), with size and time
//         limits only. This is what notices a new blocking rule; the nightly job runs it.
// both    (default) pinned, then live.
// --repin rewrites filter-lists.json with each repository's current head commit and the files' hashes.
//
// Downloads are cached by SHA-256 in .filter-lists/ (git-ignored). The lists themselves are never committed or
// shipped: they are data read at check time (their licences — GPL-3.0, CC BY-SA 3.0 — are not on the dependency
// allow-list and do not need to be, because nothing of them is distributed).
// Exit codes: 0 nothing blocked, 1 blocked, 2 configuration, download or checksum error.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { DEFAULT_HOSTS, ROOT } from "./build-config.ts";
import { FilterSet, type Request } from "./filter-list/matcher.ts";

/** A request to evaluate; `used: false` marks a probe for a request the tracker deliberately does not make. */
export type Probe = Request & { used: boolean };

interface FileEntry {
  sha256: string;
  bytes: number;
}
interface ListSource {
  name: string;
  /** Which blockers ship it by default (for the report). */
  usedBy: string;
  repo: string;
  branch: string;
  commit: string;
  /** Entry file; `!#include` files are resolved relative to it and must be pinned as well. */
  entry: string;
  /** Live URL of the entry file when the canonical publisher is not the repository (EasyList). */
  live?: string;
  files: Record<string, FileEntry>;
}
interface Config {
  $comment?: string;
  maxBytes: number;
  timeoutMs: number;
  lists: ListSource[];
}

const CONFIG = join(ROOT, "scripts", "filter-lists.json");
const CACHE = join(ROOT, ".filter-lists");

class CheckError extends Error {}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function download(url: string, cfg: Config): Promise<Uint8Array> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": "scf-tracker-filter-list-check" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) throw new CheckError(`${url}: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > cfg.maxBytes)
      throw new CheckError(`${url}: ${declared} B exceeds ${cfg.maxBytes}`);
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of res.body) {
      n += c.length;
      if (n > cfg.maxBytes) throw new CheckError(`${url}: more than ${cfg.maxBytes} B`);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof CheckError) throw e;
    throw new CheckError(
      `${url}: ${ac.signal.aborted ? `timeout after ${cfg.timeoutMs} ms` : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const raw = (repo: string, ref: string, path: string): string =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

const includes = (text: string): string[] =>
  [...text.matchAll(/^!#include\s+(\S+)\s*$/gm)].map((m) => m[1] as string);

/** Load one list (entry + includes) as text files. */
async function load(
  src: ListSource,
  mode: "pinned" | "live",
  cfg: Config,
): Promise<{ path: string; text: string; sha256: string; bytes: number }[]> {
  const out: { path: string; text: string; sha256: string; bytes: number }[] = [];
  const seen = new Set<string>();
  const queue = [src.entry];
  while (queue.length) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    if (seen.size > 50) throw new CheckError(`${src.name}: more than 50 included files`);
    let body: Uint8Array;
    if (mode === "pinned") {
      const pin = src.files[path];
      if (!pin)
        throw new CheckError(`${src.name}: ${path} is included but not pinned (run --repin)`);
      const cached = join(CACHE, `${pin.sha256}.txt`);
      if (existsSync(cached) && sha256(readFileSync(cached)) === pin.sha256) {
        body = readFileSync(cached);
      } else {
        body = await download(raw(src.repo, src.commit, path), cfg);
        const got = sha256(body);
        if (got !== pin.sha256 || body.length !== pin.bytes) {
          throw new CheckError(
            `${src.name}: ${path}@${src.commit.slice(0, 12)} is ${body.length} B sha256 ${got}, pinned ${pin.bytes} B ${pin.sha256}`,
          );
        }
        mkdirSync(CACHE, { recursive: true });
        writeFileSync(cached, body);
      }
    } else {
      const url = path === src.entry && src.live ? src.live : raw(src.repo, src.branch, path);
      body = await download(url, cfg);
    }
    const text = Buffer.from(body).toString("utf8");
    out.push({ path, text, sha256: sha256(body), bytes: body.length });
    for (const inc of includes(text)) {
      if (/^[a-z]+:/i.test(inc) || inc.includes("..")) {
        throw new CheckError(`${src.name}: refusing include ${inc}`);
      }
      queue.push(posix.join(posix.dirname(path), inc));
    }
  }
  return out;
}

/**
 * Every request the tracker makes, from a generic tenant page, on both ingest hosts. `ips` are the addresses each
 * host resolves to (for `ipaddress=` filters); a host that does not resolve (placeholder names) has none.
 */
export function trackerRequests(
  hosts: readonly string[],
  version: string,
  pageHost: string,
  ips: Record<string, readonly string[]> = {},
): Probe[] {
  const r: Probe[] = [];
  for (const h of hosts) {
    const at = { pageHost, ips: ips[h] ?? [], used: true };
    for (const p of ["standard", "strict"]) {
      r.push({ url: `${h}/lib/${version}/${p}.js`, type: "script", method: "GET", ...at });
    }
    r.push({ url: `${h}/lib/manifest.json`, type: "xmlhttprequest", method: "GET", ...at });
    r.push({ url: `${h}/v1/c`, type: "xmlhttprequest", method: "POST", ...at });
    r.push({ url: `${h}/v1/e`, type: "xmlhttprequest", method: "POST", ...at });
    r.push({ url: `${h}/v1/e`, type: "ping", method: "POST", ...at, used: false });
  }
  return r;
}

async function resolve(hosts: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const h of hosts) {
    try {
      out[h] = (await lookup(new URL(h).hostname, { all: true })).map((a) => a.address);
    } catch {
      out[h] = [];
    }
  }
  return out;
}

interface Finding {
  mode: string;
  list: string;
  request: string;
  blocked: boolean;
  rule: string;
  where: string;
  allowedBy?: string;
  /** The request is a probe the tracker does not make (never fails the check). */
  notSent?: true;
}

async function check(mode: "pinned" | "live", cfg: Config, reqs: Probe[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const src of cfg.lists) {
    const files = await load(src, mode, cfg);
    const set = new FilterSet(src.name);
    for (const f of files) set.add(f.text, f.path);
    const unsupported = [...set.unsupported.values()].reduce((a, b) => a + b, 0);
    const ref =
      mode === "pinned" ? src.commit.slice(0, 12) : src.live ? "live" : `${src.branch} (live)`;
    console.log(
      `  ${src.name} [${ref}] ${files.length} file(s), ${files.reduce((a, f) => a + f.bytes, 0)} B, ` +
        `${set.blocking.length} blocking + ${set.exceptions.length} exception rules` +
        (unsupported
          ? `, ${unsupported} with unsupported options (${[...set.unsupported.keys()].slice(0, 5).join("; ")})`
          : ""),
    );
    for (const r of reqs) {
      const v = set.match(r);
      if (!v.by) continue;
      const f: Finding = {
        mode,
        list: src.name,
        request: `${r.method} ${r.url} (${r.type})`,
        blocked: v.blocked && r.used,
        rule: v.by.raw,
        where: `${v.by.list}:${v.by.line}${mode === "live" ? " (live)" : ""}`,
      };
      if (!r.used) f.notSent = true;
      if (v.allowedBy) f.allowedBy = `${v.allowedBy.raw} (${v.allowedBy.list}:${v.allowedBy.line})`;
      findings.push(f);
      console.log(
        !r.used
          ? `    not sent by the tracker, would be blocked: ${f.request}\n            by ${f.rule}   (${f.where})`
          : v.blocked
            ? `    BLOCKED ${f.request}\n            by ${f.rule}   (${f.where})`
            : `    matched but allowed ${f.request}\n            by ${f.rule} (${f.where}), allowed by ${f.allowedBy}`,
      );
    }
  }
  return findings;
}

async function repin(cfg: Config): Promise<void> {
  for (const src of cfg.lists) {
    const api = `https://api.github.com/repos/${src.repo}/commits/${src.branch}`;
    const meta = JSON.parse(Buffer.from(await download(api, cfg)).toString("utf8")) as {
      sha?: string;
    };
    if (!meta.sha || !/^[0-9a-f]{40}$/.test(meta.sha))
      throw new CheckError(`${api}: no commit sha`);
    // Download entry + includes at the new commit and record what was downloaded.
    src.commit = meta.sha;
    src.files = {};
    const queue = [src.entry];
    while (queue.length) {
      const path = queue.shift() as string;
      if (src.files[path]) continue;
      const body = await download(raw(src.repo, src.commit, path), cfg);
      src.files[path] = { sha256: sha256(body), bytes: body.length };
      for (const inc of includes(Buffer.from(body).toString("utf8"))) {
        if (/^[a-z]+:/i.test(inc) || inc.includes("..")) {
          throw new CheckError(`${src.name}: refusing include ${inc}`);
        }
        queue.push(posix.join(posix.dirname(path), inc));
      }
    }
    console.log(
      `  ${src.name}: ${src.repo}@${src.commit.slice(0, 12)}, ${Object.keys(src.files).length} file(s)`,
    );
  }
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`wrote ${CONFIG}`);
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

async function main(): Promise<number> {
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8")) as Config;
  if (process.argv.includes("--repin")) {
    await repin(cfg);
    return 0;
  }
  const mode = arg("mode") ?? "both";
  if (!["pinned", "live", "both"].includes(mode)) throw new CheckError(`--mode=${mode}`);
  const hosts = arg("hosts")?.split(",") ?? [...DEFAULT_HOSTS];
  for (const h of hosts) {
    if (!/^https:\/\/[a-z0-9.-]+$/.test(h))
      throw new CheckError(`--hosts: ${h} is not an https origin`);
  }
  const pageHost = arg("page-host") ?? "tenant.example";
  const version = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
  ).version;
  const ips = await resolve(hosts);
  const reqs = trackerRequests(hosts, version, pageHost, ips);

  console.log(
    `Filter-list check (web.adblock-safe-script-name, web.adblock-safe-endpoints): ${reqs.length} requests from https://${pageHost}/`,
  );
  for (const h of hosts) {
    console.log(
      `  ${h} resolves to ${ips[h]?.join(", ") || "nothing (ipaddress= filters not applied)"}`,
    );
  }
  for (const r of reqs) {
    console.log(
      `  ${r.method} ${r.url} (${r.type})${r.used ? "" : "  — probe only, not sent by the tracker"}`,
    );
  }
  const findings: Finding[] = [];
  for (const m of mode === "both" ? (["pinned", "live"] as const) : [mode as "pinned" | "live"]) {
    console.log(`\n== ${m}`);
    findings.push(...(await check(m, cfg, reqs)));
  }
  const blocked = findings.filter((f) => f.blocked);
  const report = arg("report");
  if (report) {
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(
      report,
      `${JSON.stringify({ hosts, pageHost, version, mode, findings }, null, 2)}\n`,
    );
  }
  console.log(
    blocked.length
      ? `\nResult: FAIL — ${blocked.length} blocked (request × list × mode)`
      : `\nResult: PASS — nothing blocked by ${cfg.lists.length} lists` +
          (findings.some((f) => f.allowedBy)
            ? ` (${findings.filter((f) => f.allowedBy).length} match(es) allowed only by an exception — fragile)`
            : ""),
  );
  return blocked.length ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`Result: ERROR — ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
