// SPDX-License-Identifier: Apache-2.0
// The API-analytics, OpenTelemetry, erasure and operator fixtures are valid control-plane answers, and they agree with
// each other (classes = codes = routes = summary), so the browser tests check real contract shapes.
import { describe, expect, it } from "vitest";
import { assertValidResponse } from "../../e2e/support/openapi.ts";
import {
  apiPoints,
  apiRange,
  DATA_QUALITY_7D,
  HORIZON_PREVIOUS,
  HORIZON_SUMMARY,
  ROUTES,
  RPC_STREAM_WARNING,
  RPC_SUMMARY,
  SERVICES,
  STATUS_CODES,
  SVC_HORIZON,
  SVC_RPC,
  TOKENS,
} from "../fixtures/api.ts";
import {
  OP_API_KEYS,
  OP_COUNTRY_ROWS,
  OP_PROJECTS,
  OP_SERVICES,
  OP_SETTINGS,
  OP_TOMBSTONES,
  PRIVACY,
} from "../fixtures/operator.ts";
import { otelRecipe, STACKS, TOKEN_PLACEHOLDER } from "../fixtures/otel-recipes.ts";

const range = apiRange("2026-11-06T00:00:00Z", "2026-11-13T00:00:00Z", "1h", {
  stream_group: { kind: "mixed", warning: RPC_STREAM_WARNING },
  sampled_lower_bound: false,
});

describe("tenant API fixtures match the OpenAPI document", () => {
  it("services and tokens", () => {
    assertValidResponse("listServices", 200, SERVICES);
    assertValidResponse("listIngestTokens", 200, TOKENS);
    assertValidResponse("createIngestToken", 201, {
      ...TOKENS[0],
      token: "scfa_ing_ProdColl0001_abcdefghijklmnopqrstuvwxyz0123456",
    });
  });
  it("summaries, status codes, routes, time series and data quality", () => {
    for (const s of [HORIZON_SUMMARY, HORIZON_PREVIOUS, RPC_SUMMARY])
      assertValidResponse("getApiSummary", 200, { range, ...s });
    for (const [svc, codes] of Object.entries(STATUS_CODES)) {
      const classes = (svc === SVC_HORIZON ? HORIZON_SUMMARY : RPC_SUMMARY).status;
      assertValidResponse("getApiStatusCodes", 200, { range, classes, codes });
    }
    for (const items of Object.values(ROUTES))
      assertValidResponse("listApiRoutes", 200, { range, items, next_cursor: null });
    assertValidResponse("getApiTimeseries", 200, {
      range,
      points: apiPoints(range.start, range.end, "1h", SVC_HORIZON),
      accuracy_class: "exp3",
    });
    for (const reasons of Object.values(DATA_QUALITY_7D))
      assertValidResponse("getServiceDataQuality", 200, {
        start: range.start,
        end: range.end,
        reasons,
      });
  });
  it("views add up: classes = status codes = routes = requests", () => {
    for (const [svc, s] of [
      [SVC_HORIZON, HORIZON_SUMMARY],
      [SVC_RPC, RPC_SUMMARY],
    ] as const) {
      const c = s.status;
      expect(c.s2xx + c.s3xx + c.s4xx + c.s5xx + c.unknown).toBe(s.requests);
      expect((STATUS_CODES[svc] ?? []).reduce((a, x) => a + x.requests, 0)).toBe(s.requests);
      expect((ROUTES[svc] ?? []).reduce((a, x) => a + x.requests, 0)).toBe(s.requests);
    }
    const p = HORIZON_PREVIOUS.status;
    expect(p.s2xx + p.s3xx + p.s4xx + p.s5xx + p.unknown).toBe(HORIZON_PREVIOUS.requests);
  });
  it("every OpenTelemetry recipe is a valid OtelConfig with the token as a placeholder", () => {
    for (const { id } of STACKS) {
      const cfg = otelRecipe(id, {
        endpoint: "https://otlp.example.invalid",
        serviceName: "horizon-proxy",
      });
      assertValidResponse("getOtelConfig", 200, cfg);
      const text = JSON.stringify(cfg);
      expect(text).toContain(TOKEN_PLACEHOLDER);
      expect(text).not.toMatch(/scfa_ing_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}/);
    }
  });
});

describe("operator fixtures match the OpenAPI document", () => {
  it("web project rows, breakdown, settings, tombstones and keys", () => {
    const items = OP_PROJECTS.map((p) => ({
      tenant_id: p.tenant_id,
      slug: p.slug,
      name: p.name,
      verification_level: p.verification_level,
      trust_score_28d: p.trust_score_28d,
      scf_awarded: p.scf_awarded,
      ...p.verified,
    }));
    assertValidResponse("operatorWebProjects", 200, { items, next_cursor: null, privacy: PRIVACY });
    assertValidResponse("operatorWebBreakdown", 200, {
      privacy: PRIVACY,
      dimension: "country",
      rows: OP_COUNTRY_ROWS,
    });
    assertValidResponse("operatorGetSettings", 200, OP_SETTINGS);
    assertValidResponse("operatorListTombstones", 200, { items: OP_TOMBSTONES, next_cursor: null });
    assertValidResponse("operatorListApiKeys", 200, OP_API_KEYS);
  });
  it("API service rows", () => {
    const items = OP_SERVICES.map((s) => ({
      tenant_id: s.tenant_id,
      slug: "x",
      service_id: s.service_id,
      service_name: s.service_name,
      verification_level: "L2",
      assurance_level: s.assurance_level,
      onchain_badge: s.onchain_badge,
      active_days: 3,
      ...s.cells,
    }));
    assertValidResponse("operatorApiServices", 200, {
      items,
      next_cursor: null,
      privacy: PRIVACY,
      label: "self-attested telemetry",
    });
  });
  it("breakdown rows respect the minimum count and rounding they claim", () => {
    for (const r of OP_COUNTRY_ROWS) {
      for (const v of [r.visitors_sum, r.pageviews]) {
        expect(v as number).toBeGreaterThanOrEqual(PRIVACY.min_count);
        expect((v as number) % PRIVACY.round_to).toBe(0);
      }
    }
  });
});
