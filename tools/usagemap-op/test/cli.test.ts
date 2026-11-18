// SPDX-License-Identifier: Apache-2.0
// usagemap-op against a mock control plane on loopback (real HTTP, shapes from docs/api/*.openapi.yaml), plus the
// handover fingerprint diff on fixture files. LIVE=1 adds a dry run against the live host's public endpoints only
// (no credential). Run: tools/usagemap-op/run selftest

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { adoptionReportArgs, main } from "../cli.ts";
import { redact } from "../src/client.ts";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const CLI = join(HERE, "..", "cli.ts");
const FX = join(HERE, "fixtures");

const KEY = `scfa_op_${"A".repeat(12)}_${"b".repeat(33)}`;
const SESSION = "s".repeat(20) + "_-".repeat(5) + "T".repeat(13); // 43 base64url characters
const TENANT = "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12";
const R1 = "01a1f23a-1141-75bf-9b8d-cb794505501b";
const R2 = "01a1f23a-113f-7152-ac6c-06755ac5a01c";
const R3 = "01a1f23a-1287-7c66-9407-6e0bd1db6bc5";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
}
const seen: Seen[] = [];
let server: Server;
let base = "";
let stepUpOk = true;
let dir = "";
let keyFile = "";
let sessionFile = "";

const summary = (id: string, name: string, domain: string | null, round: number) => ({
  registry_project_id: id,
  name,
  website: domain ? `https://${domain}/` : null,
  domain,
  categories: [],
  award_round: round,
  award_stage: null,
  sources: ["stellarlight"],
});

function coverageBody(origin: string, q: URLSearchParams) {
  const all = [
    { p: summary(R1, "SocketFi", "socket.fi", 32), status: "measuring", e: 1, v: 1, m: 1 },
    { p: summary(R2, "Sollpay", "sollpay.com", 38), status: "enrolled", e: 1, v: 0, m: 0 },
    { p: summary(R3, "Soroban Assistant", null, 14), status: "not_enrolled", e: 0, v: 0, m: 0 },
  ];
  const items = all
    .filter((x) => !q.get("status") || x.status === q.get("status"))
    .map((x) => ({
      project: x.p,
      status: x.status,
      tenants_enrolled: x.e,
      tenants_verified: x.v,
      tenants_measuring: x.m,
      invite_url: `${origin}/onboard?project=${x.p.registry_project_id}`,
    }));
  return {
    measuring_days: Number(q.get("measuring_days") ?? 7),
    totals: { projects: 3, not_enrolled: 1, enrolled: 1, verified: 0, measuring: 1 },
    items,
  };
}

