// SPDX-License-Identifier: Apache-2.0
// The facts the landing page states about the tracker and the base engine, read from the release files at build time:
// the tracker build's manifest (checked against the bytes of the files it describes), tracker/package.json and the
// Umami pin. Nothing here is typed in by hand, so the page cannot drift from what the gateway serves; a missing or
// inconsistent manifest fails the build.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGINS, REPO_ROOT } from "./config.ts";

export type Profile = "standard" | "strict";
const PROFILES: readonly Profile[] = ["standard", "strict"];

export interface TrackerFile {
  profile: Profile;
  /** immutable URL on the first ingest host, `/lib/<version>/<profile>.js` (wire-formats §a.1) */
  url: string;
  path: string;
  bytes: number;
  gzipBytes: number;
  sha256: string;
  /** SRI string, `sha384-…` */
  integrity: string;
}

export interface Facts {
  tracker: {
    name: string;
    version: string;
    protocol: string;
    hosts: readonly [string, string];
    files: Record<Profile, TrackerFile>;
    budgetsGzipBytes: Record<Profile, number>;
  };
  umami: { version: string; commit: string };
}

interface ManifestFile {
  path: string;
  profile: string;
  bytes: number;
  gzip_bytes: number;
  sha256: string;
  sha384: string;
  integrity: string;
}

interface Manifest {
  name: string;
  version: string;
  protocol: string;
  url_pattern: string;
  config: { hosts: string[] };
  budgets_gzip_bytes: Record<string, number>;
  files: ManifestFile[];
}

const fail = (msg: string): never => {
  throw new Error(`tracker facts: ${msg}`);
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

function readManifest(file: string): Manifest {
  if (!existsSync(file)) {
    fail(
      `${file} is missing — build the tracker first (pnpm --filter @usagemap/tracker build, with TRACKER_HOSTS for a deployment)`,
    );
  }
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fail(`${file} is not JSON`);
  }
  const o = m as Partial<Manifest>;
  if (
    typeof o.name !== "string" ||
    typeof o.version !== "string" ||
    typeof o.protocol !== "string" ||
    o.url_pattern !== "/lib/<version>/<profile>.js" ||
    !Array.isArray(o.config?.hosts) ||
    typeof o.budgets_gzip_bytes !== "object" ||
    !Array.isArray(o.files)
  ) {
    fail(`${file} does not have the tracker manifest shape`);
  }
  return o as Manifest;
}

/** Reads and checks the manifest of one tracker build: every number on the page comes from here. */
export function loadTrackerFacts(dist: string, version: string): Facts["tracker"] {
  const dir = join(dist, version);
  const manifestPath = join(dir, "manifest.json");
  const m = readManifest(manifestPath);
  if (m.version !== version) fail(`${manifestPath} is for version ${m.version}, not ${version}`);

  const hosts = m.config.hosts;
  if (
    hosts.length !== 2 ||
    !hosts.every((h) => typeof h === "string" && /^https?:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(h))
  ) {
    fail(`${manifestPath}: config.hosts must be two origins`);
  }
  const origin = hosts[0] as string;

  const files = {} as Record<Profile, TrackerFile>;
  const budgets = {} as Record<Profile, number>;
  for (const profile of PROFILES) {
    const entry = m.files.find((f) => f.profile === profile);
    if (!entry) return fail(`${manifestPath} has no ${profile} file`);
    if (entry.path !== `${profile}.js`) fail(`${manifestPath}: unexpected path ${entry.path}`);
    if (!isInt(entry.bytes) || !isInt(entry.gzip_bytes)) fail(`${manifestPath}: bad sizes`);
    const budget = m.budgets_gzip_bytes[profile];
    if (!isInt(budget)) fail(`${manifestPath}: no gzip budget for ${profile}`);
    budgets[profile] = budget as number;

    // The manifest is only trusted as far as the bytes it describes agree with it.
    const filePath = join(dir, entry.path);
    if (!existsSync(filePath)) fail(`${filePath} is missing`);
    const code = readFileSync(filePath);
    const sha384 = createHash("sha384").update(code).digest("base64");
    const sha256 = createHash("sha256").update(code).digest("hex");
    if (code.byteLength !== entry.bytes) fail(`${filePath}: size differs from its manifest`);
    if (sha256 !== entry.sha256) fail(`${filePath}: sha256 differs from its manifest`);
    if (sha384 !== entry.sha384 || entry.integrity !== `sha384-${sha384}`) {
      fail(`${filePath}: SRI hash differs from its manifest`);
    }
    files[profile] = {
      profile,
      url: `${origin}/lib/${version}/${entry.path}`,
      path: entry.path,
      bytes: entry.bytes,
      gzipBytes: entry.gzip_bytes,
      sha256,
      integrity: entry.integrity,
    };
  }
  return {
    name: m.name,
    version,
    protocol: m.protocol,
    hosts: [origin, hosts[1] as string],
    files,
    budgetsGzipBytes: budgets,
  };
}

/** The Umami pin (vendor/umami/UPSTREAM, ADR-0002). */
export function loadUmamiPin(
  file = join(REPO_ROOT, "vendor", "umami", "UPSTREAM"),
): Facts["umami"] {
  if (!existsSync(file)) fail(`${file} is missing`);
  const kv = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) kv.set(m[1] as string, m[2] as string);
  }
  const version = kv.get("UMAMI_VERSION");
  const commit = kv.get("UMAMI_COMMIT");
  if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) fail(`${file}: no UMAMI_VERSION`);
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) fail(`${file}: no UMAMI_COMMIT`);
  return { version: version as string, commit: commit as string };
}

/** Version in tracker/package.json: the version a build pins unless told otherwise. */
export function trackerPackageVersion(file = join(REPO_ROOT, "tracker", "package.json")): string {
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") fail(`${file} has no version`);
  return pkg.version as string;
}

export function loadFacts(dist: string, version: string): Facts {
  return { tracker: loadTrackerFacts(dist, version), umami: loadUmamiPin() };
}

/** A release build serves the production deployment only: the tracker it pins must talk to e1/e2.usagemap.dev. */
export function checkReleaseHosts(f: Facts): void {
  const [a, b] = f.tracker.hosts;
  if (a !== ORIGINS.ingest[0] || b !== ORIGINS.ingest[1]) {
    fail(
      `release build: the tracker manifest's hosts are ${a}, ${b}; expected ${ORIGINS.ingest.join(", ")} ` +
        `(rebuild the tracker with TRACKER_HOSTS=${ORIGINS.ingest.join(",")})`,
    );
  }
}
