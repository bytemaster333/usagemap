// SPDX-License-Identifier: Apache-2.0
// Build-time rendering of the published measurement methodology (plan C1 #6, feature.signed-snapshot-v2): the URL signed into every v2
// traction snapshot (`<portal>/docs/methodology/1.0.0`) must resolve to the document, read-only, under the portal CSP.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  methodologyPages,
  renderInline,
  renderMarkdown,
  slugOf,
} from "../../scripts/methodology.ts";

const repo = join(import.meta.dirname, "..", "..", "..", "..");

describe("Markdown subset renderer", () => {
  it("escapes every piece of text, including link text and code spans", () => {
    const html = renderMarkdown('Hello <script>alert("x")</script> & `<b>` [a<i>](#x) **<u>** "q"');
    expect(html).not.toMatch(/<script|<b>|<i>|<u>/);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;");
    expect(html).toContain("<code>&lt;b&gt;</code>");
    expect(html).toContain('<a href="#x">a&lt;i&gt;</a>');
    expect(html).toContain("<strong>&lt;u&gt;</strong>");
  });

  it("allows only in-page anchors and https links; relative repository links become text", () => {
    expect(renderInline("[x](https://example.org/a?b=1&c=2)")).toBe(
      '<a href="https://example.org/a?b=1&amp;c=2" rel="noreferrer">x</a>',
    );
    expect(renderInline("[x](#per-round-freeze)")).toBe('<a href="#per-round-freeze">x</a>');
    expect(renderInline("[x](javascript:alert(1))")).not.toContain("href");
    expect(renderInline("[x](data:text/html,hi)")).not.toContain("href");
    expect(renderInline("[Metric definitions](../metrics/definitions.md)")).toBe(
      'Metric definitions (<span class="docref">docs/metrics/definitions.md</span>)',
    );
    expect(renderInline("[why](../onboarding/wallets.md#counted-only-events)")).toBe(
      'why (<span class="docref">docs/onboarding/wallets.md#counted-only-events</span>)',
    );
  });

  it("renders emphasis, headings with GitHub-style ids, tables, nested lists and indented code", () => {
    const md = [
      "# Title `v1`",
      "",
      "## Trust score `trust/1.0.0`",
      "",
      "A *b* **c**.",
      "",
      "| | |",
      "|---|---|",
      "| Version | `x` |",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- one",
      "  continued",
      "  - nested",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "    T = a < b",
      "",
      "End.",
    ].join("\n");
    const html = renderMarkdown(md);
    expect(html).toContain('<h1 id="title-v1">Title <code>v1</code></h1>');
    expect(html).toContain('<h2 id="trust-score-trust100">');
    expect(html).toContain("<p>A <em>b</em> <strong>c</strong>.</p>");
    // A table whose header cells are all empty has no header row.
    expect(html).toContain(
      "<table><tbody><tr><td>Version</td><td><code>x</code></td></tr></tbody></table>",
    );
    expect(html).toContain(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
    expect(html).toContain("<ul><li>one continued<ul><li>nested</li></ul></li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<pre><code>T = a &lt; b</code></pre>");
    expect(html).toContain("<p>End.</p>");
  });

  it("slugs like GitHub", () => {
    expect(slugOf("On-chain figures")).toBe("on-chain-figures");
    expect(slugOf("Flags and appeals")).toBe("flags-and-appeals");
  });
});

describe("published methodology pages", () => {
  const pages = methodologyPages(join(repo, "docs", "methodology"));

  it("renders every published version as /docs/methodology/<semver>, read-only and CSP-clean", () => {
    const p = pages.find((x) => x.version === "1.0.0");
    expect(p?.fileName).toBe("docs/methodology/1.0.0.html");
    const html = p?.html ?? "";
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Measurement methodology scf-methodology/1.0.0");
    // No script, no inline style, no form, no event handler attribute: the portal CSP (script-src/style-src 'self',
    // Trusted Types) holds without exceptions.
    expect(html).not.toMatch(/<script|<style|style=|<form|<iframe|\son[a-z]+=/i);
    expect(html).toMatch(/<link rel="stylesheet" href="\/docs\/methodology\/methodology\.css">/);
    // Every in-page anchor resolves to a heading of the page.
    for (const m of html.matchAll(/href="#([^"]+)"/g))
      expect(html, `anchor #${m[1]}`).toContain(`id="${m[1]}"`);
    expect(html).toContain('id="small-count-floors"');
    expect(html).toContain("Changelog");
  });

  it("serves the exact URL the control plane signs into v2 snapshots", () => {
    const src = readFileSync(
      join(repo, "services", "control-plane", "src", "programme", "snapshot-v2.ts"),
      "utf8",
    );
    const version = /METHODOLOGY_VERSION = "scf-methodology\/([0-9.]+)"/.exec(src)?.[1];
    expect(src).toContain(["`$", "{portal}/docs/methodology/1.0.0`"].join(""));
    expect(pages.map((p) => p.version)).toContain(version);
  });

  it("refuses a file whose title names another version", () => {
    expect(() =>
      methodologyPages(join(import.meta.dirname, "..", "fixtures", "methodology-bad")),
    ).toThrow(/names version/);
  });

  it("is wired into the build and served by Caddy without the SPA fallback", () => {
    const cfg = readFileSync(join(import.meta.dirname, "..", "..", "vite.config.ts"), "utf8");
    expect(cfg).toContain("methodologyPlugin(");
    const caddy = readFileSync(
      join(import.meta.dirname, "..", "..", "server", "Caddyfile"),
      "utf8",
    );
    expect(caddy).toMatch(
      /handle \/docs\/methodology\/\* \{[^}]*try_files \{path\} \{path\}\.html/,
    );
    const docker = readFileSync(join(import.meta.dirname, "..", "..", "Dockerfile"), "utf8");
    expect(docker).toContain("COPY docs/methodology docs/methodology");
    expect(existsSync(join(repo, "docs", "methodology", "scf-methodology-1.0.0.md"))).toBe(true);
  });
});
