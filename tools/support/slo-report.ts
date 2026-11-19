// SPDX-License-Identifier: Apache-2.0
// Monthly SLO verdict with the 95 % coverage floor (availability; slo.ingest-availability, slo.dashboard-availability; docs/sla.md §1,
// §1.1, §2.2, §7; ADR-0031).
//
//   node tools/support/slo-report.ts --month=2026-11 --verdicts=DIR/2026-11/verdicts.csv [--profile=lean|scale-out]
//                                    [--floor=0.95] [--out=DIR]
//
// Input: the `verdicts.csv` that `scf-ops slo-report` writes next to the month's report (one row per judged probe
// round or journey window: series, kind, target, start_utc, voters, bad_votes, result good|bad|unknown). When the
// month directory holds the generator's SHA256SUMS, the file's hash must match it, or the report is refused.
//
// The rule this file adds (the coverage floor): a month's objective is judged only when the month was measured.
//   coverage     = measured slots ÷ slots in the calendar month
//   measured     = slots with a `good` or `bad` verdict; `unknown` (too few probe sources voted, C-78) and slots
//                  with no verdict at all (prober down, data lost) are NOT measured
//   availability = good ÷ (good + bad)
//   status       = "not measured" when coverage < floor (default 95 %); otherwise "met" when availability ≥ the
//                  objective, else "missed"
// A month that was not measured is never reported as met: an outage of the measurement must not read as an
// available service. Slot length: 30 s for probe rounds (kinds round, host, node, otlp), 5 min for dashboard
// journey windows (kind journey) — the same slots `scf-ops slo-report` judges (ops/internal/quorum).
// Objectives by deployment profile (docs/sla.md §1.1, C-123): lean 99.5 % ingest and 99.5 % dashboard; scale-out
// 99.99 % ingest and 99.9 % dashboard. Per-hostname, per-node and OTLP figures have no objective of their own and are
// published with their coverage.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { monthRange } from "./support-report.ts";

export const COVERAGE_FLOOR = 0.95;
export const PROFILES = {
  lean: { ingest: 0.995, dashboard: 0.995 },
  "scale-out": { ingest: 0.9999, dashboard: 0.999 },
} as const;
export type Profile = keyof typeof PROFILES;
export const SLOT_SECONDS: Record<string, number> = {
  round: 30,
  host: 30,
  node: 30,
  otlp: 30,
  journey: 300,
};

export interface Verdict {
  series: string;
  kind: string;
  target: string;
  start: number;
  result: "good" | "bad" | "unknown";
}

export type Status = "met" | "missed" | "not measured" | "no objective";

export interface SeriesResult {
  series: string;
  kind: string;
  target: string;
  objective: number | null;
  slotSeconds: number;
  slots: number;
  good: number;
  bad: number;
  unknown: number;
  missing: number;
  coverage: number;
  availability: number | null;
  status: Status;
}

/** Minimal RFC 4180 reader (quoted fields, doubled quotes); the generator writes series names with commas quoted. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  if (q) throw new Error("verdicts.csv: unterminated quoted field");
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

const HEADER = ["series", "kind", "target", "start_utc", "voters", "bad_votes", "result"];

export function parseVerdicts(text: string, month: string): Verdict[] {
  const rows = parseCSV(text);
  const head = rows.shift();
  if (!head || head.join(",") !== HEADER.join(","))
    throw new Error(`verdicts.csv: header must be ${HEADER.join(",")}`);
  const [from, to] = monthRange(month);
  const seen = new Set<string>();
  return rows.map((r, i) => {
    const line = i + 2;
    if (r.length !== HEADER.length)
      throw new Error(`verdicts.csv line ${line}: ${r.length} fields`);
    const [series, kind, target, startS, , , result] = r as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const slot = SLOT_SECONDS[kind];
    if (!slot) throw new Error(`verdicts.csv line ${line}: unknown kind ${JSON.stringify(kind)}`);
    if (result !== "good" && result !== "bad" && result !== "unknown")
      throw new Error(`verdicts.csv line ${line}: unknown result ${JSON.stringify(result)}`);
    const start = Date.parse(startS);
    if (Number.isNaN(start)) throw new Error(`verdicts.csv line ${line}: bad time ${startS}`);
    if (start < from || start >= to)
      throw new Error(`verdicts.csv line ${line}: ${startS} is outside ${month}`);
    if ((start - from) % (slot * 1000) !== 0)
      throw new Error(`verdicts.csv line ${line}: ${startS} is not aligned to a ${slot} s slot`);
    const key = `${series}\u0000${start}`;
    if (seen.has(key))
      throw new Error(`verdicts.csv line ${line}: slot ${startS} of "${series}" appears twice`);
    seen.add(key);
    return { series, kind, target, start, result };
  });
}

export function objectiveFor(kind: string, target: string, profile: Profile): number | null {
  if (kind === "round" && target === "ingest") return PROFILES[profile].ingest;
  if (kind === "journey" && target === "dashboard") return PROFILES[profile].dashboard;
  return null;
}

export function evaluate(
  verdicts: Verdict[],
  month: string,
  profile: Profile,
  floor = COVERAGE_FLOOR,
  required: { kind: string; target: string; series: string }[] = HEADLINES,
): SeriesResult[] {
  const [from, to] = monthRange(month);
  const groups = new Map<string, Verdict[]>();
  for (const v of verdicts) {
    const g = groups.get(v.series) ?? [];
    g.push(v);
    groups.set(v.series, g);
  }
  // A headline series with no verdict at all is still reported — as not measured, never silently absent.
  for (const r of required)
    if (![...groups.values()].some((g) => g[0]?.kind === r.kind && g[0]?.target === r.target))
      groups.set(r.series, []);
  const out: SeriesResult[] = [];
  for (const [series, vs] of groups) {
    const req = required.find((r) => r.series === series);
    const kind = vs[0]?.kind ?? req?.kind ?? "round";
    const target = vs[0]?.target ?? req?.target ?? "";
    if (vs.some((v) => v.kind !== kind || v.target !== target))
      throw new Error(`series "${series}" mixes kinds or targets`);
    const slotSeconds = SLOT_SECONDS[kind] as number;
    const slots = Math.round((to - from) / 1000 / slotSeconds);
    const good = vs.filter((v) => v.result === "good").length;
    const bad = vs.filter((v) => v.result === "bad").length;
    const unknown = vs.filter((v) => v.result === "unknown").length;
    const coverage = (good + bad) / slots;
    const availability = good + bad ? good / (good + bad) : null;
    const objective = objectiveFor(kind, target, profile);
    let status: Status;
    if (objective === null) status = coverage < floor ? "not measured" : "no objective";
    else if (coverage < floor || availability === null) status = "not measured";
    else status = availability >= objective ? "met" : "missed";
    out.push({
      series,
      kind,
      target,
      objective,
      slotSeconds,
      slots,
      good,
      bad,
      unknown,
      missing: slots - vs.length,
      coverage,
      availability,
      status,
    });
  }
  const rank = (r: SeriesResult): number => (r.objective === null ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || a.series.localeCompare(b.series));
}

export const HEADLINES = [
  { kind: "round", target: "ingest", series: "Ingest availability (probe rounds, headline)" },
  {
    kind: "journey",
    target: "dashboard",
    series: "Dashboard availability (signed-in journeys, 5-minute windows)",
  },
];

/** When the month directory holds the generator's SHA256SUMS, verdicts.csv must match its entry. */
export function checkSums(verdictsPath: string): "verified" | "no SHA256SUMS" {
  const sums = join(dirname(verdictsPath), "SHA256SUMS");
  if (!existsSync(sums)) return "no SHA256SUMS";
  const want = readFileSync(sums, "utf8")
    .split("\n")
    .map((l) => /^([0-9a-f]{64}) {2}(.+)$/.exec(l))
    .find((m) => m && m[2] === basename(verdictsPath))?.[1];
  if (!want) throw new Error(`SHA256SUMS has no entry for ${basename(verdictsPath)}`);
  const got = createHash("sha256").update(readFileSync(verdictsPath)).digest("hex");
  if (got !== want)
    throw new Error(`${basename(verdictsPath)}: sha256 ${got} != SHA256SUMS ${want}`);
  return "verified";
}

