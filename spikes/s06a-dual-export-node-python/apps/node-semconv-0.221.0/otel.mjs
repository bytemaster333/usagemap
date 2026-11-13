// SPDX-License-Identifier: Apache-2.0
// Semconv boundary check: one exporter configured purely from OTEL_* env (single destination).
import { register } from "node:module";
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
import { NodeSDK } from "@opentelemetry/sdk-node";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
const sdk = new NodeSDK({ instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()] });
sdk.start();
process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
