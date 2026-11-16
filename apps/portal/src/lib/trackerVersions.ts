// SPDX-License-Identifier: Apache-2.0
// Which tracker version a site runs compared with the newest release (tracker.intentional-upgrade, ADR-0004): tenants upgrade only by
// editing their snippet (version + SRI hash) or bumping the npm dependency, so the portal states the difference and
// never changes anything itself. Versions are plain x.y.z (C-37).

import type { ControlPlane } from "@usagemap/api-types";

export type UpgradeState =
  | { kind: "not_reported"; latest: string | null }
  | { kind: "current"; seen: string; latest: string }
  | { kind: "update_available"; seen: string; latest: string }
  | { kind: "withdrawn"; seen: string; latest: string | null; advisory: string | null }
  | { kind: "unknown"; seen: string; latest: string | null };

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function latestActive(versions: readonly ControlPlane.TrackerVersion[]): string | null {
  const active = versions.filter((v) => v.status === "active").map((v) => v.version);
  active.sort((a, b) => compareSemver(b, a));
  return active[0] ?? null;
}

export function upgradeState(
  seen: string | null | undefined,
  versions: readonly ControlPlane.TrackerVersion[],
): UpgradeState {
  const latest = latestActive(versions);
  if (!seen) return { kind: "not_reported", latest };
  const release = versions.find((v) => v.version === seen);
  if (!release) return { kind: "unknown", seen, latest };
  if (release.status === "withdrawn")
    return { kind: "withdrawn", seen, latest, advisory: release.advisory_url ?? null };
  if (latest && compareSemver(latest, seen) > 0) return { kind: "update_available", seen, latest };
  return { kind: "current", seen, latest: latest ?? seen };
}
