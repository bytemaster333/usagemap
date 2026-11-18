// SPDX-License-Identifier: Apache-2.0
// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findAttr, fixTag, fixText, parseVersions, scanText, unifiedDiff } from "../src/pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const releases = parseVersions(readFileSync(join(here, "..", "testdata", "releases.json"), "utf8"));
const HOSTS = ["e1.usagemap.dev", "e2.usagemap.dev"];
const S110 = "sha384-AYjFWyBUxxvOL92oDDKxAus7EAPjONT2RDrOiuPh4XUiEJNKkMaZqGVBDw4Lqn0+";
const S100 = "sha384-grGHJaIn1S7+QsKcbybsmEiu1LXgxcbaz4buMHrOZKdbGyYIStg+BbK8eJuYeX8K";

test("parseVersions reads all three published shapes, newest first", () => {
  assert.deepEqual(
    releases.map((v) => `${v.version}:${v.status}`),
    ["1.1.0:active", "1.0.1:withdrawn", "1.0.0:active"],
  );
  // a single release manifest, as archived in the tracker package
  const one = parseVersions(
    readFileSync(join(repoRoot, "tracker/releases/1.0.0/manifest.json"), "utf8"),
  );
  assert.equal(one.length, 1);
  assert.equal(one[0]?.status, "active");
  assert.equal(one[0]?.files[0]?.path, "/lib/1.0.0/standard.js");
  // the edge's aggregate /lib/manifest.json
  const agg = parseVersions(
    JSON.stringify({
      schema: "scf-analytics/tracker-manifests/1",
      versions: [
        JSON.parse(readFileSync(join(repoRoot, "tracker/releases/1.0.0/manifest.json"), "utf8")),
      ],
    }),
  );
  assert.equal(agg[0]?.files.length, 2);
  // the CLI's embedded snapshot of the live list
  const live = parseVersions(
    readFileSync(join(repoRoot, "tools/stellar-scf/releases/usagemap.dev.json"), "utf8"),
  );
  assert.ok(live.length >= 1);
  for (const bad of [
    "{}",
    '[{"version":"x"}]',
    '[{"version":"1.0.0","status":"revoked"}]',
    '[{"version":"1.0.0","files":[{"profile":"strict","integrity":"sha256-x"}]}]',
  ]) {
    assert.throws(() => parseVersions(bad), bad);
  }
});

test("findAttr handles quotes, JSX expressions and case", () => {
  assert.equal(findAttr('<script src="a">', "src")?.value, "a");
  assert.equal(findAttr("<script src='b'>", "src")?.value, "b");
  assert.equal(findAttr('<Script src={"c"} />', "src")?.value, "c");
  assert.equal(findAttr('<script crossOrigin="anonymous">', "crossorigin")?.value, "anonymous");
  assert.equal(findAttr('<script data-src="x">', "src"), null, "data-src is not src");
});

test("scanText judges each pin", () => {
  const tag = (/** @type {string} */ v, /** @type {string} */ extra) =>
    `<script src="https://e1.usagemap.dev/lib/${v}/standard.js" ${extra} data-site="k" defer></script>`;
  const cases = [
    [tag("1.1.0", `integrity="${S110}" crossorigin="anonymous"`), "ok", []],
    [tag("1.1.0", `integrity="${S110}" crossorigin`), "ok", []],
    [tag("1.0.0", `integrity="${S100}" crossorigin="anonymous"`), "warning", ["outdated"]],
    [tag("1.0.1", `integrity="${S100}" crossorigin="anonymous"`), "error", ["withdrawn"]],
    [tag("1.1.0", `integrity="${S100}" crossorigin="anonymous"`), "error", ["integrity_mismatch"]],
    [tag("1.1.0", ""), "error", ["missing_integrity", "missing_crossorigin"]],
    [tag("1.0.0", ""), "error", ["missing_integrity", "missing_crossorigin", "outdated"]],
    [
      tag("1.1.0", `integrity="${S110}" crossorigin="use-credentials"`),
      "error",
      ["bad_crossorigin"],
    ],
    [tag("latest", ""), "error", ["unpinned_version", "missing_integrity", "missing_crossorigin"]],
    [tag("9.9.9", `integrity="${S110}" crossorigin="anonymous"`), "error", ["unknown_version"]],
  ];
  for (const [html, sev, codes] of cases) {
    const [f] = scanText("x.html", /** @type {string} */ (html), releases, HOSTS);
    assert.equal(f?.severity, sev, /** @type {string} */ (html));
    assert.deepEqual(f?.codes, codes, /** @type {string} */ (html));
  }
  // a templated src is reported, never rewritten
  const [tpl] = scanText(
    "x",
    '<script src="https://e1.usagemap.dev/lib/{{ tracker_version }}/standard.js"></script>',
    releases,
    HOSTS,
  );
  assert.equal(tpl?.severity, "warning");
  assert.deepEqual(tpl?.codes, ["templated"]);
  assert.equal(tpl?.proposed, null);
  // other hosts and other paths are not ours
  assert.equal(
    scanText(
      "x",
      '<script src="https://cdn.example/lib/1.0.0/standard.js"></script>',
      releases,
      HOSTS,
    ).length,
    0,
  );
  assert.equal(
    scanText("x", '<script src="https://e1.usagemap.dev/other.js"></script>', releases, HOSTS)
      .length,
    0,
  );
});

