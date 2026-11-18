// SPDX-License-Identifier: Apache-2.0
// Adoption report (live proof of adoption) on recorded operator-API answers: fixtures/local-stack.json was
// recorded from a real local stack by tools/forge/test/stack-e2e.ts --record-adoption (real API shapes, no SCF-awarded
// projects, so the adoption threshold is not met); fixtures/programme.json has the same shapes with three SCF-awarded web
// projects and one API project (threshold met), and small counts for the floor. Run: tools/adoption-report/run selftest

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { ApiClient } from "../../mcp/src/api.ts";
import { buildReport, fixtureFetch, floored, publicJson, renderMarkdown } from "../report.ts";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const REPORT = join(HERE, "..", "report.ts");
const load = (f: string) =>
  JSON.parse(readFileSync(join(HERE, "fixtures", f), "utf8")) as Record<string, unknown>;

function rangeOf(fx: Record<string, unknown>): { start: string; end: string } {
  const k = Object.keys(fx).find((x) => x.startsWith("/op/v1/web/daily?")) as string;
  const q = new URLSearchParams(k.split("?")[1]);
  return { start: (q.get("start") ?? "").slice(0, 10), end: (q.get("end") ?? "").slice(0, 10) };
}

async function report(f: string, floor = 10) {
  const fx = load(f);
  const api = new ApiClient({
    baseUrl: "https://app.usagemap.dev",
    key: "unused",
    fetch: fixtureFetch(fx),
  });
  return buildReport(api, {
    ...rangeOf(fx),
    floor,
    operatorViewUrl: "https://app.usagemap.dev/operator",
    now: new Date("2026-11-19T08:00:00Z"),
  });
}

describe("adoption report", () => {
  test("recorded local stack: projects listed, API instrumentation found, threshold honestly not met", async () => {
    const r = await report("local-stack.json");
    assert.ok(r.projects.length >= 1);
    assert.equal(
      r.threshold.scf_awarded_web.met,
      false,
      "a test stack has no SCF-awarded projects",
    );
    assert.ok(r.threshold.api.found >= 1, "the forge run sent API traffic");
    assert.equal(r.threshold.met, false);
    const forge = r.projects.find((p) => p.slug.startsWith("rvt-forge-") && p.web.instrumented);
    assert.ok(forge, "the forge run's real browser visit is a verified page view in the rollup");
    assert.equal(forge.web.verified_pageviews, 1);
    assert.deepEqual([forge.web.first_day, forge.api.first_day], ["2026-11-18", "2026-11-18"]);
    assert.ok(forge.api.instrumented && forge.api.active_days === 1);
    const load = r.projects.find((p) => p.slug.startsWith("rvt-ceil") && p.web.raw_pageviews > 0);
    assert.equal(
      load?.web.instrumented,
      false,
      "scripted load traffic is raw (suspect), never verified",
    );
    const md = renderMarkdown(r);
    assert.match(
      md,
      new RegExp(
        `\\(\`${forge.slug}\`\\) \\| unknown \\| L0 \\| yes \\| 2026-11-18 … 2026-11-18, 1 \\| < 10 \\|`,
      ),
    );
    assert.ok(r.notes.some((n) => /self-attested/.test(n)));
  });

  test("programme fixture: three SCF-awarded web projects and one API project meet the threshold", async () => {
    const r = await report("programme.json");
    assert.deepEqual(r.threshold.scf_awarded_web.slugs.sort(), [
      "anchor-one",
      "dex-two",
      "wallet-three",
    ]);
    assert.deepEqual(r.threshold.api.slugs, ["anchor-one"]);
    assert.equal(r.threshold.met, true);
    const unawarded = r.projects.find((p) => p.slug === "hobby-four");
    assert.equal(unawarded?.web.instrumented, true);
    assert.ok(
      !r.threshold.scf_awarded_web.slugs.includes("hobby-four"),
      "web traffic without an award does not count",
    );
    const dex = r.projects.find((p) => p.slug === "dex-two");
    assert.deepEqual(
      [dex?.web.first_day, dex?.web.last_day, dex?.web.active_days],
      ["2026-11-02", "2026-11-03", 2],
    );
    assert.equal(
      r.projects.find((p) => p.slug === "suspended-five"),
      undefined,
      "suspended projects are left out",
    );
  });

  test("small-count floor: exact counts below the floor never leave in Markdown or JSON", async () => {
    const r = await report("programme.json");
    const md = renderMarkdown(r);
    const js = JSON.stringify(publicJson(r));
    const wallet = r.projects.find((p) => p.slug === "wallet-three");
    assert.equal(wallet?.web.verified_pageviews, 7);
    assert.match(md, /\| < 10 \|/);
    assert.ok(!/"verified_pageviews":7\b/.test(js));
    assert.match(js, /"verified_pageviews":"< 10"/);
    assert.equal(floored(0, 10), "0");
    assert.equal(floored(9, 10), "< 10");
    assert.equal(floored(12345, 10), "12,345");
    assert.match(md, /Live global operator view: https:\/\/app\.usagemap\.dev\/operator/);
    assert.match(md, /\| SCF-awarded projects instrumented for web analytics \| 3 \| 3 \| yes \|/);
  });

  test("CLI on fixtures: exit 0 when met, 1 when not, Markdown on stdout; no key needed for fixtures", async () => {
    const met = await run(process.execPath, [
      REPORT,
      "--fixtures",
      join(HERE, "fixtures/programme.json"),
      ...rangeArgs("programme.json"),
    ]);
    assert.match(met.stdout, /^# Adoption evidence/);
    await assert.rejects(
      run(process.execPath, [
        REPORT,
        "--fixtures",
        join(HERE, "fixtures/local-stack.json"),
        ...rangeArgs("local-stack.json"),
        "--json",
      ]),
      (e: { code: number; stdout: string }) =>
        e.code === 1 && JSON.parse(e.stdout).threshold.met === false,
    );
  });

  test("CLI without a key file fails with exit 2 and never echoes a key", async () => {
    await assert.rejects(
      run(process.execPath, [REPORT, "--api", "http://127.0.0.1:9"], {
        env: { PATH: process.env.PATH ?? "" },
      }),
      (e: { code: number; stderr: string }) => e.code === 2 && /no op key given/.test(e.stderr),
    );
  });
});

function rangeArgs(f: string): string[] {
  const r = rangeOf(load(f));
  return ["--start", r.start, "--end", r.end];
}
