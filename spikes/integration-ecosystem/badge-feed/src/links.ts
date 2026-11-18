// SPDX-License-Identifier: Apache-2.0
// Registry links of the DEMO projects. The grant-system segment is `demo`, never `scf`, so a demo id can never be
// mistaken for (or collide with) a real PG Atlas / OpenGrants id. Consent to the feed is a separate opt-in from public
// stats; in the demo every public, registry-linked project except one has opted in, to show the exclusion.

import type { TenantPlan } from "../../../../tools/demo-seed/src/plan.ts";
import type { FeedLink } from "./feed.ts";

export function demoLink(t: TenantPlan): FeedLink {
  const name = t.slug.replace(/^demo-/, "").replaceAll("-", "_");
  return {
    daoip5Id: `daoip-5:demo:project:${name}`,
    stellarlightSlug: t.registryLinked ? t.slug : null,
    feedConsent: t.index !== 3,
    publicStats: t.publicStats,
    registryLinked: t.registryLinked,
  };
}
