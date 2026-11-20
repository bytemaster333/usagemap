// SPDX-License-Identifier: Apache-2.0
// Drift tests: every tracker fact on the page (version, sizes, SRI, URL) is the one of the release files, recomputed
// here from the bytes; a manifest that disagrees with its files, or is missing, fails the build.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configFromEnv, REPO_ROOT } from "../src/config.ts";
import {
  checkReleaseHosts,
  loadFacts,
  loadTrackerFacts,
  loadUmamiPin,
  trackerPackageVersion,
} from "../src/facts.ts";
import {
  buildFor,
  RELEASED_VERSION,
  RELEASES,
  releaseCopy,
  SITE_KEY,
  tags,
  testConfig,
} from "./helpers.ts";

const sri = (file: string): string =>
  `sha384-${createHash("sha384").update(readFileSync(file)).digest("base64")}`;

/** Independent check of one build directory against the facts loaded from it. */
function assertMatchesFiles(dist: string, version: string): void {
  const f = loadTrackerFacts(dist, version);
  assert.equal(f.version, version);
  for (const profile of ["standard", "strict"] as const) {
    const file = join(dist, version, `${profile}.js`);
    assert.equal(f.files[profile].integrity, sri(file), `${profile} SRI`);
    assert.equal(f.files[profile].bytes, readFileSync(file).byteLength, `${profile} bytes`);
    assert.equal(f.files[profile].url, `${f.hosts[0]}/lib/${version}/${profile}.js`);
    assert.ok(
      f.files[profile].gzipBytes <= f.budgetsGzipBytes[profile],
      `${profile} within budget`,
    );
  }
}

