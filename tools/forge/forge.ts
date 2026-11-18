// SPDX-License-Identifier: Apache-2.0
// "Prove it yourself": a script anyone can run that tries to inflate a UsageMap site's numbers the cheap ways and shows
// that only a real browser visit is counted — while every answer looks the same, so a forger learns nothing.
// Node standard library only (Playwright is used for step d when this checkout has it).
//
//   node tools/forge/forge.ts --site <public site key> --origin https://<declared domain of the site> \
//        [--base https://e1.usagemap.dev] [--api https://app.usagemap.dev] \
//        [--operator-key-file FILE --project <project uuid> [--site-id <uuid>]] [--ingest-token-file FILE] \
//        [--browser | --skip-browser] [--steps a,b,c,d,e,f,g] [--wait 240] [--json] [--strict] \
//        [--connect host:port --ca FILE]   # local stacks: like curl --resolve, plus the stack's private CA
//
// Steps: (a) naive server-side POST; (b) forged token with a made-up key epoch; (c) replayed proof of work (the
// browser's own request sent again; c2: its token and proof reused by this script for a new event);
// (d) a real browser visit; (e) the answers to counted and not-counted requests compared; (f) the tracker file's
// SRI hash recomputed; (g) a Stellar address and a secret seed in an API path, sent over OTLP, read back normalised.
// Counting is observed in the SCF-operator metrics API (verdict and reason counters, exact) when an operator key and
// the project id are given; without them the steps run and the tool says what it could not observe.
// Secrets (operator key, ingest token, the throwaway seed of step g) are never printed.
// Exit: 0 every check passed (skips allowed unless --strict); 1 a check failed; 2 usage error.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, loadKey, redact, UUID_RE } from "../mcp/src/api.ts";
import { type BrowserVisit, browserVisit, findPlaywright, PLAYWRIGHT_HINT } from "./src/browser.ts";
import { loadCa, observable, parseConnect, type Res, request, type Target } from "./src/net.ts";
import {
  browserHeaders,
  CHROME_UA,
  curlHeaders,
  eventId,
  forgeToken,
  pageviewBatch,
  parseToken,
  solvePow,
} from "./src/protocol.ts";
import { throwawayKeys } from "./src/strkey.ts";

export type Outcome = "pass" | "fail" | "skip" | "info";
export interface Check {
  step: string;
  name: string;
  outcome: Outcome;
  detail: string;
  data?: unknown;
}

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USAGE = `usage: node tools/forge/forge.ts --site <site key> --origin https://<declared domain> [options]
  --base URL               ingest host (default https://e1.usagemap.dev)
  --api URL                control-plane host for the operator metrics API (default https://app.usagemap.dev)
  --operator-key-file F    SCF-operator key (scfa_op_…, scopes web:read + api:read) to observe counting
  --project UUID           the site's project (tenant) id, for the counter read-back
  --site-id UUID           limit the read-back to this site
  --ingest-token-file F    the project's ingest token (scfa_ing_…) for step g
  --browser / --skip-browser   run step d with Playwright (default: when installed) / never
  --steps a,b,…            subset of steps (default all)
  --wait S                 seconds to wait for counters (default 240; counters arrive about once a minute)
  --connect HOST:PORT      connect there instead of resolving --base (local stack), keeping SNI and Host
  --ca FILE                trust this CA (local stack)
  --json                   machine-readable report on stdout
  --strict                 a skipped step is a failure (production smoke)
`;

interface Counters {
  verdict: Record<string, number>;
  reason: Record<string, number>;
}
const n = (c: Counters, k: "verdict" | "reason", l: string) => c[k][l] ?? 0;

function delta(a: Counters, b: Counters): Counters {
  const d: Counters = { verdict: {}, reason: {} };
  for (const k of ["verdict", "reason"] as const) {
    for (const l of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) {
      const v = (b[k][l] ?? 0) - (a[k][l] ?? 0);
      if (v !== 0) d[k][l] = v;
    }
  }
  return d;
}

