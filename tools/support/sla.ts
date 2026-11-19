// SPDX-License-Identifier: Apache-2.0
// Support-ticket SLA automation (support.first-response, support.resolution; docs/sla.md §9.2–9.3; ADR-0031).
//
//   tools/support/run sla --fixtures=DIR   evaluate the rule on JSON fixture events (tests, no network)
//   tools/support/run sla --plan           read open issues, print what would change (read-only)
//   tools/support/run sla --apply          read open issues and apply labels/comments
//     (--plan/--apply need GITHUB_TOKEN and GITHUB_REPOSITORY; run by a maintainer, e.g. daily)
//
// Rules (docs/sla.md §9.2–9.3):
//   - age is counted in business time: Monday–Friday in time zone SCF_SUPPORT_TZ (default UTC), minus the dates in
//     the holiday calendar (SCF_SUPPORT_HOLIDAYS, default ops/support/holidays.yaml; one `- YYYY-MM-DD` per line);
//     one business day = 24 h of a business date, so "5 business days" ends at the same clock time five business
//     days later;
//   - the clock pauses while the issue carries `status:needs-info`, from the moment the label is added until it is
//     removed or the issue author comments, whichever is first;
//   - first response = the first comment by a maintainer (author association OWNER / MEMBER / COLLABORATOR) who is
//     not a bot and not the issue author; issues opened by a maintainer need no first response;
//   - `sla:awaiting-first-response` while no first response; a warning comment at 4 business days; the label
//     `sla:response-breach` at 5 (never removed); a warning comment at 8 business days open; `sla:resolution-breach`
//     at 10 (never removed). Each warning is posted once (hidden marker). `sla:exempt` excludes an issue (e.g. a
//     maintainers' tracking issue) and is a visible, reviewable label.
// No personal data is stored or logged: the output names issue numbers, labels and ages only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LABELS = {
  awaiting: "sla:awaiting-first-response",
  responseBreach: "sla:response-breach",
  resolutionBreach: "sla:resolution-breach",
  needsInfo: "status:needs-info",
  exempt: "sla:exempt",
} as const;

export const MARKERS = {
  responseWarning: "<!-- scf-sla:response-warning -->",
  resolutionWarning: "<!-- scf-sla:resolution-warning -->",
} as const;

export const THRESHOLDS = {
  responseWarn: 4,
  responseBreach: 5,
  resolutionWarn: 8,
  resolutionBreach: 10,
};

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const DAY_MS = 86_400_000;

export interface Config {
  tz: string;
  holidays: Set<string>;
}

export interface Comment {
  author: string;
  association: string;
  bot: boolean;
  createdAt: string;
  body?: string;
}

export interface LabelEvent {
  label: string;
  action: "labeled" | "unlabeled";
  createdAt: string;
}

export interface Issue {
  number: number;
  author: string;
  authorAssociation: string;
  createdAt: string;
  closedAt?: string | null;
  labels: string[];
  comments: Comment[];
  labelEvents: LabelEvent[];
}

// ----------------------------------------------------------------------------------------------- calendar

function parts(
  t: number,
  tz: string,
): { y: number; m: number; d: number; h: number; mi: number; s: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "");
  return {
    y: +(p.year ?? 0),
    m: +(p.month ?? 0),
    d: +(p.day ?? 0),
    h: +(p.hour ?? 0),
    mi: +(p.minute ?? 0),
    s: +(p.second ?? 0),
    wd,
  };
}

/** Local calendar date (YYYY-MM-DD) and weekday (0 = Sunday) of an instant in a time zone. */
export function localDay(t: number, tz: string): { date: string; weekday: number } {
  const p = parts(t, tz);
  return {
    date: `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`,
    weekday: p.wd,
  };
}

