// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { otelRecipe } from "../../../../apps/portal/test/fixtures/otel-recipes.ts";
import { alignSpan, autoResolution, planApiRange } from "../../src/api/metrics.ts";
import { otelConfig, type Stack, TOKEN_PLACEHOLDER } from "../../src/api/otel.ts";
import { ApiError } from "../../src/http/problem.ts";

const H = 3_600_000;
const D = 86_400_000;
const NOW = Date.UTC(2026, 10, 13, 12, 34, 56);

describe("API range planning (parameter resolution, C-86)", () => {
  it("auto picks 1m up to 6 h, 1h up to 31 days, else 1d", () => {
    expect(autoResolution({ start: 0, end: 6 * H })).toBe("1m");
    expect(autoResolution({ start: 0, end: 6 * H + 1 })).toBe("1h");
    expect(autoResolution({ start: 0, end: 31 * D })).toBe("1h");
    expect(autoResolution({ start: 0, end: 31 * D + 1 })).toBe("1d");
  });

  it("aligns outward to the bucket grid", () => {
    expect(alignSpan({ start: 90_500, end: 179_999 }, "1m")).toEqual({
      start: 60_000,
      end: 180_000,
    });
    expect(alignSpan({ start: H + 1, end: 2 * H }, "1h")).toEqual({ start: H, end: 2 * H });
    expect(alignSpan({ start: D - 1, end: D + 1 }, "1d")).toEqual({ start: 0, end: 2 * D });
  });

  it("24h is answered hourly, presets up to 30 days hourly, 90 days daily", () => {
    expect(planApiRange({ range: "24h" }, NOW, 0).res).toBe("1h");
    expect(planApiRange({ range: "24h" }, NOW, 0).span).toEqual({
      start: Math.floor((NOW - D) / H) * H,
      end: Math.ceil(NOW / H) * H,
    });
    expect(planApiRange({ range: "30d" }, NOW, 0).res).toBe("1h");
    expect(planApiRange({ range: "90d" }, NOW, 0).res).toBe("1d");
  });

  it("refuses resolutions outside their retention or above the point cap", () => {
    expect(() => planApiRange({ range: "90d" }, NOW, 0, "1m")).toThrow(ApiError);
    expect(() => planApiRange({ range: "all" }, NOW, NOW - 3000 * D, "1h")).toThrow(ApiError);
    expect(() => planApiRange({ range: "7d" }, NOW, 0, "1m")).toThrow(ApiError); // 10 080 points
    expect(
      planApiRange({ range: "7d" }, NOW, 0, "1d").span.end -
        planApiRange({ range: "7d" }, NOW, 0, "1d").span.start,
    ).toBe(7 * D);
  });
});

describe("onboarding configuration (S-06a/b quickstarts)", () => {
  const stacks: Stack[] = [
    "collector",
    "node",
    "nextjs",
    "python",
    "fastapi",
    "go",
    "rust",
    "java",
    "dotnet",
    "lambda",
    "vercel",
    "cloudflare_workers",
    "env_only",
  ];

  it("every stack carries the token placeholder and our endpoint, never a key", () => {
    for (const s of stacks) {
      const c = otelConfig(s, "my-api", "https://otlp.example.org/");
      const text = JSON.stringify(c);
      expect(c.env.SCF_OTLP_TOKEN, s).toBe(TOKEN_PLACEHOLDER);
      expect(text, s).toContain("https://otlp.example.org");
      expect(text, s).not.toContain("otlp.example.org//");
      expect(text, s).not.toContain("<OTLP_ENDPOINT>");
      expect(text, s).not.toContain("ingest.scf.example");
      expect(text, s).not.toMatch(/scfa_ing_[0-9A-Za-z]{12}_/);
      expect(c.notes.length, s).toBeGreaterThan(0);
    }
  });

  it("without a configured endpoint the text says to replace the placeholder", () => {
    const c = otelConfig("node", "my-api", undefined);
    expect(c.files[0]?.content).toContain("https://<OTLP_ENDPOINT>/v1/metrics");
    expect(c.notes.join(" ")).toContain("<OTLP_ENDPOINT>");
  });

  it("Rust warns that environment headers override the token (C-105)", () => {
    expect(otelConfig("rust", "x", undefined).notes.join(" ")).toMatch(
      /OTEL_EXPORTER_OTLP_HEADERS/,
    );
  });

  it("the texts are the portal's reference recipes, local-root SERVER spans only (C-107, C-119)", () => {
    const shared = [
      "collector",
      "node",
      "nextjs",
      "fastapi",
      "go",
      "rust",
      "java",
      "dotnet",
    ] as const;
    for (const s of shared) {
      const ours = otelConfig(s, "checkout-api", "https://otlp.example.org");
      const ref = otelRecipe(s, {
        endpoint: "https://otlp.example.org",
        serviceName: "checkout-api",
      });
      expect(ours.files, s).toEqual(ref.files);
      expect(ours.env, s).toEqual(ref.env);
      for (const n of ref.notes ?? []) expect(ours.notes, s).toContain(n);
    }
    const col = otelConfig("collector", "x", "https://o.example").files[0]?.content ?? "";
    expect(col).toContain("- span.kind != SPAN_KIND_SERVER");
    expect(col).toContain(
      "- not IsRootSpan() and (span.flags / 256) - (span.flags / 512) * 2 == 1 and (span.flags / 512) - (span.flags / 1024) * 2 == 0",
    );
    const next = otelConfig("nextjs", "x", "https://o.example").files[0]?.content ?? "";
    expect(next).toContain("!s.parentSpanContext || s.parentSpanContext.isRemote");
  });
});
