// SPDX-License-Identifier: Apache-2.0
// Run: node --test spikes/integration-ecosystem/badge-feed/test/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiBadge, compact, shieldsApi, shieldsWeb, webBadge } from "../src/badge.ts";
import { demoCohort, type MetricsDoc } from "../src/demo-metrics.ts";
import { buildFeed, DAOIP5_ID, FeedError, type FeedLink } from "../src/feed.ts";
import { demoLink } from "../src/links.ts";

const TODAY = new Date("2026-11-19T00:00:00Z");
const BASE = "http://localhost:5173";
const cohort = demoCohort(TODAY);
const items = cohort.map(({ plan, doc }) => ({ doc, link: demoLink(plan) }));

test("metrics documents have exactly the top-level and web/api keys of wire-formats §i.1", () => {
  for (const { doc } of cohort) {
    assert.deepEqual(Object.keys(doc).sort(), ["api", "generated_at", "links", "project", "schema", "web", "window"]);
    assert.deepEqual(Object.keys(doc.web).sort(), ["daily", "raw", "verified", "visit_metrics"]);
    assert.equal(doc.api.label, "self-attested telemetry");
    assert.equal(doc.window.days, 30);
    assert.ok(doc.web.verified.pageviews <= doc.web.raw.pageviews);
    assert.equal(doc.web.daily.reduce((a, d) => a + d.pageviews_verified, 0), doc.web.verified.pageviews);
  }
});

test("demo cohort is deterministic", () => {
  assert.deepEqual(demoCohort(TODAY), cohort);
});

test("compact number format", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(9_999), "9,999");
  assert.equal(compact(12_399), "12.3k");
  assert.equal(compact(100_000), "100k");
  assert.equal(compact(1_204_513), "1.2M");
  assert.throws(() => compact(-1), RangeError);
});

test("web badge states the window and is not an endorsement", () => {
  const doc = cohort[0]!.doc;
  const svg = webBadge(doc, `${BASE}/p/${doc.project.slug}`);
  assert.match(svg, /^<svg [^>]*role="img"/);
  assert.match(svg, /verified visitors \/ 30 d/);
  assert.match(svg, /not an endorsement/);
  assert.doesNotMatch(svg, /SCF verified|endorsed by/i);
});

test("API badge always says self-attested; projects without API get none", () => {
  for (const { doc } of cohort) {
    const svg = apiBadge(doc);
    if (doc.api.assurance_level === null) {
      assert.equal(svg, null);
      assert.equal(shieldsApi(doc).message, "not reported");
    } else {
      assert.match(svg!, /self-attested/);
      assert.match(svg!, new RegExp(`· ${doc.api.assurance_level}`));
    }
  }
});

test("names are XML-escaped in badges", () => {
  const doc: MetricsDoc = structuredClone(cohort[0]!.doc);
  doc.project.name = `<script>alert("x")</script> & co`;
  const svg = webBadge(doc, `${BASE}/p/x`) + apiBadge(doc);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("Shields endpoint JSON has the required fields", () => {
  for (const { doc } of cohort) {
    for (const s of [shieldsWeb(doc), shieldsApi(doc)]) {
      assert.equal(s.schemaVersion, 1);
      assert.ok(s.label.length > 0 && s.message.length > 0);
    }
  }
});

test("feed includes only public + registry-linked + consenting projects, keyed by DAOIP-5 id", () => {
  const feed = buildFeed(items, BASE, "2026-11-19T01:00:00Z");
  const expected = items
    .filter((i) => i.link.publicStats && i.link.registryLinked && i.link.feedConsent)
    .map((i) => i.link.daoip5Id)
    .sort();
  assert.deepEqual(Object.keys(feed.projects), expected);
  assert.ok(expected.length > 0);
  // the one public, linked project that did not consent is absent
  const refused = items.filter((i) => i.link.publicStats && i.link.registryLinked && !i.link.feedConsent);
  for (const r of refused) assert.equal(feed.projects[r.link.daoip5Id], undefined);
  for (const id of Object.keys(feed.projects)) assert.match(id, DAOIP5_ID);
});

test("feed figures equal the metrics documents", () => {
  const feed = buildFeed(items, BASE, "2026-11-19T01:00:00Z");
  for (const { doc, link } of items) {
    const e = feed.projects[link.daoip5Id];
    if (!e) continue;
    assert.equal(e.usagemap_slug, doc.project.slug);
    if (e.web) assert.equal(e.web.verified_visitors_sum, doc.web.verified.visitors_sum);
    if (e.api) assert.equal(e.api.requests, doc.api.requests);
  }
});

test("feed carries no addresses, contract ids, hashes or per-visitor data", () => {
  const text = JSON.stringify(buildFeed(items, BASE, "2026-11-19T01:00:00Z"));
  assert.doesNotMatch(text, /\b[GCMS][A-Z2-7]{55}\b/, "Stellar strkey");
  assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/, "tx hash");
  assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b/, "IPv4");
  assert.doesNotMatch(text, /"(daily|referrer|path|country|ip|user_agent)"/);
});

test("DAOIP-5 id check accepts PG Atlas forms and rejects others", () => {
  assert.match("daoip-5:scf:project:soroswap", DAOIP5_ID);
  assert.match("daoip-5:scf:application:agentsmith_x402:_stellar_facilitator", DAOIP5_ID);
  for (const bad of ["scf:project:x", "daoip-5:scf:grant:x", "daoip-5:scf:project:", "daoip-5:scf:project:a b"]) {
    assert.doesNotMatch(bad, DAOIP5_ID);
  }
  const link: FeedLink = { ...items[0]!.link, daoip5Id: "daoip-5:scf:project:has space" };
  const consenting = items.find((i) => i.link.feedConsent && i.link.publicStats && i.link.registryLinked)!;
  assert.throws(() => buildFeed([{ doc: consenting.doc, link }], BASE, "x"), FeedError);
});

test("two projects claiming one id is an error", () => {
  const c = items.filter((i) => i.link.feedConsent && i.link.publicStats && i.link.registryLinked).slice(0, 2);
  assert.equal(c.length, 2);
  const dup = c.map((i) => ({ doc: i.doc, link: { ...i.link, daoip5Id: "daoip-5:demo:project:same" } }));
  assert.throws(() => buildFeed(dup, BASE, "x"), /two projects claim/);
});