function offset(t: number, tz: string): number {
  const p = parts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** The instant of local midnight at the start of a date in a time zone (DST-safe by iteration). */
export function zonedMidnight(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  let t = utc - offset(utc, tz);
  t = utc - offset(t, tz);
  return t;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function isBusinessDay(date: string, weekday: number, holidays: Set<string>): boolean {
  return weekday >= 1 && weekday <= 5 && !holidays.has(date);
}

type Interval = [number, number];

function merge(intervals: Interval[]): Interval[] {
  const s = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of s) {
    const last = out.at(-1);
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** Business time between two instants, in business days (fractional), excluding paused intervals. */
export function businessDays(
  start: number,
  end: number,
  cfg: Config,
  pauses: Interval[] = [],
): number {
  const paused = merge(pauses);
  let total = 0;
  let t = start;
  while (t < end) {
    const day = localDay(t, cfg.tz);
    const next = zonedMidnight(nextDate(day.date), cfg.tz);
    const segEnd = Math.min(next, end);
    if (isBusinessDay(day.date, day.weekday, cfg.holidays)) {
      let len = segEnd - t;
      for (const [a, b] of paused) len -= Math.max(0, Math.min(b, segEnd) - Math.max(a, t));
      total += len;
    }
    t = segEnd;
  }
  return total / DAY_MS;
}

// ----------------------------------------------------------------------------------------------- rule

const ms = (s: string): number => Date.parse(s);

export function isMaintainer(c: { association: string; bot?: boolean }): boolean {
  return !c.bot && MAINTAINER_ASSOCIATIONS.has(c.association);
}

/** Intervals during which the clock is paused by `status:needs-info`. */
export function pauseIntervals(issue: Issue, now: number): Interval[] {
  const events = [...issue.labelEvents]
    .filter((e) => e.label === LABELS.needsInfo)
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const authorReplies = issue.comments
    .filter((c) => c.author === issue.author)
    .map((c) => ms(c.createdAt))
    .sort((a, b) => a - b);
  const out: Interval[] = [];
  let open: number | undefined;
  const close = (at: number): void => {
    if (open === undefined) return;
    const reply = authorReplies.find((r) => r > (open as number));
    out.push([open, Math.min(at, reply ?? Number.POSITIVE_INFINITY)]);
    open = undefined;
  };
  for (const e of events) {
    if (e.action === "labeled" && open === undefined) open = ms(e.createdAt);
    else if (e.action === "unlabeled") close(ms(e.createdAt));
  }
  close(now);
  return out;
}

export interface Evaluation {
  number: number;
  exempt: boolean;
  responded: boolean;
  responseAge: number;
  resolutionAge: number;
  add: string[];
  remove: string[];
  comments: { marker: string; body: string }[];
}

export function evaluate(issue: Issue, nowIso: string, cfg: Config): Evaluation {
  const now = ms(nowIso);
  const has = (l: string): boolean => issue.labels.includes(l);
  const base: Evaluation = {
    number: issue.number,
    exempt: false,
    responded: false,
    responseAge: 0,
    resolutionAge: 0,
    add: [],
    remove: [],
    comments: [],
  };
  if (has(LABELS.exempt)) {
    return { ...base, exempt: true, remove: has(LABELS.awaiting) ? [LABELS.awaiting] : [] };
  }
  const created = ms(issue.createdAt);
  const end = issue.closedAt ? Math.min(ms(issue.closedAt), now) : now;
  const pauses = pauseIntervals(issue, now);
  const openedByMaintainer = isMaintainer({ association: issue.authorAssociation });
  const first = issue.comments
    .filter((c) => isMaintainer(c) && c.author !== issue.author)
    .map((c) => ms(c.createdAt))
    .sort((a, b) => a - b)[0];
  const responded = openedByMaintainer || first !== undefined;
  const responseEnd = openedByMaintainer ? created : Math.min(first ?? end, end);
  const responseAge = businessDays(created, responseEnd, cfg, pauses);
  const resolutionAge = businessDays(created, end, cfg, pauses);
  const markers = new Set(
    issue.comments.flatMap((c) => Object.values(MARKERS).filter((m) => c.body?.includes(m))),
  );
  const ev: Evaluation = { ...base, responded, responseAge, resolutionAge };
  const isOpen = !issue.closedAt;
  if (!responded && isOpen && !has(LABELS.awaiting)) ev.add.push(LABELS.awaiting);
  if ((responded || !isOpen) && has(LABELS.awaiting)) ev.remove.push(LABELS.awaiting);
  if (responseAge >= THRESHOLDS.responseBreach) {
    if (!has(LABELS.responseBreach)) ev.add.push(LABELS.responseBreach);
  } else if (
    !responded &&
    isOpen &&
    responseAge >= THRESHOLDS.responseWarn &&
    !markers.has(MARKERS.responseWarning)
  ) {
    ev.comments.push({
      marker: MARKERS.responseWarning,
      body: `${MARKERS.responseWarning}\nSupport SLA: this ticket has had no maintainer response for ${THRESHOLDS.responseWarn} business days. The first-response target is ${THRESHOLDS.responseBreach} business days (docs/sla.md §9).`,
    });
  }
  if (resolutionAge >= THRESHOLDS.resolutionBreach) {
    if (!has(LABELS.resolutionBreach)) ev.add.push(LABELS.resolutionBreach);
  } else if (
    isOpen &&
    resolutionAge >= THRESHOLDS.resolutionWarn &&
    !markers.has(MARKERS.resolutionWarning)
  ) {
    ev.comments.push({
      marker: MARKERS.resolutionWarning,
      body: `${MARKERS.resolutionWarning}\nSupport SLA: this ticket has been open for ${THRESHOLDS.resolutionWarn} business days. The resolution target is ${THRESHOLDS.resolutionBreach} business days (docs/sla.md §9.2).`,
    });
  }
  return ev;
}

// ----------------------------------------------------------------------------------------------- config

export function parseHolidays(text: string): Set<string> {
  const out = new Set<string>();
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*-\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*(#.*)?$/.exec(l);
    if (m?.[1]) out.add(m[1]);
    else if (l.trim() && !/^\s*#/.test(l) && !/^\s*[A-Za-z_]+:\s*$/.test(l))
      throw new Error(
        `holiday calendar: cannot read line ${JSON.stringify(l)} (expected "- YYYY-MM-DD")`,
      );
  }
  return out;
}

export function configFromEnv(root: string): Config {
  const tz = process.env.SCF_SUPPORT_TZ || "UTC";
  new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws on an unknown zone
  const file = resolve(root, process.env.SCF_SUPPORT_HOLIDAYS || "ops/support/holidays.yaml");
  const holidays = existsSync(file) ? parseHolidays(readFileSync(file, "utf8")) : new Set<string>();
  if (!existsSync(file))
    process.stderr.write(`WARN holiday calendar ${file} not found: weekends only\n`);
  return { tz, holidays };
}

// ----------------------------------------------------------------------------------------------- GitHub

interface GhIssue {
  number: number;
  user: { login: string; type: string } | null;
  author_association: string;
  created_at: string;
  closed_at: string | null;
  labels: { name: string }[];
  pull_request?: unknown;
}

interface GhComment {
  user: { login: string; type: string } | null;
  author_association: string;
  created_at: string;
  body?: string;
}

interface GhEvent {
  event: string;
  label?: { name: string };
  created_at: string;
}

export class GitHub {
  private readonly token: string;
  private readonly repo: string;
  private readonly api: string;

  constructor(
    token: string,
    repo: string,
    api = process.env.GITHUB_API_URL ?? "https://api.github.com",
  ) {
    this.token = token;
    this.repo = repo;
    this.api = api;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "scf-support-sla",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok && !(method === "DELETE" && res.status === 404))
      throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return (res.status === 204 || method === "DELETE" ? undefined : await res.json()) as T;
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page < 100; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.req<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async openIssues(): Promise<Issue[]> {
    const issues = (await this.all<GhIssue>(`/repos/${this.repo}/issues?state=open`)).filter(
      (i) => !i.pull_request,
    );
    const out: Issue[] = [];
    for (const i of issues) {
      const comments = await this.all<GhComment>(`/repos/${this.repo}/issues/${i.number}/comments`);
      const events = await this.all<GhEvent>(`/repos/${this.repo}/issues/${i.number}/events`);
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
          ...(c.body ? { body: c.body } : {}),
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

  async apply(ev: Evaluation): Promise<void> {
    if (ev.add.length)
      await this.req("POST", `/repos/${this.repo}/issues/${ev.number}/labels`, { labels: ev.add });
    for (const l of ev.remove)
      await this.req(
        "DELETE",
        `/repos/${this.repo}/issues/${ev.number}/labels/${encodeURIComponent(l)}`,
      );
    for (const c of ev.comments)
      await this.req("POST", `/repos/${this.repo}/issues/${ev.number}/comments`, { body: c.body });
  }
}

// ----------------------------------------------------------------------------------------------- CLI

export interface Fixture {
  name: string;
  now: string;
  config?: { tz?: string; holidays?: string[] };
  issue: Issue;
  expect: {
    add: string[];
    remove: string[];
    comments: string[];
    responseAge?: number;
    resolutionAge?: number;
  };
}

export function runFixture(f: Fixture): string[] {
  const cfg: Config = { tz: f.config?.tz ?? "UTC", holidays: new Set(f.config?.holidays ?? []) };
  const ev = evaluate(f.issue, f.now, cfg);
  const problems: string[] = [];
  const same = (a: string[], b: string[]): boolean =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (!same(ev.add, f.expect.add))
    problems.push(`add ${JSON.stringify(ev.add)} != ${JSON.stringify(f.expect.add)}`);
  if (!same(ev.remove, f.expect.remove))
    problems.push(`remove ${JSON.stringify(ev.remove)} != ${JSON.stringify(f.expect.remove)}`);
  const markers = ev.comments.map((c) => c.marker);
  if (!same(markers, f.expect.comments))
    problems.push(`comments ${JSON.stringify(markers)} != ${JSON.stringify(f.expect.comments)}`);
  for (const k of ["responseAge", "resolutionAge"] as const) {
    const want = f.expect[k];
    if (want !== undefined && Math.abs(ev[k] - want) > 1e-6)
      problems.push(`${k} ${ev[k]} != ${want}`);
  }
  return problems;
}

function fmt(ev: Evaluation): string {
  return `#${ev.number}: response ${ev.responseAge.toFixed(2)} bd${ev.responded ? " (responded)" : ""}, open ${ev.resolutionAge.toFixed(2)} bd; +[${ev.add.join(", ")}] -[${ev.remove.join(", ")}]${ev.comments.length ? ` comments ${ev.comments.length}` : ""}${ev.exempt ? " (exempt)" : ""}`;
}

export async function main(argv: string[]): Promise<number> {
  const arg = (k: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const fixtures = arg("fixtures");
  if (fixtures) {
    const files = readdirSync(fixtures)
      .filter((f) => f.endsWith(".json"))
      .sort();
    let failed = 0;
    for (const file of files) {
      const f = JSON.parse(readFileSync(join(fixtures, file), "utf8")) as Fixture;
      const p = runFixture(f);
      process.stdout.write(`${p.length ? "FAIL" : "ok  "} ${file}: ${f.name}\n`);
      for (const x of p) process.stdout.write(`       ${x}\n`);
      if (p.length) failed++;
    }
    process.stdout.write(
      `\nResult: ${failed === 0 ? "PASS" : "FAIL"} — ${files.length} fixture(s), ${failed} failing\n`,
    );
    return failed === 0 ? 0 : 1;
  }
  const apply = argv.includes("--apply");
  if (!apply && !argv.includes("--plan")) {
    process.stderr.write("usage: sla.ts --fixtures=DIR | --plan | --apply\n");
    return 2;
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    process.stderr.write("GITHUB_TOKEN and GITHUB_REPOSITORY are required\n");
    return 2;
  }
  const cfg = configFromEnv(resolve(import.meta.dirname, "..", ".."));
  const gh = new GitHub(token, repo);
  const now = new Date().toISOString();
  const issues = await gh.openIssues();
  let changed = 0;
  for (const i of issues) {
    const ev = evaluate(i, now, cfg);
    const change = ev.add.length + ev.remove.length + ev.comments.length > 0;
    if (change) changed++;
    process.stdout.write(`${fmt(ev)}\n`);
    if (apply && change) await gh.apply(ev);
  }
  process.stdout.write(
    `\n${issues.length} open issue(s), ${changed} ${apply ? "updated" : "would change"} (tz ${cfg.tz}, ${cfg.holidays.size} holiday(s))\n`,
  );
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
