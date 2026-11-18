// SPDX-License-Identifier: Apache-2.0
// Writes the prototype outputs for the 20 DEMO projects into ./out (or the directory given as the first argument):
//   metrics/<slug>.json, badges/<slug>.web.svg, badges/<slug>.api.svg, badges/<slug>.shields-{web,api}.json, feed.json
// Run: node spikes/integration-ecosystem/badge-feed/run.ts [outDir]     (no network, no database)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiBadge, shieldsApi, shieldsWeb, webBadge } from "./src/badge.ts";
import { demoCohort } from "./src/demo-metrics.ts";
import { buildFeed } from "./src/feed.ts";
import { demoLink } from "./src/links.ts";

const TODAY = new Date("2026-11-19T00:00:00Z");
const BASE = "http://localhost:5173";
const out = process.argv[2] ?? join(import.meta.dirname, "out");
mkdirSync(join(out, "metrics"), { recursive: true });
mkdirSync(join(out, "badges"), { recursive: true });

const cohort = demoCohort(TODAY);
for (const { doc } of cohort) {
  const s = doc.project.slug;
  writeFileSync(join(out, "metrics", `${s}.json`), `${JSON.stringify(doc, null, 1)}\n`);
  writeFileSync(join(out, "badges", `${s}.web.svg`), webBadge(doc, `${BASE}/p/${s}`));
  const api = apiBadge(doc);
  if (api) writeFileSync(join(out, "badges", `${s}.api.svg`), api);
  writeFileSync(join(out, "badges", `${s}.shields-web.json`), JSON.stringify(shieldsWeb(doc)));
  writeFileSync(join(out, "badges", `${s}.shields-api.json`), JSON.stringify(shieldsApi(doc)));
}
const feed = buildFeed(
  cohort.map(({ plan, doc }) => ({ doc, link: demoLink(plan) })),
  BASE,
  "2026-11-19T01:00:00Z",
);
writeFileSync(join(out, "feed.json"), `${JSON.stringify(feed, null, 1)}\n`);
console.log(
  `${cohort.length} demo projects → ${Object.keys(feed.projects).length} in feed.json (${out}); ` +
    `${cohort.filter((c) => apiBadge(c.doc)).length} API badges`,
);
