// SPDX-License-Identifier: Apache-2.0
// SLO verdict with the 95 % coverage floor (slo.ingest-availability, slo.dashboard-availability). Unit cases on generated verdicts, plus one end-to-end
// case that writes a raw probe store, runs the real `scf-ops slo-report` (Go, ops/cmd/scf-ops) and judges its
// verdicts.csv — so the two tools cannot drift apart on the file format. Run: tools/support/run selftest

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import {
  checkSums,
  evaluate,
  HEADLINES,
  main,
  markdown,
  parseCSV,
  parseVerdicts,
  type Verdict,
} from "../slo-report.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

const FEB = Date.UTC(2026, 1, 1); // 28 days: 80,640 rounds, 8,064 windows
const ROUNDS = 80_640;
const WINDOWS = 8_064;
const INGEST = HEADLINES[0]?.series as string;
const DASH = HEADLINES[1]?.series as string;

/** Verdicts for a month: `n` slots from the start, the first `bad` of them bad, every `unknownEvery`-th unknown. */
function series(
  name: string,
  kind: string,
  target: string,
  slotS: number,
  n: number,
  bad = 0,
  unknownEvery = 0,
): Verdict[] {
  return Array.from({ length: n }, (_, i) => ({
    series: name,
    kind,
    target,
    start: FEB + i * slotS * 1000,
    result: i < bad ? "bad" : unknownEvery && i % unknownEvery === 0 ? "unknown" : "good",
  }));
}

describe("coverage floor", () => {
  test("a fully measured month with 0.4 % bad rounds meets the lean objective (99.5 %)", () => {
    const r = evaluate(series(INGEST, "round", "ingest", 30, ROUNDS, 322), "2026-02", "lean").find(
      (x) => x.series === INGEST,
    );
    assert.equal(r?.status, "met");
    assert.equal(r?.coverage, 1);
  });
  test("the same month misses the scale-out objective (99.99 %)", () => {
    const rows = evaluate(
      series(INGEST, "round", "ingest", 30, ROUNDS, 322),
      "2026-02",
      "scale-out",
    );
    assert.equal(rows.find((r) => r.series === INGEST)?.status, "missed");
  });
  test("94.9 % of the month measured is NOT MEASURED, even when every measured round was good", () => {
    const n = Math.floor(ROUNDS * 0.949);
    const r = evaluate(series(INGEST, "round", "ingest", 30, n), "2026-02", "lean").find(
      (x) => x.series === INGEST,
    );
    assert.equal(r?.availability, 1);
    assert.equal(r?.status, "not measured");
    assert.equal(r?.missing, ROUNDS - n);
  });
  test("exactly 95 % measured is judged", () => {
    const n = Math.ceil(ROUNDS * 0.95);
    const r = evaluate(series(INGEST, "round", "ingest", 30, n), "2026-02", "lean").find(
      (x) => x.series === INGEST,
    );
    assert.equal(r?.status, "met");
  });
  test("unknown rounds (fewer than two sources voted) are not measured", () => {
    // every 10th of all rounds unknown → 90 % coverage
    const r = evaluate(
      series(INGEST, "round", "ingest", 30, ROUNDS, 0, 10),
      "2026-02",
      "lean",
    ).find((x) => x.series === INGEST);
    assert.equal(r?.unknown, ROUNDS / 10);
    assert.ok(Math.abs((r?.coverage ?? 0) - 0.9) < 1e-9);
    assert.equal(r?.status, "not measured");
  });
  test("dashboard windows are 5 minutes; a headline with no verdict at all is reported as not measured", () => {
    const rows = evaluate(series(INGEST, "round", "ingest", 30, ROUNDS), "2026-02", "lean");
    const d = rows.find((x) => x.series === DASH);
    assert.equal(d?.slots, WINDOWS);
    assert.equal(d?.slotSeconds, 300);
    assert.equal(d?.status, "not measured");
    assert.equal(d?.availability, null);
  });
  test("figures without an objective keep their coverage", () => {
    const rows = evaluate(
      [
        ...series(INGEST, "round", "ingest", 30, ROUNDS),
        ...series(
          "Ingest hostname host-a (first attempt, no retry)",
          "host",
          "host-a",
          30,
          ROUNDS / 2,
        ),
      ],
      "2026-02",
      "lean",
    );
    const h = rows.find((x) => x.kind === "host");
    assert.equal(h?.objective, null);
    assert.equal(h?.status, "not measured");
  });
  test("the Markdown states the floor and marks unmeasured figures", () => {
    const rows = evaluate(series(INGEST, "round", "ingest", 30, 1000), "2026-02", "lean");
    const md = markdown("2026-02", "lean", 0.95, rows, "verified");
    assert.match(md, /Coverage floor 95 %/);
    assert.match(md, /\*\*not measured\*\*/);
    assert.match(md, /never as met/);
  });
});

