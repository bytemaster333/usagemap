// SPDX-License-Identifier: Apache-2.0
// After a deployment: checks that what the gateway serves is what the landing page pins.
//
//   node check-live.ts [<dist>]     (default: apps/landing/dist, i.e. the build being deployed)
//
// For each profile, fetches the tracker file from its pinned URL and compares its SHA-384 with the page's SRI value
// and its size with the stated size; then checks the gateway's combined manifest lists the same integrity. Then checks
// the landing page and its hashed assets (served byte for byte as built, with the right types), the apex's plain-text
// files and the documentation host (docs.usagemap.dev, apps/docs): its main pages answer and its
// agent skill pins a tracker hash the gateway serves. Read-only, no credentials, only our own hosts.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LANDING_ROOT, ORIGINS } from "./src/config.ts";
import type { TrackerFile } from "./src/facts.ts";

interface DistFacts {
  tracker: { version: string; hosts: [string, string]; files: Record<string, TrackerFile> };
}

async function main(): Promise<number> {
  const dist = process.argv[2] ?? join(LANDING_ROOT, "dist");
  const facts = JSON.parse(readFileSync(join(dist, "facts.json"), "utf8")) as DistFacts;
  let failures = 0;
  const report = (ok: boolean, what: string) => {
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  };
  for (const f of Object.values(facts.tracker.files)) {
    const res = await fetch(f.url, { redirect: "error" });
    const body = new Uint8Array(await res.arrayBuffer());
    const sri = `sha384-${createHash("sha384").update(body).digest("base64")}`;
    report(res.status === 200, `${f.url} answers 200 (got ${res.status})`);
    report(sri === f.integrity, `${f.url} matches the pinned ${f.integrity}`);
    report(body.byteLength === f.bytes, `${f.url} is ${f.bytes} bytes (got ${body.byteLength})`);
  }
  const mres = await fetch(`${facts.tracker.hosts[0]}/lib/manifest.json`, { redirect: "error" });
  const manifest = mres.ok ? ((await mres.json()) as { versions?: unknown }) : {};
  const listed = JSON.stringify(manifest.versions ?? manifest);
  for (const f of Object.values(facts.tracker.files)) {
    report(listed.includes(f.integrity), `/lib/manifest.json lists ${f.integrity}`);
  }
  // The page and its assets (stylesheet, script, fonts), byte for byte as built.
  const TYPES: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    woff2: "font/woff2",
  };
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const assetsDir = join(dist, "assets");
  const pageFiles = [join(dist, "index.html"), ...(existsSync(assetsDir) ? walk(assetsDir) : [])];
  for (const file of pageFiles) {
    const rel = relative(dist, file).replaceAll("\\", "/");
    const url = `${ORIGINS.landing}/${rel === "index.html" ? "" : rel}`;
    const res = await fetch(url, { redirect: "error" });
    const body = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    const want = TYPES[rel.split(".").pop() ?? ""] ?? "";
    report(
      res.status === 200 && body.equals(readFileSync(file)),
      `${url} answers 200 with the built file (got ${res.status})`,
    );
    report(type.includes(want), `${url} is ${want} (got ${type})`);
  }
  // The apex's llms.txt: served byte for byte as built.
  {
    const res = await fetch(`${ORIGINS.landing}/llms.txt`, { redirect: "error" });
    const body = res.ok ? await res.text() : "";
    report(
      res.status === 200 && body === readFileSync(join(dist, "llms.txt"), "utf8"),
      `${ORIGINS.landing}/llms.txt answers 200 with the built file (got ${res.status})`,
    );
  }
  // The documentation host.
  for (const path of ["/", "/quickstart/", "/llms.txt", "/llms-full.txt", "/SKILL.md"]) {
    const res = await fetch(`${ORIGINS.docs}${path}`, { redirect: "error" });
    report(res.status === 200, `${ORIGINS.docs}${path} answers 200 (got ${res.status})`);
  }
  // The agent skill pins a tracker hash: it must be one the gateway serves.
  const sres = await fetch(`${ORIGINS.docs}/SKILL.md`, { redirect: "error" });
  const skill = sres.ok ? await sres.text() : "";
  for (const m of skill.matchAll(/integrity="(sha384-[A-Za-z0-9+/=]+)"/g)) {
    report(
      listed.includes(m[1] as string),
      `SKILL.md pins ${m[1]}, which /lib/manifest.json lists`,
    );
  }
  // SEP-1: CORS for every origin and a text/plain type (src/sep1.ts checked the content at build time).
  const toml = join(dist, ".well-known", "stellar.toml");
  if (existsSync(toml)) {
    const res = await fetch(`${ORIGINS.landing}/.well-known/stellar.toml`, {
      redirect: "error",
      headers: { Origin: "https://example.org" },
    });
    const body = res.ok ? await res.text() : "";
    report(res.status === 200, `/.well-known/stellar.toml answers 200 (got ${res.status})`);
    report(body === readFileSync(toml, "utf8"), "/.well-known/stellar.toml is the built file");
    report(
      res.headers.get("access-control-allow-origin") === "*",
      `/.well-known/stellar.toml sends Access-Control-Allow-Origin: * (got ${res.headers.get("access-control-allow-origin")})`,
    );
    report(
      (res.headers.get("content-type") ?? "").startsWith("text/plain"),
      `/.well-known/stellar.toml is text/plain (got ${res.headers.get("content-type")})`,
    );
  }
  return failures;
}

main().then(
  (failures) => {
    if (failures) {
      console.error(`${failures} check(s) failed`);
      process.exitCode = 1;
    }
  },
  (e: unknown) => {
    console.error(`check-live failed: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
