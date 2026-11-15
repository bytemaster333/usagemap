// SPDX-License-Identifier: Apache-2.0
// `@usagemap/tracker/wallets` — wrappers for apps that call a wallet directly instead of through the Stellar
// Wallets Kit (plan B2, C-135, C-136): Freighter (`@stellar/freighter-api`), Albedo (`@albedo-link/intent`), xBull
// (`window.xBullSDK` or `@creit.tech/xbull-wallet-connect`), LOBSTR (`@lobstrco/signer-extension-api`), Hana
// (`window.hanaWallet.stellar`), HOT (`@hot-wallet/sdk`), any other injected SEP-43-style provider (D'CENT, Rabet,
// Klever, OneKey, Bitget, Cactus Link, Scopuly …), and the app's own transaction submission (Horizon, RPC).
//
// None of these wallets emits events, so the functions the app calls are wrapped. Each `wrap…` returns a wrapped
// VIEW of the object the app passes in and uses instead of the original:
//
//   import * as freighterApi from "@stellar/freighter-api";
//   import { wrapFreighter } from "@usagemap/tracker/wallets";
//   const freighter = wrapFreighter(freighterApi);
//   await freighter.requestAccess();               // → wallet_connect {wt: freighter, ck: new}
//
// The wallet object itself is never modified (ADR-0029: patching a wallet's signing object is what malicious scripts
// do), no global is enumerated, no extension message is listened to. Calls are delegated synchronously with the same
// arguments, so pop-ups still open inside the user's click, and return exactly what the wallet returns.
// Values read from results: presence of a non-empty address (boolean), a SEP-43 `code`, a `status`/`success` field.

import {
  type AdapterOptions,
  availabilityCall,
  type ConnectKind,
  connectCall,
  disconnectCall,
  horizonErrorClass,
  type Network,
  networkCall,
  networkOf,
  observe,
  optNetwork,
  optSubmit,
  patchMethods,
  type ResultClass,
  rpcPollClass,
  rpcSendClass,
  type SignKind,
  signCall,
  stellarEvent,
  type WalletState,
  type WalletType,
  type Wrappers,
  walletState,
  walletType,
  wrappedView,
} from "./stellar.js";

export type {
  AdapterOptions,
  Network,
  StellarEventName,
  StellarFields,
  WalletType,
} from "./stellar.js";
export { networkOf, stellarEvent, walletContext, walletType } from "./stellar.js";

type AnyFn = (...args: unknown[]) => unknown;
type Obj = object;

/** First argument's options object: `fn(xdr, opts)` → `opts`. */
const second = (a: unknown[]): unknown => a[1];
/** Albedo / Hana style: one params object `{xdr, network | networkPassphrase, submit}`. */
const first = (a: unknown[]): unknown => a[0];

const sign =
  (
    st: WalletState,
    kind: SignKind | ((a: unknown[]) => SignKind),
    net: (a: unknown[]) => unknown,
  ) =>
  (f: AnyFn): AnyFn =>
    signCall(st, f, typeof kind === "function" ? kind : () => kind, (a) => optNetwork(net(a)));

const connect =
  (st: WalletState, ck: ConnectKind) =>
  (f: AnyFn): AnyFn =>
    connectCall(st, f, ck);

/**
 * Freighter (`@stellar/freighter-api` ≥ 2 and the renamed `@stellar/varial-sdk`; the module namespace or its
 * default export). `requestAccess` → `wallet_connect` `new`; `getAddress` (silent while the site is allowed) →
 * `wallet_connect` `restored`; `signTransaction` (`tx`, or `tx_submit` with `{submit: true}`), `signAuthEntry`,
 * `signMessage` → `sign_*`; `getNetwork`/`getNetworkDetails` results set the network of later events; `isConnected`
 * (`{isConnected: false}` = extension not installed) is remembered for `wallet_connect_failed`. Freighter resolves
 * errors as `{error: {code}}` instead of rejecting; both are classified by the SEP-43 code. A `requestAccess` that
 * fails → `wallet_connect_failed` (`fr`: `user_rejected`, `wallet_not_installed`, `wallet_locked` for an answer with
 * no address and no error, `network_mismatch`, `timeout`, `error_other`).
 */
