// SPDX-License-Identifier: Apache-2.0
// The embeddable badge of a public project card (plan D-5): a self-contained SVG the project pastes into its own page,
// linking back to the public card. It is generated here from the current public metrics document and states its date,
// so it never needs a request to our servers from the embedding page (no visitor of that page is ever seen by us).
// Wording rule C4: it describes a measurement ("measured usage", "verified" = passed our bot checks), never an
// endorsement: nothing that implies approval by SCF or SDF.

export interface BadgeInput {
  name: string;
  verifiedVisitors: number;
  days: number;
  /** YYYY-MM-DD, the last day the figure covers */
  asOf: string;
  cardUrl: string;
}

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function badgeLines(b: BadgeInput): { left: string; right: string; title: string } {
  return {
    left: "measured usage",
    right: `${INT.format(b.verifiedVisitors)} verified visitors / ${b.days} d`,
    title: `${b.name}: ${INT.format(b.verifiedVisitors)} visitors (sum of daily uniques) whose page views passed bot checks, ${b.days} days to ${b.asOf}. Measured by UsageMap, an independent analytics service; not an endorsement by SCF, SDF or anyone else.`,
  };
}

/** Approximate text width at 11px sans-serif (6.2 px per character), as badge generators do. */
const width = (s: string) => Math.round(s.length * 6.2) + 12;

export function badgeSvg(b: BadgeInput): string {
  const { left, right, title } = badgeLines(b);
  const lw = width(left);
  const rw = width(right);
  const w = lw + rw;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escapeXml(`${left}: ${right}`)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${lw}" height="20" fill="#2f3237"/>`,
    `<rect x="${lw}" width="${rw}" height="20" fill="#1b6e45"/>`,
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="6" y="14">${escapeXml(left)}</text>`,
    `<text x="${lw + 6}" y="14">${escapeXml(right)}</text>`,
    "</g></svg>",
  ].join("");
}

/** The HTML a project pastes: the badge, linking to its public card. */
export function badgeHtml(b: BadgeInput): string {
  return `<a href="${escapeXml(b.cardUrl)}" rel="noopener">${badgeSvg(b)}</a>`;
}

export { width as badgeTextWidth };
