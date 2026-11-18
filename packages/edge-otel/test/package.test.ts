// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { optionsFromEnv, tokenFromOtlpHeaders, VERSION } from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sources = readdirSync(join(root, "src")).map((f) => [
  f,
  readFileSync(join(root, "src", f), "utf8"),
]);

describe("package", () => {
  it("has no runtime dependencies and the version matches", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies).toBeUndefined();
    expect(VERSION).toBe(pkg.version);
    expect(pkg.license).toBe("Apache-2.0");
  });

  it("the source imports nothing outside itself (no node:, no packages)", () => {
    for (const [f, src] of sources) {
      for (const m of (src as string).matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)) {
        expect(m[1], f as string).toMatch(/^\.\/[a-z-]+\.ts$/);
      }
    }
  });

  it("privacy by construction: the source never reads headers, the query, cookies, the body or the client address", () => {
    for (const [f, src] of sources) {
      const code = (src as string).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const forbidden of [
        ".headers.",
        "headers.get",
        ".search",
        "searchParams",
        ".cookie",
        ".json()",
        ".text()",
        ".formData",
        ".arrayBuffer",
        "requestIP",
        "remoteAddr",
        "cf-connecting-ip",
        "x-forwarded-for",
        "user-agent",
        ".cf",
        "console.log",
      ]) {
        expect(code.includes(forbidden), `${f} uses ${forbidden}`).toBe(false);
      }
    }
  });
});

describe("environment variables", () => {
  it("reads the standard OTEL_* variables", () => {
    expect(
      optionsFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://e1.usagemap.dev",
        OTEL_EXPORTER_OTLP_HEADERS: "x-a=1, Authorization=Bearer%20scfa_ing_abc123def456",
        OTEL_SERVICE_NAME: "anchor-api",
      }),
    ).toEqual({
      endpoint: "https://e1.usagemap.dev",
      metricsEndpoint: undefined,
      token: "scfa_ing_abc123def456",
      serviceName: "anchor-api",
    });
  });

  it("USAGEMAP_* wins; the metrics endpoint is used only without USAGEMAP_ENDPOINT", () => {
    expect(
      optionsFromEnv({
        USAGEMAP_ENDPOINT: "https://e2.usagemap.dev",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://other/v1/metrics",
        USAGEMAP_TOKEN: "scfa_ing_t",
        USAGEMAP_SERVICE_NAME: "a",
        OTEL_SERVICE_NAME: "b",
      }),
    ).toEqual({
      endpoint: "https://e2.usagemap.dev",
      metricsEndpoint: undefined,
      token: "scfa_ing_t",
      serviceName: "a",
    });
    expect(
      optionsFromEnv({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://x/v1/metrics" })
        .metricsEndpoint,
    ).toBe("https://x/v1/metrics");
    expect(optionsFromEnv(undefined)).toEqual({
      endpoint: undefined,
      metricsEndpoint: undefined,
      token: undefined,
      serviceName: undefined,
    });
  });

  it("parses the Authorization entry of OTEL_EXPORTER_OTLP_HEADERS only", () => {
    expect(tokenFromOtlpHeaders("authorization=Bearer scfa_ing_1")).toBe("scfa_ing_1");
    expect(tokenFromOtlpHeaders("x-api-key=abc")).toBeUndefined();
    expect(tokenFromOtlpHeaders("Authorization=Basic%20abc")).toBeUndefined();
    expect(tokenFromOtlpHeaders("Authorization=%E0%A4%A")).toBeUndefined();
  });
});