const problem = (status: number, code: string) => ({
  type: `https://x/problems/${code}`,
  title: code,
  status,
  code,
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "usagemap-op-"));
  keyFile = join(dir, "op.key");
  sessionFile = join(dir, "session");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  writeFileSync(sessionFile, `__Host-scf_session=${SESSION}; Path=/\n`, { mode: 0o600 });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      seen.push({
        method: req.method ?? "",
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body,
      });
      const send = (status: number, obj: unknown, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(JSON.stringify(obj));
      };
      const bearer = req.headers.authorization === `Bearer ${KEY}`;
      const cookie = req.headers.cookie === `__Host-scf_session=${SESSION}`;
      const p = u.pathname;
      if (p.startsWith("/op/v1/") && !bearer) return send(401, problem(401, "unauthenticated"));
      if (p.startsWith("/v1/operator/") && !cookie)
        return send(401, problem(401, "unauthenticated"));
      if (p === "/v1/operator/onboarding/coverage")
        return send(200, coverageBody(base, u.searchParams));
      if (p === "/op/v1/registry/projects") {
        // two pages, to exercise the cursor
        if (!u.searchParams.get("cursor"))
          return send(200, {
            data: [
              {
                registry_project_id: R1,
                source: "stellarlight",
                source_id: "socketfi",
                name: "SocketFi",
                websites: ["https://socket.fi/"],
                scf_awarded: true,
                award_round: 32,
                linked_project_ids: [TENANT],
              },
              {
                registry_project_id: R2,
                source: "stellarlight",
                source_id: "sollpay",
                name: "Sollpay",
                websites: ["https://sollpay.com/"],
                scf_awarded: true,
                award_round: 38,
                linked_project_ids: [],
              },
            ],
            next_cursor: "c2",
            privacy: {},
            meta: {},
          });
        return send(200, {
          data: [
            {
              registry_project_id: R3,
              source: "pg_atlas",
              source_id: "sa",
              name: "Soroban Assistant",
              websites: [],
              scf_awarded: true,
              award_round: 14,
              linked_project_ids: [],
            },
          ],
          next_cursor: null,
          privacy: {},
          meta: {},
        });
      }
      if (p === "/op/v1/projects")
        return send(200, {
          data: [
            {
              project_id: TENANT,
              slug: "socketfi",
              name: "SocketFi",
              status: "active",
              created_at: "2026-11-01T00:00:00Z",
              verification_level: "L2",
              scf_awarded: true,
              registry_project_ids: [R1],
              site_count: 1,
              service_count: 1,
            },
          ],
          next_cursor: null,
          privacy: {},
          meta: {},
        });
      if (p === `/v1/operator/tenants/${TENANT}`)
        return send(200, {
          tenant: { tenant_id: TENANT, slug: "socketfi", name: "SocketFi", status: "active" },
          sites: [{}],
          services: [],
        });
      if (p === `/v1/operator/tenants/${TENANT}/removal` && req.method === "POST") {
        if (req.headers["x-scf-request"] !== "1" || req.headers.origin !== base)
          return send(403, problem(403, "csrf_failed"));
        if (!stepUpOk) return send(403, problem(403, "step_up_required"));
        return send(200, {
          tenant_id: TENANT,
          slug: "socketfi",
          name: "SocketFi",
          status: "removed",
          purge_after: "2026-12-19T10:00:00Z",
        });
      }
      if (p === `/v1/operator/tenants/${TENANT}/registry-links/${R2}` && req.method === "PUT") {
        if (req.headers["x-scf-request"] !== "1" || req.headers.origin !== base)
          return send(403, problem(403, "csrf_failed"));
        if (!stepUpOk) return send(403, problem(403, "step_up_required"));
        res.writeHead(204);
        return res.end();
      }
      if (p === "/public/v1/registry/projects") {
        if (req.headers.authorization || req.headers.cookie)
          return send(400, problem(400, "validation_failed"));
        return send(200, { items: [summary(R1, "SocketFi", "socket.fi", 32)], more: false });
      }
      if (p === "/op/v1/me") {
        res.writeHead(302, { location: "https://elsewhere.invalid/" });
        return res.end();
      }
      send(404, problem(404, "not_found"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => server.close());

async function cli(args: string[], creds: { key?: boolean; session?: boolean } = {}) {
  let out = "";
  let err = "";
  const io = {
    out: (s: string) => {
      out += redact(s);
    },
    err: (s: string) => {
      err += redact(s);
    },
  };
  const env = {
    USAGEMAP_API_URL: base,
    ...(creds.key ? { USAGEMAP_OPERATOR_KEY_FILE: keyFile } : {}),
    ...(creds.session ? { USAGEMAP_SESSION_FILE: sessionFile } : {}),
  };
  let code: number;
  try {
    code = await main(args, env, io);
  } catch (e) {
    err += redact((e as Error).message);
    code = 2;
  }
  for (const s of [out, err]) {
    assert.ok(!s.includes(KEY), "the key is never printed");
    assert.ok(!s.includes(SESSION), "the session is never printed");
  }
  return { code, out, err };
}

const last = (path: string) => [...seen].reverse().find((s) => s.path === path);

describe("coverage", () => {
  test("session: authoritative counts from the onboarding coverage endpoint", async () => {
    const r = await cli(["coverage", "--measuring-days", "14"], { session: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /SCF-awarded registry projects: 3/);
    assert.match(r.out, /not_enrolled\s+1 \(33 %\)/);
    assert.match(r.out, /measuring\s+1/);
    assert.match(r.out, /last 14 days/);
    const s = last("/v1/operator/onboarding/coverage");
    assert.equal(s?.query.get("measuring_days"), "14");
    assert.equal(
      s?.headers.authorization,
      undefined,
      "the operator key never goes to /v1/operator",
    );
    assert.equal(s?.headers.origin, undefined, "no CSRF pair on a GET");
  });

  test("--json --list", async () => {
    const r = await cli(["coverage", "--json"], { session: true });
    const j = JSON.parse(r.out);
    assert.equal(j.totals.measuring, 1);
    const l = await cli(["coverage", "--list"], { session: true });
    assert.match(l.out, /measuring\s+SocketFi\s+socket\.fi\s+32\s+1\/1\/1/);
  });

  test("key only: approximate counts from registry links, labelled as such", async () => {
    const r = await cli(["coverage"], { key: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /rows \(per source\): 3/);
    assert.match(r.out, /linked to a project\s+1/);
    assert.match(r.out, /not linked\s+2/);
    assert.match(r.out, /linked projects at L2: 1/);
    assert.match(r.out, /approximate/);
    assert.equal(last("/op/v1/registry/projects")?.query.get("cursor"), "c2", "follows the cursor");
    assert.equal(last("/op/v1/registry/projects")?.query.get("scf_awarded"), "true");
  });

  test("no credential: usage error naming both options", async () => {
    const r = await cli(["coverage"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--session-file.*--key-file/);
  });

  test("bad --status and --measuring-days are refused before any request", async () => {
    const n = seen.length;
    assert.equal((await cli(["coverage", "--status", "nope"], { session: true })).code, 2);
    assert.equal((await cli(["coverage", "--measuring-days", "91"], { session: true })).code, 2);
    assert.equal(seen.length, n);
  });
});

describe("projects", () => {
  test("list (session) with status filter passed to the API", async () => {
    const r = await cli(["projects", "list", "--status", "enrolled"], { session: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /enrolled\s+Sollpay/);
    assert.doesNotMatch(r.out, /SocketFi/);
    assert.equal(last("/v1/operator/onboarding/coverage")?.query.get("status"), "enrolled");
  });

  test("list (key) shows linked tenants with their level", async () => {
    const r = await cli(["projects", "list", "--q", "sock"], { key: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /socketfi L2\s+SocketFi\s+stellarlight/);
    assert.doesNotMatch(r.out, /Sollpay/);
    assert.equal((await cli(["projects", "list", "--status", "enrolled"], { key: true })).code, 2);
  });

  test("show with both credentials: status, invite link, linked project", async () => {
    const r = await cli(["projects", "show", R1], { key: true, session: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /SocketFi {2}\(01a1f23a/);
    assert.match(r.out, /status\s+measuring/);
    assert.match(r.out, new RegExp(`invite link\\s+${base}/onboard\\?project=${R1}`));
    assert.match(r.out, /linked\s+socketfi L2 active sites 1 services 1/);
  });

  test("show unknown id → 1; malformed id → 2", async () => {
    assert.equal(
      (await cli(["projects", "show", "01a1f23a-0000-7000-8000-000000000000"], { session: true }))
        .code,
      1,
    );
    assert.equal((await cli(["projects", "show", "x"], { session: true })).code, 2);
  });
});

describe("invite", () => {
  test("session: the coverage list's own link, nothing sent", async () => {
    const r = await cli(["invite", R3, "--message"], { session: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Soroban Assistant {2}\[not_enrolled\]/);
    assert.ok(r.out.includes(`${base}/onboard?project=${R3}`));
    assert.match(r.out, /Hi Soroban Assistant team/);
    assert.match(r.err, /nothing was sent/);
    assert.ok(
      !seen.some((s) => s.method !== "GET" && s.path.includes("invit")),
      "no write anywhere",
    );
  });

  test("already enrolled: warns about a claim dispute", async () => {
    const r = await cli(["invite", R2], { session: true });
    assert.match(r.err, /already enrolled/);
  });

  test("key only: checked against the registry", async () => {
    assert.equal((await cli(["invite", R2], { key: true })).code, 0);
    assert.equal(
      (await cli(["invite", "01a1f23a-0000-7000-8000-000000000000"], { key: true })).code,
      1,
    );
  });

  test("no credential: link built locally, marked unchecked; --portal-origin respected", async () => {
    const r = await cli(["invite", R1, "--portal-origin", "https://portal.example"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `https://portal.example/onboard?project=${R1}`);
    assert.match(r.err, /not checked/);
  });

  test("--search uses the public registry search without any credential header", async () => {
    const r = await cli(["invite", "--search", "socket"], { key: true, session: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`SocketFi\\s+socket\\.fi\\s+${base}/onboard\\?project=${R1}`));
    const s = last("/public/v1/registry/projects");
    assert.equal(s?.query.get("q"), "socket");
    assert.equal(s?.headers.authorization, undefined);
    assert.equal(s?.headers.cookie, undefined);
  });
});

describe("remove", () => {
  test("dry run by default: shows the tenant, writes nothing", async () => {
    const n = seen.filter((s) => s.method === "POST").length;
    const r = await cli(["remove", TENANT, "--reason", "not part of the ecosystem"], {
      session: true,
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would remove: SocketFi \(socketfi/);
    assert.match(r.out, /dry run/);
    assert.equal(seen.filter((s) => s.method === "POST").length, n);
  });

  test("--yes posts the reason with the CSRF pair; slug resolved with the key", async () => {
    stepUpOk = true;
    const r = await cli(["remove", "socketfi", "--reason", "spam", "--yes"], {
      key: true,
      session: true,
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /removed: SocketFi \(socketfi\) status removed, purge after 2026-12-19/);
    const s = last(`/v1/operator/tenants/${TENANT}/removal`);
    assert.deepEqual(JSON.parse(s?.body ?? "{}"), { reason: "spam" });
    assert.equal(s?.headers["x-scf-request"], "1");
    assert.equal(s?.headers.origin, base);
    assert.equal(s?.headers.authorization, undefined);
  });

  test("step-up missing: explains what to do", async () => {
    stepUpOk = false;
    const r = await cli(["remove", TENANT, "--reason", "spam", "--yes"], { session: true });
    stepUpOk = true;
    assert.equal(r.code, 2);
    assert.match(r.err, /step-up required: sign in to the portal again .* rotates it/);
  });

  test("needs a session and a reason", async () => {
    assert.match(
      (await cli(["remove", TENANT, "--reason", "x"], { key: true })).err,
      /portal session/,
    );
    assert.match((await cli(["remove", TENANT], { session: true })).err, /--reason/);
  });
});

describe("link", () => {
  test("dry run shows the current link state, writes nothing", async () => {
    const n = seen.filter((s) => s.method !== "GET").length;
    const r = await cli(["link", TENANT, R2, "--confirm"], { session: true });
    assert.equal(r.code, 0, r.err);
    assert.match(
      r.out,
      /would confirm the registry match .* for SocketFi \(socketfi\); now: no link yet/,
    );
    assert.equal(seen.filter((s) => s.method !== "GET").length, n);
  });

  test("--confirm --yes sends PUT {decision} with the CSRF pair (204)", async () => {
    stepUpOk = true;
    const r = await cli(["link", TENANT, R2, "--confirm", "--yes"], { session: true });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /confirmed: SocketFi \(socketfi\)/);
    const s = last(`/v1/operator/tenants/${TENANT}/registry-links/${R2}`);
    assert.equal(s?.method, "PUT");
    assert.deepEqual(JSON.parse(s?.body ?? "{}"), { decision: "confirm" });
    assert.equal(s?.headers["x-scf-request"], "1");
  });

  test("needs exactly one decision; step-up hint on 403", async () => {
    assert.equal((await cli(["link", TENANT, R2], { session: true })).code, 2);
    assert.equal(
      (await cli(["link", TENANT, R2, "--confirm", "--reject"], { session: true })).code,
      2,
    );
    stepUpOk = false;
    const r = await cli(["link", TENANT, R2, "--reject", "--yes"], { session: true });
    stepUpOk = true;
    assert.match(r.err, /step-up required/);
  });
});

describe("safety", () => {
  test("redirects are refused (a credential never follows a Location)", async () => {
    const { OpClient } = await import("../src/client.ts");
    const c = new OpClient({ baseUrl: base, key: KEY });
    await assert.rejects(c.get("/op/v1/me", "key"), /redirect refused \(302\)/);
  });

  test("plain http only on loopback; wrong key kind and junk files refused without echoing them", async () => {
    const { OpClient, loadOperatorKey, loadSession } = await import("../src/client.ts");
    assert.throws(() => new OpClient({ baseUrl: "http://app.usagemap.dev" }), /https/);
    const ing = join(dir, "ing.key");
    writeFileSync(ing, `scfa_ing_${"A".repeat(12)}_${"b".repeat(33)}\n`);
    assert.throws(() => loadOperatorKey(ing), /expected an scfa_op_ key/);
    const junk = join(dir, "junk");
    writeFileSync(junk, "hunter2-secret\n");
    assert.throws(
      () => loadSession(junk),
      (e: Error) => !e.message.includes("hunter2"),
    );
    assert.throws(
      () => loadOperatorKey(junk),
      (e: Error) => !e.message.includes("hunter2"),
    );
  });

  test("a world-readable credential file draws a warning", async () => {
    const loose = join(dir, "loose.key");
    writeFileSync(loose, `${KEY}\n`);
    chmodSync(loose, 0o644);
    let err = "";
    await main(
      ["coverage"],
      { USAGEMAP_API_URL: base, USAGEMAP_OPERATOR_KEY_FILE: loose },
      {
        out: () => {},
        err: (s) => {
          err += s;
        },
      },
    );
    assert.match(err, /readable by others/);
  });

  test("enrol-on-behalf: no API, honest steps, exit 3", async () => {
    const n = seen.length;
    const r = await cli(["enrol-on-behalf"]);
    assert.equal(r.code, 3);
    assert.match(r.out, /there is no API for it/);
    assert.match(r.out, /usagemap-op invite <registry-id>/);
    assert.equal(seen.length, n, "no request");
  });
});

describe("verify-migration", () => {
  test("identical fingerprints → 0", async () => {
    const r = await cli(["verify-migration", join(FX, "fp-a.tsv"), join(FX, "fp-same.tsv")]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /IDENTICAL/);
    assert.match(r.out, /3 tables, 259 rows/);
  });

  test("different fingerprints → 1, naming each difference", async () => {
    const r = await cli(["verify-migration", join(FX, "fp-a.tsv"), join(FX, "fp-b.tsv")]);
    assert.equal(r.code, 1);
    assert.match(r.out, /DIFFERENT: 6 line\(s\) differ/);
    assert.match(r.out, /scf table scf.sites: changed \(5 rows both, content hash differs\)/);
    assert.match(r.out, /umami table public.website_event: changed \(rows 251 → 250\)/);
    assert.match(r.out, /scf table scf.extra: only in B/);
    assert.match(r.out, /- role scf_app: only in A/);
    assert.match(r.out, /scf sequence scf.audit_seq: changed \(42 t → 40 t\)/);
    assert.match(r.out, /FP_RAW=1/);
    const j = JSON.parse(
      (await cli(["verify-migration", "--json", join(FX, "fp-a.tsv"), join(FX, "fp-b.tsv")])).out,
    );
    assert.equal(j.equal, false);
    assert.equal(j.kinds.table.changed, 2);
  });

  test("malformed input → 2", async () => {
    const bad = join(dir, "bad.tsv");
    writeFileSync(bad, "not a fingerprint\n");
    assert.equal((await cli(["verify-migration", bad, join(FX, "fp-a.tsv")])).code, 2);
    const dup = join(dir, "dup.tsv");
    writeFileSync(dup, "scf\ttable\tt\t1 x\nscf\ttable\tt\t1 x\n");
    assert.match((await cli(["verify-migration", dup, join(FX, "fp-a.tsv")])).err, /repeats/);
  });
});

describe("adoption-report", () => {
  test("argument mapping: --key-file becomes --operator-key-file; env defaults fill gaps", () => {
    assert.deepEqual(
      adoptionReportArgs(["--key-file", "k", "--json"], { USAGEMAP_API_URL: "https://a" }),
      ["--operator-key-file", "k", "--json", "--api", "https://a"],
    );
    assert.deepEqual(adoptionReportArgs(["--fixtures", "f"], { USAGEMAP_OPERATOR_KEY_FILE: "k" }), [
      "--fixtures",
      "f",
    ]);
  });

  test("wraps tools/adoption-report (recorded fixtures, no network)", async () => {
    const fx = join(HERE, "..", "..", "adoption-report", "test", "fixtures", "programme.json");
    const recorded = JSON.parse(readFileSync(fx, "utf8")) as Record<string, unknown>;
    const k = Object.keys(recorded).find((x) => x.startsWith("/op/v1/web/daily?")) ?? "";
    const q = new URLSearchParams(k.split("?")[1]);
    const range = [
      "--start",
      (q.get("start") ?? "").slice(0, 10),
      "--end",
      (q.get("end") ?? "").slice(0, 10),
    ];
    const r: { stdout: string; code?: number } = await run(process.execPath, [
      CLI,
      "adoption-report",
      "--fixtures",
      fx,
      "--json",
      ...range,
    ]).catch((e: { stdout: string; code: number }) => ({ stdout: e.stdout, code: e.code }));
    const j = JSON.parse(r.stdout);
    assert.equal(j.threshold.met, true, "the adoption report's JSON comes through");
    assert.equal(r.code, undefined, "and its exit code (0 = thresholds met)");
  });
});

describe("process", () => {
  test("cli.ts runs as a program; errors exit 2 without a stack", async () => {
    const r = await run(process.execPath, [CLI, "help"]);
    assert.match(r.stdout, /usagemap-op — SCF-operator command line/);
    const e = await run(process.execPath, [CLI, "coverage"], {
      env: { PATH: process.env.PATH ?? "" },
    }).catch((x: { code: number; stderr: string }) => x);
    assert.equal((e as { code: number }).code, 2);
    assert.match((e as { stderr: string }).stderr, /^usagemap-op: coverage needs/);
  });
});

describe("live host, public endpoints only (LIVE=1)", { skip: process.env.LIVE !== "1" }, () => {
  test("invite --search against https://app.usagemap.dev; the link opens the portal", async () => {
    let out = "";
    const code = await main(
      ["invite", "--search", "stellar", "--json"],
      {},
      {
        out: (s) => {
          out += s;
        },
        err: () => {},
      },
    );
    assert.equal(code, 0);
    const j = JSON.parse(out) as {
      items: Array<{ invite_url: string; registry_project_id: string }>;
    };
    assert.ok(j.items.length > 0);
    const first = j.items[0] as { invite_url: string; registry_project_id: string };
    assert.equal(
      first.invite_url,
      `https://app.usagemap.dev/onboard?project=${first.registry_project_id}`,
    );
    const page = await fetch(first.invite_url, { redirect: "manual" });
    assert.equal(page.status, 200);
  });

  test("coverage without a session is refused locally; the live endpoint answers 401 to an anonymous caller", async () => {
    const r = await fetch("https://app.usagemap.dev/v1/operator/onboarding/coverage", {
      redirect: "manual",
    });
    assert.equal(r.status, 401);
    let err = "";
    const code = await main(
      ["coverage"],
      {},
      {
        out: () => {},
        err: (s) => {
          err += s;
        },
      },
    ).catch((e: Error) => {
      err += e.message;
      return 2;
    });
    assert.equal(code, 2);
    assert.match(err, /--session-file/);
  });
});
