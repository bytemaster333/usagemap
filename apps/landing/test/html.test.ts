// SPDX-License-Identifier: Apache-2.0
// Structure, links and the page's own privacy rules: valid nesting, one h1 and no skipped heading levels, unique
// ids, every in-page link resolves, every outbound link stays on usagemap.dev, nothing is loaded from anywhere but
// this site's hashed assets (pinned by SRI) and the tracker's ingest host, the CSP allows nothing inline, the size
// budgets hold, the wording rule (C4), and the integrations directory states what the approved design states.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ASSET_BUDGET_BYTES, PAGE_BUDGET_BYTES } from "../build.ts";
import { METHODOLOGY_PATH } from "../src/config.ts";
import { sri } from "../src/page.ts";
import { balance, buildFor, tags, text } from "./helpers.ts";

const ALLOWED_HOST = /^(?:usagemap\.dev|(?:app|docs|status|e1|e2)\.usagemap\.dev)$/;

for (const variant of ["with tracker", "without tracker"] as const) {
  describe(`landing page (${variant})`, () => {
    const r = buildFor(variant === "with tracker" ? {} : { siteKey: undefined });
    const html = r.html;
    const all = tags(html);
    const open = all.filter((t) => !t.close);
    const ingest = r.facts.tracker.hosts[0];
    const asset = (path: string) => readFileSync(join(r.outDir, path));

    it("is well-formed: doctype, lang, charset first, balanced elements, no duplicate attributes", () => {
      assert.ok(html.startsWith("<!doctype html>\n"));
      assert.equal(open[0]?.name, "html");
      assert.equal(open[0]?.attrs.get("lang"), "en");
      assert.equal(open[2]?.name, "meta");
      assert.equal(open[2]?.attrs.get("charset"), "utf-8");
      assert.deepEqual(balance(all), []);
      assert.equal(open.filter((t) => t.name === "title").length, 1);
      assert.equal(open.filter((t) => t.name === "main").length, 1);
    });

    it("has one h1 and never skips a heading level", () => {
      const levels = open.filter((t) => /^h[1-6]$/.test(t.name)).map((t) => Number(t.name[1]));
      assert.equal(levels.filter((l) => l === 1).length, 1);
      assert.equal(levels[0], 1);
      for (let i = 1; i < levels.length; i++) {
        assert.ok(
          (levels[i] as number) - (levels[i - 1] as number) <= 1,
          `h${levels[i]} after h${levels[i - 1]}`,
        );
      }
    });

    it("has unique ids and every in-page link and reference resolves", () => {
      const ids = open.map((t) => t.attrs.get("id")).filter((v): v is string => v !== undefined);
      assert.equal(new Set(ids).size, ids.length);
      for (const t of open) {
        const href = t.attrs.get("href") ?? "";
        if (href.startsWith("#"))
          assert.ok(ids.includes(href.slice(1)), `missing #${href.slice(1)}`);
        for (const a of ["aria-labelledby", "aria-controls", "for"]) {
          const v = t.attrs.get(a);
          if (v) assert.ok(ids.includes(v), `${a}=${v}`);
        }
      }
    });

    it("links only to usagemap.dev hosts, over https, each with text", () => {
      const links = open.filter((t) => t.name === "a");
      assert.ok(links.length > 10);
      const hrefs = links.map((t) => t.attrs.get("href") ?? "");
      for (const href of hrefs) {
        if (href.startsWith("#")) continue;
        const u = new URL(href);
        assert.equal(u.protocol, "https:", href);
        assert.match(u.host, ALLOWED_HOST, href);
      }
      for (const must of [
        "https://app.usagemap.dev/onboard",
        "https://app.usagemap.dev/signin",
        "https://app.usagemap.dev/verify",
        `https://app.usagemap.dev${METHODOLOGY_PATH}`,
        "https://status.usagemap.dev",
        "https://docs.usagemap.dev/",
        "https://docs.usagemap.dev/llms.txt",
      ]) {
        assert.ok(hrefs.includes(must), must);
      }
      assert.ok(!/github\.com/i.test(html), "the repository is private: no link to it");
      const anchors = html.match(/<a\s[^>]*>[\s\S]*?<\/a>/g) ?? [];
      for (const a of anchors) assert.ok(text(a).trim() || /aria-label="[^"]+"/.test(a), a);
    });

    it("has no evidence page, route or link", () => {
      for (const [name, body] of [
        ["index.html", html],
        ["stylesheet", r.css],
        ["script", r.js],
      ] as const) {
        assert.ok(!/\/evidence\b/i.test(body), `${name} mentions /evidence`);
      }
      assert.ok(!/evidence/i.test(text(html)), "visible text mentions evidence");
      assert.ok(!r.files.some(([p]) => /evidence/i.test(p)), "an evidence file is written");
    });

    it("loads nothing but its own pinned assets and the pinned tracker", () => {
      const scripts = open.filter((t) => t.name === "script");
      for (const s of scripts) {
        const src = s.attrs.get("src") ?? "";
        assert.ok(
          /^\/assets\/site\.[0-9a-f]{12}\.js$/.test(src) || src.startsWith(`${ingest}/lib/`),
          `script ${src}`,
        );
        assert.ok(s.attrs.get("integrity")?.startsWith("sha384-"));
      }
      assert.equal(scripts.length, variant === "with tracker" ? 2 : 1);
      assert.ok(!/<script>/i.test(html), "no inline script");
      assert.ok(!/<style/i.test(html), "no inline style element");
      for (const t of open) {
        for (const [k] of t.attrs) {
          assert.ok(!/^on/.test(k), `inline handler ${k}`);
          assert.notEqual(k, "style", `style attribute on <${t.name}>`);
        }
        if (t.name === "link") {
          const rel = t.attrs.get("rel") ?? "";
          const href = t.attrs.get("href") ?? "";
          assert.ok(["canonical", "icon", "preload", "stylesheet"].includes(rel), rel);
          if (rel === "icon") assert.ok(href.startsWith("data:"));
          if (rel === "preload")
            assert.match(href, /^\/assets\/fonts\/[a-z-]+\.[0-9a-f]{12}\.woff2$/);
          if (rel === "stylesheet") {
            assert.match(href, /^\/assets\/site\.[0-9a-f]{12}\.css$/);
            assert.equal(t.attrs.get("integrity"), sri(asset(href)));
          }
        }
        if (t.name === "script" && t.attrs.get("src")?.startsWith("/assets/")) {
          assert.equal(t.attrs.get("integrity"), sri(asset(t.attrs.get("src") as string)));
        }
        for (const a of ["srcset", "poster", "data", "action"]) {
          if (t.attrs.has(a)) assert.fail(`<${t.name} ${a}> loads a resource`);
        }
        if (t.name !== "script" && t.attrs.has("src")) assert.fail(`<${t.name} src>`);
      }
      assert.ok(!/@import/i.test(r.css), "CSS imports nothing");
      for (const m of r.css.matchAll(/url\(([^)]*)\)/g)) {
        const u = (m[1] as string).replace(/^"|"$/g, "");
        assert.ok(
          u.startsWith("data:") || /^\/assets\/fonts\/[a-z-]+\.[0-9a-f]{12}\.woff2$/.test(u),
          `CSS loads ${u}`,
        );
        if (u.startsWith("/assets/")) asset(u); // the font file exists
      }
      assert.ok(
        !/innerHTML|outerHTML\s*=|insertAdjacentHTML|document\.write/.test(r.js),
        "no HTML strings",
      );
    });

    it("allows nothing inline in its Content-Security-Policy and requires Trusted Types", () => {
      const meta = open.find((t) => t.attrs.get("http-equiv") === "Content-Security-Policy");
      const csp = meta?.attrs.get("content")?.replaceAll("&#39;", "'") ?? "";
      assert.ok(csp.includes("default-src 'none'"));
      assert.ok(csp.includes("style-src 'self';"));
      assert.ok(csp.includes("font-src 'self';"));
      assert.ok(csp.includes("img-src data:;"));
      assert.ok(csp.includes("require-trusted-types-for 'script'"));
      assert.ok(csp.includes("trusted-types 'none'"));
      assert.ok(!csp.includes("unsafe"), "no unsafe-* source");
      if (variant === "with tracker") {
        assert.ok(csp.includes(`script-src 'self' ${ingest};`));
        assert.ok(csp.includes(`connect-src ${r.facts.tracker.hosts.join(" ")};`));
      } else {
        assert.ok(csp.includes("script-src 'self';"));
        assert.ok(csp.includes("connect-src 'none'"));
      }
    });

    it("works on phones: viewport with safe-area insets, compact menu with the same links", () => {
      const vp = open.find((t) => t.attrs.get("name") === "viewport")?.attrs.get("content") ?? "";
      assert.ok(vp.includes("width=device-width") && vp.includes("viewport-fit=cover"));
      const nav = /<nav class="nav-links"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
      const menu = /<nav class="mnav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
      const hrefs = (s: string) => [...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(hrefs(nav).length >= 5);
      assert.deepEqual(hrefs(menu), hrefs(nav));
      assert.match(
        html,
        /<button class="nav-menu" type="button" aria-expanded="false" aria-controls="mnav"/,
      );
    });

    it(`stays under its budgets (${PAGE_BUDGET_BYTES} B page, ${ASSET_BUDGET_BYTES} B assets)`, () => {
      assert.ok(r.bytes <= PAGE_BUDGET_BYTES, `${r.bytes} bytes`);
      assert.ok(r.assetBytes <= ASSET_BUDGET_BYTES, `${r.assetBytes} bytes`);
    });

    it("describes a measurement, never an endorsement (wording rule C4)", () => {
      const t = text(html).replace(/\s+/g, " ");
      for (const bad of [
        /\bSCF[- ]verified\b/i,
        /\bSDF[- ]approved\b/i,
        /\bcertifie[ds]\b/i,
        /\bofficial\b/i,
        /(?<!not (?:affiliated with or )?)endorsed by/i,
        /(?<!not ")genuine users/i,
      ]) {
        assert.ok(!bad.test(t), `forbidden wording ${bad}`);
      }
      assert.ok(
        t.includes(
          '"Verified" means an event passed UsageMap\'s checks; the Stellar Development Foundation (SDF) and the SCF do not run or endorse it.',
        ),
      );
      assert.ok(t.includes("API numbers can't be proven independently, so they are labelled."));
      assert.ok(t.includes("The repository opens with the public release."));
    });

    // Only integrations that are built (a catalogue card in
    // services/control-plane/src/integrations/catalogue.ts or a tested folder under examples/), and no status labels.
    it("lists the 49 built integrations, every filter counting its tiles, each with a docs guide", () => {
      const want: Record<string, number> = {
        stellar: 7,
        wallets: 5,
        web: 8,
        cms: 9,
        api: 12,
        mobile: 3,
        tools: 5,
      };
      const tiles = [
        ...html.matchAll(/<button type="button" class="ig-tile"([^>]*)>([\s\S]*?)<\/button>/g),
      ];
      assert.equal(tiles.length, 49);
      for (const [, attrs, inner] of tiles) {
        assert.match(attrs as string, /data-how="[^"]+"/);
        assert.match(attrs as string, /data-guide="https:\/\/docs\.usagemap\.dev\/[^"]*"/);
        assert.match(inner as string, /<span class="ig-nm">[^<]+<\/span>/);
      }
      const seen: Record<string, number> = {};
      for (const [, cat, body] of html.matchAll(
        /<div class="ig-group" data-cat="([\w-]+)">([\s\S]*?)<\/ul><\/div>/g,
      )) {
        const n = [...(body as string).matchAll(/class="ig-tile"/g)].length;
        seen[cat as string] = n;
        assert.match(
          html,
          new RegExp(`data-f="${cat}">[^<]*<span class="ct">${n}</span>`),
          `filter ${cat}`,
        );
      }
      assert.deepEqual(seen, want);
      assert.match(html, /data-f="all">All <span class="ct">49<\/span>/);
      const names = tiles.map(([, , inner]) => /class="ig-nm">([^<]+)</.exec(inner as string)?.[1]);
      for (const gone of [
        "Ledger",
        "Trezor",
        "LOBSTR",
        "Datadog",
        "Grafana",
        "Honeycomb",
        "Codex",
      ]) {
        assert.ok(!names.includes(gone), `${gone} is not built and must not be listed`);
      }
      for (const kept of [
        ".NET",
        "Next.js API routes",
        "OpenTelemetry Collector (dual export)",
        "VitePress",
      ]) {
        assert.ok(names.includes(kept), kept);
      }
      const t = text(html);
      assert.ok(
        !/npm install/i.test(t),
        "no npm-registry install is offered while the packages are unpublished",
      );
      assert.ok(t.includes("Packages install from the release until they are on npm."));
    });

    it("shows no release-status labels anywhere: nothing coming, available, pending, beta or soon", () => {
      const visible = text(html.replace(/<script[\s\S]*?<\/script>/g, "")).replace(/\s+/g, " ");
      const hit = /\b(?:coming|available|pending|beta|soon|roadmap)\b/i.exec(visible);
      assert.equal(
        hit,
        null,
        `status wording: "${visible.slice(Math.max(0, (hit?.index ?? 0) - 40), (hit?.index ?? 0) + 40)}"`,
      );
      assert.ok(
        !/class="st2\b|data-st=|ilegend/.test(html),
        "no status badge, attribute or legend",
      );
      for (const attr of html.matchAll(/(?:aria-label|title|data-how)="([^"]*)"/g)) {
        assert.ok(!/\b(?:coming|available|pending|beta|soon)\b/i.test(attr[1] as string), attr[1]);
      }
      assert.ok(
        !/\b(?:Coming|Available|Pending|Beta)\b/.test(r.js),
        "the script adds no status label",
      );
    });

    it("states the availability commitment in the status page's words (docs/sla.md §1, C-180)", () => {
      const t = text(html);
      assert.ok(
        t.includes(
          "Ingestion availability committed on the scale-out profile; dashboard availability 99.90 %. The single-host launch setup targets 99.5 %.",
        ),
      );
      assert.ok(!t.includes("dashboards 99.9 %"));
    });

    it("never shows an IP address, a Stellar key or a query string", () => {
      const t = text(html);
      assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(t), "IPv4 literal");
      assert.ok(!/\b[GSCM][A-Z2-7]{55}\b/.test(t), "StrKey");
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        const href = m[1] as string;
        if (!href.startsWith("data:")) assert.ok(!href.includes("?"), `query string in ${href}`);
      }
    });
  });
}
