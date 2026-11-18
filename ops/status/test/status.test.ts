// SPDX-License-Identifier: Apache-2.0
// External status checks (core plan C1 item 5; slo.ingest-availability, slo.dashboard-availability): the generated Gatus and Upptime files are current,
// their thresholds and objectives equal docs/sla.md and the SLO tool, every checked route exists, and there are at
// least two vantage points outside the application host. The pinned Gatus binary itself is exercised by
// test/gatus-it.sh. Run: node --test ops/status/test/*.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { COVERAGE_FLOOR, PROFILES } from "../../../tools/support/slo-report.ts";
import { checks, gatus, loadSli, outputs, upptime } from "../generate.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const sli = loadSli();
// docs/sla.md with block quotes and line breaks folded, so a sentence can be matched across lines.
const sla = read("docs/sla.md").replace(/^> ?/gm, "").replace(/\s+/g, " ");

describe("generated files", () => {
  test("gatus/config.yaml and upptime/.upptimerc.yml equal what sli.json generates", () => {
    for (const [f, body] of Object.entries(outputs()))
      assert.equal(readFileSync(f, "utf8"), body, f);
  });
  test("every check appears in both tools with its threshold", () => {
    const g = gatus(sli);
    const u = upptime(sli);
    for (const c of checks(sli)) {
      assert.ok(g.includes(`url: "\${${c.env}}${c.path}"`), `gatus ${c.id}`);
      assert.ok(g.includes(`[RESPONSE_TIME] < ${c.maxMs}`), `gatus ${c.id} threshold`);
      assert.ok(u.includes(`url: $${c.env}${c.path}`), `upptime ${c.id}`);
      assert.ok(!c.path.includes("?"), "no query strings in checked URLs");
    }
  });
});

describe("SLI definitions match docs/sla.md and the SLO tool", () => {
  test("ingest: accepted within 2 seconds on one of the two ingest hostnames", () => {
    assert.match(
      sla,
      /at least one of the two ingest hostnames accepts the event \(2xx after durable persistence\) within 2 seconds/,
    );
    assert.equal(sli.ingest.maxResponseMs, 2000);
    assert.equal(sli.ingest.hosts.length, 2);
  });
  test("dashboard: a step slower than 3 s fails the journey", () => {
    assert.match(sla, /a single step takes longer than 3 s/);
    assert.equal(sli.dashboard.maxStepMs, 3000);
  });
  test("objectives per profile (docs/sla.md §1.1) and the coverage floor equal the SLO tool's", () => {
    // §1.1 columns: v1 host | lean profile (full size) | scale-out profile; since C-180 the scale-out
    // column is the commitment at the published targets.
    assert.match(
      sla,
      /\| Ingest availability \| \*\*objective 99\.5 %\*\* per month[^|\n]*\| objective 99\.5 % \| \*\*commitment 99\.99 %\*\* /,
    );
    assert.match(
      sla,
      /\| Dashboard availability \| \*\*objective 99\.5 %\*\* per month[^|\n]*\| objective 99\.5 % \| \*\*commitment 99\.90 %\*\* /,
    );
    assert.deepEqual(sli.objectives, JSON.parse(JSON.stringify(PROFILES)));
    assert.deepEqual(sli.objectives.lean, { ingest: 0.995, dashboard: 0.995 });
    assert.equal(sli.coverageFloor, COVERAGE_FLOOR);
  });
});

describe("routes and placement", () => {
  test("every checked route exists in the code that serves it", () => {
    assert.match(
      read("services/gateway/internal/ingest/http.go"),
      /mux\.HandleFunc\("GET \/healthz"/,
    );
    assert.match(read("apps/portal/server/Caddyfile"), /handle \/portal-healthz \{/);
    assert.match(read("apps/portal/server/Caddyfile"), /@api path [^\n]*\/public\/\*/);
    const api = read("docs/api/control-plane.openapi.yaml");
    assert.match(api, /^ {2}\/public\/v1\/health:$/m);
    assert.match(api, /- dashboards\n/);
  });
  test("at least two vantage points outside the application host, at the tools' real cadence", () => {
    const outside = sli.vantagePoints.filter((v) => v.tool === "gatus" || v.tool === "upptime");
    assert.ok(outside.length >= 2);
    assert.equal(new Set(outside.map((v) => v.id)).size, outside.length);
    assert.equal(
      outside.find((v) => v.tool === "upptime")?.intervalSeconds,
      300,
      "GitHub cron minimum",
    );
    assert.equal(outside.find((v) => v.tool === "gatus")?.intervalSeconds, 30, "the probe round");
  });
  test("the Gatus vantage point runs the pinned image, hardened, UI on loopback only", () => {
    const c = read("ops/status/gatus/compose.yaml");
    assert.match(c, /image: twinproduction\/gatus:v5\.38\.0@sha256:[0-9a-f]{64}/);
    assert.match(c, /read_only: true/);
    assert.match(c, /cap_drop: \[ALL\]/);
    assert.match(c, /no-new-privileges:true/);
    assert.match(c, /ports: \["127\.0\.0\.1:/);
  });
});
