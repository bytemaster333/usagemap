// SPDX-License-Identifier: Apache-2.0
// The js-stellar-sdk copy under test and the few places where its majors differ. vitest.config.ts runs the whole
// suite once per supported major by aliasing `@stellar/stellar-sdk` to `stellar-sdk-v13` … `stellar-sdk-v16` (exact
// pins in package.json); without an alias (plain `node`, the default project) it is the 17.x devDependency.
import * as sdk from "@stellar/stellar-sdk";
import type { Instrumentation, InstrumentOptions, ServerLike } from "../src/index.ts";
import { instrumentHorizon, instrumentStellarRpc } from "../src/index.ts";

export { sdk };

/** The exact version the vitest project expects to load (guards against an alias silently not applying). */
export const EXPECTED_VERSION = process.env.STELLAR_SDK_EXPECTED_VERSION;

type Any = Record<string, unknown>;
const rpcNs = sdk.rpc as unknown as Any;
const horizonNs = sdk.Horizon as unknown as Any;

/**
 * SDK 13.x to 14.3.0: servers have no `httpClient`; every server of the SDK copy uses the module-wide
 * `rpc.AxiosClient` / `Horizon.AxiosClient`. SDK ≥ 14.3.1: one `httpClient` per server.
 */
export const MODULE_SCOPE =
  (new sdk.rpc.Server("http://127.0.0.1:9", { allowHttp: true }) as unknown as Any).httpClient ===
  undefined;

interface PostClient {
  post(url: string, data?: unknown, config?: unknown): Promise<{ data: unknown; status: number }>;
}
/** The client a server really sends through (its own, or the module-wide one). */
export const rpcClient = (s: object): PostClient =>
  ((s as Any).httpClient ?? rpcNs.AxiosClient) as PostClient;
export const horizonClient = (s: object): PostClient =>
  ((s as Any).httpClient ?? horizonNs.AxiosClient) as PostClient;

/** What a user of this SDK major passes: the server itself, or the namespace on module-scope majors. */
export const rpcTarget = (s: object): ServerLike =>
  (MODULE_SCOPE ? sdk.rpc : s) as unknown as ServerLike;
export const horizonTarget = (s: object): ServerLike =>
  (MODULE_SCOPE ? sdk.Horizon : s) as unknown as ServerLike;

// Module-wide instrumentation outlives a test's server objects: every handle is detached after each test.
const live: Instrumentation[] = [];
const track = (h: Instrumentation) => {
  live.push(h);
  return h;
};
export const instrumentRpc = (s: object, o?: InstrumentOptions) =>
  track(instrumentStellarRpc(rpcTarget(s), o));
export const instrumentHz = (s: object, o?: InstrumentOptions) =>
  track(instrumentHorizon(horizonTarget(s), o));
export const detachAll = () => {
  for (const h of live.splice(0)) h.detach();
};

/** base64 XDR of an SDK XDR value: `toXdr` (17.x generated classes) or `toXDR` (js-xdr, 13.x to 16.x). */
export const b64 = (v: unknown): string => {
  const o = v as { toXdr?: (f: string) => string; toXDR?: (f: string) => string };
  return typeof o.toXdr === "function"
    ? o.toXdr("base64")
    : (o.toXDR as (f: string) => string)("base64");
};
