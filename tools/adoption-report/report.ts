// SPDX-License-Identifier: Apache-2.0
// Adoption report: live proof of adoption (by default, at least three real SCF-awarded projects instrumented for
// web analytics and one project instrumented for API traffic, next to the live global operator view), generated
// from the SCF-operator metrics API (docs/api/operator-metrics.openapi.yaml) with an operator key read from a file.
//
//   node tools/adoption-report/report.ts --api https://app.usagemap.dev --operator-key-file ~/op.key \
//        [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--operator-view-url URL] [--floor 10] [--out DIR] [--json]
//        [--record FILE | --fixtures FILE]
//
// "Instrumented for web" = at least one verified page view in the range (the anti-inflation layer passed it);
// "instrumented for API" = at least one API request in the range. Counts below the small-count floor are printed as
// "< floor" (the same floor as the API's breakdown minimum count, ADR-0027), never as the exact figure. The key is
// never printed. --record writes every API answer to a fixture file; --fixtures replays one (no network).
// Exit: 0 report written and the adoption thresholds met; 1 report written, thresholds not met; 2 usage or API error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, dayStart, lastDays, loadKey, redact } from "../mcp/src/api.ts";

export interface Project {
  project_id: string;
  slug: string;
  name: string;
  status: string;
  verification_level: string;
  scf_awarded: boolean | null;
  site_count: number;
  service_count: number;
  metrics_endpoint?: string;
}
interface WebDay {
  day: string;
  project_id: string;
  pageviews: number | null;
}
interface ApiDay {
  bucket_start: string | null;
  project_id: string;
  requests: number | null;
}
interface WebSum {
  project_id: string;
  pageviews: number | null;
  visitors_sum: number | null;
  visits: number | null;
}

export interface ProjectAdoption {
  project_id: string;
  slug: string;
  name: string;
  scf_awarded: boolean | null;
  verification_level: string;
  web: {
    instrumented: boolean;
    first_day: string | null;
    last_day: string | null;
    active_days: number;
    verified_pageviews: number;
    raw_pageviews: number;
    visitors_sum: number;
  };
  api: {
    instrumented: boolean;
    first_day: string | null;
    last_day: string | null;
    active_days: number;
    requests: number;
  };
  metrics_endpoint: string | null;
}

export interface AdoptionReport {
  generated_at: string;
  source: string;
  operator_view_url: string | null;
  range: { start: string; end: string; end_exclusive: true };
  floor: number;
  projects: ProjectAdoption[];
  threshold: {
    scf_awarded_web: { required: 3; found: number; met: boolean; slugs: string[] };
    api: { required: 1; found: number; met: boolean; slugs: string[] };
    met: boolean;
  };
  notes: string[];
}

