// SPDX-License-Identifier: Apache-2.0
// Monthly support report (first response within 5 business days; resolution within 10 business days;
// support.first-response, support.resolution; docs/sla.md §9.2–9.3 K3/K4; runbook ops/runbooks/support-sla.md).
//
//   node tools/support/support-report.ts --month=2026-11 --issues=FILE.json [--at=ISO] [--repo=ORG/REPO] [--out=DIR]
//   node tools/support/support-report.ts --month=2026-11 --github [--out=DIR]   (GITHUB_TOKEN, GITHUB_REPOSITORY)
//
// The clock is the one the label automation uses (tools/support/sla.ts, imported, not copied): business
// time Monday–Friday in SCF_SUPPORT_TZ minus ops/support/holidays.yaml, paused while `status:needs-info` waits for
// the reporter; first response = first comment by a maintainer who is not a bot and not the author.
//
// What is counted (one rule each, so the report can be recomputed from the ticket history):
//   - the month's cohort: every ticket OPENED in the calendar month (UTC), except `sla:exempt` (visible label) —
//     pull requests are never tickets;
//   - response: met when the first response came at < 5 business days; breached when it came at ≥ 5, when the
//     ticket is still unanswered at ≥ 5, or when it carries `sla:response-breach` (the automation's label is never
//     removed, so the report can never be kinder than the label); pending when unanswered and younger than 5;
//   - resolution: the ticket is closed (docs/sla.md §9.2: fix deployed, workaround, answer or decision); met at
//     < 10 business days; breached at ≥ 10, when still open at ≥ 10, or when labelled `sla:resolution-breach`;
//     pending when open and younger than 10;
//   - "carried over": tickets opened before the month that were still open at its start — listed with their state,
//     so a breach in an old ticket cannot fall between two reports;
//   - all ages are measured at --at (default: now), which the report prints.
// Output names issue numbers, labels and business-day ages only — never authors, titles or bodies (personal data).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  businessDays,
  type Config,
  configFromEnv,
  type Issue,
  isMaintainer,
  LABELS,
  parseHolidays,
  pauseIntervals,
  THRESHOLDS,
} from "./sla.ts";

export type State = "met" | "breached" | "pending";

export interface TicketRow {
  number: number;
  createdAt: string;
  closedAt: string | null;
  responseDays: number | null; // business days to the first response (null: none yet)
  responseAge: number; // business days without a response at --at, or responseDays
  response: State;
  resolutionDays: number | null; // business days to closing (null: still open)
  resolutionAge: number;
  resolution: State;
  paused: boolean; // the clock was paused at least once (status:needs-info)
}

export interface Stats {
  tickets: number;
  responded: number;
  responseMet: number;
  responseBreached: number;
  responsePending: number;
  responseMedian: number | null;
  responseMax: number | null;
  resolved: number;
  resolutionMet: number;
  resolutionBreached: number;
  resolutionPending: number;
  resolutionMedian: number | null;
  resolutionMax: number | null;
}

export interface SupportReport {
  month: string;
  at: string;
  tz: string;
  holidays: number;
  excluded: { exempt: number[] };
  cohort: TicketRow[];
  carriedOver: TicketRow[];
  stats: Stats;
}

