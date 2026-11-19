// SPDX-License-Identifier: Apache-2.0
// Unit tests of the demo generator (node --test tools/demo-seed/test/*.test.ts): determinism, the award-mix shares,
// cohort sizes, DEMO labelling, no real project names, StrKey checksums, SEP-53 signatures, the database invariants
// of every staged row and the privacy invariants of the generated SQL.

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { histogram, split, trustOf, walletPropsOf } from "../src/derived.ts";
import { buildPlan, cohortSizes, DEFAULT_PHRASE } from "../src/plan.ts";
import {
  buildScfSql,
  copyField,
  DEFAULTS,
  liveWindowDays,
  type SeedOptions,
  siteHistory,
  stagedCounts,
} from "../src/sql.ts";
import { decodeStrKey, demoKey, encodeStrKey, VERSION } from "../src/stellar.ts";
import { breakdownsOf, daySessions, dayShape } from "../src/traffic.ts";
import { buildUmamiSql, liveDays } from "../src/umami.ts";

const TODAY = new Date("2026-11-16T09:30:00Z");
const opts = (mode: "api" | "db" = "api", phrase = DEFAULT_PHRASE): SeedOptions => ({
  phrase,
  today: TODAY,
  mode,
  historyDays: 40,
  propsDays: 20,
  apiHourlyDays: 3,
  liveBudget: DEFAULTS.liveBudget,
});
const plan = buildPlan();
const sql = buildScfSql(plan, opts());

/** Names of real SCF-awarded projects and ecosystem tools: never reused. */
const REAL_NAMES = [
  "Account Demolisher",
  "ACTA",
  "Adamik",
  "AgentSmith",
  "ApiCharge",
  "BIM Exchange",
  "Bloccpay",
  "Blux",
  "Boundless",
  "BWB",
  "Canary",
  "CashAbroad",
  "Centiiv",
  "Chainless",
  "Choppaddi",
  "Cobo",
  "DappRadar",
  "DevAsign",
  "Dobprotocol",
  "Fairblock",
  "Fermah",
  "Fewticket",
  "Fuul",
  "GrantFox",
  "Houdini",
  "Hurupay",
  "IRL",
  "Janus",
  "Kasi Money",
  "KindFi",
  "LendWise",
  "LumAgg",
  "Lumen Later",
  "Lumen Loop",
  "LumenShade",
  "LumenWipe",
  "Lumexo",
  "Lunar Finance",
  "Microvault",
  "Minisend",
  "Mobula",
  "Moonlight",
  "MPCVault",
  "Myaza",
  "Neko",
  "Normal",
  "OctoPos",
  "Offer-Hub",
  "PagCrypto",
  "Paykit",
  "PG Atlas",
  "Pollar",
  "Prism",
  "Query402",
  "Range",
  "REAPP",
  "RendBit",
  "ROZO",
  "Rumble Fish",
  "Scopuly",
  "Seevcash",
  "Stellar Attestation Service",
  "Stellar Passport",
  "Stride",
  "SwiftEx",
  "Tansu",
  "Tezoro",
  "Tipper",
  "Token Tails",
  "Token Terminal",
  "Tokeshare",
  "TransferMole",
  "Trustless Work",
  "TuCambio",
  "Unalivio",
  "Unstoppable Wallet",
  "Upesa",
  "Wirex",
  "Albireo",
];