/** A fetch that replays a recorded fixture: `{ "<path>?<sorted query>": body }`. */
export function fixtureFetch(fixtures: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const key = fixtureKey(u);
    if (!(key in fixtures))
      return new Response(JSON.stringify({ code: "not_found", detail: `no fixture for ${key}` }), {
        status: 404,
      });
    return new Response(JSON.stringify(fixtures[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

export function fixtureKey(u: URL): string {
  const q = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${u.pathname}?${new URLSearchParams(q).toString()}`;
}

/** Wraps fetch so that every successful JSON answer is kept under its fixture key. */
export function recordingFetch(
  store: Record<string, unknown>,
  inner: typeof fetch = fetch,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const r = await inner(input, init);
    if (r.ok) {
      const body = await r.clone().text();
      try {
        store[fixtureKey(new URL(String(input instanceof Request ? input.url : input)))] =
          JSON.parse(body);
      } catch {
        // not JSON: not recorded
      }
    }
    return r;
  }) as typeof fetch;
}

export async function buildReport(
  api: ApiClient,
  o: { start: string; end: string; floor: number; operatorViewUrl: string | null; now: Date },
): Promise<AdoptionReport> {
  const q = { start: dayStart(o.start), end: dayStart(o.end), min_level: "L0" };
  const [projects, webDays, rawSum, verSum, apiDays] = await Promise.all([
    api.all<Project>("/op/v1/projects", { min_level: "L0" }),
    api.all<WebDay>("/op/v1/web/daily", { ...q, variant: "verified", group: "project" }),
    api.all<WebSum>("/op/v1/web/summary", { ...q, variant: "raw" }),
    api.all<WebSum>("/op/v1/web/summary", { ...q, variant: "verified" }),
    api.all<ApiDay>("/op/v1/api/daily", { ...q, group: "project" }),
  ]);
  const days = <T>(
    rows: T[],
    id: (r: T) => string,
    day: (r: T) => string | null,
    n: (r: T) => number | null,
  ) => {
    const m = new Map<
      string,
      { first: string | null; last: string | null; active: number; total: number }
    >();
    for (const r of rows) {
      const k = id(r);
      const v = Number(n(r) ?? 0);
      const d = day(r)?.slice(0, 10) ?? null;
      const e = m.get(k) ?? { first: null, last: null, active: 0, total: 0 };
      e.total += v;
      if (v > 0 && d) {
        e.active++;
        if (!e.first || d < e.first) e.first = d;
        if (!e.last || d > e.last) e.last = d;
      }
      m.set(k, e);
    }
    return m;
  };
  const web = days(
    webDays,
    (r) => r.project_id,
    (r) => r.day,
    (r) => r.pageviews,
  );
  const apiM = days(
    apiDays,
    (r) => r.project_id,
    (r) => r.bucket_start,
    (r) => r.requests,
  );
  const raw = new Map(rawSum.map((r) => [r.project_id, r]));
  const ver = new Map(verSum.map((r) => [r.project_id, r]));

  const out: ProjectAdoption[] = projects
    .filter((p) => p.status === "active")
    .map((p) => {
      const w = web.get(p.project_id);
      const a = apiM.get(p.project_id);
      return {
        project_id: p.project_id,
        slug: p.slug,
        name: p.name,
        scf_awarded: p.scf_awarded ?? null,
        verification_level: p.verification_level,
        web: {
          instrumented: (w?.total ?? 0) > 0,
          first_day: w?.first ?? null,
          last_day: w?.last ?? null,
          active_days: w?.active ?? 0,
          verified_pageviews: Number(ver.get(p.project_id)?.pageviews ?? w?.total ?? 0),
          raw_pageviews: Number(raw.get(p.project_id)?.pageviews ?? 0),
          visitors_sum: Number(ver.get(p.project_id)?.visitors_sum ?? 0),
        },
        api: {
          instrumented: (a?.total ?? 0) > 0,
          first_day: a?.first ?? null,
          last_day: a?.last ?? null,
          active_days: a?.active ?? 0,
          requests: a?.total ?? 0,
        },
        metrics_endpoint: p.metrics_endpoint ?? null,
      };
    })
    .sort(
      (x, y) =>
        Number(y.scf_awarded === true) - Number(x.scf_awarded === true) ||
        x.slug.localeCompare(y.slug),
    );

  const awardedWeb = out
    .filter((p) => p.scf_awarded === true && p.web.instrumented)
    .map((p) => p.slug);
  const apiOnes = out.filter((p) => p.api.instrumented).map((p) => p.slug);
  const notes = [
    "Instrumented for web = at least one verified page view in the range; for API = at least one API request in the range.",
    "Verified page views passed the anti-inflation checks (challenge, proof of work, bot and transport signals); raw page views include suspect events.",
    "API figures are self-attested telemetry sent by the project's own services (OpenTelemetry); they cannot be proven genuine by the platform.",
    `Counts below ${o.floor} are shown as "< ${o.floor}" (small-count floor).`,
    "Visitors are sums of per-site daily unique visitors; no cross-site de-duplication is computed.",
  ];
  if (out.some((p) => p.scf_awarded === null))
    notes.push(
      "Projects without a registry link have an unknown SCF award status and are not counted as SCF-awarded.",
    );
  return {
    generated_at: o.now.toISOString(),
    source: api.origin,
    operator_view_url: o.operatorViewUrl,
    range: { start: q.start, end: q.end, end_exclusive: true },
    floor: o.floor,
    projects: out,
    threshold: {
      scf_awarded_web: {
        required: 3,
        found: awardedWeb.length,
        met: awardedWeb.length >= 3,
        slugs: awardedWeb,
      },
      api: { required: 1, found: apiOnes.length, met: apiOnes.length >= 1, slugs: apiOnes },
      met: awardedWeb.length >= 3 && apiOnes.length >= 1,
    },
    notes,
  };
}

/** A count under the floor is shown as "< floor"; zero stays 0 (no traffic is not personal data). */
export function floored(n: number, floor: number): string {
  if (n === 0) return "0";
  return n < floor ? `< ${floor}` : n.toLocaleString("en");
}

/** The JSON form with every count below the floor replaced by the string "< floor" (no exact small counts leave). */
export function publicJson(r: AdoptionReport): unknown {
  return {
    ...r,
    projects: r.projects.map((p) => ({
      ...p,
      web: {
        ...p.web,
        verified_pageviews: floored(p.web.verified_pageviews, r.floor),
        raw_pageviews: floored(p.web.raw_pageviews, r.floor),
        visitors_sum: floored(p.web.visitors_sum, r.floor),
      },
      api: { ...p.api, requests: floored(p.api.requests, r.floor) },
    })),
  };
}

export function renderMarkdown(r: AdoptionReport): string {
  const yes = (b: boolean) => (b ? "yes" : "no");
  const span = (a: string | null, b: string | null) => (a ? `${a} … ${b}` : "—");
  const end = new Date(Date.parse(r.range.end) - 86_400_000).toISOString().slice(0, 10);
  const L = [
    `# Adoption evidence — ${r.range.start.slice(0, 10)} to ${end}`,
    "",
    `Generated ${r.generated_at} from the SCF-operator metrics API at ${r.source} (live proof of adoption).`,
    r.operator_view_url
      ? `Live global operator view: ${r.operator_view_url}`
      : "Live global operator view: (not given)",
    "",
    "## Adoption threshold",
    "",
    "| Requirement | Required | Found | Met | Projects |",
    "|---|---|---|---|---|",
    `| SCF-awarded projects instrumented for web analytics | ${r.threshold.scf_awarded_web.required} | ${r.threshold.scf_awarded_web.found} | ${yes(r.threshold.scf_awarded_web.met)} | ${r.threshold.scf_awarded_web.slugs.join(", ") || "—"} |`,
    `| Projects instrumented for API traffic | ${r.threshold.api.required} | ${r.threshold.api.found} | ${yes(r.threshold.api.met)} | ${r.threshold.api.slugs.join(", ") || "—"} |`,
    "",
    "## Projects",
    "",
    "| Project | SCF-awarded | Level | Web | Web days (first … last, active) | Verified page views | Raw page views | Visitors (sum) | API | API days (first … last, active) | API requests |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.projects.map(
      (p) =>
        `| ${p.name} (\`${p.slug}\`) | ${p.scf_awarded === null ? "unknown" : yes(p.scf_awarded)} | ${p.verification_level} | ${yes(p.web.instrumented)} | ${span(p.web.first_day, p.web.last_day)}, ${p.web.active_days} | ${floored(p.web.verified_pageviews, r.floor)} | ${floored(p.web.raw_pageviews, r.floor)} | ${floored(p.web.visitors_sum, r.floor)} | ${yes(p.api.instrumented)} | ${span(p.api.first_day, p.api.last_day)}, ${p.api.active_days} | ${floored(p.api.requests, r.floor)} |`,
    ),
    "",
    "## Notes",
    "",
    ...r.notes.map((n) => `- ${n}`),
    "",
  ];
  return L.join("\n");
}

const USAGE = `usage: node tools/adoption-report/report.ts --api URL --operator-key-file FILE
         [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--operator-view-url URL] [--floor 10] [--out DIR] [--json]
         [--record FILE | --fixtures FILE]
`;

async function main(argv: string[]): Promise<number> {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      api: { type: "string", default: "https://app.usagemap.dev" },
      "operator-key-file": { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      "operator-view-url": { type: "string" },
      floor: { type: "string", default: "10" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      record: { type: "string" },
      fixtures: { type: "string" },
      now: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (a.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const now = a.now ? new Date(a.now) : new Date();
  const def = lastDays(28, now);
  const start = a.start ?? def.start;
  const end = a.end ?? def.end;
  const floor = Number(a.floor);
  if (!Number.isInteger(floor) || floor < 1) throw new Error("--floor must be a positive integer");
  const recorded: Record<string, unknown> = {};
  let f: typeof fetch | undefined;
  let key: string | undefined;
  if (a.fixtures)
    f = fixtureFetch(JSON.parse(readFileSync(a.fixtures, "utf8")) as Record<string, unknown>);
  else {
    key = loadKey({ file: a["operator-key-file"], value: process.env.USAGEMAP_OPERATOR_KEY }, "op");
    if (a.record) f = recordingFetch(recorded);
  }
  const api = new ApiClient({
    baseUrl: a.api,
    key: key ?? "fixture",
    fetch: f,
    userAgent: "usagemap-adoption-report/1",
  });
  const r = await buildReport(api, {
    start,
    end,
    floor,
    operatorViewUrl: a["operator-view-url"] ?? null,
    now,
  });
  if (a.record) writeFileSync(a.record, `${JSON.stringify(recorded, null, 2)}\n`);
  const md = renderMarkdown(r);
  const js = `${JSON.stringify(publicJson(r), null, 2)}\n`;
  if (a.out) {
    mkdirSync(a.out, { recursive: true });
    const stem = `adoption-${start}-${end}`;
    writeFileSync(join(a.out, `${stem}.md`), md);
    writeFileSync(join(a.out, `${stem}.json`), js);
    process.stderr.write(`wrote ${join(a.out, `${stem}.md`)} and .json\n`);
  }
  process.stdout.write(a.json ? js : md);
  return r.threshold.met ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e: unknown) => {
      process.stderr.write(`adoption-report: ${redact((e as Error).message)}\n`);
      process.exit(2);
    },
  );
}
