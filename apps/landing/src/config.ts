// SPDX-License-Identifier: Apache-2.0
// Build-time configuration of the landing page. Everything the page links to is fixed here; everything that depends
// on a build of the tracker (version, hosts, sizes, SRI) comes from the tracker's manifest (src/facts.ts), never from
// this file.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LANDING_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(LANDING_ROOT, "..", "..");

/** The public hostnames of the hosted instance. */
export const ORIGINS = {
  landing: "https://usagemap.dev",
  /** end-user documentation (apps/docs, C-152) */
  docs: "https://docs.usagemap.dev",
  app: "https://app.usagemap.dev",
  status: "https://status.usagemap.dev",
  ingest: ["https://e1.usagemap.dev", "https://e2.usagemap.dev"] as const,
} as const;

/** The methodology page the portal renders statically (C-142 (10)). */
export const METHODOLOGY_PATH = "/docs/methodology/1.0.0";

export interface LandingConfig {
  /** directory holding `<version>/manifest.json` and the tracker files of that build */
  trackerDist: string;
  /** tracker version the page pins */
  trackerVersion: string;
  /** site key of the landing page itself, or undefined (then the page carries no tracker) */
  siteKey: string | undefined;
  /** optional link to a demo entry point the deployment provides */
  demoUrl: string | undefined;
  /** release builds refuse anything that is not the production deployment */
  release: boolean;
  outDir: string;
  /** the repository root (content/stellar.toml) */
  repoRoot: string;
}

const SITE_KEY = /^[0-9A-Za-z]{22}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** A demo link must stay on one of our own hosts: the page never sends a visitor elsewhere unannounced. */
function checkDemoUrl(v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("LANDING_DEMO_URL must be an absolute URL");
  }
  if (u.protocol !== "https:" || (u.host !== "usagemap.dev" && !u.host.endsWith(".usagemap.dev"))) {
    throw new Error(
      "LANDING_DEMO_URL must be an https URL on usagemap.dev or one of its subdomains",
    );
  }
  return u.href;
}

/**
 * Reads the build configuration from the environment.
 *
 *   LANDING_SITE_KEY         the landing page's own 22-character site key (required with --release)
 *   LANDING_TRACKER_DIST     tracker build output (default: tracker/dist of this repository)
 *   LANDING_TRACKER_VERSION  pinned tracker version (default: the version in tracker/package.json)
 *   LANDING_DEMO_URL         optional demo entry point on usagemap.dev
 *   LANDING_OUT              output directory (default: apps/landing/dist)
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { release: boolean; defaultTrackerVersion: string },
): LandingConfig {
  const siteKey = env.LANDING_SITE_KEY?.trim() || undefined;
  if (siteKey !== undefined && !SITE_KEY.test(siteKey)) {
    throw new Error("LANDING_SITE_KEY must be the 22-character alphanumeric site key");
  }
  if (opts.release && siteKey === undefined) {
    throw new Error("a release build needs LANDING_SITE_KEY (the landing page measures itself)");
  }
  const trackerVersion = env.LANDING_TRACKER_VERSION?.trim() || opts.defaultTrackerVersion;
  if (!SEMVER.test(trackerVersion)) throw new Error("LANDING_TRACKER_VERSION must be plain semver");
  const demo = env.LANDING_DEMO_URL?.trim();
  return {
    trackerDist: resolve(env.LANDING_TRACKER_DIST?.trim() || join(REPO_ROOT, "tracker", "dist")),
    trackerVersion,
    siteKey,
    demoUrl: demo ? checkDemoUrl(demo) : undefined,
    release: opts.release,
    outDir: resolve(env.LANDING_OUT?.trim() || join(LANDING_ROOT, "dist")),
    repoRoot: REPO_ROOT,
  };
}
