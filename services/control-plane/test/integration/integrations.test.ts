// SPDX-License-Identifier: Apache-2.0
// Integration catalogue against real PostgreSQL: the catalogue with the tenant's own site key
// and service name, its isolation, and the full status loop — not started → test received → live data seen — from
// exactly what the edge and the metrics writer store:
//   web — the gateway's answer to the generated test curl (a dev-origin page view without a challenge token) is a
//         `dev` entry of the counter record, `would_be: rejected`, `challenge_missing`, on `/usagemap-test`; it is
//         delivered here through the real internal edge API and must show up in the first-event panel and the
//         status, and must not count: no verdict counter, no web figure, status not "live";
//   OTLP — the writer's answer to the generated OTLP test is one `cumulative_first_point` counter of the service and
//         nothing else (metrics-writer cumul.Step, C-122); the status turns to "test received" and the API summary
//         stays at zero requests until real metric rows exist;
//   wallet — the integration's Stellar test events are `dev` entries of kind `stellar`: the wallet cards' test;
//   RPC  — stored per-site RPC totals (the counter record's `rpc` part) are the browser RPC card's live data;
//   app  — the edge's answer to the app test is one `_dropped/reason/stale` cell of the counter record's `app` part:
//         a test received for the app cards, never an event; accepted events make them live (self-attested);
//   badges — configured exactly while the project's statistics are public, and the generated badge curl answers.
// The end-to-end runs of every generated command through the real gateway, Collector and writer (and the real
// badge and pin Action) are test/live/integration-test-commands.sh.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allResolutions,
  createService,
  declareContract,
  metricRows,
  route,
  streamGroup,
} from "../support/api-seed.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

let h: Harness;
let owner = "";
let tenant = "";
let site = "";
let siteKey = "";
let service = "";
let other = "";
let otherTenant = "";
const NODE = "edge-f1";
const SERVICE_NAME = `anchor-api-${randomUUID().slice(0, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);

function counterRecord(extra: Record<string, unknown>) {
  return {
    rv: 1,
    type: "counter",
    record_id: randomUUID(),
    node_id: NODE,
    period_start_ms: Date.now() - 60_000,
    period_end_ms: Date.now(),
    web: [],
    otlp: [],
    tokens: [],
    spool: {
      boot_id: randomUUID(),
      day: today(),
      fsynced: 0,
      acked_stored: 0,
      acked_engine_bot: 0,
      acked_engine_rejected: 0,
      expired_72h: 0,
      queued: 0,
    },
    ...extra,
  };
}

async function postCounters(body: unknown) {
  const res = await h.internal.inject({
    method: "POST",
    url: "/internal/v1/edge/counters",
    headers: { "x-scf-edge-node": NODE, "content-type": "application/json" },
    payload: body as object,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const get = (url: string, cookie = owner) => call(h, { method: "GET", url, cookie });
const statusOf = async (id: string) => {
  const r = await get(
    `/v1/tenants/${tenant}/integrations/status?site_id=${site}&service_id=${service}`,
  );
  expect(r.statusCode, r.body).toBe(200);
  return {
    body: r.json(),
    status: (r.json().statuses as Array<{ id: string; status: string }>).find((s) => s.id === id)
      ?.status,
  };
};

beforeAll(async () => {
  h = await startHarness({ SCF_OTLP_ENDPOINT: "https://e1.example.test" });
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  const s = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenant}/sites`,
    cookie: owner,
    body: { name: "Docs", dev_origins: ["localhost"] },
  });
  expect(s.statusCode, s.body).toBe(201);
  site = s.json().site_id;
  siteKey = s.json().site_key;
  service = await createService(h, owner, tenant, SERVICE_NAME);
  other = await signInGithub(h, newGithubUser());
  otherTenant = await createTenant(h, other);
});

afterAll(async () => {
  expect(h.responseProblems).toEqual([]);
  await h?.close();
});