describe("plan", () => {
  it("is deterministic and depends on the phrase", () => {
    assert.deepEqual(buildPlan(), plan);
    assert.equal(buildScfSql(buildPlan(), opts()), sql);
    const other = buildPlan("another phrase");
    assert.notEqual(other[0]?.contracts[0]?.contractId, plan[0]?.contracts[0]?.contractId);
    assert.deepEqual(
      other.map((t) => t.slug),
      plan.map((t) => t.slug),
    );
  });

  it("follows the award mix: ~80 % web, ~45 % API, five categories, recent rounds, payments largest", () => {
    assert.ok(plan.length >= 15 && plan.length <= 25);
    const share = (f: (t: (typeof plan)[number]) => boolean) => plan.filter(f).length / plan.length;
    assert.equal(
      share((t) => t.website !== null),
      0.8,
    );
    assert.equal(
      share((t) => t.api !== null),
      0.45,
    );
    assert.equal(new Set(plan.flatMap((t) => t.categories)).size, 5);
    for (const t of plan) assert.ok(t.round >= 30 && t.round <= 45, t.slug);
    assert.ok(share((t) => t.round >= 42) > 0.5);
    const products = new Map<string, number>();
    for (const t of plan) products.set(t.product, (products.get(t.product) ?? 0) + 1);
    const [top] = [...products].sort((a, b) => b[1] - a[1]);
    assert.equal(top?.[0], "payments");
    assert.equal(new Set(plan.map((t) => t.stage)).size, 4);
    assert.ok(plan.some((t) => t.website?.anomaly === "spike"));
    assert.ok(plan.some((t) => t.website?.anomaly === "suspect_high"));
  });

  it("has shown and suppressed cohorts (cohort_min_tenants = 5)", () => {
    const cat = cohortSizes(plan, "category");
    assert.equal(cat.get("end_user_application"), 6);
    assert.equal(cat.get("financial_protocols"), 5);
    for (const k of ["applications", "developer_tooling", "infrastructure_services"])
      assert.ok((cat.get(k) ?? 0) < 5, k);
    const round = cohortSizes(plan, "round");
    assert.equal(round.get("44"), 5);
    assert.equal(round.get("45"), 5);
    assert.ok([...round].filter(([, n]) => n < 5).length >= 3);
    // the end-user cohort shows on-chain figures: ≥ 5 of its projects have a verified contract
    const eua = plan.filter(
      (t) => t.registryLinked && t.categories.includes("end_user_application"),
    );
    assert.ok(eua.filter((t) => t.contracts.some((c) => c.verified)).length >= 5);
    // only L3/L4 projects are registry-linked
    for (const t of plan) assert.equal(t.registryLinked, t.level === "L3" || t.level === "L4");
  });

  it("labels everything DEMO", () => {
    for (const t of plan) {
      assert.match(t.slug, /^demo-[a-z0-9][a-z0-9-]{1,33}[a-z0-9]$/);
      assert.ok(t.name.startsWith("DEMO · "), t.name);
      assert.match(t.description, /Synthetic demo data/);
      if (t.website) assert.match(t.website.host, /\.demo\.invalid$/);
      if (t.api) assert.match(t.api.baseUrl, /^https:\/\/api\.[a-z0-9-]+\.demo\.invalid$/);
    }
  });

  it("never uses a real project name", () => {
    const names = [...REAL_NAMES];
    const ref = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "references",
      "scf-awards-analysis-2026-11-16.md",
    );
    if (existsSync(ref)) {
      // the reference is internal (git-ignored); when present, every **bold** or listed name of §3 is checked too
      const text = readFileSync(ref, "utf8");
      const s3 = text.slice(text.indexOf("## 3."), text.indexOf("## 4."));
      for (const m of s3.matchAll(/\*\*([A-Z][^*]{2,40})\*\*/g)) names.push(m[1] as string);
    }
    const words = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    for (const t of plan) {
      const ours = ` ${words(t.name.slice(7)).join(" ")} `;
      for (const n of names) {
        const theirs = words(n).join(" ");
        if (theirs.length < 3) continue;
        assert.ok(!ours.includes(` ${theirs} `), `${t.name} contains the real name ${n}`);
      }
    }
  });
});

describe("stellar keys", () => {
  it("encodes StrKeys like stellar-sdk 17.4.0", () => {
    const z = Buffer.alloc(32);
    const p = Buffer.alloc(32, 7);
    assert.equal(
      encodeStrKey(VERSION.account, z),
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    assert.equal(
      encodeStrKey(VERSION.contract, z),
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    );
    assert.equal(
      encodeStrKey(VERSION.account, p),
      "GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI",
    );
    assert.equal(
      encodeStrKey(VERSION.contract, p),
      "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
    );
  });

  it("gives every demo contract a valid C… StrKey and refuses a bad checksum", () => {
    const ids = plan.flatMap((t) => t.contracts.map((c) => c.contractId));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^C[A-Z2-7]{55}$/);
      assert.equal(decodeStrKey(id).version, VERSION.contract);
    }
    const bad = `${ids[0]?.slice(0, 55)}${ids[0]?.endsWith("A") ? "B" : "A"}`;
    assert.throws(() => decodeStrKey(bad));
  });

  it("signs SEP-53 messages that verify against the account", () => {
    const k = demoKey(DEFAULT_PHRASE, "reviewer");
    assert.equal(k.account, demoKey(DEFAULT_PHRASE, "reviewer").account);
    const { version, payload } = decodeStrKey(k.account);
    assert.equal(version, VERSION.account);
    const msg = "example.org wants you to sign in\nnonce: 1";
    const digest = createHash("sha256").update(`Stellar Signed Message:\n${msg}`).digest();
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: payload.toString("base64url") },
      format: "jwk",
    });
    assert.ok(verify(null, digest, pub, Buffer.from(k.signMessage(msg), "base64")));
  });
});

