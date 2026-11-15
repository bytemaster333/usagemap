// SPDX-License-Identifier: Apache-2.0
// `@usagemap/tracker/privy` — Privy embedded Stellar wallets (`@privy-io/react-auth` 3.52.0, Apache-2.0, read
// 2026-11-19: `extended-chains` entry `useCreateWallet`, `useSignRawHash`; `useLogin` callbacks). Stellar is a Privy
// "Tier 2" chain: the app creates the wallet with `createWallet({chainType: "stellar"})` and signs the transaction
// hash with `signRawHash({address, chainType: "stellar", hash})`.
//
//   import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
//   import { useLogin, usePrivy } from "@privy-io/react-auth";
//   import { privyLoginCallbacks, wrapPrivyStellar } from "@usagemap/tracker/privy";
//   const { createWallet } = wrapPrivyStellar(useCreateWallet(), { networkPassphrase });
//   const { signRawHash } = wrapPrivyStellar(useSignRawHash(), { networkPassphrase });
//   const { logout } = wrapPrivyStellar(usePrivy());
//   const { login } = useLogin(privyLoginCallbacks({ onComplete: (p) => { … } }));
//
// What it reads, and nothing else: the `chainType` argument (calls for other chains pass through untouched); whether
// a result carries a wallet address (a boolean); whether the user object lists a linked wallet whose `chainType` is
// `stellar` (a boolean); the login callback's `wasAlreadyAuthenticated` boolean and Privy's closed error code. Never
// the user, e-mail, login account, wallet id, address, hash or signature. Privy is never imported or bundled.
//
// All wrapped hook results share one per-page state (hooks return new objects on every render), so a connection is
// counted once until `logout`.

import {
  type AdapterOptions,
  connectFailed,
  disconnectCall,
  type FailReason,
  hasAddress,
  networkOf,
  observe,
  signCall,
  stellarEvent,
  type WalletState,
  walletState,
  wrappedView,
} from "./stellar.js";

export type { AdapterOptions, Network, StellarEventName, StellarFields } from "./stellar.js";
export { networkOf, stellarEvent, walletContext } from "./stellar.js";

let shared: WalletState | undefined;
/** The page's Privy wallet state; a `networkPassphrase` given later fills in an unknown network. */
function state(opts: AdapterOptions): WalletState {
  shared ??= walletState("privy", opts);
  const n = networkOf(opts.networkPassphrase);
  if (n !== "unknown" && shared.appNet === "unknown") shared.net = shared.appNet = n;
  if (opts.timeoutMs !== undefined) shared.timeoutMs = opts.timeoutMs;
  return shared;
}

/** Forget the page's Privy state (tests). */
export function resetPrivyState(): void {
  shared = undefined;
}

const stellarCall = (a: unknown[]): boolean =>
  a[0] !== null &&
  typeof a[0] === "object" &&
  (a[0] as { chainType?: unknown }).chainType === "stellar";

/** A Privy `createWallet` / `signRawHash` result's wallet carries an address (boolean only). */
const walletCreated = (v: unknown): boolean =>
  v !== null && typeof v === "object" && hasAddress((v as { wallet?: unknown }).wallet);

/** `fr` of a failed Privy call: Privy's closed `PrivyErrorCode` `exited_auth_flow` (or a SEP-43-style -4) →
 * `user_rejected`; the adapter's timeout → `timeout`; anything else → `error_other`. */
function privyFailReason(e: unknown): FailReason {
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : e;
  return code === "exited_auth_flow" || code === -4 ? "user_rejected" : "error_other";
}

/**
 * Wrap the object returned by Privy's `useCreateWallet()`, `useSignRawHash()` or `usePrivy()` (the hook result itself
 * is never modified). Only calls with `chainType: "stellar"` are observed:
 * - `createWallet({chainType: "stellar"})` → `wallet_connect {wt: privy, ck: new}` when it yields a wallet, else
 *   `wallet_connect_failed {wt: privy, fr}`;
 * - `signRawHash({chainType: "stellar", …})` → `sign_requested` / `sign_approved` / `sign_rejected` with `sk: tx`
 *   (Privy signs the transaction hash; the hash itself is never read);
 * - `logout()` → `wallet_disconnect` when a Stellar connection was counted.
 */
export function wrapPrivyStellar<T extends object>(hook: T, opts: AdapterOptions = {}): T {
  const st = state(opts);
  return wrappedView(hook, {
    createWallet: (f) =>
      function (this: unknown, ...args: unknown[]) {
        if (!stellarCall(args)) return f.apply(this, args);
        return observe(f, this, args, (ok, v) => {
          if (ok && walletCreated(v)) {
            if (st.connected) return;
            st.connected = true;
            stellarEvent("wallet_connect", { wt: "privy", net: st.net, ck: "new" });
          } else if (!st.connected) connectFailed(st, ok ? "error_other" : privyFailReason(v));
        });
      },
    signRawHash: (f) => {
      const signed = signCall(
        st,
        f,
        () => "tx",
        () => undefined,
      );
      return function (this: unknown, ...args: unknown[]) {
        return (stellarCall(args) ? signed : f).apply(this, args);
      };
    },
    logout: (f) => disconnectCall(st, f),
  });
}

/** Structural type of a Privy user: only `linkedAccounts[].type` and `.chainType` are read. */
interface PrivyUserLike {
  linkedAccounts?: readonly { type?: unknown; chainType?: unknown }[];
}

export interface PrivyLoginCallbacks {
  onComplete?: (params: {
    user: unknown;
    isNewUser: boolean;
    wasAlreadyAuthenticated: boolean;
    loginMethod: unknown;
    loginAccount: unknown;
  }) => void;
  onError?: (error: unknown) => void;
}

/**
 * Callbacks for Privy's `useLogin(...)`, wrapping the app's own (called unchanged, after the event):
 * - `onComplete` with a linked Stellar wallet → `wallet_connect {wt: privy}`, `ck: restored` when the user entered
 *   already authenticated, else `new` (a login without a Stellar wallet sends nothing);
 * - `onError` → `wallet_connect_failed {wt: privy, fr}` (`exited_auth_flow` → `user_rejected`, else `error_other`).
 */
export function privyLoginCallbacks<C extends PrivyLoginCallbacks>(
  callbacks: C = {} as C,
  opts: AdapterOptions = {},
): C {
  const st = state(opts);
  return {
    ...callbacks,
    onComplete: (params: Parameters<NonNullable<PrivyLoginCallbacks["onComplete"]>>[0]) => {
      try {
        const accounts = (params?.user as PrivyUserLike | null)?.linkedAccounts;
        const stellar =
          Array.isArray(accounts) &&
          accounts.some((a) => a?.type === "wallet" && a?.chainType === "stellar");
        if (stellar && !st.connected) {
          st.connected = true;
          stellarEvent("wallet_connect", {
            wt: "privy",
            net: st.net,
            ck: params?.wasAlreadyAuthenticated === true ? "restored" : "new",
          });
        }
      } catch {}
      return callbacks.onComplete?.(params);
    },
    onError: (error: unknown) => {
      if (!st.connected) connectFailed(st, privyFailReason(error));
      return callbacks.onError?.(error);
    },
  };
}
