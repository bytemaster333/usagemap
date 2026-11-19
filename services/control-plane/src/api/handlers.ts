// SPDX-License-Identifier: Apache-2.0
// Tenant API analytics: services, declared contracts, ingest tokens, API metrics, data quality, assurance and the
// dual-export onboarding configuration (ADR-0009, ADR-0010, ADR-0016; data-model §8.6, §8.7, §8.11; C-21, C-22, C-103).

import type { Handler } from "../http/pipeline.ts";
import type { Peppers } from "../keys/keys.ts";
import { metricsHandlers } from "./metrics.ts";
import { otelHandlers } from "./otel.ts";
import { seedWarningHandlers } from "./seed-warning.ts";
import { contractHandlers, serviceHandlers } from "./services.ts";
import { tokenHandlers } from "./tokens.ts";

export interface ApiDeps {
  peppers: Peppers;
  /** Clock (tests). */
  now?: () => number;
  /** Public OTLP ingest base URL shown in the onboarding configuration (`SCF_OTLP_ENDPOINT`); placeholder when unset. */
  otlpEndpoint?: string | undefined;
}

export function apiHandlers(deps: ApiDeps): Record<string, Handler> {
  const clock = deps.now ? { now: deps.now } : {};
  return {
    ...serviceHandlers(),
    ...contractHandlers(),
    ...tokenHandlers({ peppers: deps.peppers, ...clock }),
    ...metricsHandlers(clock),
    ...otelHandlers({ otlpEndpoint: deps.otlpEndpoint }),
    ...seedWarningHandlers(),
  };
}