describe("traffic and derived rows", () => {
  const t = plan.find((x) => x.website?.anomaly === "spike");
  const site = t?.website;
  assert.ok(t && site);

  it("produces rollup totals that satisfy web_daily_totals' checks", () => {
    for (const d of siteHistory(t, opts())) {
      const x = d.totals;
      assert.ok(x.pageviews_verified <= x.pageviews_raw);
      assert.ok(x.visitors_verified <= x.visitors_raw);
      assert.ok(x.bounces <= x.visits);
      assert.ok(x.events_raw >= x.pageviews_raw);
      assert.equal(x.visits, x.visitors_raw);
    }
  });

  it("draws the planned spike 12 days back, mostly suspect", () => {
    const h = siteHistory(t, opts());
    const spike = h.find((d) => d.daysBack === 12);
    const normal = h.find((d) => d.daysBack === 13);
    assert.ok(spike?.shape.spike && normal && !normal.shape.spike);
    assert.ok((spike?.totals.pageviews_raw ?? 0) > 3 * normal.totals.pageviews_raw);
    assert.ok((spike?.shape.suspect ?? 0) / (spike?.shape.sessions ?? 1) > 0.6);
  });

  it("ranks breakdowns by visitors (events for `event`), raw rows carry visits", () => {
    const shape = dayShape(site, DEFAULT_PHRASE, "2026-11-10", 6, 40);
    const rows = breakdownsOf(daySessions(site, shape));
    for (const dim of ["country", "path", "event"] as const) {
      const ver = rows.filter((r) => r.dimension === dim && r.variant === "verified");
      assert.ok(ver.length > 0, dim);
      for (const [i, r] of ver.entries()) assert.equal(r.rank, i + 1);
      for (let i = 1; i < ver.length; i++) {
        const k = (r: (typeof ver)[number]) => (dim === "event" ? (r.events ?? 0) : r.visitors);
        assert.ok(k(ver[i - 1] as (typeof ver)[number]) >= k(ver[i] as (typeof ver)[number]));
      }
    }
    for (const r of rows) {
      assert.equal(r.dimension === "event", r.events !== null);
      assert.equal(r.variant === "raw" && r.dimension !== "event", r.visits !== null);
    }
  });

  it("keeps today's sessions before now", () => {
    const shape = dayShape(site, DEFAULT_PHRASE, "2026-11-16", 0, 40);
    const until = 9.5 * 3600;
    for (const s of daySessions(site, shape, until))
      for (const e of s.events) assert.ok(e.offsetS < until);
  });

  it("splits exactly and builds histograms that sum to the count", () => {
    assert.deepEqual(
      split(10, [
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ]),
      [
        ["a", 4],
        ["b", 3],
        ["c", 3],
      ],
    );
    const h = histogram(1000, 40);
    assert.equal(h.hist.length, 15);
    assert.equal(
      h.hist.reduce((a, b) => a + b, 0),
      1000,
    );
    assert.ok(h.sum > 0);
  });

  it("scores trust with trust/1.0.0's thresholds and insufficient_data below 10 page views", () => {
    assert.deepEqual(
      trustOf(
        1,
        {
          pvVerified: 5,
          pvRaw: 8,
          datacenterShare: 0,
          engagementShare: 0,
          multiplicityHigh: 0,
          powFast: 0,
        },
        0,
      ).reason_codes,
      ["insufficient_data"],
    );
    const clean = trustOf(
      1,
      {
        pvVerified: 990,
        pvRaw: 1000,
        datacenterShare: 0.05,
        engagementShare: 0.1,
        multiplicityHigh: 0,
        powFast: 0.01,
      },
      0.01,
    );
    assert.equal(clean.score, 100);
    assert.deepEqual(clean.reason_codes, []);
    const bad = trustOf(
      1,
      {
        pvVerified: 400,
        pvRaw: 1000,
        datacenterShare: 0.4,
        engagementShare: 0.3,
        multiplicityHigh: 0,
        powFast: 0.1,
        step: 7,
      },
      0.02,
    );
    assert.ok((bad.score ?? 100) < 70);
    assert.ok(
      bad.reason_codes.includes("proof_coverage_low") && bad.reason_codes.includes("step_change"),
    );
  });

  it("counts wallet events in the closed vocabularies with a non-increasing funnel", () => {
    const shape = dayShape(site, DEFAULT_PHRASE, "2026-11-10", 6, 40);
    const rows = walletPropsOf(site, daySessions(site, shape), false);
    const total = (e: string) =>
      rows.filter((r) => r.event === e && r.key === "_total").reduce((a, r) => a + r.count, 0);
    assert.ok(total("wallet_modal_opened") >= total("wallet_connect"));
    assert.ok(total("wallet_connect") >= total("sign_requested"));
    assert.ok(total("sign_requested") >= total("sign_approved"));
    assert.ok(total("sign_approved") >= total("tx_submitted"));
    const allowed: Record<string, string[]> = {
      _total: ["all"],
      wallet: [
        "freighter",
        "albedo",
        "xbull",
        "lobstr",
        "hana",
        "hot",
        "rabet",
        "walletconnect",
        "passkey",
        "unknown",
      ],
      connect_kind: ["new", "restored"],
      sign_kind: ["tx", "auth_entry", "message", "tx_submit"],
      error_class: [
        "user_rejected",
        "invalid_request",
        "external_service",
        "internal",
        "timeout",
        "unsupported",
        "unknown",
      ],
      result_class: ["success", "failed", "pending", "try_again_later", "error"],
      duration: ["lt5s", "5_30s", "gt30s"],
      outcome: ["connected", "dismissed", "error"],
      passkey_op: ["register", "authenticate", "sign"],
    };
    for (const r of rows) {
      assert.ok(allowed[r.key]?.includes(r.value), `${r.key}=${r.value}`);
      assert.ok(r.count > 0);
    }
    // every property's split adds up to the event's total
    for (const e of new Set(rows.map((r) => `${r.event}|${r.network}|${r.verdict}`))) {
      const of = rows.filter((r) => `${r.event}|${r.network}|${r.verdict}` === e);
      const tot = of.find((r) => r.key === "_total")?.count ?? 0;
      for (const key of new Set(of.map((r) => r.key)))
        if (key !== "_total")
          assert.equal(
            of.filter((r) => r.key === key).reduce((a, r) => a + r.count, 0),
            tot,
            `${e} ${key}`,
          );
    }
  });

  it("computes the live window like scf.web_live_window_days and covers it in the engine", () => {
    const h = siteHistory(t, opts());
    const L = liveWindowDays(h, 10_000);
    assert.ok(L >= 1 && L <= 90);
    const days = liveDays(t, opts(), 10_000);
    assert.equal(days.length, L);
    assert.equal(days.at(-1), "2026-11-16");
  });
});

