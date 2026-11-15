// SPDX-License-Identifier: Apache-2.0
// `@usagemap/tracker/wallets-kit` — Stellar Wallets Kit adapter (ADR-0029 Tier 1, C-136, C-137, plan B2).
//
//   import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
//   import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
//   attachWalletsKit(StellarWalletsKit);            // v2 (static class); v1: attachWalletsKitV1(kitInstance)
//
// What it reads (and nothing else): the kit's three events — `WALLET_SELECTED` (`payload.id`), `STATE_UPDATE`
// (whether `payload.address` is non-empty, as a boolean, and `payload.networkPassphrase` mapped to a network) and
// `DISCONNECT` —, a wallet module's `productId`, whether `getAddress` returned an address (a boolean), the SEP-43
// `code` of a rejected call, and `status` of `signAndSubmitTransaction`. It never reads the kit's storage, never
// touches wallet extensions, and sends only schema-v1 enums (§a.3.1).
//
// Sign calls are observed on the kit's **wallet modules**, not on its static methods: every v2 method (`sdk/kit.js`
// read at 2.0.0, 2.4.0 and 2.8.0) delegates at call time through the static getter `StellarWalletsKit.selectedModule`,
// so wrapping the module that getter returns also sees calls made through a method reference the app copied before
// attaching (Scaffold Stellar's `wallet.ts`: `export const signTransaction = StellarWalletsKit.signTransaction`),
// modules given to a later `init()`, and every wallet including WalletConnect. Apps that also call modules themselves
// (outside the kit) can wrap them at construction: `init({ modules: wrapWalletsKitModules(defaultModules()) })`.
//
// The kit is never imported or installed by this package: the app passes the class (v2), its instance (v1) or its
// module objects.