function fmt(c: Counters): string {
  const p = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`)
      .join(", ") || "none";
  return `verdicts: ${p(c.verdict)}; reasons: ${p(c.reason)}`;
}

export async function run(
  argv: string[],
  out: (s: string) => void,
): Promise<{ code: number; checks: Check[] }> {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      site: { type: "string" },
      origin: { type: "string" },
      base: { type: "string", default: "https://e1.usagemap.dev" },
      api: { type: "string", default: "https://app.usagemap.dev" },
      "operator-key-file": { type: "string" },
      project: { type: "string" },
      "site-id": { type: "string" },
      "ingest-token-file": { type: "string" },
      browser: { type: "boolean", default: false },
      "skip-browser": { type: "boolean", default: false },
      steps: { type: "string", default: "a,b,c,d,e,f,g" },
      wait: { type: "string", default: "240" },
      connect: { type: "string" },
      ca: { type: "string" },
      json: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (a.help) {
    out(USAGE);
    return { code: 0, checks: [] };
  }
  const site = a.site ?? "";
  if (!/^[0-9A-Za-z]{22}$/.test(site))
    throw new UsageError("--site must be the 22-character public site key");
  const origin = (a.origin ?? "").replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin))
    throw new UsageError("--origin must be https://<a declared domain of the site> (no path)");
  if (a.project && !UUID_RE.test(a.project)) throw new UsageError("--project must be a UUID");
  if (a["site-id"] && !UUID_RE.test(a["site-id"])) throw new UsageError("--site-id must be a UUID");
  const steps = new Set(a.steps.split(",").map((s) => s.trim()));
  const waitMs = Number(a.wait) * 1000;
  const t: Target = { base: new URL(a.base), connect: parseConnect(a.connect), ca: loadCa(a.ca) };
  if (t.base.protocol !== "https:" || t.base.pathname !== "/")
    throw new UsageError("--base must be https://host");
  const opKey = a["operator-key-file"]
    ? loadKey({ file: a["operator-key-file"] }, "op")
    : undefined;
  const ingKey = a["ingest-token-file"]
    ? loadKey({ file: a["ingest-token-file"] }, "ing")
    : undefined;
  const opApi = opKey
    ? new ApiClient({ baseUrl: a.api, key: opKey, userAgent: "usagemap-forge/1" })
    : undefined;
  const canCount = !!(opApi && a.project);
  const runId =
    eventId()
      .replace(/[^A-Za-z]/g, "")
      .slice(0, 6)
      .toLowerCase() || "run";
  const pathOf = (step: string) => `/forge/${step}/${runId}`;

  const checks: Check[] = [];
  const say = (s: string) => {
    if (!a.json) out(s);
  };
  const add = (c: Check) => {
    checks.push(c);
    say(
      `  [${c.outcome.toUpperCase()}] (${c.step}) ${c.name}\n         ${c.detail.replace(/\n/g, "\n         ")}`,
    );
  };
  const send = (body: string, headers: Record<string, string>) =>
    request(t, "POST", "/v1/e", { headers, body });

  say(
    `UsageMap forge check — ${t.base.origin}${t.connect ? ` (via ${t.connect.host}:${t.connect.port})` : ""}`,
  );
  say(`site ${site}, origin ${origin}, run ${runId}`);
  say(
    canCount
      ? `counting observed in the operator metrics API at ${new URL(a.api).origin} (project ${a.project})`
      : "counting NOT observable: no --operator-key-file and --project (every answer is identical by design, see e)",
  );
  say("");

  // ---- tracker manifest (needed by d and f) ----
  const man = await request(t, "GET", "/lib/manifest.json");
  if (man.status !== 200)
    throw new Error(`GET /lib/manifest.json answered ${man.status}: is --base an ingest host?`);
  const manifest = JSON.parse(man.body) as {
    versions: {
      version: string;
      config?: { hosts?: string[] };
      files: { path: string; profile: string; sha384: string; integrity: string }[];
    }[];
  };
  const latest = [...manifest.versions].sort((x, y) => cmpSemver(y.version, x.version))[0];
  if (!latest) throw new Error("the manifest lists no tracker version");
  const tv = latest.version;
  const file = latest.files.find((f) => f.profile === "standard");
  if (!file) throw new Error(`tracker ${tv} has no standard build`);
  const trackerPath = `/lib/${tv}/${file.path}`;

  // ---- (f) SRI ----
  if (steps.has("f")) {
    const js = await request(t, "GET", trackerPath);
    const got = `sha384-${createHash("sha384").update(js.raw).digest("base64")}`;
    const archived = join(REPO_ROOT, "tracker", "releases", tv, "manifest.json");
    let repoIntegrity: string | undefined;
    if (existsSync(archived)) {
      const m = JSON.parse(readFileSync(archived, "utf8")) as {
        files: { path: string; integrity: string }[];
      };
      repoIntegrity = m.files.find((f) => f.path === file.path)?.integrity;
    }
    const ok =
      js.status === 200 && got === file.integrity && (!repoIntegrity || repoIntegrity === got);
    add({
      step: "f",
      name: "tracker file matches its SRI hash",
      outcome: ok ? "pass" : "fail",
      detail:
        `GET ${trackerPath} → ${js.status}, ${js.raw.length} bytes\n` +
        `sha384 computed here : ${got}\n` +
        `manifest integrity   : ${file.integrity}\n` +
        (repoIntegrity
          ? `repository release   : ${repoIntegrity} (tracker/releases/${tv}/manifest.json)\n`
          : `repository release   : (tracker/releases/${tv} not archived in this checkout)\n`) +
        `same as: curl -s ${t.base.origin}${trackerPath} | openssl dgst -sha384 -binary | openssl base64 -A`,
      data: {
        url: `${t.base.origin}${trackerPath}`,
        computed: got,
        manifest: file.integrity,
        repository: repoIntegrity ?? null,
      },
    });
  }

  // ---- counters ----
  const readCounters = async (): Promise<Counters> => {
    if (!opApi || !a.project) throw new Error("no counter access");
    const now = Date.now();
    const day = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`;
    const rows = await opApi.all<{
      site_id: string;
      counter: string;
      label: string;
      count: number;
    }>("/op/v1/web/verdicts", {
      start: day(now - 86_400_000),
      end: day(now + 86_400_000),
      project_ids: [a.project],
      min_level: "L0",
    });
    const c: Counters = { verdict: {}, reason: {} };
    for (const r of rows) {
      if (a["site-id"] && r.site_id !== a["site-id"]) continue;
      const tbl =
        r.counter === "verdict" ? c.verdict : r.counter === "reason" ? c.reason : undefined;
      if (tbl) tbl[r.label] = (tbl[r.label] ?? 0) + Number(r.count);
    }
    return c;
  };
  const waitFor = async (
    base: Counters,
    ok: (d: Counters) => boolean,
  ): Promise<{ d: Counters; ok: boolean }> => {
    const deadline = Date.now() + waitMs;
    let d: Counters = { verdict: {}, reason: {} };
    for (;;) {
      d = delta(base, await readCounters());
      if (ok(d)) return { d, ok: true };
      if (Date.now() > deadline) return { d, ok: false };
      await sleep(5000);
    }
  };
  let c0 = canCount ? await readCounters() : undefined;

  // ---- (d) real browser ----
  let visit: BrowserVisit | undefined;
  if (steps.has("d")) {
    const pw = a["skip-browser"] ? undefined : await findPlaywright(REPO_ROOT);
    if (!pw) {
      add({
        step: "d",
        name: "a real browser visit is counted",
        outcome: "skip",
        detail: a["skip-browser"] ? "skipped (--skip-browser)" : PLAYWRIGHT_HINT,
      });
    } else {
      say("  … (d) real Chromium loading the SRI-pinned tracker on the site's origin");
      visit = await browserVisit(pw, {
        origin,
        path: pathOf("d"),
        siteKey: site,
        trackerSrc: `${t.base.origin}${trackerPath}`,
        integrity: file.integrity,
        ingestHosts: (latest.config?.hosts ?? [t.base.origin]).map((h) => new URL(h).hostname),
        connect: t.connect,
        ignoreHttpsErrors: !!t.connect,
      });
      let outcome: Outcome = visit.status === 202 ? "info" : "fail";
      let detail = `Chromium ${visit.browserVersion} sent its page view → ${visit.status}`;
      if (canCount && c0 && visit.status === 202) {
        const w = await waitFor(c0, (d) => n(d, "verdict", "verified") >= 1);
        outcome = w.ok ? "pass" : "fail";
        detail += `\ncounter change: ${fmt(w.d)}${w.ok ? "" : ` (no verified event within ${a.wait} s)`}`;
        c0 = await readCounters();
      } else if (visit.status === 202)
        detail += "\n(counted? needs --operator-key-file and --project to observe)";
      add({
        step: "d",
        name: "a real browser visit is counted",
        outcome,
        detail,
        data: { status: visit.status },
      });
    }
  }

  // ---- (a) (b) (c) forged traffic ----
  const ua = visit?.userAgent ?? CHROME_UA(131);
  const answers: Record<string, Res> = {};
  if (steps.has("a")) {
    answers.a = await send(pageviewBatch({ site, tv, path: pathOf("a") }), curlHeaders());
  }
  let forgedKep = 0;
  if (steps.has("b")) {
    const f = await forgeToken(site);
    forgedKep = f.kep;
    answers.b = await send(
      pageviewBatch({ site, tv, path: pathOf("b"), token: f.token, c: f.c }),
      browserHeaders(origin, ua),
    );
  }
  let replaySource = "";
  let reuse: { token: string; c: number } | undefined;
  if (steps.has("c")) {
    let token: string;
    let c: number;
    let original: string;
    if (visit?.requestBody) {
      const sent = JSON.parse(visit.requestBody) as { t: string; c: number };
      token = sent.t;
      c = sent.c;
      original = visit.requestBody;
      replaySource = "the browser's own request from step d, byte for byte";
      reuse = { token, c };
    } else {
      const ch = await request(t, "POST", "/v1/c", {
        headers: browserHeaders(origin, ua),
        body: JSON.stringify({ v: 1, s: site, p: "standard", tv }),
      });
      if (ch.status !== 200) throw new Error(`challenge answered ${ch.status}`);
      token = (JSON.parse(ch.body) as { t: string }).t;
      c = await solvePow(token);
      original = pageviewBatch({ site, tv, path: pathOf("c"), token, c });
      answers.c0 = await send(original, browserHeaders(origin, ua));
      replaySource = "a request with a proof solved by this script (no browser run), sent twice";
    }
    answers.c1 = await send(original, browserHeaders(origin, ua)); // byte-identical replay
    const tok = parseToken(token);
    replaySource += ` (token epoch ${tok.kep}, proof counter ${c} of ${tok.max})`;
  }

  // ---- verdicts of the forged traffic ----
  const expected: Record<string, { reason: string | null; text: string }> = {
    a: {
      reason: "challenge_missing",
      text: "no token at all → rejected/challenge_missing (curl UA also ua_bot)",
    },
    b: {
      reason: "challenge_invalid",
      text: "MAC cannot be made without the gateways' hourly key → rejected/challenge_invalid",
    },
    c: {
      reason: null,
      text: "the replay carries the same event id → dropped as a duplicate (C-37): no verdict, nothing counted",
    },
  };
  const forged = ["a", "b", "c"].filter((s) => steps.has(s));
  let forgedDelta: Counters | undefined;
  const waitAndRead = async (ok: (d: Counters) => boolean): Promise<Counters | undefined> => {
    if (!canCount || !c0) return undefined;
    say("  … waiting for the gateway's counter records (about one a minute)");
    const w = await waitFor(c0, ok);
    await sleep(6000); // one more read: a record that straddled the first one
    const d = w.ok ? delta(c0, await readCounters()) : w.d;
    c0 = await readCounters();
    return d;
  };
  if (forged.length) {
    const reasons = forged.map((s) => expected[s]?.reason).filter((r): r is string => !!r);
    forgedDelta = await waitAndRead((d) =>
      reasons.length
        ? reasons.every((r) => n(d, "reason", r) >= 1)
        : Object.keys(d.verdict).length > 0,
    );
  }
  for (const s of forged) {
    const st = s === "c" ? ["c0", "c1"].filter((k) => answers[k]) : [s];
    const statuses = st.map((k) => `${k}: ${answers[k]?.status}`).join(", ");
    const allAccepted = st.every((k) => answers[k]?.status === 202);
    const name = {
      a: "naive server-side POST is not counted",
      b: "forged token (made-up key epoch) is not counted",
      c: "replayed proof of work is not counted",
    }[s] as string;
    let outcome: Outcome = "info";
    let detail = `${statuses}${s === "b" ? ` (forged epoch ${forgedKep})` : ""}${s === "c" ? `\nreplayed: ${replaySource}` : ""}\nexpected: ${expected[s]?.text}`;
    if (!allAccepted) outcome = "fail";
    else if (forgedDelta) {
      const r = expected[s]?.reason;
      const seen = r ? n(forgedDelta, "reason", r) >= 1 : true;
      const verified = n(forgedDelta, "verdict", "verified");
      outcome = seen && verified === 0 ? "pass" : "fail";
      detail += `\nobserved: ${r ? `reason ${r} ${seen ? "counted" : "NOT seen"}; ` : ""}verified change ${verified}`;
    } else detail += "\n(not counted? needs --operator-key-file and --project to observe)";
    add({ step: s, name, outcome, detail });
  }
  if (forgedDelta) {
    say(`         counter change of a, b and c together: ${fmt(forgedDelta)}`);
    checks.push({
      step: "abc",
      name: "counter change of the forged traffic",
      outcome: "info",
      detail: fmt(forgedDelta),
      data: forgedDelta,
    });
  }

  // (c2) The browser's token and proof reused by this script for a new event (what a farm that harvests proofs does):
  // within the token's 30 minutes and 300 events the proof itself is valid, so this is caught by the request layer only
  // through the transport fingerprint (and ctx_moved from another network) — the documented boundary of ADR-0008.
  if (reuse) {
    answers.c2 = await send(
      pageviewBatch({ site, tv, path: pathOf("c2"), token: reuse.token, c: reuse.c }),
      browserHeaders(origin, ua),
    );
    let outcome: Outcome = answers.c2.status === 202 ? "info" : "fail";
    let detail = `c2: ${answers.c2.status} — the browser's token and proof, a new event id, sent from this script with the browser's User-Agent\nexpected: suspect/transport_mismatch (Node's TLS stack is not Chrome's) — not verified`;
    const d =
      answers.c2.status === 202
        ? await waitAndRead((x) => Object.keys(x.verdict).length > 0)
        : undefined;
    if (d) {
      const verified = n(d, "verdict", "verified");
      outcome = verified === 0 && Object.keys(d.verdict).length > 0 ? "pass" : "fail";
      detail += `\nobserved: ${fmt(d)}${verified ? "\nA verified count here means the gateway sees no transport fingerprint (TLS terminated in front of it, GW_ALLOW_PLAINTEXT): see wire-formats §a.1." : ""}`;
    } else if (answers.c2.status === 202)
      detail += "\n(not counted? needs --operator-key-file and --project to observe)";
    add({
      step: "c2",
      name: "a harvested proof reused by a script is not verified",
      outcome,
      detail,
    });
  }

  // ---- (e) identical answers ----
  if (steps.has("e")) {
    const sets: [string, ReturnType<typeof observable>][] = Object.entries(answers).map(
      ([k, r]) => [k, observable(r)],
    );
    if (visit) sets.push(["d (browser)", observable(visit)]);
    const debug = sets.filter(([, o]) => o.headers["x-scf-debug"]);
    // The browser sends an Origin, the naive POST does not: CORS headers legitimately differ with the request's Origin.
    const withOrigin = sets.filter(([k]) => k !== "a");
    const strip = (o: ReturnType<typeof observable>) => {
      const { "x-scf-debug": _d, ...h } = o.headers;
      return JSON.stringify({ ...o, headers: h });
    };
    const ref = withOrigin[0];
    const same = withOrigin.every(([, o]) => ref && strip(o) === strip(ref[1]));
    const statusBodySame = sets.every(
      ([, o]) => o.status === sets[0]?.[1].status && o.body === sets[0]?.[1].body,
    );
    add({
      step: "e",
      name: "counted and not-counted requests get the same answer",
      outcome: sets.length < 2 ? "skip" : same && statusBodySame ? "pass" : "fail",
      detail: [
        ...sets.map(
          ([k, o]) =>
            `${k.padEnd(12)} ${o.status} body=${JSON.stringify(o.body)} headers=${JSON.stringify(o.headers)}`,
        ),
        "compared: status, body and every header except date/connection/content-length/transfer-encoding;",
        "the naive POST (a) carries no Origin, so it gets no CORS headers — that depends on the request, not the verdict.",
        ...(debug.length
          ? [
              `note: the site's debug mode is ON (X-Scf-Debug present) — the one time-boxed, audited exception (§a.8)`,
            ]
          : []),
      ].join("\n"),
      data: Object.fromEntries(sets),
    });
  }

  // ---- (g) OTLP path redaction ----
  if (steps.has("g")) {
    if (!ingKey) {
      add({
        step: "g",
        name: "Stellar address and secret seed in an API path are normalised",
        outcome: "skip",
        detail: "needs --ingest-token-file (the project's scfa_ing_… token)",
      });
    } else {
      const k = throwawayKeys();
      const now = BigInt(Date.now()) * 1_000_000n;
      const route = `/forge/${runId}/accounts/${k.account}/sign/${k.seed}`;
      const body = JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "usagemap-forge" } }],
            },
            scopeSpans: [
              {
                scope: { name: "usagemap-forge" },
                spans: [
                  {
                    traceId: randomBytes(16).toString("hex"),
                    spanId: randomBytes(8).toString("hex"),
                    name: "GET",
                    kind: 2,
                    startTimeUnixNano: String(now - 5_000_000n),
                    endTimeUnixNano: String(now),
                    attributes: [
                      { key: "url.path", value: { stringValue: route } },
                      { key: "http.request.method", value: { stringValue: "GET" } },
                      { key: "http.response.status_code", value: { intValue: "200" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      const r = await request(t, "POST", "/v1/traces", {
        headers: { "content-type": "application/json", authorization: `Bearer ${ingKey}` },
        body,
      });
      let outcome: Outcome = r.status === 200 ? "info" : "fail";
      let detail = `sent one SERVER span, url.path = /forge/${runId}/accounts/G…(throwaway account)/sign/S…(throwaway seed, never printed) → ${r.status}`;
      if (r.status === 200 && opApi && a.project) {
        const deadline = Date.now() + waitMs;
        let rows: { route?: string; requests?: number }[] = [];
        let mine: { route?: string } | undefined;
        const d0 = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        const d1 = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        while (!mine && Date.now() < deadline) {
          rows = await opApi.all<{ route?: string }>("/op/v1/api/summary", {
            start: `${d0}T00:00:00Z`,
            end: `${d1}T00:00:00Z`,
            project_ids: [a.project],
            group: "route",
            min_level: "L0",
          });
          mine = rows.find((x) => x.route?.includes(`/${runId}/`));
          if (!mine) await sleep(5000);
        }
        const leaked = rows.some((x) => x.route?.includes(k.account) || x.route?.includes(k.seed));
        const ok =
          !!mine &&
          !leaked &&
          /\{account\}/.test(mine.route ?? "") &&
          /\{redacted\}/.test(mine.route ?? "");
        outcome = ok ? "pass" : "fail";
        detail += mine
          ? `\nstored route: ${mine.route}\nraw address or seed anywhere in the project's routes: ${leaked ? "YES (fail)" : "no"}`
          : `\nno route of this run within ${a.wait} s`;
      } else if (r.status === 200)
        detail += "\n(read-back needs --operator-key-file and --project)";
      add({
        step: "g",
        name: "Stellar address and secret seed in an API path are normalised",
        outcome,
        detail,
      });
    }
  }

  const failed = checks.filter((c) => c.outcome === "fail").length;
  // The "abc" row is the combined counter change (data), not a step.
  const skipped = checks.filter(
    (c) => c.step !== "abc" && (c.outcome === "skip" || c.outcome === "info"),
  ).length;
  const code = failed > 0 || (a.strict && skipped > 0) ? 1 : 0;
  if (a.json) {
    out(
      `${redact(
        JSON.stringify(
          {
            tool: "usagemap-forge/1",
            at: new Date().toISOString(),
            base: t.base.origin,
            site,
            origin,
            run: runId,
            counting_observed: canCount,
            result: code === 0 ? "pass" : "fail",
            checks,
          },
          null,
          2,
        ),
      )}\n`,
    );
  } else {
    say("");
    say(
      `${code === 0 ? "PASS" : "FAIL"}: ${checks.filter((c) => c.outcome === "pass").length} passed, ${failed} failed, ${skipped} not observable or skipped`,
    );
  }
  return { code, checks };
}

export function cmpSemver(x: string, y: string): number {
  const p = (v: string) => v.split(".").map(Number);
  const [a, b] = [p(x), p(y)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

class UsageError extends Error {}

if (import.meta.main) {
  run(process.argv.slice(2), (s) => process.stdout.write(`${redact(s)}\n`)).then(
    (r) => process.exit(r.code),
    (e: unknown) => {
      process.stderr.write(`forge: ${redact((e as Error).message)}\n`);
      if (e instanceof UsageError) process.stderr.write(USAGE);
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
