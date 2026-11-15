// SPDX-License-Identifier: Apache-2.0
// Types generated from docs/api/control-plane.openapi.yaml and docs/api/operator-metrics.openapi.yaml, plus the parsed
// documents. Regenerate with `pnpm --filter @usagemap/api-types generate`; `test` fails when they are stale.

import { documentJson as controlPlaneJson } from "./control-plane.openapi.gen.ts";
import { documentJson as operatorMetricsJson } from "./operator-metrics.openapi.gen.ts";

export type * as ControlPlane from "./control-plane.gen.ts";
export { operationIds as controlPlaneOperationIds } from "./control-plane.gen.ts";
export type * as OperatorMetrics from "./operator-metrics.gen.ts";
export { operationIds as operatorMetricsOperationIds } from "./operator-metrics.gen.ts";

/** Minimal structural type of an OpenAPI 3.1 document as parsed from YAML. */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; [k: string]: unknown };
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

/** A fresh deep copy of the control-plane OpenAPI document (callers may annotate it, e.g. with `$id`). */
export function controlPlaneOpenApi(): OpenApiDocument {
  return JSON.parse(controlPlaneJson) as OpenApiDocument;
}

/** A fresh deep copy of the operator-metrics OpenAPI document. */
export function operatorMetricsOpenApi(): OpenApiDocument {
  return JSON.parse(operatorMetricsJson) as OpenApiDocument;
}
