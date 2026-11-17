// SPDX-License-Identifier: Apache-2.0
// Server-side badges of a public project card (plan D-5 follow-up; spike spikes/integration-ecosystem/badge-feed):
// a static SVG and a Shields.io "endpoint" JSON (schemaVersion 1: label, message, color) built from the project's
// PUBLIC metrics document only (wire-formats §i.1; anonymous read, so a project that has not switched public stats on
// has no badge). Rules:
//   - wording C4: the badge says who measured ("measured by UsageMap") and what ("verified visitors" = page views that
//     passed our bot checks; "self-attested" API telemetry), never an endorsement by SCF, SDF or anyone;
//   - small-count floors: a count below the floor is shown as "< floor" (a badge is no place for exact tiny numbers,
//     which tell a reader little and change with every single visit);
//   - short numbers: 1,234 · 12.3k · 1.2M (rounded down, so a badge never overstates).
// Pure functions; handlers.ts serves them with the metrics document's cache rules.

export type BadgeMetric = "visitors" | "api";

/** Below these counts the badge shows "< floor" instead of the number. */
export const BADGE_FLOORS: Record<BadgeMetric, number> = { visitors: 100, api: 1000 };

export const BADGE_LABEL = "measured by UsageMap";

/** The parts of the public metrics document a badge reads (wire-formats §i.1). */
export interface BadgeDoc {
  project: { slug: string; name: string };
  window: { end: string; days: number };
  web: { verified: { visitors_sum: number } };
  api: { requests: number; assurance_level: string | null };
}

/** 1234 → "1,234"; 12_345 → "12.3k"; 1_204_513 → "1.2M" — always rounded down. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError("not a count");
  const v = Math.floor(n);
  if (v < 10_000) return new Intl.NumberFormat("en-US").format(v);
  if (v < 1_000_000) return `${(Math.floor(v / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(Math.floor(v / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The count as a badge shows it, with the small-count floor. */
export function flooredCount(n: number, metric: BadgeMetric): string {
  const floor = BADGE_FLOORS[metric];
  return n < floor ? `< ${compactCount(floor)}` : compactCount(n);
}

const asOf = (doc: BadgeDoc) =>
  new Date(Date.parse(doc.window.end) - 86_400_000).toISOString().slice(0, 10);

export interface BadgeText {
  label: string;
  message: string;
  title: string;
  color: string;
  /** false when the project reports nothing for this metric (a grey "not reported" badge, never a 0) */
  reported: boolean;
}

export function badgeText(doc: BadgeDoc, metric: BadgeMetric): BadgeText {
  const days = doc.window.days;
  if (metric === "visitors") {
    const n = doc.web.verified.visitors_sum;
    return {
      label: BADGE_LABEL,
      message: `${flooredCount(n, "visitors")} verified visitors / ${days}d`,
      title: `${doc.project.name}: visitors (sum of daily uniques) whose page views passed bot checks, ${days} days to ${asOf(doc)}. Measured by UsageMap, an independent analytics service; not an endorsement by SCF, SDF or anyone else.`,
      color: "1f5fae",
      reported: true,
    };
  }
  if (doc.api.assurance_level === null || doc.api.requests === 0)
    return {
      label: BADGE_LABEL,
      message: "API: not reported",
      title: `${doc.project.name} reports no API telemetry to UsageMap.`,
      color: "9f9f9f",
      reported: false,
    };
  return {
    label: BADGE_LABEL,
    message: `${flooredCount(doc.api.requests, "api")} API requests (self-attested) / ${days}d`,
    title: `${doc.project.name}: API requests reported by the project's own telemetry (assurance ${doc.api.assurance_level}), ${days} days to ${asOf(doc)}. Not independently verified; measured by UsageMap, not an endorsement by SCF, SDF or anyone else.`,
    color: "6b5a1f",
    reported: true,
  };
}

export function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Approximate text width at 11px sans-serif (6.2 px per character), as badge generators do. */
const width = (s: string) => Math.round(s.length * 6.2) + 12;

export function badgeSvg(doc: BadgeDoc, metric: BadgeMetric): string {
  const t = badgeText(doc, metric);
  const lw = width(t.label);
  const rw = width(t.message);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${escapeXml(`${t.label}: ${t.message}`)}">`,
    `<title>${escapeXml(t.title)}</title>`,
    `<rect width="${lw}" height="20" fill="#3b3b3b"/>`,
    `<rect x="${lw}" width="${rw}" height="20" fill="#${t.color}"/>`,
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="6" y="14">${escapeXml(t.label)}</text>`,
    `<text x="${lw + 6}" y="14">${escapeXml(t.message)}</text>`,
    "</g></svg>",
  ].join("");
}

export interface ShieldsEndpoint {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
}

/** https://shields.io/badges/endpoint-badge (schemaVersion, label, message required; cacheSeconds ≥ 300). */
export function shieldsEndpoint(doc: BadgeDoc, metric: BadgeMetric): ShieldsEndpoint {
  const t = badgeText(doc, metric);
  return {
    schemaVersion: 1,
    label: t.label,
    message: t.message,
    color: t.color,
    cacheSeconds: 3600,
  };
}
