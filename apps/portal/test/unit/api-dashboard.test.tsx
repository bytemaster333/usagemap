// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// Tenant API dashboard pieces and the erasure/recipe helpers with the fixtures' known values (dashboard.api-*,
// isolation.api-dashboard, privacy.tenant-erasure).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseApiDashboardSearch,
  parseApiWizardSearch,
  parseOperatorSearch,
} from "../../src/lib/search.ts";
import {
  ApiSummaryTiles,
  DataQualityTable,
  RouteTable,
  SelfAttested,
  StatusDistribution,
} from "../../src/pages/ApiDashboard.tsx";
import { describeCriteria } from "../../src/pages/Erasure.tsx";
import { envLines } from "../../src/pages/OtelSetup.tsx";
import {
  apiRange,
  DATA_QUALITY_7D,
  EXPECTED_API,
  HORIZON_PREVIOUS,
  HORIZON_SUMMARY,
  ROUTES,
  RPC_STREAM_WARNING,
  RPC_SUMMARY,
  STATUS_CODES,
  SVC_HORIZON,
} from "../fixtures/api.ts";
import { otelRecipe } from "../fixtures/otel-recipes.ts";

afterEach(cleanup);
const range = apiRange("2026-11-06T00:00:00Z", "2026-11-13T00:00:00Z", "1h");

describe("ApiSummaryTiles", () => {
  it("shows volume, error rates and p50/p95/p99 with the accuracy class", () => {
    render(<ApiSummaryTiles summary={HORIZON_SUMMARY} />);
    expect(
      within(screen.getByTestId("tile-requests")).getByText(EXPECTED_API.requests),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-5xx")).getByText(EXPECTED_API.errorRate5xx),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-4xx")).getByText(EXPECTED_API.errorRate4xx),
    ).toBeTruthy();
    expect(within(screen.getByTestId("tile-p50")).getByText(EXPECTED_API.p50)).toBeTruthy();
    expect(within(screen.getByTestId("tile-p95")).getByText(EXPECTED_API.p95)).toBeTruthy();
    expect(within(screen.getByTestId("tile-p99")).getByText(EXPECTED_API.p99)).toBeTruthy();
    expect(screen.getByTestId("tile-p95").textContent).toContain("accuracy: ± 4.3 %");
    expect(screen.getByTestId("accuracy-note").textContent).toContain("within 4.3 %");
  });
  it("explicit 15-bucket layout: ≤ 5 ms and the bucket-width caveat", () => {
    render(<ApiSummaryTiles summary={RPC_SUMMARY} />);
    expect(within(screen.getByTestId("tile-p50")).getByText(EXPECTED_API.rpcP50)).toBeTruthy();
    expect(within(screen.getByTestId("tile-p95")).getByText(EXPECTED_API.rpcP95)).toBeTruthy();
    expect(screen.getByTestId("accuracy-note").textContent).toContain("17–18 %");
  });
  it("compares with the previous period", () => {
    render(<ApiSummaryTiles summary={HORIZON_SUMMARY} previous={HORIZON_PREVIOUS} />);
    expect(screen.getByTestId("tile-requests").textContent).toContain(
      `${EXPECTED_API.requestsDelta} vs previous period`,
    );
    expect(screen.getByTestId("tile-p95").textContent).toContain("+6.1% vs previous period");
  });
  it("no comparison when the previous period is missing", () => {
    render(<ApiSummaryTiles summary={HORIZON_SUMMARY} previous={null} />);
    expect(screen.getByTestId("tile-requests").textContent).toContain("No comparison");
  });
});

describe("self-attested label and stream groups", () => {
  it("states self-attestation and the stream-group warning", () => {
    render(
      <SelfAttested
        range={{
          ...range,
          stream_group: { kind: "mixed", warning: RPC_STREAM_WARNING },
          sampled_lower_bound: true,
        }}
      />,
    );
    expect(screen.getByTestId("self-attested").textContent).toContain("Self-attested telemetry");
    expect(screen.getByTestId("stream-warning").textContent).toContain(RPC_STREAM_WARNING);
    expect(screen.getByTestId("sampled-lower-bound")).toBeTruthy();
  });
});

describe("StatusDistribution", () => {
  it("lists classes with shares and the per-code breakdown", () => {
    render(
      <StatusDistribution
        codes={{ range, classes: HORIZON_SUMMARY.status, codes: STATUS_CODES[SVC_HORIZON] ?? [] }}
      />,
    );
    expect(screen.getByTestId("class-s2xx").textContent).toMatch(
      /2xx success\s*1,201,000\s*93\.50%/,
    );
    expect(screen.getByTestId("class-s5xx").textContent).toContain(EXPECTED_API.share5xx);
    expect(screen.getByTestId("status-codes").textContent).toContain("none reported");
  });
});

describe("RouteTable", () => {
  const rows = ROUTES[SVC_HORIZON] ?? [];
  it("shows routes with percentiles, accuracy and placeholder explanations", () => {
    const onPick = vi.fn();
    render(
      <RouteTable
        rows={rows}
        total={HORIZON_SUMMARY.requests}
        sort="-requests"
        onSort={() => {}}
        onPick={onPick}
      />,
    );
    const t = screen.getByTestId("route-table");
    expect(t.textContent).toContain("/accounts/{account_id}");
    expect(t.textContent).toContain(EXPECTED_API.transactionsP99);
    expect(t.textContent).toContain(EXPECTED_API.unknownP50);
    expect(screen.getByTestId("placeholder-help").textContent).toContain("route limit");
    expect(screen.getByTestId("placeholder-help").textContent).toContain("matched no route");
    fireEvent.click(screen.getByRole("button", { name: "/ledgers" }));
    expect(onPick).toHaveBeenCalledWith("/ledgers");
  });
  it("sorting toggles descending → ascending and announces the order", () => {
    const onSort = vi.fn();
    render(<RouteTable rows={rows} total={1} sort="-requests" onSort={onSort} onPick={() => {}} />);
    expect(screen.getByRole("columnheader", { name: /Requests/ }).getAttribute("aria-sort")).toBe(
      "descending",
    );
    fireEvent.click(screen.getByRole("button", { name: /^Requests/ }));
    expect(onSort).toHaveBeenCalledWith("requests");
    fireEvent.click(screen.getByRole("button", { name: /^p95/ }));
    expect(onSort).toHaveBeenCalledWith("-p95_ms");
  });
});