describe("input integrity", () => {
  const head = "series,kind,target,start_utc,voters,bad_votes,result\n";
  test("quoted series names with commas parse", () => {
    assert.deepEqual(parseCSV('a,"b, c ""q""",d\n'), [["a", 'b, c "q"', "d"]]);
  });
  test("refuses a wrong header, unknown kind or result, rows outside the month, unaligned or duplicate slots", () => {
    assert.throws(() => parseVerdicts("x\n", "2026-02"), /header/);
    assert.throws(
      () => parseVerdicts(`${head}s,weird,t,2026-02-01T00:00:00Z,2,0,good\n`, "2026-02"),
      /unknown kind/,
    );
    assert.throws(
      () => parseVerdicts(`${head}s,round,ingest,2026-02-01T00:00:00Z,2,0,fine\n`, "2026-02"),
      /unknown result/,
    );
    assert.throws(
      () => parseVerdicts(`${head}s,round,ingest,2026-03-01T00:00:00Z,2,0,good\n`, "2026-02"),
      /outside/,
    );
    assert.throws(
      () => parseVerdicts(`${head}s,round,ingest,2026-02-01T00:00:10Z,2,0,good\n`, "2026-02"),
      /aligned/,
    );
    assert.throws(
      () =>
        parseVerdicts(
          `${head}s,round,ingest,2026-02-01T00:00:00Z,2,0,good\ns,round,ingest,2026-02-01T00:00:00Z,2,0,bad\n`,
          "2026-02",
        ),
      /twice/,
    );
  });
  test("a verdicts.csv that does not match the generator's SHA256SUMS is refused", () => {
    const d = tmp("slo-sums-");
    const body = `${head}s,round,ingest,2026-02-01T00:00:00Z,2,0,good\n`;
    writeFileSync(join(d, "verdicts.csv"), body);
    const h = createHash("sha256").update(body).digest("hex");
    writeFileSync(join(d, "SHA256SUMS"), `${h}  verdicts.csv\n`);
    assert.equal(checkSums(join(d, "verdicts.csv")), "verified");
    writeFileSync(join(d, "verdicts.csv"), body.replace("good", "bad"));
    assert.throws(() => checkSums(join(d, "verdicts.csv")), /sha256/);
  });
});

describe("end to end with scf-ops slo-report (Go)", () => {
  test("a raw store with a 2-day prober outage is judged NOT MEASURED; the full store is judged met", async () => {
    // Two probe sources (mon-c, probe-d) over February 2026: ingest rounds every 30 s, a journey every 60 s.
    // Store A: complete, 30 minutes of bad rounds (60 rounds) and one bad 5-minute window. Store B: the same with
    // both sources silent for 2 days (7.1 % of the month → coverage 92.9 %).
    const make = (gapDays: number): string => {
      const dir = tmp("slo-store-");
      const gapFrom = FEB + 10 * 86_400_000;
      const gapTo = gapFrom + gapDays * 86_400_000;
      for (const src of ["mon-c", "probe-d"]) {
        mkdirSync(join(dir, src));
        for (let day = 0; day < 28; day++) {
          const lines = ["round_start_utc,source,kind,target,outcome,status,latency_ms"];
          for (let s = 0; s < 86_400; s += 30) {
            const t = FEB + day * 86_400_000 + s * 1000;
            if (t >= gapFrom && t < gapTo) continue;
            const iso = new Date(t).toISOString().replace(".000Z", "Z");
            const badRound = day === 3 && s >= 3600 && s < 3600 + 1800;
            lines.push(`${iso},${src},round,ingest,${badRound ? "bad,503,2001" : "good,202,120"}`);
            if (s % 60 === 0) {
              const badJourney = day === 5 && s >= 7200 && s < 7200 + 300;
              lines.push(
                `${iso},${src},journey,dashboard,${badJourney ? "bad,500,3100" : "good,200,800"}`,
              );
            }
          }
          const date = new Date(FEB + day * 86_400_000).toISOString().slice(0, 10);
          writeFileSync(join(dir, src, `${date}.csv`), `${lines.join("\n")}\n`);
        }
      }
      return dir;
    };
    type Out = {
      md: string;
      json: { series: { series: string; status: string; coverage: number; bad: number }[] };
    };
    const run = async (store: string): Promise<Out> => {
      const out = tmp("slo-out-");
      execFileSync(
        "go",
        ["run", "./cmd/scf-ops", "slo-report", "-store", store, "-month", "2026-02", "-out", out],
        { cwd: join(ROOT, "ops"), stdio: "pipe" },
      );
      const res = join(out, "verdict");
      const rc = await main([
        "--month=2026-02",
        `--verdicts=${join(out, "2026-02", "verdicts.csv")}`,
        "--profile=lean",
        `--out=${res}`,
      ]);
      assert.equal(rc, 0);
      return {
        md: readFileSync(join(res, "slo-verdict-2026-02.md"), "utf8"),
        json: JSON.parse(readFileSync(join(res, "slo-verdict-2026-02.json"), "utf8")),
      };
    };
    const full = await run(make(0));
    const ing = full.json.series.find((s) => s.series === INGEST);
    const dash = full.json.series.find((s) => s.series === DASH);
    assert.equal(ing?.status, "met");
    assert.equal(ing?.coverage, 1);
    assert.equal(ing?.bad, 60);
    assert.equal(dash?.status, "met");
    assert.equal(dash?.bad, 1);
    assert.match(full.md, /integrity: verified/);
    const gap = await run(make(2));
    const ing2 = gap.json.series.find((s) => s.series === INGEST);
    assert.equal(ing2?.status, "not measured");
    assert.ok(Math.abs((ing2?.coverage ?? 0) - 26 / 28) < 1e-9);
    assert.equal(gap.json.series.find((s) => s.series === DASH)?.status, "not measured");
  });
});