test("proposals: same version when only attributes are wrong, newest otherwise", () => {
  const [mismatch] = scanText(
    "x",
    `<script src="https://e2.usagemap.dev/lib/1.1.0/strict.js" integrity="${S100}" crossorigin="anonymous"></script>`,
    releases,
    HOSTS,
  );
  assert.equal(mismatch?.proposed?.version, "1.1.0");
  assert.equal(
    mismatch?.proposed?.src,
    "https://e2.usagemap.dev/lib/1.1.0/strict.js",
    "host is kept",
  );
  const [old] = scanText(
    "x",
    `<script src="https://e1.usagemap.dev/lib/1.0.0/standard.js"></script>`,
    releases,
    HOSTS,
  );
  assert.equal(old?.proposed?.version, "1.1.0", "an unpinned old tag moves to the newest release");
  const [keep] = scanText(
    "x",
    `<script src="https://e1.usagemap.dev/lib/1.0.0/standard.js"></script>`,
    releases,
    HOSTS,
    { upgrade: false },
  );
  assert.equal(keep?.proposed?.version, "1.0.0", "upgrade=false keeps an active version");
  assert.equal(keep?.proposed?.integrity, S100);
  const [noUp] = scanText(
    "x",
    `<script src="https://e1.usagemap.dev/lib/1.0.0/standard.js" integrity="${S100}" crossorigin="anonymous"></script>`,
    releases,
    HOSTS,
    { upgrade: false },
  );
  assert.equal(noUp?.severity, "warning");
  assert.equal(noUp?.proposed, null, "upgrade=false proposes nothing for a correct old pin");
  const [wd] = scanText(
    "x",
    `<script src="https://e1.usagemap.dev/lib/1.0.1/standard.js" integrity="${S110}" crossorigin="anonymous"></script>`,
    releases,
    HOSTS,
  );
  assert.equal(wd?.proposed?.version, "1.1.0");
  assert.equal(wd?.proposed?.integrity, S110);
});

test("fixTag edits only src, integrity and crossorigin", () => {
  const p = { src: "https://e1.usagemap.dev/lib/1.1.0/standard.js", integrity: S110 };
  assert.equal(
    fixTag('<script src="https://e1.usagemap.dev/lib/1.0.0/standard.js" data-site="k" defer>', p),
    `<script src="${p.src}" integrity="${S110}" crossorigin="anonymous" data-site="k" defer>`,
  );
  assert.equal(
    fixTag(
      `<script src='https://e1.usagemap.dev/lib/1.0.0/standard.js' integrity='x' crossorigin='use-credentials'>`,
      p,
    ),
    `<script src='${p.src}' integrity='${S110}' crossorigin='anonymous'>`,
  );
  assert.equal(
    fixTag(
      '<Script src={"https://e1.usagemap.dev/lib/1.0.0/standard.js"} strategy="afterInteractive" />',
      p,
    ),
    `<Script src={"${p.src}"} integrity="${S110}" crossOrigin="anonymous" strategy="afterInteractive" />`,
  );
  // idempotent on a fixed tag
  const fixed = fixTag('<script src="a" data-site="k">', p);
  assert.equal(fixTag(fixed, p), fixed);
});

test("unifiedDiff: hunks, context and missing final newline", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n";
  const after = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\n";
  const d = unifiedDiff("p.txt", before, after);
  assert.equal(
    d,
    "diff --git a/p.txt b/p.txt\n--- a/p.txt\n+++ b/p.txt\n" +
      "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n" +
      "@@ -8,4 +8,4 @@\n h\n i\n j\n-k\n+K\n",
  );
  const nl = unifiedDiff("q", "x\ny", "x\nY");
  assert.equal(
    nl,
    "diff --git a/q b/q\n--- a/q\n+++ b/q\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+Y\n\\ No newline at end of file\n",
  );
  assert.equal(unifiedDiff("r", "same\n", "same\n"), "");
});

test("fixText then scanText is a fixpoint", () => {
  const html = readFileSync(join(here, "../testdata/repos/broken/pages/unpinned.html"), "utf8");
  const fs = scanText("u", html, releases, HOSTS);
  assert.equal(fs.length, 2);
  const fixed = fixText(html, fs);
  const again = scanText("u", fixed, releases, HOSTS);
  assert.deepEqual(
    again.map((f) => f?.severity),
    ["ok", "ok"],
  );
});
