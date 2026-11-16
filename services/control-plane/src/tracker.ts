// SPDX-License-Identifier: Apache-2.0
// Released tracker versions (ADR-0004, C-37, C-100). Two inputs, both produced by the release process:
//   - SCF_TRACKER_MANIFEST_DIR: the tracker build output, `<semver>/manifest.json` per version (per-file sha384/SRI);
//   - SCF_TRACKER_RELEASES_FILE: `[{"version","released_at","status":"active"|"withdrawn","advisory_url"?}]`.
// A version is published only when it appears in both. The edge snapshot carries version + status; the public
// endpoint adds the SRI hashes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TrackerVersionView {
  version: string;
  status: "active" | "withdrawn";
  released_at: string;
  files: Array<{
    profile: "standard" | "strict";
    url: string;
    integrity: string;
    gzip_bytes?: number;
  }>;
  advisory_url: string | null;
}

export interface TrackerRegistry {
  versions(): TrackerVersionView[];
  /** The two ingest origins compiled into a version (manifest `config.hosts`); empty when unknown. */
  hosts(version: string): string[];
}

interface Release {
  version: string;
  released_at: string;
  status: "active" | "withdrawn";
  advisory_url?: string | null;
}

interface Manifest {
  version: string;
  config?: { hosts?: unknown };
  url_pattern?: string;
  files: Array<{
    path: string;
    profile: "standard" | "strict";
    integrity: string;
    gzip_bytes?: number;
  }>;
}

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function loadTrackerRegistry(
  manifestDir: string | undefined,
  releasesFile: string | undefined,
): TrackerRegistry {
  const list: TrackerVersionView[] = [];
  const hosts = new Map<string, string[]>();
  if (manifestDir && releasesFile) {
    const releases = JSON.parse(readFileSync(releasesFile, "utf8")) as Release[];
    for (const r of releases) {
      if (!SEMVER.test(r.version)) throw new Error(`tracker release ${r.version} is not x.y.z`);
      const path = join(manifestDir, r.version, "manifest.json");
      if (!existsSync(path)) throw new Error(`tracker release ${r.version} has no manifest`);
      const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
      if (m.version !== r.version) throw new Error(`manifest version mismatch for ${r.version}`);
      const h = Array.isArray(m.config?.hosts) ? m.config.hosts : [];
      hosts.set(
        r.version,
        h.filter((x): x is string => typeof x === "string" && /^https?:\/\/[^/\s]+$/.test(x)),
      );
      list.push({
        version: r.version,
        status: r.status,
        released_at: new Date(r.released_at).toISOString(),
        files: m.files
          .filter((f) => f.profile === "standard" || f.profile === "strict")
          .map((f) => ({
            profile: f.profile,
            url: `/lib/${r.version}/${f.profile}.js`,
            integrity: f.integrity,
            ...(typeof f.gzip_bytes === "number" ? { gzip_bytes: f.gzip_bytes } : {}),
          })),
        advisory_url: r.advisory_url ?? null,
      });
    }
  }
  list.sort((a, b) => compareSemver(b.version, a.version));
  return {
    versions: () => list.map((v) => ({ ...v, files: v.files.map((f) => ({ ...f })) })),
    hosts: (version) => [...(hosts.get(version) ?? [])],
  };
}

/**
 * The version a snippet pins (ADR-0004, tracker.intentional-upgrade): the requested one when it is active, otherwise — without a request —
 * the newest active version. Every active version stays selectable, so tenants upgrade only by choosing to; a
 * withdrawn version is never offered (its files answer `410`).
 */
export function selectTrackerVersion(
  versions: readonly TrackerVersionView[],
  wanted: string | undefined,
): TrackerVersionView | undefined {
  return wanted
    ? versions.find((x) => x.version === wanted && x.status === "active")
    : versions.find((x) => x.status === "active");
}

const VERSION_LABEL = /^v([0-9]+)_([0-9]+)_([0-9]+)$/;

/**
 * The tracker version a site's events came from (C-129, tracker.intentional-upgrade): the gateway counts every event it does not reject
 * under web counter `tracker_version`, label `v<major>_<minor>_<patch>`. Returns the version with the most events in
 * the rows given (ties → the higher version), or null when none was counted. Labels of another shape are ignored.
 */
export function trackerVersionSeen(
  rows: ReadonlyArray<{ label: string; count: number }>,
): string | null {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const m = VERSION_LABEL.exec(r.label);
    if (!m || !(r.count > 0)) continue;
    const v = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
    totals.set(v, (totals.get(v) ?? 0) + r.count);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of totals)
    if (best === null || n > bestN || (n === bestN && compareSemver(v, best) > 0)) {
      best = v;
      bestN = n;
    }
  return best;
}

/** True when the version seen is below the newest active release (the installation check's `outdated_tracker`). */
export function trackerOutdated(
  seen: string | null,
  versions: readonly TrackerVersionView[],
): boolean {
  const newest = selectTrackerVersion(versions, undefined);
  return seen !== null && newest !== undefined && compareSemver(seen, newest.version) < 0;
}