export function wrapFreighter<T extends Obj>(api: T, opts: AdapterOptions = {}): T {
  const st = walletState("freighter", opts);
  return wrappedView(api, {
    requestAccess: connect(st, "new"),
    getAddress: connect(st, "restored"),
    getPublicKey: connect(st, "restored"), // freighter-api 1.x
    signTransaction: sign(st, (a) => (optSubmit(a[1]) ? "tx_submit" : "tx"), second),
    signAuthEntry: sign(st, "auth_entry", second),
    signMessage: sign(st, "message", second),
    signBlob: sign(st, "message", second), // freighter-api 1.x
    getNetwork: (f) => networkCall(st, f),
    getNetworkDetails: (f) => networkCall(st, f),
    isConnected: (f) => availabilityCall(st, f),
  });
}

/**
 * Albedo (`@albedo-link/intent`, the default `albedo` object). Every intent opens Albedo's pop-up, so `publicKey`
 * is an explicit connect (`new`); `tx` → `sign_*` (`tx_submit` with `submit: true`; network from its `network`
 * parameter, `public`/`testnet` or a passphrase); `signMessage` → `sign_*` `message`.
 */
export function wrapAlbedo<T extends Obj>(albedo: T, opts: AdapterOptions = {}): T {
  const st = walletState("albedo", opts);
  return wrappedView(albedo, {
    publicKey: connect(st, "new"),
    tx: sign(st, (a) => (optSubmit(a[0]) ? "tx_submit" : "tx"), first),
    signMessage: sign(st, "message", first),
  });
}

/**
 * xBull: the extension's injected `window.xBullSDK` (`connect`, `getPublicKey`, `signXDR(xdr, {network})`) or an
 * `xBullWalletConnect` instance from `@creit.tech/xbull-wallet-connect` (`connect`, `sign({xdr, network})`,
 * `signMessage(message, {networkPassphrase})`). `connect` → `new`; `getPublicKey` → `restored`.
 */
export function wrapXBull<T extends Obj>(xbull: T, opts: AdapterOptions = {}): T {
  const st = walletState("xbull", opts);
  return wrappedView(xbull, {
    connect: connect(st, "new"),
    getPublicKey: connect(st, "restored"),
    signXDR: sign(st, "tx", second),
    sign: sign(st, "tx", first),
    signMessage: sign(st, "message", second),
  });
}

/**
 * LOBSTR signer extension (`@lobstrco/signer-extension-api`, the module namespace). `getPublicKey` asks the
 * extension for access → `new`; `signTransaction(xdr)` → `tx`; `signMessage(message)` → `message`. LOBSTR takes no
 * network argument: pass `networkPassphrase` here if the app knows it, otherwise the network is `unknown`.
 */
export function wrapLobstr<T extends Obj>(lobstr: T, opts: AdapterOptions = {}): T {
  const st = walletState("lobstr", opts);
  return wrappedView(lobstr, {
    getPublicKey: connect(st, "new"),
    signTransaction: sign(st, "tx", () => undefined),
    signMessage: sign(st, "message", () => undefined),
  });
}

/**
 * Hana (`window.hanaWallet.stellar`): `getPublicKey` → `new`; `signTransaction({xdr, networkPassphrase})` → `tx`;
 * `signAuthEntry({xdr})` → `auth_entry`; `signMessage({message})` / `signBlob({blob})` → `message`.
 */
export function wrapHana<T extends Obj>(hana: T, opts: AdapterOptions = {}): T {
  const st = walletState("hana", opts);
  return wrappedView(hana, {
    getPublicKey: connect(st, "new"),
    signTransaction: sign(st, "tx", first),
    signAuthEntry: sign(st, "auth_entry", first),
    signMessage: sign(st, "message", first),
    signBlob: sign(st, "message", first),
  });
}

/** HOT methods (`HOT.request(method, params)`, `@hot-wallet/sdk`, as the Wallets Kit 2.8.0 module calls it). */
const HOT_METHODS: Record<string, SignKind | "connect"> = {
  "stellar:getAddress": "connect",
  "stellar:signTransaction": "tx",
  "stellar:signAuthEntry": "auth_entry",
  "stellar:signMessage": "message",
};

/**
 * HOT Wallet (`HOT` from `@hot-wallet/sdk`): wraps `request(method, params)` and classifies by the method name:
 * `stellar:getAddress` → `wallet_connect` `new`; `stellar:signTransaction`/`signAuthEntry`/`signMessage` → `sign_*`.
 * Other methods pass through untouched. HOT's calls carry no network: pass `networkPassphrase` if known.
 */