export function monthRange(month: string): [number, number] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`--month must be YYYY-MM, got ${JSON.stringify(month)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`--month: no month ${mo}`);
  return [Date.UTC(y, mo - 1, 1), Date.UTC(y, mo, 1)];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** One ticket's response and resolution state at instant `at`. */
export function assess(issue: Issue, at: number, cfg: Config): TicketRow {
  const created = Date.parse(issue.createdAt);
  const closed = issue.closedAt ? Date.parse(issue.closedAt) : null;
  const isClosed = closed !== null && closed <= at;
  const end = isClosed ? (closed as number) : at;
  const pauses = pauseIntervals(issue, at);
  const openedByMaintainer = isMaintainer({ association: issue.authorAssociation });
  const first = issue.comments
    .filter((c) => isMaintainer(c) && c.author !== issue.author && Date.parse(c.createdAt) <= at)
    .map((c) => Date.parse(c.createdAt))
    .sort((a, b) => a - b)[0];
  const has = (l: string): boolean => issue.labels.includes(l);

  let responseDays: number | null = null;
  let responseAge: number;
  if (openedByMaintainer) responseDays = 0;
  else if (first !== undefined) responseDays = businessDays(created, first, cfg, pauses);
  if (responseDays !== null) responseAge = responseDays;
  else responseAge = businessDays(created, end, cfg, pauses);
  let response: State;
  if (has(LABELS.responseBreach) || responseAge >= THRESHOLDS.responseBreach) response = "breached";
  else response = responseDays !== null ? "met" : isClosed ? "met" : "pending";
  // A ticket closed without any maintainer comment (e.g. the reporter closed it) needs no response: "met" only if the
  // close came before the deadline, which the age check above already decided.

  const resolutionAge = businessDays(created, end, cfg, pauses);
  const resolutionDays = isClosed ? resolutionAge : null;
  let resolution: State;
  if (has(LABELS.resolutionBreach) || resolutionAge >= THRESHOLDS.resolutionBreach)
    resolution = "breached";
  else resolution = isClosed ? "met" : "pending";

  return {
    number: issue.number,
    createdAt: issue.createdAt,
    closedAt: isClosed ? (issue.closedAt as string) : null,
    responseDays,
    responseAge,
    response,
    resolutionDays,
    resolutionAge,
    resolution,
    paused: pauses.length > 0,
  };
}

export function stats(rows: TicketRow[]): Stats {
  const responded = rows
    .filter((r) => r.responseDays !== null)
    .map((r) => r.responseDays as number);
  const resolved = rows
    .filter((r) => r.resolutionDays !== null)
    .map((r) => r.resolutionDays as number);
  const count = (k: "response" | "resolution", s: State): number =>
    rows.filter((r) => r[k] === s).length;
  return {
    tickets: rows.length,
    responded: responded.length,
    responseMet: count("response", "met"),
    responseBreached: count("response", "breached"),
    responsePending: count("response", "pending"),
    responseMedian: median(responded),
    responseMax: responded.length ? Math.max(...responded) : null,
    resolved: resolved.length,
    resolutionMet: count("resolution", "met"),
    resolutionBreached: count("resolution", "breached"),
    resolutionPending: count("resolution", "pending"),
    resolutionMedian: median(resolved),
    resolutionMax: resolved.length ? Math.max(...resolved) : null,
  };
}

export function build(issues: Issue[], month: string, atIso: string, cfg: Config): SupportReport {
  const [from, to] = monthRange(month);
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new Error(`--at is not a time: ${atIso}`);
  if (at < to)
    process.stderr.write(
      `WARN report time ${atIso} is before the end of ${month}: figures are provisional\n`,
    );
  const seen = new Set<number>();
  const exempt: number[] = [];
  const cohort: TicketRow[] = [];
  const carried: TicketRow[] = [];
  for (const i of issues) {
    if (seen.has(i.number)) throw new Error(`issue #${i.number} appears twice in the input`);
    seen.add(i.number);
    const created = Date.parse(i.createdAt);
    if (Number.isNaN(created)) throw new Error(`issue #${i.number}: createdAt is not a time`);
    if (created > at) continue;
    const closed = i.closedAt ? Date.parse(i.closedAt) : null;
    const inMonth = created >= from && created < to;
    const openAtStart = created < from && (closed === null || closed >= from);
    if (!inMonth && !openAtStart) continue;
    if (i.labels.includes(LABELS.exempt)) {
      exempt.push(i.number);
      continue;
    }
    (inMonth ? cohort : carried).push(assess(i, at, cfg));
  }
  const byNumber = (a: TicketRow, b: TicketRow): number => a.number - b.number;
  cohort.sort(byNumber);
  carried.sort(byNumber);
  exempt.sort((a, b) => a - b);
  return {
    month,
    at: new Date(at).toISOString(),
    tz: cfg.tz,
    holidays: cfg.holidays.size,
    excluded: { exempt },
    cohort,
    carriedOver: carried,
    stats: stats(cohort),
  };
}

