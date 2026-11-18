// SPDX-License-Identifier: Apache-2.0
// Options from environment variables, so the same variables work for the edge
// middleware and for any OpenTelemetry SDK (docs/onboarding/api-otel.md):
//
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT  full metrics URL (wins)
//   OTEL_EXPORTER_OTLP_ENDPOINT          base URL ("/v1/metrics" is appended)
//   OTEL_EXPORTER_OTLP_HEADERS           "Authorization=Bearer%20scfa_ing_…"
//   OTEL_SERVICE_NAME                    service.name
//   USAGEMAP_ENDPOINT / USAGEMAP_TOKEN / USAGEMAP_SERVICE_NAME  shorter equivalents (win over OTEL_*)
//
// Workers: pass `env`; Deno: `Deno.env.toObject()`; Bun / Node / Vercel: `process.env`.

import type { RecorderOptions } from "./recorder.ts";

type Env = Readonly<Record<string, unknown>> | undefined | null;

const str = (env: Env, key: string): string | undefined => {
  const v = env?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** The bearer token from an OTEL_EXPORTER_OTLP_HEADERS value (W3C baggage-style list, values percent-encoded). */
export function tokenFromOtlpHeaders(headers: string | undefined): string | undefined {
  if (!headers) return undefined;
  for (const pair of headers.split(",")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    if (pair.slice(0, i).trim().toLowerCase() !== "authorization") continue;
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(i + 1).trim());
    } catch {
      return undefined;
    }
    const m = /^Bearer\s+(\S+)$/i.exec(value);
    return m?.[1];
  }
  return undefined;
}

/** Read endpoint, token and service name from an environment object. Missing values stay undefined. */
export function optionsFromEnv(
  env: Env,
): Pick<RecorderOptions, "endpoint" | "metricsEndpoint" | "token" | "serviceName"> {
  return {
    endpoint: str(env, "USAGEMAP_ENDPOINT") ?? str(env, "OTEL_EXPORTER_OTLP_ENDPOINT"),
    metricsEndpoint: str(env, "USAGEMAP_ENDPOINT")
      ? undefined
      : str(env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
    token:
      str(env, "USAGEMAP_TOKEN") ?? tokenFromOtlpHeaders(str(env, "OTEL_EXPORTER_OTLP_HEADERS")),
    serviceName: str(env, "USAGEMAP_SERVICE_NAME") ?? str(env, "OTEL_SERVICE_NAME"),
  };
}