export function wrapHot<T extends Obj>(hot: T, opts: AdapterOptions = {}): T {
  const st = walletState("hot", opts);
  const signers: Partial<Record<SignKind, AnyFn>> = {};
  let connector: AnyFn | undefined;
  return wrappedView(hot, {
    request: (f) =>
      function (this: unknown, ...args: unknown[]) {
        const role = typeof args[0] === "string" ? HOT_METHODS[args[0]] : undefined;
        if (!role) return f.apply(this, args);
        if (role === "connect") {
          connector ??= connectCall(st, f, "new");
          return connector.apply(this, args);
        }
        signers[role] ??= signCall(
          st,
          f,
          () => role,
          () => undefined,
        );
        return (signers[role] as AnyFn).apply(this, args);
      },
  });
}

/**
 * Documented globals of injected Stellar providers (Wallets Kit 2.8.0 modules), used only to NAME the provider the
 * app passed in, by identity. Never enumerated, never recorded: only the resulting wallet type is sent.
 */
const INJECTED: readonly [path: readonly string[], wt: WalletType][] = [
  [["dcentStellarProvider"], "dcent"],
  [["rabet"], "rabet"],
  [["hanaWallet", "stellar"], "hana"],
  [["kleverWallet", "stellar"], "klever"],
  [["$onekey", "stellar"], "onekey"],
  [["bitkeep", "stellar"], "bitget"],
  [["cactuslink_stellar"], "cactuslink"],
  [["scopuly"], "scopuly"],
  [["xBullSDK"], "xbull"],
];

const read = (root: unknown, path: readonly string[]): unknown => {
  let o = root;
  for (const k of path) {
    if (o === null || (typeof o !== "object" && typeof o !== "function")) return undefined;
    try {
      o = (o as Record<string, unknown>)[k];
    } catch {
      return undefined;
    }
  }
  return o;
};

/**
 * Wallet type of an injected provider object: by identity with a wallet's documented global, else by the detection
 * sentinel `window.stellar.provider` that D'CENT and Freighter Mobile inject (a frozen `{provider, platform}`
 * object) when the app passed that sentinel's own provider; any other provider is `injected_other`.
 */
export function detectInjectedWallet(provider: unknown): WalletType {
  if (provider === null || provider === undefined) return "unknown";
  const g = globalThis as unknown;
  for (const [path, wt] of INJECTED) if (read(g, path) === provider) return wt;
  const sentinel = read(g, ["stellar"]);
  if (sentinel === provider) {
    const named = walletType(read(sentinel, ["provider"]));
    if (named !== "unknown") return named;
  }
  return "injected_other";
}

export interface InjectedOptions extends AdapterOptions {
  /** The wallet type, when the app knows it (a Wallets Kit id or canonical name); otherwise detected. */
  wallet?: string;
}

/**
 * Any injected SEP-43-style provider (D'CENT `window.dcentStellarProvider`, Rabet, Klever, OneKey, Bitget, Cactus
 * Link, Scopuly …). `requestAccess`/`connect`/`getPublicKey` → `wallet_connect` `new`; `getAddress` (silent once
 * the site is allowed) → `restored`; `signTransaction(xdr, opts)` / `sign` → `tx` (`tx_submit` with `submit:
 * true`); `signAuthEntry` → `auth_entry`; `signMessage`/`signBlob` → `message`; `getNetwork` sets the network.
 * Rabet's `connect()` resolves `{publicKey}` and `sign(xdr, network)` takes the network as a string — both handled.
 */
export function wrapInjected<T extends Obj>(provider: T, opts: InjectedOptions = {}): T {
  const wt = opts.wallet ? walletType(opts.wallet) : detectInjectedWallet(provider);
  const st = walletState(wt, opts);
  const net2 = (a: unknown[]): unknown => (typeof a[1] === "string" ? { network: a[1] } : a[1]);
  return wrappedView(provider, {
    requestAccess: connect(st, "new"),
    connect: connect(st, "new"),
    getPublicKey: connect(st, "new"),
    getAddress: connect(st, "restored"),
    signTransaction: sign(st, (a) => (optSubmit(a[1]) ? "tx_submit" : "tx"), second),
    sign: sign(st, "tx", net2),
    signAuthEntry: sign(st, "auth_entry", second),
    signMessage: sign(st, "message", second),
    signBlob: sign(st, "message", second),
    disconnect: (f) => disconnectCall(st, f),
    getNetwork: (f) => networkCall(st, f),
  });
}

