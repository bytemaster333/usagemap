// SPDX-License-Identifier: Apache-2.0
// Bulk ecosystem feed, keyed by DAOIP-5 project id (the key PG Atlas and OpenGrants use: `daoip-5:scf:project:<name>`
// or `daoip-5:scf:application:<name>`), with the Stellarlight slug alongside. One document for all consenting projects,
// because a crawler over hundreds of projects prefers one fetch to hundreds. Prototype only: no third party has
// agreed to read it.
//
// Inclusion: the project made its stats public, linked itself to a registry entry the operator confirmed (L3/L4), and
// opted in to the feed. Everything else is absent: an absent key means "no data", never "zero".
// Content: aggregate counts already public on the project card (§i.1). Never addresses, contract ids, tx hashes,
// per-route or per-referrer detail, or anything per visitor.

import type { MetricsDoc } from "./demo-metrics.ts";

export const FEED_SCHEMA = "usagemap/ecosystem-feed/0";

/** DAOIP-5 grant-system project id, as PG Atlas serves them; ≤ 200 chars like `registry_projects.canonical_daoip5_id`. */
export const DAOIP5_ID = /^daoip-5:[a-z0-9][a-z0-9_-]*:(project|application):[^\s\p{Cc}]{1,160}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export interface FeedLink {
  daoip5Id: string;
  stellarlightSlug: string | null;
  feedConsent: boolean;
  publicStats: boolean;
  /** an operator-confirmed registry link exists */
  registryLinked: boolean;
}

export interface FeedEntry {
  stellarlight_slug: string | null;
  usagemap_slug: string;
  verification_level: MetricsDoc["project"]["verification_level"];
  web: {
    verified_pageviews: number;
    verified_visitors_sum: number;
    raw_pageviews: number;
    suspect_pageview_share: number | null;
  } | null;
  api: {
    label: "self-attested telemetry";
    requests: number;
    assurance_level: "A0" | "A1" | "A2";
  } | null;
  card_url: string;
  metrics_url: string;
  badge: { svg: string; shields_endpoint: string };
}

export interface Feed {
  schema: typeof FEED_SCHEMA;
  generated_at: string;
  window: MetricsDoc["window"];
  notice: string;
  definitions: string;
  projects: Record<string, FeedEntry>;
}

export class FeedError extends Error {}

export function buildFeed(
  items: { doc: MetricsDoc; link: FeedLink }[],
  base: string,
  generatedAt: string,
): Feed {
  const included = items.filter((i) => i.link.feedConsent && i.link.publicStats && i.link.registryLinked);
  const first = included[0]?.doc;
  const projects: Record<string, FeedEntry> = {};
  for (const { doc, link } of included.sort((a, b) => (a.link.daoip5Id < b.link.daoip5Id ? -1 : 1))) {
    if (!DAOIP5_ID.test(link.daoip5Id)) throw new FeedError(`not a DAOIP-5 project id: ${JSON.stringify(link.daoip5Id)}`);
    if (link.stellarlightSlug !== null && !SLUG.test(link.stellarlightSlug))
      throw new FeedError(`not a Stellarlight slug: ${JSON.stringify(link.stellarlightSlug)}`);
    if (projects[link.daoip5Id]) throw new FeedError(`two projects claim ${link.daoip5Id}`);
    if (first && (doc.window.start !== first.window.start || doc.window.end !== first.window.end))
      throw new FeedError(`window of ${doc.project.slug} differs from the feed window`);
    const slug = encodeURIComponent(doc.project.slug);
    const hasWeb = doc.web.raw.pageviews > 0;
    projects[link.daoip5Id] = {
      stellarlight_slug: link.stellarlightSlug,
      usagemap_slug: doc.project.slug,
      verification_level: doc.project.verification_level,
      web: hasWeb
        ? {
            verified_pageviews: doc.web.verified.pageviews,
            verified_visitors_sum: doc.web.verified.visitors_sum,
            raw_pageviews: doc.web.raw.pageviews,
            suspect_pageview_share: doc.web.visit_metrics.suspect_pageview_share,
          }
        : null,
      api:
        doc.api.assurance_level !== null && doc.api.requests > 0
          ? { label: doc.api.label, requests: doc.api.requests, assurance_level: doc.api.assurance_level }
          : null,
      card_url: `${base}/p/${slug}`,
      metrics_url: `${base}/public/v1/projects/${slug}/metrics.json`,
      badge: {
        svg: `${base}/public/v1/projects/${slug}/badge.svg`,
        shields_endpoint: `${base}/public/v1/projects/${slug}/badge.json`,
      },
    };
  }
  return {
    schema: FEED_SCHEMA,
    generated_at: generatedAt,
    window: first?.window ?? { start: generatedAt, end: generatedAt, days: 0 },
    notice:
      "Measured usage of projects that opted in. Web figures passed bot checks; API figures are the project's own telemetry. A measurement, not an endorsement by anyone.",
    definitions: `${base}/docs/metric-definitions/1`,
    projects,
  };
}