import {
  type AdapterOptions,
  availabilityCall,
  connectCall,
  connectFailed,
  connectFailureCount,
  disconnectCall,
  errorClass,
  failReason,
  hasAddress,
  type Network,
  networkCall,
  networkOf,
  observe,
  optNetwork,
  optSubmit,
  patchMethods,
  type ResultClass,
  signCall,
  stellarEvent,
  type WalletState,
  type WalletType,
  type WcMethod,
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

/** Structural type of the v2 kit (`StellarWalletsKit`, a static class); only the members used here. */
export interface WalletsKitV2Like {
  on(type: string, cb: (event: { eventType?: string; payload?: unknown }) => void): () => void;
  authModal?(...args: unknown[]): Promise<unknown>;
  signTransaction?(...args: unknown[]): Promise<unknown>;
  signAuthEntry?(...args: unknown[]): Promise<unknown>;
  signMessage?(...args: unknown[]): Promise<unknown>;
  signAndSubmitTransaction?(...args: unknown[]): Promise<unknown>;
  getNetwork?(...args: unknown[]): Promise<unknown>;
}

/** Structural type of a v1 kit instance (`new StellarWalletsKit({...})`, ≤ 1.9.5). */
export interface WalletsKitV1Like {
  openModal?(params: {
    onWalletSelected: (o: { id?: unknown }) => void;
    onClosed?: (e: unknown) => void;
  }): unknown;
  setWallet?(id: string): unknown;
  getAddress?(...args: unknown[]): Promise<unknown>;
  signTransaction?(...args: unknown[]): Promise<unknown>;
  signAuthEntry?(...args: unknown[]): Promise<unknown>;
  signMessage?(...args: unknown[]): Promise<unknown>;
  getNetwork?(...args: unknown[]): Promise<unknown>;
  disconnect?(...args: unknown[]): unknown;
}

/** The kit's event-type string values (`KitEventType` in v2.0–2.8: note `STATE_UPDATED` is `"STATE_UPDATE"`). */
const STATE = "STATE_UPDATE";
const SELECTED = "WALLET_SELECTED";
const DISCONNECT = "DISCONNECT";

/** `signAndSubmitTransaction` resolves `{status: "success" | "pending"}` (kit v2.8.0); a rejection with code -4 means
 * nothing was submitted. */
const submitClass = (v: unknown): ResultClass => {
  const s = v !== null && typeof v === "object" ? (v as { status?: unknown }).status : undefined;
  return s === "pending" ? "pending" : s === "success" || s === undefined ? "success" : "error";
};

const signWrappers = (st: ReturnType<typeof walletState>) => ({
  signTransaction: (f: AnyFn) =>
    signCall(
      st,
      f,
      (a) => (optSubmit(a[1]) ? "tx_submit" : "tx"),
      (a) => optNetwork(a[1]),
    ),
  signAuthEntry: (f: AnyFn) =>
    signCall(
      st,
      f,
      () => "auth_entry",
      (a) => optNetwork(a[1]),
    ),
  signMessage: (f: AnyFn) =>
    signCall(
      st,
      f,
      () => "message",
      (a) => optNetwork(a[1]),
    ),
  signAndSubmitTransaction: (f: AnyFn) =>
    signCall(
      st,
      f,
      () => "tx_submit",
      (a) => optNetwork(a[1]),
      {
        approved: (v, net) =>
          stellarEvent("tx_submitted", { rc: submitClass(v), net, wt: st.wt() }),
        rejected: (e, net) => {
          // A user rejection or an invalid request never reached the network; anything else may have.
          const ec = errorClass(e);
          if (ec !== "user_rejected" && ec !== "invalid_request") {
            stellarEvent("tx_submitted", { rc: "error", net, wt: st.wt() });
          }
        },
      },
    ),
  getNetwork: (f: AnyFn) => networkCall(st, f),
});

/** Structural type of a v2 wallet module (`ModuleInterface`); only `productId` is read. */
export interface WalletsKitModuleLike {
  productId?: unknown;
}

/** WalletConnect module method → the Stellar WalletConnect namespace method it requests (kit 2.8.0
 * `wallet-connect.module`: `stellar_signXDR`, `stellar_signAndSubmitXDR`, `stellar_signMessage`,
 * `stellar_signAuthEntry`). */
const WC_METHODS: Record<string, WcMethod> = {
  signTransaction: "sign_xdr",
  signAndSubmitTransaction: "sign_submit_xdr",
  signMessage: "sign_message",
  signAuthEntry: "sign_auth_entry",
};

/** WalletConnect chain id (`stellar:pubnet` / `stellar:testnet`) → network; anything else → unknown. */
const WC_CHAINS: Record<string, Network> = {
  "stellar:pubnet": "mainnet",
  "stellar:testnet": "testnet",
};

/**
 * The network of a WalletConnect session proposal, as the kit's module builds it: its `wcParams.allowedChains`, by
 * default `["stellar:pubnet"]`. One known chain → its network; several or unknown ones → `unknown`.
 */
const wcSessionNet = (mod: object): Network => {
  try {
    const chains = (mod as { wcParams?: { allowedChains?: unknown } }).wcParams?.allowedChains ?? [
      "stellar:pubnet",
    ];
    return Array.isArray(chains) && chains.length === 1
      ? (WC_CHAINS[String(chains[0])] ?? "unknown")
      : "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * WalletConnect funnel around a module's `getAddress` (a session proposal through `signClient.connect`):
 * `walletconnect_session {ws: proposed}` at the call, then `approved` when it yields an address or `rejected` when it
 * fails. A proposal the user never answers stays `proposed` (abandoned).
 */
const wcSession =
  (mod: object) =>
  (f: AnyFn): AnyFn =>
    function (this: unknown, ...args: unknown[]) {
      const net = wcSessionNet(mod);
      stellarEvent("walletconnect_session", { ws: "proposed", net });
      return observe(f, this, args, (ok, v) =>
        stellarEvent("walletconnect_session", {
          ws: ok && hasAddress(v) ? "approved" : "rejected",
          net,
        }),
      );
    };

/**
 * WalletConnect request around a module sign method: `walletconnect_request {wm, net, ws: approved | rejected}` when
 * it settles. `net` is the request's chain as the module picks it: `stellar:pubnet` for the public passphrase, else
 * `stellar:testnet`.
 */
const wcRequest =
  (wm: WcMethod) =>
  (f: AnyFn): AnyFn =>
    function (this: unknown, ...args: unknown[]) {
      const net: Network = networkOf(optNetwork(args[1])) === "mainnet" ? "mainnet" : "testnet";
      return observe(f, this, args, (ok, v) => {
        const err =
          ok && v !== null && typeof v === "object" ? (v as { error?: unknown }).error : undefined;
        stellarEvent("walletconnect_request", {
          wm,
          net,
          ws: ok && !err ? "approved" : "rejected",
        });
      });
    };

/** State a module view shares with the attached kit; the wallet's own network and availability stay the module's. */
const KIT_KEYS = new Set<PropertyKey>(["net", "appNet", "connected"]);

/** Module views made by this adapter (a view is never wrapped again). */
const VIEWS = new WeakSet<object>();
/** State of the attached v2 kit (a singleton), shared with module views so a connection is counted once. */
let attached: WalletState | undefined;

/**
 * A view of one kit module (the module itself is never modified; its methods run with the module as `this`): sign
 * calls → `sign_*` (and `tx_submitted`), `getAddress` with an address → `wallet_connect` (`ck: new`, once until a
 * disconnect) and without one → `wallet_connect_failed`, `disconnect` → `wallet_disconnect`, `getNetwork` and
 * `isAvailable` remembered in memory. `wt` is the module's own `productId`. The WalletConnect module also reports its
 * session proposals (`walletconnect_session`) and requests (`walletconnect_request`).
 */
function moduleView<M extends object>(mod: M, opts: AdapterOptions, kit?: WalletState): M {
  if (VIEWS.has(mod)) return mod;
  const own = walletState(() => walletType((mod as WalletsKitModuleLike).productId), opts);
  // connected/net of the attached kit when there is one (its events see restored sessions), else the module's own;
  // the wallet's own network and availability are always the module's.
  const s = (): WalletState => kit ?? attached ?? own;
  const shared = new Proxy(own, {
    get: (t, k) => Reflect.get(KIT_KEYS.has(k) ? s() : t, k),
    set: (t, k, v) => Reflect.set(KIT_KEYS.has(k) ? s() : t, k, v),
  });
  const wrappers: Record<string, (f: AnyFn) => AnyFn> = {
    ...signWrappers(own),
    isAvailable: (f) => availabilityCall(own, f),
    getAddress: (f) => connectCall(shared, f, "new"),
    disconnect: (f) =>
      function (this: unknown, ...args: unknown[]) {
        if (shared.connected) {
          shared.connected = false;
          stellarEvent("wallet_disconnect", { wt: own.wt(), net: shared.net });
        }
        return f.apply(this, args);
      },
  };
  if (own.wt() === "walletconnect") {
    const conn = wrappers.getAddress as (f: AnyFn) => AnyFn;
    wrappers.getAddress = (f) => wcSession(mod)(conn(f));
    for (const [k, wm] of Object.entries(WC_METHODS)) {
      const inner = wrappers[k];
      if (inner) wrappers[k] = (f) => wcRequest(wm)(inner(f));
    }
  }
  const v = wrappedView(mod, wrappers);
  VIEWS.add(v);
  return v;
}

/**
 * Wrap the kit's wallet modules where the app constructs them — `StellarWalletsKit.init({ modules:
 * wrapWalletsKitModules(defaultModules()) })` — for apps that also call a module directly (outside the kit). Each
 * module is replaced by a view (the module itself is untouched); views are recognised by `attachWalletsKit`, so using
 * both counts every event once. Without `attachWalletsKit`, a session the kit restores at launch is not reported.
 */
export function wrapWalletsKitModules<M extends object>(
  modules: M[],
  opts: AdapterOptions = {},
): M[] {
  return modules.map((m) => (m !== null && typeof m === "object" ? moduleView(m, opts) : m));
}

/**
 * Attach to Stellar Wallets Kit v2 (`StellarWalletsKit`, the static class), at any time after the app imported it.
 * Returns `detach()`, which unsubscribes and restores the class exactly (idempotent).
 *
 * Events: `wallet_selected` (a `WALLET_SELECTED` with an id, except the one replayed when subscribing), `wallet_connect`
 * (`ck: restored` for the address the kit restores at launch — `STATE_UPDATE` fires once synchronously on every
 * subscription — and `ck: new` for an address that appears later), `wallet_disconnect` (`DISCONNECT`),
 * `wallet_modal_opened`/`wallet_modal_closed` (wrapped `authModal`: `connected`, `dismissed` for the kit's
 * `code -1` "user closed the modal", else `error`), `sign_*` and `tx_submitted` (`signAndSubmitTransaction`) from the
 * selected wallet module, seen through the kit's `selectedModule` getter — so also for method references copied off
 * the class before this call and for modules given to a later `init()`. `wt` is the module's wallet; `net` the
 * network of the call (the kit adds its configured network to every sign call).
 *
 * Not seen: calls the app makes on a module object itself, outside the kit (wrap those modules with
 * `wrapWalletsKitModules`). A kit without the `selectedModule` accessor (2.0.0, 2.4.0 and 2.8.0 all have it) falls
 * back to wrapping the static sign methods, which misses references copied before attaching. One kit per page (the
 * v2 kit is a singleton).
 */
export function attachWalletsKit(kit: WalletsKitV2Like, opts: AdapterOptions = {}): () => void {
  if (!kit || typeof kit.on !== "function")
    throw new TypeError("scf: not a Stellar Wallets Kit v2 class");
  let id: WalletType = "unknown";
  const st = walletState(() => id, opts);
  // Every v2 method delegates through the static getter `selectedModule`: wrap the module it returns. A kit without
  // that accessor (not a released 2.x shape) gets its static sign methods wrapped instead, which cannot see method
  // references copied before this call.
  const acc = Object.getOwnPropertyDescriptor(kit, "selectedModule");
  const get = acc?.configurable ? acc.get : undefined;
  let picked = false; // a wallet was selected while the modal was open
  let modalOpen = false;
  const restore = patchMethods(kit, {
    ...(get ? {} : signWrappers(st)),
    authModal: (f) =>
      function (this: unknown, ...args: unknown[]) {
        stellarEvent("wallet_modal_opened");
        modalOpen = true;
        picked = false;
        const seen = connectFailureCount();
        return observe(f, this, args, (ok, x) => {
          modalOpen = false;
          const code = (x as { code?: unknown } | null)?.code;
          stellarEvent("wallet_modal_closed", {
            out: ok ? "connected" : code === -1 ? "dismissed" : "error",
            wt: st.wt(),
          });
          // The modal connects through the module itself (kit 2.8.0 `auth-options.page`: `activeModule.value
          // .getAddress()`), so a failed connect surfaces here as the modal's rejection. Any wallet code other than
          // the kit's -1 is a connect failure; -1 (the kit's "user closed the modal", but also what the kit's
          // `parseError` gives an error without a code) only after a wallet was picked. Not reported twice when a
          // module view already did.
          if (!ok && (code !== -1 || picked) && connectFailureCount() === seen)
            connectFailed(st, failReason(x, st));
        });
      },
  });
  if (get) {
    const views = new WeakMap<object, object>();
    Object.defineProperty(kit, "selectedModule", {
      ...acc,
      get(this: unknown) {
        const m: unknown = get.call(this);
        if (m === null || typeof m !== "object") return m;
        let v = views.get(m);
        if (!v) {
          v = moduleView(m, opts, st);
          views.set(m, v);
        }
        return v;
      },
    });
  }
  const undo = () => {
    if (get) Object.defineProperty(kit, "selectedModule", acc as PropertyDescriptor);
    restore();
    if (attached === st) attached = undefined;
  };
  attached = st;

  const subs: (() => void)[] = [];
  let initial = true;
  // The kit clears the address (STATE_UPDATE) and the selected id (WALLET_SELECTED) before it emits DISCONNECT, so
  // remember that we were connected; `id` keeps the last selected wallet because an id reset is ignored below.
  let wasConnected = false;
  try {
    subs.push(
      kit.on(SELECTED, (e) => {
        const raw = (e?.payload as { id?: unknown } | undefined)?.id;
        if (raw === undefined || raw === null) return; // reset on disconnect
        id = walletType(raw);
        if (modalOpen) picked = true;
        if (!initial) stellarEvent("wallet_selected", { wt: id });
      }),
    );
    subs.push(
      kit.on(STATE, (e) => {
        const p = e?.payload as { address?: unknown; networkPassphrase?: unknown } | undefined;
        const n = networkOf(p?.networkPassphrase);
        if (n !== "unknown") st.net = n;
        const has = typeof p?.address === "string" && p.address.length > 0;
        if (has && !st.connected) {
          st.connected = true;
          stellarEvent("wallet_connect", { wt: id, net: st.net, ck: initial ? "restored" : "new" });
        } else if (!has) {
          wasConnected ||= st.connected;
          st.connected = false;
        }
      }),
    );
    subs.push(
      kit.on(DISCONNECT, () => {
        if (wasConnected || st.connected)
          stellarEvent("wallet_disconnect", { wt: id, net: st.net });
        wasConnected = false;
        st.connected = false;
      }),
    );
  } catch (e) {
    for (const s of subs) s();
    undo();
    throw e;
  } finally {
    initial = false;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const s of subs.splice(0)) {
      try {
        s();
      } catch {}
    }
    undo();
  };
}

/**
 * Attach to a Stellar Wallets Kit v1 instance (`new StellarWalletsKit({...})`, ≤ 1.9.5), which has no event API: its
 * methods are wrapped in place on the instance. `openModal` → `wallet_modal_opened`, the modal's
 * `onWalletSelected` → `wallet_selected`, `onClosed` → `wallet_modal_closed` (`dismissed`); `getAddress` →
 * `wallet_connect` (`ck: new` after a wallet was picked in the modal on this page, `restored` otherwise); sign
 * methods → `sign_*`; `disconnect` → `wallet_disconnect`. Pass `networkPassphrase` (the kit's `network` option),
 * because a v1 kit does not expose it.
 */
export function attachWalletsKitV1(kit: WalletsKitV1Like, opts: AdapterOptions = {}): () => void {
  if (!kit || typeof kit !== "object")
    throw new TypeError("scf: not a Stellar Wallets Kit v1 instance");
  let id: WalletType = "unknown";
  let picked = false;
  const st = walletState(() => id, opts);
  return patchMethods(kit, {
    ...signWrappers(st),
    setWallet: (f) =>
      function (this: unknown, ...args: unknown[]) {
        const r = f.apply(this, args);
        id = walletType(args[0]);
        return r;
      },
    openModal: (f) =>
      function (this: unknown, ...args: unknown[]) {
        const p = args[0] as Parameters<NonNullable<WalletsKitV1Like["openModal"]>>[0] | undefined;
        if (!p || typeof p !== "object") return f.apply(this, args);
        stellarEvent("wallet_modal_opened");
        const params = {
          ...p,
          onWalletSelected: (o: { id?: unknown }) => {
            id = walletType(o?.id);
            picked = true;
            stellarEvent("wallet_selected", { wt: id });
            return p.onWalletSelected(o);
          },
          onClosed: (e: unknown) => {
            stellarEvent("wallet_modal_closed", { out: "dismissed" });
            return p.onClosed?.(e);
          },
        };
        return f.apply(this, [params, ...args.slice(1)]);
      },
    getAddress: (f) => connectCall(st, f, () => (picked ? "new" : "restored")),
    disconnect: (f) =>
      disconnectCall(st, function (this: unknown, ...args: unknown[]) {
        picked = false;
        return f.apply(this, args);
      }),
  });
}