describe("generated SQL", () => {
  it("stages every table and checks what it touches", () => {
    const c = stagedCounts(sql);
    for (const k of [
      "st_tenant",
      "st_site",
      "st_totals",
      "st_bd",
      "st_trust",
      "st_props",
      "st_api",
      "st_chain",
      "st_counter",
    ])
      assert.ok((c[k] ?? 0) > 0, k);
    assert.equal(c.st_tenant, plan.length);
    assert.match(sql, /slug text CHECK \(slug LIKE 'demo-%'\)/);
    // every DELETE is bounded by the demo tenants
    for (const line of sql.split("\n").filter((l) => /^DELETE FROM scf\./.test(l)))
      assert.match(line, /USING demo_t t WHERE \S+\.tenant_id = t\.tenant_id/, line);
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
  });

  it("db mode creates the projects and the demo viewer", () => {
    const db = buildScfSql(plan, opts("db"));
    assert.match(db, /'DEMO viewer \(read-only\)'/);
    assert.equal((db.match(/, 'viewer', /g) ?? []).length, plan.length);
  });

  it("holds the privacy invariants: no IP, User-Agent, query string, page title or end-user address", () => {
    const umami = buildUmamiSql(
      plan,
      opts(),
      plan
        .filter((t) => t.website)
        .map((t, i) => ({
          slug: t.slug,
          websiteId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        })),
      10_000,
    );
    for (const text of [sql, umami]) {
      assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "IPv4 address");
      assert.doesNotMatch(text, /Mozilla\/|AppleWebKit|User-Agent/i, "User-Agent");
      assert.doesNotMatch(text, /[?&](utm_|gclid|fbclid)/, "query string");
      assert.doesNotMatch(text, /\bS[A-Z2-7]{55}\b/, "secret seed");
    }
    // the only G… accounts are the demo owners' own (project-owned, stellar_account evidence)
    const owners = new Set(plan.map((t) => demoKey(DEFAULT_PHRASE, `owner:${t.slug}`).account));
    for (const m of sql.matchAll(/\bG[A-Z2-7]{55}\b/g)) assert.ok(owners.has(m[0]), m[0]);
    assert.doesNotMatch(umami, /\bG[A-Z2-7]{55}\b/);
    // engine rows: empty query string and no page title (columns url_query = '' and page_title = \N)
    const ev = umami.slice(umami.indexOf("COPY website_event"));
    const first = ev.split("\n")[2]?.split("\t") ?? [];
    assert.equal(first[6], "");
    assert.equal(first[10], "\\N");
  });

  it("escapes COPY fields", () => {
    assert.equal(copyField(null), "\\N");
    assert.equal(copyField("a\tb\\c\nd"), "a\\tb\\\\c\\nd");
    assert.equal(copyField(["x", "y z"]), '{"x","y z"}');
    assert.equal(copyField([1, 2]), "{1,2}");
    assert.equal(copyField({ a: 1 }), '{"a":1}');
  });
});