const pct = (x: number | null, digits = 3): string =>
  x === null ? "—" : `${(x * 100).toFixed(digits)} %`;

export function markdown(
  month: string,
  profile: Profile,
  floor: number,
  rows: SeriesResult[],
  integrity: string,
): string {
  const L: string[] = [];
  L.push(`# SLO verdict ${month} (${profile} profile)`, "");
  L.push(
    `Generated by \`tools/support/slo-report.ts\` from \`verdicts.csv\` of \`scf-ops slo-report\` (integrity: ${integrity}). ` +
      `Objectives are objectives, not guarantees (C-78). **Coverage floor ${pct(floor, 0)}:** a month is judged only when at ` +
      "least that share of its slots was measured (a `good` or `bad` verdict); otherwise it is reported as **not measured**, never as met.",
    "",
  );
  L.push(
    "| Figure | Objective | Status | Availability | Coverage | Good | Bad | Unknown | No verdict | Slots | Slot |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of rows)
    L.push(
      `| ${r.series} | ${r.objective === null ? "—" : pct(r.objective, 2)} | ${r.status === "missed" || r.status === "not measured" ? `**${r.status}**` : r.status} | ${pct(r.availability)} | ${pct(r.coverage, 2)} | ${r.good} | ${r.bad} | ${r.unknown} | ${r.missing} | ${r.slots} | ${r.slotSeconds} s |`,
    );
  L.push("");
  const nm = rows.filter((r) => r.status === "not measured");
  if (nm.length)
    L.push(
      `Not measured: ${nm.map((r) => `${r.series} (${pct(r.coverage, 2)} covered)`).join("; ")}. The gap is explained in the month's report and, when it hides an outage, in a post-mortem.`,
      "",
    );
  return L.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const arg = (k: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const month = arg("month");
  const file = arg("verdicts");
  const profile = (arg("profile") ?? "lean") as Profile;
  const floor = Number(arg("floor") ?? COVERAGE_FLOOR);
  if (!month || !file || !(profile in PROFILES) || !(floor > 0 && floor <= 1)) {
    process.stderr.write(
      "usage: slo-report.ts --month=YYYY-MM --verdicts=FILE [--profile=lean|scale-out] [--floor=0.95] [--out=DIR]\n",
    );
    return 2;
  }
  const integrity = checkSums(file);
  const rows = evaluate(parseVerdicts(readFileSync(file, "utf8"), month), month, profile, floor);
  const md = markdown(month, profile, floor, rows, integrity);
  const out = arg("out");
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `slo-verdict-${month}.md`), `${md}\n`);
    writeFileSync(
      join(out, `slo-verdict-${month}.json`),
      `${JSON.stringify({ month, profile, floor, integrity, series: rows }, null, 2)}\n`,
    );
    process.stdout.write(`wrote ${join(out, `slo-verdict-${month}.md`)} and .json\n`);
  } else process.stdout.write(`${md}\n`);
  // Exit 0 for any verdict: a missed or unmeasured month is a result to publish, not a tool failure.
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e: unknown) => {
      process.stderr.write(`FAIL ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