describe("DataQualityTable", () => {
  it("separates problems from filtering by design, in plain language", () => {
    render(
      <DataQualityTable
        dq={{ start: range.start, end: range.end, reasons: DATA_QUALITY_7D[SVC_HORIZON] ?? [] }}
      />,
    );
    const issues = screen.getByTestId("dq-issues").textContent ?? "";
    const design = screen.getByTestId("dq-design").textContent ?? "";
    expect(issues).toContain("The ingest token had expired.");
    expect(issues).toContain("1,960");
    expect(design).toContain("Metrics other than HTTP server duration");
    expect(design).toContain("120,400");
    expect(issues).not.toContain("metric_not_allowed");
  });
});

describe("erasure descriptions never invent a redacted selector", () => {
  const base = {
    request_id: "r",
    site_id: "s",
    service_id: null,
    scope: "filtered" as const,
    selector_redacted_at: null,
    status: "previewed" as const,
    created_at: "2026-11-01T00:00:00Z",
  };
  it("literal while kept, type and length once redacted", () => {
    const criteria = { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" };
    expect(
      describeCriteria({
        ...base,
        criteria: { ...criteria, path_pattern: "/users/jane/*" },
        selector: { type: "path_pattern", length: 13 },
      }),
    ).toBe("page path pattern “/users/jane/*”, 1 Oct 2026 – 31 Oct 2026");
    expect(
      describeCriteria({
        ...base,
        criteria: { ...criteria, path_pattern: null },
        selector: { type: "path_pattern", length: 13 },
      }),
    ).toBe("page path pattern (redacted, 13 characters), 1 Oct 2026 – 31 Oct 2026");
    expect(describeCriteria({ ...base, scope: "tenant", criteria, selector: null })).toContain(
      "Everything in this project",
    );
  });
});

describe("OpenTelemetry recipes (S-06a/S-06b)", () => {
  const r = (s: Parameters<typeof otelRecipe>[0]) =>
    JSON.stringify(otelRecipe(s, { endpoint: "https://otlp.example.invalid", serviceName: "svc" }));
  it("keep the tested fixes", () => {
    expect(r("node")).toContain("@opentelemetry/instrumentation/hook.mjs");
    expect(r("node")).toContain("OTEL_LOGS_EXPORTER");
    expect(r("fastapi")).toContain("OTEL_SEMCONV_STABILITY_OPT_IN");
    expect(r("fastapi")).toContain("lifespan");
    expect(r("nextjs")).toContain("NEXT_MANUAL_SIG_HANDLE");
    expect(r("nextjs")).toContain("parentSpanContext.isRemote");
    expect(r("collector")).toContain("IsRootSpan()");
    expect(r("collector")).toContain("SPAN_KIND_SERVER");
    expect(r("rust")).toContain("service.instance.id");
    expect(r("rust")).toMatch(/Unset OTEL_EXPORTER_OTLP_HEADERS/);
    expect(r("dotnet")).toContain("HttpProtobuf");
    expect(r("go")).toContain("resource.WithService()");
    expect(r("java")).toContain("detection/development");
  });
  it("every recipe dual-exports: the tenant's APM stays", () => {
    for (const s of ["node", "fastapi", "go", "java", "dotnet", "collector"] as const)
      expect(r(s)).toContain("apm");
    expect(r("nextjs")).toContain("'auto'");
  });
  it("environment lines are shell-safe", () => {
    expect(
      envLines({ A: "1", B: "<your APM key>", C: "service.instance.id=<unique per replica>" }),
    ).toBe("A=1\nB='<your APM key>'\nC='service.instance.id=<unique per replica>'");
  });
});

describe("search parsers", () => {
  it("API dashboard defaults and route", () => {
    expect(parseApiDashboardSearch({})).toEqual({
      range: "30d",
      compare: false,
      sort: "-requests",
    });
    expect(
      parseApiDashboardSearch({
        range: "7d",
        route: "{overflow}",
        sort: "p95_ms",
        compare: "true",
      }),
    ).toEqual({
      range: "7d",
      route: "{overflow}",
      sort: "p95_ms",
      compare: true,
    });
  });
  it("wizard rejects foreign ids and unknown steps", () => {
    expect(parseApiWizardSearch({ step: "nope", service: "../x", stack: "cobol" })).toEqual({
      step: "service",
      stack: "node",
    });
  });
  it("operator search keeps at most 6 valid ids and whole-number thresholds", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `a0000000-0000-4000-8000-00000000000${i}`);
    const s = parseOperatorSearch({ ids: [...ids, "x"], min: "12", min_level: "L9", band: "high" });
    expect(s.ids).toHaveLength(6);
    expect(s.min).toBe(12);
    expect(s.min_level).toBe("L1");
    expect(s.band).toBe("high");
    expect(parseOperatorSearch({ min: "1.5" }).min).toBeUndefined();
  });
});