// ---- transaction submission ----

export interface SubmitOptions {
  /** Network of the server, when the transaction object does not carry `networkPassphrase` itself. */
  networkPassphrase?: string;
  /** The wallet that signed, if the app knows it (optional on `tx_submitted`). */
  wallet?: string;
  /** How long to wait for the app's own poll of a `PENDING`/`DUPLICATE` RPC submission before `pending` (30 s). */
  pollBoundMs?: number;
}

const txNetwork = (tx: unknown, fallback: Network): Network => {
  const n = networkOf((tx as { networkPassphrase?: unknown } | null)?.networkPassphrase);
  return n === "unknown" ? fallback : n;
};

/**
 * Horizon (`Horizon.Server` of `@stellar/stellar-sdk`): wraps `submitTransaction` in place on the instance →
 * `tx_submitted` with `rc` `success` (200), `failed` (400 with `tx_failed`/`op_*` codes), `pending` (504) or
 * `error`. Returns `detach()`.
 */
export function attachHorizonServer(server: Obj, opts: SubmitOptions = {}): () => void {
  const fallback = networkOf(opts.networkPassphrase);
  const wt = opts.wallet ? walletType(opts.wallet) : undefined;
  return patchMethods(server, {
    submitTransaction: (f) =>
      function (this: unknown, ...args: unknown[]) {
        const net = txNetwork(args[0], fallback);
        return observe(f, this, args, (ok, x) => {
          stellarEvent("tx_submitted", {
            rc: ok ? "success" : horizonErrorClass(x),
            net,
            ...(wt && { wt }),
          });
        });
      },
  });
}

/**
 * Soroban RPC (`rpc.Server` of `@stellar/stellar-sdk`): wraps `sendTransaction` in place → `tx_submitted` once per
 * submission: `ERROR` → `error`, `TRY_AGAIN_LATER` → `try_again_later`; `PENDING`/`DUPLICATE` wait for the app's own
 * `getTransaction`/`pollTransaction` of that submission (`SUCCESS` → `success`, `FAILED` → `failed`) and report
 * `pending` if it has not finished within `pollBoundMs`. The adapter makes no RPC call of its own; the submission's
 * hash is held in memory only to match the app's poll and is never sent. Returns `detach()`.
 */
export function attachRpcServer(server: Obj, opts: SubmitOptions = {}): () => void {
  const fallback = networkOf(opts.networkPassphrase);
  const wt = opts.wallet ? walletType(opts.wallet) : undefined;
  const bound = opts.pollBoundMs ?? 30_000;
  const waiting = new Map<string, { net: Network; timer: ReturnType<typeof setTimeout> }>();
  const report = (rc: ResultClass, net: Network): void => {
    stellarEvent("tx_submitted", { rc, net, ...(wt && { wt }) });
  };
  const settle = (hash: unknown, status: unknown): void => {
    if (typeof hash !== "string") return;
    const w = waiting.get(hash);
    const rc = rpcPollClass(status);
    if (!w || !rc) return;
    clearTimeout(w.timer);
    waiting.delete(hash);
    report(rc, w.net);
  };
  const poll: Wrappers[string] = (f) =>
    function (this: unknown, ...args: unknown[]) {
      const hash = args[0];
      return observe(f, this, args, (ok, v) => {
        if (ok) settle(hash, (v as { status?: unknown } | null)?.status);
      });
    };
  const detach = patchMethods(server, {
    sendTransaction: (f) =>
      function (this: unknown, ...args: unknown[]) {
        const net = txNetwork(args[0], fallback);
        return observe(f, this, args, (ok, v) => {
          if (!ok) return report("error", net);
          const r = v as { status?: unknown; hash?: unknown } | null;
          const rc = rpcSendClass(r?.status);
          if (rc !== "pending" || typeof r?.hash !== "string") return report(rc, net);
          const hash = r.hash;
          if (waiting.has(hash)) return; // a DUPLICATE resend of a submission already being followed
          const timer = setTimeout(() => {
            waiting.delete(hash);
            report("pending", net);
          }, bound);
          waiting.set(hash, { net, timer });
        });
      },
    getTransaction: poll,
    pollTransaction: poll,
  });
  return () => {
    for (const w of waiting.values()) clearTimeout(w.timer);
    waiting.clear();
    detach();
  };
}
