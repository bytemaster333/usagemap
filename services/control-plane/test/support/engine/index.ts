// SPDX-License-Identifier: Apache-2.0
// The engine test stack for control-plane tests: our Umami 3.5.0 image behind the REAL engine proxy (mutual TLS),
// bootstrapped (B1–B5) and ready. Implementation and full API: packages/umami-adapter/test/support/engine-stack.ts.
//
//   import { startControlPlaneEngine } from "../support/engine/index.ts";
//   const { info, stop } = await startControlPlaneEngine();      // in beforeAll (hookTimeout ≥ 240 s)
//   const t = engineTools(info);
//   t.client("reader" | "provisioner" | "edge")                 // adapter HttpClient with that role's certificate
//   await t.adminToken()                                        // P1 token of the provisioning admin
//   await t.sendEvent(websiteId, { tag: "v", ts, surrogate: "2001:db8::1", url: "/", country: "DE",
//                                  referrer?, name?, visit?: "track" | "none" })   // POST /api/send as an edge
//   info.proxyUrl, info.ca, info.reader/.provisioner/.edge ({cert,key}), info.provisionerUser/.provisionerPassword
//   await stop()                                                // in afterAll (KEEP=1 keeps the stack)
//
// Compose project `scf-wsf-eng` (override: SCF_WSF_ENG_PROJECT); host ports 56148 (proxy mTLS) and 56149 (proxy
// metrics) — override with SCF_WSF_ENG_PROXY_PORT / SCF_WSF_ENG_METRICS_PORT when two runs share the machine. A test
// that needs a fake second core can use 56150–56154.

import {
  type EngineStackInfo,
  startEngineStack,
} from "../../../../../packages/umami-adapter/test/support/engine-stack.ts";

export {
  type EngineEvent,
  type EngineStackInfo,
  type EngineTools,
  engineTools,
} from "../../../../../packages/umami-adapter/test/support/engine-stack.ts";

export function startControlPlaneEngine(): Promise<{
  info: EngineStackInfo;
  stop: () => Promise<void>;
}> {
  return startEngineStack({
    project: process.env.SCF_WSF_ENG_PROJECT ?? "scf-wsf-eng",
    proxyPort: Number(process.env.SCF_WSF_ENG_PROXY_PORT ?? 56148),
    metricsPort: Number(process.env.SCF_WSF_ENG_METRICS_PORT ?? 56149),
  });
}