const d = (x: number | null): string => (x === null ? "—" : x.toFixed(2));

export function markdown(r: SupportReport, repo?: string): string {
  const link = (n: number): string =>
    repo ? `[#${n}](https://github.com/${repo}/issues/${n})` : `#${n}`;
  const s = r.stats;
  const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)} %`);
  const L: string[] = [];
  L.push(`# Support report ${r.month}`, "");
  L.push(
    `Generated by \`tools/support/support-report.ts\`; ages measured at ${r.at}. Business days: Monday–Friday in ` +
      `${r.tz}, minus ${r.holidays} published holiday(s) (\`ops/support/holidays.yaml\`), paused while ` +
      "`status:needs-info` waits for the reporter (docs/sla.md §9.2).",
    "",
  );
  L.push(
    "Targets (docs/sla.md K3/K4): first response within **5** business days, resolution within **10**.",
    "",
  );
  L.push("## Tickets opened this month", "");
  L.push("| Figure | Value |", "|---|---|");
  L.push(`| Tickets | ${s.tickets} |`);
  L.push(
    `| First response within 5 business days | ${s.responseMet} of ${s.tickets - s.responsePending} decided (${pct(s.responseMet, s.tickets - s.responsePending)}); ${s.responsePending} still within the target |`,
  );
  L.push(`| Response breaches | ${s.responseBreached} |`);
  L.push(
    `| First response: median / maximum (business days) | ${d(s.responseMedian)} / ${d(s.responseMax)} |`,
  );
  L.push(
    `| Resolved within 10 business days | ${s.resolutionMet} of ${s.tickets - s.resolutionPending} decided (${pct(s.resolutionMet, s.tickets - s.resolutionPending)}); ${s.resolutionPending} open within the target |`,
  );
  L.push(`| Resolution breaches | ${s.resolutionBreached} |`);
  L.push(
    `| Resolution: median / maximum (business days) | ${d(s.resolutionMedian)} / ${d(s.resolutionMax)} |`,
  );
  L.push("");
  const table = (rows: TicketRow[]): void => {
    L.push(
      "| Ticket | Opened (UTC) | First response (bd) | Response | Closed (UTC) | Open / to close (bd) | Resolution | Paused |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const t of rows)
      L.push(
        `| ${link(t.number)} | ${t.createdAt.slice(0, 16)} | ${t.responseDays === null ? `none (${d(t.responseAge)})` : d(t.responseDays)} | ${t.response} | ${t.closedAt ? t.closedAt.slice(0, 16) : "open"} | ${d(t.resolutionAge)} | ${t.resolution} | ${t.paused ? "yes" : "no"} |`,
      );
    L.push("");
  };
  if (r.cohort.length) table(r.cohort);
  else L.push("No tickets were opened this month.", "");
  const breaches = r.cohort.filter((t) => t.response === "breached" || t.resolution === "breached");
  L.push("## Breaches", "");
  if (breaches.length)
    for (const t of breaches)
      L.push(
        `- ${link(t.number)}: ${[t.response === "breached" ? "response" : "", t.resolution === "breached" ? "resolution" : ""].filter(Boolean).join(" and ")}`,
      );
  else L.push("None.");
  L.push("", "Breaches stay breaches when the ticket is resolved later (docs/sla.md §9.3).", "");
  L.push("## Carried over (opened earlier, open at the start of the month)", "");
  if (r.carriedOver.length) table(r.carriedOver);
  else L.push("None.", "");
  if (r.excluded.exempt.length)
    L.push(
      `Excluded as \`sla:exempt\` (maintainers' tracking issues, reviewable): ${r.excluded.exempt.map(link).join(", ")}.`,
      "",
    );
  return L.join("\n");
}

