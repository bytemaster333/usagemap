// SPDX-License-Identifier: Apache-2.0
// Spike: a Stellar Wallets Kit (v2.8.0) "analytics module" as a module *wrapper*.
//
//   StellarWalletsKit.init({ modules: withUsageMap(defaultModules()) });
//
// The kit's static methods always delegate through `StellarWalletsKit.selectedModule.<fn>(...)` at call time
// (src/sdk/kit.ts:123-170 at v2.8.0), and `init()` stores whatever `ModuleInterface[]` it is given
// (src/sdk/kit.ts:41-42). So wrapping the *modules* sees every connect/sign/submit, including calls made through a
// method reference copied before our code ran (Scaffold Stellar's `export const signTransaction =
// StellarWalletsKit.signTransaction`), which patching the class's static methods cannot see.
//
// Events use tracker schema v1 names and closed values only (tracker/src/stellar.ts). The wrapper reads: the module's
// `productId` (mapped to a wallet type), whether getAddress returned a non-empty string (boolean), a passphrase mapped
// to a network in memory, a numeric SEP-43 `code` on rejection, and `status` of signAndSubmitTransaction. It never
// reads or forwards addresses, XDR, signed payloads, messages or error text.

import { networkOf } from "./classify.ts";

export type Emit = (name: string, fields: Record<string, string>) => void;

/** SWK productId → tracker wallet type (`WALLET_TYPES`). Unknown ids become `injected_other`. */
const WT: Record<string, string> = {
  varial: "freighter",
  freighter: "freighter",
  albedo: "albedo",
  xbull: "xbull",
  lobstr: "lobstr",
  hana: "hana",
  "hot-wallet": "hot",
  rabet: "rabet",
  wallet_connect: "walletconnect",
  LEDGER: "ledger",
  TREZOR: "trezor",
  fordefi: "fordefi",
  klever: "klever",
  onekey: "onekey",
  BitgetWallet: "bitget",
  cactuslink: "cactuslink",
  dcent: "dcent",
  scopuly: "scopuly",
  metamask: "metamask",
  ghostsig: "ghostsig",
};
export const walletTypeOf = (id: unknown): string =>
  typeof id === "string" ? (WT[id] ?? "injected_other") : "unknown";

const errorClass = (e: unknown): string => {
  const c = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return c === -4
    ? "user_rejected"
    : c === -3
      ? "invalid_request"
      : c === -2
        ? "external_service"
        : c === -1
          ? "internal"
          : "unknown";
};
const dur = (ms: number) => (ms < 5e3 ? "lt5s" : ms <= 3e4 ? "5_30s" : "gt30s");

type AnyFn = (...a: unknown[]) => unknown;
const SIGN: Record<string, string> = {
  signTransaction: "tx",
  signAuthEntry: "auth_entry",
  signMessage: "message",
  signAndSubmitTransaction: "tx_submit",
};

export interface WrapOptions {
  emit: Emit;
  /** The app's network passphrase when sign calls do not carry one. */
  networkPassphrase?: string;
  now?: () => number;
}

/** Wrap one module. Everything except the five methods passes through to the original (same `this`). */
export function withUsageMapModule<M extends object>(mod: M, o: WrapOptions): M {
  const now = o.now ?? (() => performance.now());
  let net = networkOf(o.networkPassphrase);
  const wt = () => walletTypeOf((mod as { productId?: unknown }).productId);
  const safe = (f: () => void) => {
    try {
      f();
    } catch {}
  };
  const netOf = (opts: unknown) => {
    const p = opts && typeof opts === "object" ? (opts as { networkPassphrase?: unknown }).networkPassphrase : undefined;
    const n = networkOf(p);
    return n === "unknown" ? net : n;
  };
  const wrap = (name: string, f: AnyFn): AnyFn => {
    if (name === "getAddress")
      return (...a) => {
        const p = f.apply(mod, a) as Promise<{ address?: unknown }>;
        return Promise.resolve(p).then(
          (r) => {
            safe(() => {
              if (typeof r?.address === "string" && r.address.length > 0)
                o.emit("wallet_connect", { wt: wt(), net, ck: "new" });
            });
            return r;
          },
          (e) => {
            safe(() => o.emit("wallet_connect_failed", { wt: wt(), ec: errorClass(e) }));
            throw e;
          },
        );
      };
    if (name === "getNetwork")
      return (...a) =>
        Promise.resolve(f.apply(mod, a)).then((r) => {
          safe(() => {
            const n = networkOf((r as { networkPassphrase?: unknown })?.networkPassphrase);
            if (n !== "unknown") net = n;
          });
          return r;
        });
    if (name === "disconnect")
      return (...a) => {
        safe(() => o.emit("wallet_disconnect", { wt: wt(), net }));
        return f.apply(mod, a);
      };
    const sk = SIGN[name];
    if (sk)
      return (...a) => {
        const n = netOf(a[1]);
        const t0 = now();
        safe(() => o.emit("sign_requested", { wt: wt(), net: n, sk }));
        return Promise.resolve(f.apply(mod, a)).then(
          (r) => {
            safe(() => {
              o.emit("sign_approved", { wt: wt(), net: n, sk, dur: dur(now() - t0) });
              if (sk === "tx_submit") {
                const s = (r as { status?: unknown })?.status;
                o.emit("tx_submitted", { rc: s === "pending" ? "pending" : "success", net: n, wt: wt() });
              }
            });
            return r;
          },
          (e) => {
            safe(() => o.emit("sign_rejected", { wt: wt(), net: n, sk, dur: dur(now() - t0), ec: errorClass(e) }));
            throw e;
          },
        );
      };
    return f;
  };
  const cache = new Map<PropertyKey, AnyFn>();
  return new Proxy(mod, {
    get(target, prop, _recv) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      if (!(prop in SIGN) && prop !== "getAddress" && prop !== "getNetwork" && prop !== "disconnect")
        return (v as AnyFn).bind(target);
      let w = cache.get(prop);
      if (!w) {
        w = wrap(prop, v as AnyFn);
        cache.set(prop, w);
      }
      return w;
    },
  });
}

/** Wrap every module of a `ModuleInterface[]` (e.g. `defaultModules()`); pass the result to `StellarWalletsKit.init`. */
export const withUsageMap = <M extends object>(mods: M[], o: WrapOptions): M[] =>
  mods.map((m) => withUsageMapModule(m, o));
