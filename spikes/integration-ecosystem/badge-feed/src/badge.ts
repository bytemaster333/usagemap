// SPDX-License-Identifier: Apache-2.0
// Badges for a project's public card, from its metrics document (§i.1). Three outputs:
//   - web badge SVG: reuses the portal's existing generator (apps/portal/src/lib/badge.ts, plan D-5) unchanged;
//   - API badge SVG: new; always carries the "self-attested" label (§i.1 api.label) and the assurance level;
//   - Shields.io "endpoint" JSON (schemaVersion 1, label, message, color): lets a README use
//     https://img.shields.io/endpoint?url=<our JSON>, so the README viewer's browser talks to Shields, never to us.
// Wording rule C4: a measurement, never an endorsement; no "SCF verified", no SDF/SCF marks.

import { badgeSvg, escapeXml, badgeTextWidth as width } from "../../../../apps/portal/src/lib/badge.ts";
import type { MetricsDoc } from "./demo-metrics.ts";

/** 1234 → "1,234"; 12_345 → "12.3k"; 1_204_513 → "1.2M" (badge space is short). */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`not a count: ${n}`);
  if (n < 10_000) return new Intl.NumberFormat("en-US").format(Math.round(n));
  if (n < 1_000_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

const asOf = (doc: MetricsDoc) => new Date(Date.parse(doc.window.end) - 86_400_000).toISOString().slice(0, 10);

export function webBadge(doc: MetricsDoc, cardUrl: string): string {
  return badgeSvg({
    name: doc.project.name,
    verifiedVisitors: doc.web.verified.visitors_sum,
    days: doc.window.days,
    asOf: asOf(doc),
    cardUrl,
  });
}

/** null when the project reports no API telemetry (no badge rather than a "0" badge). */
export function apiBadge(doc: MetricsDoc): string | null {
  if (doc.api.assurance_level === null || doc.api.requests === 0) return null;
  const left = "API requests (self-attested)";
  const right = `${compact(doc.api.requests)} / ${doc.window.days} d · ${doc.api.assurance_level}`;
  const title =
    `${doc.project.name}: ${doc.api.requests} API requests reported by the project's own telemetry, ` +
    `${doc.window.days} days to ${asOf(doc)}, assurance ${doc.api.assurance_level}. Not independently verified; not an endorsement.`;
  const lw = width(left);
  const rw = width(right);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${escapeXml(`${left}: ${right}`)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${lw}" height="20" fill="#3b3b3b"/>`,
    `<rect x="${lw}" width="${rw}" height="20" fill="#6b5a1f"/>`,
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="6" y="14">${escapeXml(left)}</text>`,
    `<text x="${lw + 6}" y="14">${escapeXml(right)}</text>`,
    "</g></svg>",
  ].join("");
}

export interface ShieldsEndpoint {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  labelColor?: string;
  isError?: boolean;
}

/** https://shields.io/badges/endpoint-badge: schemaVersion, label and message are required. */
export function shieldsWeb(doc: MetricsDoc): ShieldsEndpoint {
  return {
    schemaVersion: 1,
    label: "measured usage",
    message: `${compact(doc.web.verified.visitors_sum)} verified visitors / ${doc.window.days}d`,
    color: "1f5fae",
  };
}

export function shieldsApi(doc: MetricsDoc): ShieldsEndpoint {
  if (doc.api.assurance_level === null || doc.api.requests === 0)
    return { schemaVersion: 1, label: "API requests", message: "not reported", color: "lightgrey" };
  return {
    schemaVersion: 1,
    label: "API requests (self-attested)",
    message: `${compact(doc.api.requests)} / ${doc.window.days}d · ${doc.api.assurance_level}`,
    color: "6b5a1f",
  };
}
