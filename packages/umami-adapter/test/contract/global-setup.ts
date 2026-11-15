// SPDX-License-Identifier: Apache-2.0
// Starts our Umami 3.5.0 image behind the REAL engine proxy with mutual TLS for the contract tests (compose project
// `scf-wsf`, host ports 56141 = proxy mTLS listener, 56147 = proxy metrics; this suite's range is 56140–56159). The
// bootstrap B1–B5 is part of the suite itself. KEEP=1 leaves the stack running.

import type { TestProject } from "vitest/node";
import { type EngineStackInfo, startEngineStack } from "../support/engine-stack.ts";

declare module "vitest" {
  export interface ProvidedContext {
    engine: EngineStackInfo;
  }
}

export default async function setup(p: TestProject): Promise<() => Promise<void>> {
  const { info, stop } = await startEngineStack({
    project: process.env.SCF_WSF_CONTRACT_PROJECT ?? "scf-wsf",
    proxyPort: Number(process.env.SCF_WSF_CONTRACT_PROXY_PORT ?? 56141),
    metricsPort: Number(process.env.SCF_WSF_CONTRACT_METRICS_PORT ?? 56147),
    skipBootstrap: true,
  });
  p.provide("engine", info);
  return stop;
}