describe("listIntegrations", () => {
  it("renders every card for the tenant's site and service, without secrets", async () => {
    const r = await get(`/v1/tenants/${tenant}/integrations`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const b = r.json();
    expect(b.site).toMatchObject({ site_id: site, site_key: siteKey, dev_origins: ["localhost"] });
    expect(b.service).toEqual({ service_id: service, service_name: SERVICE_NAME });
    expect(b.otlp_endpoint).toBe("https://e1.example.test");
    const byId = new Map(b.integrations.map((c: { id: string }) => [c.id, c]));
    const tag = byId.get("web_script_tag") as {
      setup: Array<{ code: string }>;
      test: { command: { code: string } };
    };
    expect(tag.setup[0]?.code).toContain(`data-site="${siteKey}"`);
    expect(tag.test.command.code).toContain(siteKey);
    const otel = byId.get("api_otel_node") as {
      test: { command: { code: string } };
      status: string;
    };
    expect(otel.test.command.code).toContain(JSON.stringify(SERVICE_NAME));
    expect(otel.test.command.code).toContain("https://e1.example.test/v1/metrics");
    expect(otel.status).toBe("not_started");
    expect(r.body).not.toMatch(/scfa_(ing|op|pub)_[A-Za-z0-9]/);
    // the newer integration cards: generated from the same rows, each linked to its example
    const card = (id: string) =>
      byId.get(id) as {
        example_path: string | null;
        setup: Array<{ code: string }>;
        test: { kind: string; command: { code: string } | null };
      };
    expect(card("wallet_privy").example_path).toBe("examples/privy");
    expect(card("app_react_native").test.kind).toBe("app_event");
    expect(card("app_react_native").test.command?.code).toContain(`"k":"${siteKey}"`);
    expect(card("api_payments").test.command?.code).toContain('"payment.server.events"');
    expect(card("api_payments").test.command?.code).toContain(JSON.stringify(SERVICE_NAME));
    const slug = (
      await h.su.query<{ slug: string }>(`SELECT slug FROM scf.tenants WHERE tenant_id = $1`, [
        tenant,
      ])
    ).rows[0]?.slug as string;
    expect(card("tool_badges").test.command?.code).toContain(
      `/public/v1/projects/${slug}/badge.json`,
    );
  });

  it("filters by group and stack, and answers 404 for a foreign site or service", async () => {
    const w = await get(`/v1/tenants/${tenant}/integrations?group=wallets`);
    expect(w.json().integrations.map((c: { group: string }) => c.group)).toEqual(
      Array(6).fill("wallets"),
    );
    const py = await get(`/v1/tenants/${tenant}/integrations?group=api&stack=python`);
    expect(py.json().integrations.map((c: { id: string }) => c.id)).toEqual([
      "api_otel_fastapi",
      "api_otel_collector",
      "api_stellar_sdk_python",
    ]);
    const mobile = await get(`/v1/tenants/${tenant}/integrations?group=mobile`);
    expect(mobile.json().integrations.map((c: { id: string }) => c.id)).toEqual([
      "app_react_native",
      "app_flutter",
      "app_telegram_mini_app",
    ]);
    const bad = await get(`/v1/tenants/${tenant}/integrations?group=nope`);
    expect(bad.statusCode).toBe(400);
    const foreignSite = await call(h, {
      method: "POST",
      url: `/v1/tenants/${otherTenant}/sites`,
      cookie: other,
      body: { name: "Other" },
    });
    for (const q of [`site_id=${foreignSite.json().site_id}`, `service_id=${randomUUID()}`]) {
      expect((await get(`/v1/tenants/${tenant}/integrations?${q}`)).statusCode).toBe(404);
      expect((await get(`/v1/tenants/${tenant}/integrations/status?${q}`)).statusCode).toBe(404);
    }
    // another user cannot read this tenant's catalogue at all
    expect((await get(`/v1/tenants/${tenant}/integrations`, other)).statusCode).toBe(404);
  });

  it("asks for a website and a service on a tenant that has neither", async () => {
    const r = await get(`/v1/tenants/${otherTenant}/integrations?group=api`, other);
    expect(r.statusCode).toBe(200);
    expect(r.json().service).toBeNull();
    for (const c of r.json().integrations) {
      expect(c.needs).toMatch(/Register an API service first/);
      expect(c.test.command).toBeNull();
    }
  });
});

describe("status loop", () => {
  it("web: the test page view arrives in the first-event panel and is never counted", async () => {
    expect((await statusOf("web_script_tag")).status).toBe("not_started");
    // what the gateway reports for the generated curl (no token → rejected/challenge_missing, dev class)
    await postCounters(
      counterRecord({
        dev: [
          {
            tenant_id: tenant,
            site_id: site,
            received_at_ms: Date.now(),
            kind: "pageview",
            name: "pageview",
            path: "/usagemap-test",
            would_be: "rejected",
            reason: "challenge_missing",
          },
        ],
      }),
    );
    const s = await statusOf("web_script_tag");
    expect(s.status).toBe("test_received");
    expect(s.body.signals.site).toMatchObject({
      dev_events_24h: 1,
      test_events_24h: 1,
      counted_7d: false,
    });
    expect((await statusOf("wallet_wallets_kit")).status).toBe("not_started");
    const panel = await get(`/v1/tenants/${tenant}/sites/${site}/dev-events`);
    expect(panel.json().events[0]).toMatchObject({
      path: "/usagemap-test",
      would_be_verdict: "rejected",
      reason: "challenge_missing",
    });
    // never counted: no edge counter of the site exists
    const c = await h.su.query(
      `SELECT 1 FROM scf.web_edge_counters WHERE tenant_id = $1 AND site_id = $2`,
      [tenant, site],
    );
    expect(c.rowCount).toBe(0);
  });

  it("web: counted events at the edge turn it into live data seen", async () => {
    await h.su.query(
      `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 'verdict', 'verified', 3)`,
      [tenant, site],
    );
    expect((await statusOf("web_nextjs")).status).toBe("live_data_seen");
  });

  it("OTLP: the baseline test point is a test received, and adds no request", async () => {
    expect((await statusOf("api_otel_node")).status).toBe("not_started");
    // what the metrics writer stores for the generated OTLP test: one cumulative_first_point, no metric row
    await h.su.query(
      `INSERT INTO scf.api_ingest_counters (tenant_id, day, service_id, reason, count)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, 'cumulative_first_point', 1)`,
      [tenant, service],
    );
    const s = await statusOf("api_edge");
    expect(s.status).toBe("test_received");
    expect(s.body.signals.service).toMatchObject({
      baseline_points_2d: 1,
      reports_7d: 1,
      counted_7d: false,
    });
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const hour = 3_600_000;
    const h0 = Math.floor(Date.now() / hour) * hour;
    const q = `range=custom&start=${encodeURIComponent(iso(h0 - hour))}&end=${encodeURIComponent(iso(h0 + hour))}`;
    const sum = await get(`/v1/tenants/${tenant}/services/${service}/api/summary?${q}`);
    expect(sum.statusCode, sum.body).toBe(200);
    expect(sum.json().requests).toBe(0);
  });

  it("OTLP: stored request metrics turn it into live data seen", async () => {
    const t = new Date();
    const g = await streamGroup(h, tenant, service);
    const rt = await route(h, tenant, service, "/accounts/{id}");
    await metricRows(
      h,
      tenant,
      service,
      g,
      allResolutions(t, { routeId: rt, status: 200, values: [0.01, 0.02] }),
    );
    expect((await statusOf("api_otel_go")).status).toBe("live_data_seen");
  });

  it("wallets: the integration's Stellar test events are a test received for the wallet cards", async () => {
    expect((await statusOf("wallet_privy")).status).toBe("not_started");
    await postCounters(
      counterRecord({
        dev: ["wallet_connect", "wallet_connect_failed"].map((name) => ({
          tenant_id: tenant,
          site_id: site,
          received_at_ms: Date.now(),
          kind: "stellar",
          name,
          path: "/usagemap-test",
          would_be: "rejected",
          reason: "challenge_missing",
        })),
      }),
    );
    const s = await statusOf("wallet_privy");
    expect(s.status).toBe("test_received");
    expect(s.body.signals.site.wallet_dev_events_24h).toBe(2);
    expect((await statusOf("wallet_walletconnect")).status).toBe("test_received");
  });

  it("browser RPC: stored per-site totals are live data", async () => {
    // the web test above already made the site's dev events non-zero: a test received
    expect((await statusOf("wallet_browser_rpc")).status).toBe("test_received");
    await postCounters(
      counterRecord({
        rpc: [
          {
            tenant_id: tenant,
            site_id: site,
            day: today(),
            api: "rpc",
            operation: "get_health",
            network: "testnet",
            outcome: "ok",
            latency: "lt100ms",
            verdict: "verified",
            count: 2,
          },
        ],
      }),
    );
    const s = await statusOf("wallet_browser_rpc");
    expect(s.status).toBe("live_data_seen");
    expect(s.body.signals.site.rpc_counted_7d).toBe(true);
  });

  it("app events: the stale test event is a test received, never an event; accepted events are live", async () => {
    expect((await statusOf("app_react_native")).status).toBe("not_started");
    const cell = (event: string, key: string, value: string) => ({
      tenant_id: tenant,
      site_id: site,
      day: today(),
      platform: "android",
      event,
      key,
      value,
      count: 1,
    });
    // what the edge reports for the generated app test: one stale drop, nothing else
    await postCounters(counterRecord({ app: [cell("_dropped", "reason", "stale")] }));
    let s = await statusOf("app_flutter");
    expect(s.status).toBe("test_received");
    expect(s.body.signals.site).toMatchObject({
      app_stale_drops_2d: 1,
      app_events_7d: 0,
      app_reports_7d: 1,
    });
    const view = await get(`/v1/tenants/${tenant}/app-events?site_id=${site}&range=7d`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().totals).toMatchObject({ events: 0, sessions: 0, dropped: 1 });
    await postCounters(
      counterRecord({
        app: [cell("app_open", "_total", "all"), cell("_session", "_total", "all")],
      }),
    );
    s = await statusOf("app_react_native");
    expect(s.status).toBe("live_data_seen");
    expect(s.body.signals.site.app_events_7d).toBe(1);
  });

  it("badges: configured exactly while the statistics are public, and the badge curl's URL answers", async () => {
    expect((await statusOf("tool_badges")).status).toBe("not_started");
    const card = async () =>
      (
        (await get(`/v1/tenants/${tenant}/integrations?group=tooling`)).json()
          .integrations as Array<{
          id: string;
          test: { command: { code: string } };
        }>
      ).find((c) => c.id === "tool_badges") as { test: { command: { code: string } } };
    const url = (await card()).test.command.code.match(/'([^']+)'/)?.[1] as string;
    const path = new URL(url).pathname;
    expect((await call(h, { method: "GET", url: path })).statusCode).toBe(404);
    await h.su.query(`UPDATE scf.tenants SET public_stats_enabled = true WHERE tenant_id = $1`, [
      tenant,
    ]);
    const s = await statusOf("tool_badges");
    expect(s.status).toBe("configured");
    expect(s.body.signals.public_stats).toBe(true);
    // the badge reads the hourly public metrics document (job public_metrics): none yet, still 404
    expect((await call(h, { method: "GET", url: path })).statusCode).toBe(404);
    const slug = decodeURIComponent(path.split("/")[4] as string);
    await h.su.query(
      `INSERT INTO scf.public_metrics_documents (tenant_id, document) VALUES ($1, $2::jsonb)`,
      [
        tenant,
        JSON.stringify({
          schema: "scf-analytics/metrics-endpoint/1",
          project: { slug, name: "F1", verification_level: "L0" },
          generated_at: new Date().toISOString(),
          window: { start: "2026-10-20T00:00:00Z", end: "2026-11-19T00:00:00Z", days: 30 },
          web: {
            verified: { pageviews: 0, visitors_sum: 0 },
            raw: {},
            visit_metrics: {},
            daily: [],
          },
          api: { label: "self-attested telemetry", requests: 0, assurance_level: null },
          links: { definitions: "x" },
        }),
      ],
    );
    const b = await call(h, { method: "GET", url: path });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json()).toMatchObject({ schemaVersion: 1 });
  });

  it("contracts: configured once one is registered", async () => {
    expect((await statusOf("onchain_contracts")).status).toBe("not_started");
    await declareContract(h, owner, tenant);
    expect((await statusOf("onchain_contracts")).status).toBe("configured");
  });
});
