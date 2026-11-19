// SPDX-License-Identifier: Apache-2.0
// Dual-export onboarding configuration (getOtelConfig). The texts are the tested quickstarts of
// spikes/s06a-dual-export-node-python/README.md and spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md (C-102, C-105),
// kept in `otel-recipes.ts` identical to the portal's reference recipes, with the service name and our OTLP endpoint
// filled in. Span-only stacks send only local-root SERVER spans (C-107, C-119). The token is never re-displayed: every
// text carries the placeholder `<INGEST_TOKEN>` (through the variable SCF_OTLP_TOKEN). Stacks without a tested recipe
// get the tenant-Collector recipe and say so in `notes` — honesty over salesmanship.

import type { Handler } from "../http/pipeline.ts";
import { otelRecipe, TOKEN_PLACEHOLDER } from "./otel-recipes.ts";
import { loadService, visibleTenant } from "./services.ts";

export { TOKEN_PLACEHOLDER };

const ENDPOINT_PLACEHOLDER = "https://<OTLP_ENDPOINT>";

export type Stack =
  | "collector"
  | "node"
  | "nextjs"
  | "python"
  | "fastapi"
  | "go"
  | "rust"
  | "java"
  | "dotnet"
  | "lambda"
  | "vercel"
  | "cloudflare_workers"
  | "env_only";

interface Out {
  files: Array<{ filename: string; content: string }>;
  env: Record<string, string>;
  notes: string[];
}

const SELF_ATTESTED =
  "API metrics are self-attested telemetry: only the HTTP server duration metric (or local-root SERVER spans) leaves " +
  "your service for UsageMap; logs are refused.";

export function otelConfig(stack: Stack, service: string, endpointIn: string | undefined): Out {
  const endpoint = (endpointIn ?? ENDPOINT_PLACEHOLDER).replace(/\/+$/, "");
  const pre: string[] = [];
  if (!endpointIn)
    pre.push("Replace https://<OTLP_ENDPOINT> with the SCF OTLP endpoint shown in the portal.");
  pre.push(
    `Replace ${TOKEN_PLACEHOLDER} with an ingest token of this tenant; tokens are shown once at creation and never again.`,
  );
  const recipe = (s: Parameters<typeof otelRecipe>[0]) => {
    const r = otelRecipe(s, { endpoint, serviceName: service });
    return { files: r.files, env: { ...r.env }, notes: [...pre, ...r.notes] };
  };
  switch (stack) {
    case "collector":
    case "node":
    case "nextjs":
    case "fastapi":
    case "go":
    case "rust":
    case "java":
    case "dotnet":
      return recipe(stack);
    case "python":
      return recipe("fastapi");
    case "vercel": {
      const r = recipe("nextjs");
      r.notes.push(
        "On Vercel the 'auto' processor keeps Vercel's own export; set SCF_OTLP_TOKEN as a project environment variable. Tested with next start, not on Vercel's platform.",
      );
      return r;
    }
    case "lambda":
    case "cloudflare_workers": {
      const r = recipe("collector");
      r.notes.push(
        stack === "lambda"
          ? "No tested Lambda recipe yet: run the tenant Collector configuration above (for example as a Collector layer or a central Collector) and point the function's SDK at it. Short-lived functions must flush before returning."
          : "No tested Cloudflare Workers recipe yet: Workers have no OpenTelemetry metrics SDK; export SERVER spans to a tenant Collector running the configuration above.",
        SELF_ATTESTED,
      );
      return r;
    }
    case "env_only":
      return {
        files: [],
        env: {
          SCF_OTLP_TOKEN: TOKEN_PLACEHOLDER,
          OTEL_SERVICE_NAME: service,
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
          OTEL_EXPORTER_OTLP_METRICS_HEADERS: `Authorization=Bearer%20${TOKEN_PLACEHOLDER}`,
          OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
          OTEL_LOGS_EXPORTER: "none",
        },
        notes: [
          ...pre,
          "Environment-only setup sends this service's metrics to UsageMap only (no dual export); use stack=collector to keep your APM.",
          "Every metric the SDK produces is sent; UsageMap keeps only the HTTP server duration metric and drops the rest.",
          SELF_ATTESTED,
        ],
      };
  }
}

export function otelHandlers(deps: { otlpEndpoint?: string | undefined }): Record<string, Handler> {
  const getOtelConfig: Handler = async (ctx) => {
    const tenantId = visibleTenant(ctx);
    const s = await ctx.tx((tx) => loadService(tx, tenantId, ctx.params.serviceId as string));
    const stack = ctx.query.stack as Stack;
    return {
      status: 200,
      body: { stack, ...otelConfig(stack, s.service_name, deps.otlpEndpoint) },
    };
  };
  return { getOtelConfig };
}