describe("tracker facts come from the release files", () => {
  it("match the committed release archive byte for byte", () => {
    assertMatchesFiles(RELEASES, RELEASED_VERSION);
  });

  it("match the current tracker build when there is one", (t) => {
    const dist = join(REPO_ROOT, "tracker", "dist");
    const v = trackerPackageVersion();
    if (!existsSync(join(dist, v, "manifest.json"))) {
      t.skip(`tracker/dist/${v} not built`);
      return;
    }
    assertMatchesFiles(dist, v);
  });

  it("fail when the manifest is missing", () => {
    const dir = releaseCopy();
    rmSync(join(dir, RELEASED_VERSION, "manifest.json"));
    assert.throws(() => loadTrackerFacts(dir, RELEASED_VERSION), /manifest\.json is missing/);
  });

  it("fail when the version directory does not exist", () => {
    assert.throws(() => loadTrackerFacts(RELEASES, "9.9.9"), /is missing/);
  });

  it("fail when a tracker file changed after its manifest was written", () => {
    const dir = releaseCopy();
    const file = join(dir, RELEASED_VERSION, "strict.js");
    const code = readFileSync(file, "utf8");
    writeFileSync(file, code.replace("strict", "strixt"));
    assert.throws(() => loadTrackerFacts(dir, RELEASED_VERSION), /differs from its manifest/);
  });

  it("fail when the manifest's SRI or size is edited", () => {
    for (const edit of [
      (m: { files: { integrity: string; sha384: string }[] }) => {
        (m.files[0] as { sha384: string }).sha384 = "A".repeat(64);
      },
      (m: { files: { bytes: number }[] }) => {
        (m.files[1] as { bytes: number }).bytes += 1;
      },
    ]) {
      const dir = releaseCopy();
      const p = join(dir, RELEASED_VERSION, "manifest.json");
      const m = JSON.parse(readFileSync(p, "utf8"));
      edit(m);
      writeFileSync(p, JSON.stringify(m));
      assert.throws(() => loadTrackerFacts(dir, RELEASED_VERSION), /differs from its manifest/);
    }
  });

  it("fail when the manifest is for another version", () => {
    const dir = releaseCopy();
    const p = join(dir, RELEASED_VERSION, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.version = "1.0.1";
    writeFileSync(p, JSON.stringify(m));
    assert.throws(() => loadTrackerFacts(dir, RELEASED_VERSION), /not 1\.0\.0/);
  });

  it("take the Umami version and commit from the pin", () => {
    const upstream = readFileSync(join(REPO_ROOT, "vendor", "umami", "UPSTREAM"), "utf8");
    const pin = loadUmamiPin();
    assert.ok(upstream.includes(`UMAMI_VERSION=${pin.version}\n`));
    assert.ok(upstream.includes(`UMAMI_COMMIT=${pin.commit}\n`));
  });
});

describe("the built page states exactly those facts", () => {
  const r = buildFor();
  const html = r.html;
  const facts = loadFacts(RELEASES, RELEASED_VERSION).tracker;
  const all = tags(html);

  it("loads its own tracker: strict profile, pinned URL and SRI of the release file", () => {
    const scripts = all.filter(
      (t) => t.name === "script" && !t.close && t.attrs.get("src")?.includes("/lib/"),
    );
    assert.equal(scripts.length, 1);
    const s = scripts[0]?.attrs;
    const file = join(RELEASES, RELEASED_VERSION, "strict.js");
    assert.equal(s?.get("src"), `${facts.hosts[0]}/lib/${RELEASED_VERSION}/strict.js`);
    assert.equal(s?.get("integrity"), sri(file));
    assert.equal(s?.get("crossorigin"), "anonymous");
    assert.equal(s?.get("data-site"), SITE_KEY);
    assert.ok(s?.has("defer"));
  });

  it("carries no SRI hash and no tracker version other than the pinned release and its own assets", () => {
    const hashes = new Set(html.match(/sha384-[A-Za-z0-9+/=]{64}/g));
    const own = all
      .filter(
        (t) =>
          !t.close && (t.attrs.get("src") ?? t.attrs.get("href") ?? "").startsWith("/assets/site."),
      )
      .map((t) => t.attrs.get("integrity"));
    assert.equal(own.length, 2);
    assert.deepEqual([...hashes].sort(), [facts.files.strict.integrity, ...own].sort());
    for (const m of html.matchAll(/\/lib\/([0-9.]+)\//g)) assert.equal(m[1], RELEASED_VERSION);
  });

  it("writes facts.json with the same values", () => {
    const fj = JSON.parse(readFileSync(join(r.outDir, "facts.json"), "utf8"));
    assert.deepEqual(fj.tracker.files, facts.files);
    assert.equal(fj.tracker.version, RELEASED_VERSION);
    assert.equal(fj.dogfood, true);
  });
});

describe("build configuration", () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
  const opts = { release: false, defaultTrackerVersion: "1.1.0" };

  it("rejects a malformed site key", () => {
    assert.throws(() => configFromEnv(env({ LANDING_SITE_KEY: "short" }), opts), /22-character/);
  });

  it("requires the site key for a release build", () => {
    assert.throws(() => configFromEnv(env({}), { ...opts, release: true }), /LANDING_SITE_KEY/);
  });

  it("keeps a demo link on usagemap.dev", () => {
    assert.throws(
      () => configFromEnv(env({ LANDING_DEMO_URL: "https://example.com/" }), opts),
      /usagemap\.dev/,
    );
    const c = configFromEnv(env({ LANDING_DEMO_URL: "https://app.usagemap.dev/p/demo-x" }), opts);
    assert.equal(c.demoUrl, "https://app.usagemap.dev/p/demo-x");
  });

  it("refuses a release build of a tracker that does not talk to e1/e2.usagemap.dev", () => {
    const f = loadFacts(RELEASES, RELEASED_VERSION);
    assert.throws(() => checkReleaseHosts(f), /TRACKER_HOSTS=https:\/\/e1\.usagemap\.dev/);
    assert.throws(() => buildFor({ release: true }), /release build/);
    const prod = {
      ...f,
      tracker: {
        ...f.tracker,
        hosts: ["https://e1.usagemap.dev", "https://e2.usagemap.dev"] as const,
      },
    };
    assert.doesNotThrow(() => checkReleaseHosts(prod));
  });

  it("without a site key the page has no tracker and says so", () => {
    const r = buildFor({ siteKey: undefined });
    assert.ok(!r.html.includes("/lib/"), "no tracker script");
    assert.ok(!r.html.includes("data-site="));
    assert.ok(r.html.includes("LANDING_SITE_KEY was not set"));
    assert.ok(r.html.includes("script-src &#39;self&#39;;"));
    assert.equal(testConfig().siteKey, SITE_KEY);
  });
});