// ----------------------------------------------------------------------------------------------- GitHub (read only)

interface GhUser {
  login: string;
  type: string;
}

async function ghAll<T>(api: string, token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 200; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${api}${path}${sep}per_page=100&page=${page}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "scf-support-report",
      },
    });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Every issue (open and closed, no pull requests) with its comments and label events. */
export async function fetchIssues(token: string, repo: string, sinceMs: number): Promise<Issue[]> {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  type GhIssue = {
    number: number;
    user: GhUser | null;
    author_association: string;
    created_at: string;
    closed_at: string | null;
    labels: { name: string }[];
    pull_request?: unknown;
  };
  // An issue relevant to the month was opened in it or open at its start, so it was updated on or after the start.
  const since = new Date(sinceMs).toISOString();
  const issues = (
    await ghAll<GhIssue>(api, token, `/repos/${repo}/issues?state=all&since=${since}`)
  ).filter((i) => !i.pull_request);
  const out: Issue[] = [];
  for (const i of issues) {
    const comments = await ghAll<{
      user: GhUser | null;
      author_association: string;
      created_at: string;
    }>(api, token, `/repos/${repo}/issues/${i.number}/comments`);
    const events = await ghAll<{ event: string; label?: { name: string }; created_at: string }>(
      api,
      token,
      `/repos/${repo}/issues/${i.number}/events`,
    );
    out.push({
      number: i.number,
      author: i.user?.login ?? "",
      authorAssociation: i.author_association,
      createdAt: i.created_at,
      closedAt: i.closed_at,
      labels: i.labels.map((l) => l.name),
      comments: comments.map((c) => ({
        author: c.user?.login ?? "",
        association: c.author_association,
        bot: c.user?.type === "Bot",
        createdAt: c.created_at,
      })),
      labelEvents: events
        .filter((e) => (e.event === "labeled" || e.event === "unlabeled") && e.label)
        .map((e) => ({
          label: e.label?.name ?? "",
          action: e.event as "labeled" | "unlabeled",
          createdAt: e.created_at,
        })),
    });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- CLI

export function configFrom(argv: string[], root: string): Config {
  const arg = (k: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const cfg = configFromEnv(root);
  const tz = arg("tz");
  if (tz) {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    cfg.tz = tz;
  }
  const hol = arg("holidays");
  if (hol) cfg.holidays = parseHolidays(readFileSync(hol, "utf8"));
  return cfg;
}

export async function main(argv: string[]): Promise<number> {
  const arg = (k: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const month = arg("month");
  if (!month || (!arg("issues") && !argv.includes("--github"))) {
    process.stderr.write(
      "usage: support-report.ts --month=YYYY-MM (--issues=FILE.json | --github) [--at=ISO] [--repo=ORG/REPO] [--tz=Zone] [--holidays=FILE] [--out=DIR]\n",
    );
    return 2;
  }
  const root = resolve(import.meta.dirname, "..", "..");
  const cfg = configFrom(argv, root);
  let issues: Issue[];
  let repo = arg("repo");
  const file = arg("issues");
  if (file) issues = JSON.parse(readFileSync(file, "utf8")) as Issue[];
  else {
    const token = process.env.GITHUB_TOKEN;
    repo = repo ?? process.env.GITHUB_REPOSITORY;
    if (!token || !repo) {
      process.stderr.write("--github needs GITHUB_TOKEN and GITHUB_REPOSITORY\n");
      return 2;
    }
    issues = await fetchIssues(token, repo, monthRange(month)[0]);
  }
  const rep = build(issues, month, arg("at") ?? new Date().toISOString(), cfg);
  const md = markdown(rep, repo);
  const out = arg("out");
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `support-${month}.md`), `${md}\n`);
    writeFileSync(join(out, `support-${month}.json`), `${JSON.stringify(rep, null, 2)}\n`);
    process.stdout.write(`wrote ${join(out, `support-${month}.md`)} and .json\n`);
  } else process.stdout.write(`${md}\n`);
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
