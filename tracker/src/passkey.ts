// SPDX-License-Identifier: Apache-2.0
// `@usagemap/tracker/passkey` — adapters for passkey smart wallets (plan B3, C-136, C-137):
// `passkey-kit` 0.20.0 (MIT, github.com/stellar/passkey-kit) and `smart-account-kit` 0.10.0 (Apache-2.0,
// github.com/stellar/smart-account-kit), both read at those versions on 2026-11-16.
//
//   import { attachPasskeyKit } from "@usagemap/tracker/passkey";
//   const detach = attachPasskeyKit(kit);              // kit = new PasskeyKit({...}) (or attachSmartAccountKit)
//
// EVENT NAME ONLY. The kits' event payloads carry the smart wallet's C-address, the passkey's key/credential id and
// transaction hashes; the listeners registered here take no argument, so none of it is ever read. Results of wrapped
// methods are inspected only for `success === true` (smart-account-kit submission results).
//
// Upstream events declared but never emitted (checked in source at the versions above — `emit(` call sites):
//   - `transactionSigned` and `transactionSubmitted` are declared in BOTH kits' event maps and emitted by neither,
//     so signing and submission are captured by wrapping the kit's sign/submit methods instead;
//   - also never emitted: passkey-kit `signerAdded`, `signerUpdated`, `signerRemoved`; smart-account-kit
//     `credentialDeleted` (none of them maps to a schema-v1 event).
//
// Methods are wrapped in place on the kit instance (so internal `this.method()` calls are seen too); `detach()`
// unsubscribes and restores them.

import {
  type AdapterOptions,
  connectFailed,
  type FailReason,
  networkOf,
  observe,
  patchMethods,
  type SignKind,
  signCall,
  stellarEvent,
  type WalletState,
  walletState,
} from "./stellar.js";

export type { AdapterOptions, Network, StellarEventName, StellarFields } from "./stellar.js";
export { networkOf, stellarEvent, walletContext } from "./stellar.js";

type AnyFn = (...args: unknown[]) => unknown;

interface EmitterLike {
  on(event: string, listener: () => void): () => void;
}

/** Structural type of `PasskeyKit` (passkey-kit 0.20.0); only the members used here. */
export interface PasskeyKitLike {
  readonly networkPassphrase?: string;
  readonly events: EmitterLike;
}

/** Structural type of `SmartAccountKit` (smart-account-kit 0.10.0); only the members used here. */
export interface SmartAccountKitLike {
  readonly networkPassphrase?: string;
  readonly events: EmitterLike;
}

const succeeded = (v: unknown): boolean =>
  v !== null && typeof v === "object" && (v as { success?: unknown }).success === true;

/** sign_* with `wt: passkey`, plus `passkey_used {po: sign}` when the passkey signed. */
const passkeySign =
  (st: WalletState, sk: SignKind, onApproved?: (v: unknown) => void) =>
  (f: AnyFn): AnyFn =>
    signCall(
      st,
      f,
      () => sk,
      () => undefined,
      {
        approved: (v, net) => {
          stellarEvent("passkey_used", { po: "sign", net });
          onApproved?.(v);
        },
        // signAndSubmit resolves {success: false, error} for a failed submission of a signed transaction.
        resultErrorIsNotRejection: onApproved !== undefined,
      },
    );

const resolved =
  (then: (v: unknown) => void) =>
  (f: AnyFn): AnyFn =>
    function (this: unknown, ...args: unknown[]) {
      return observe(f, this, args, (ok, v) => {
        if (ok) then(v);
      });
    };

/**
 * `fr` of a failed passkey connect, from the WebAuthn `DOMException` name only (a closed list of the Web
 * Authentication spec, compared with constants; the message is never read): `NotAllowedError` (the user cancelled
 * the ceremony, or it timed out — WebAuthn does not tell the two apart) → `user_rejected`; `NotSupportedError` (no
 * usable authenticator) → `wallet_not_installed`; anything else → `error_other`.
 */
export function passkeyFailReason(e: unknown): FailReason {
  const name = e !== null && typeof e === "object" ? (e as { name?: unknown }).name : undefined;
  return name === "NotAllowedError"
    ? "user_rejected"
    : name === "NotSupportedError"
      ? "wallet_not_installed"
      : "error_other";
}

const subscribe = (events: EmitterLike, map: Record<string, () => void>): (() => void)[] => {
  const subs: (() => void)[] = [];
  try {
    for (const [name, fn] of Object.entries(map)) subs.push(events.on(name, () => fn()));
  } catch (e) {
    for (const s of subs) s();
    throw e;
  }
  return subs;
};

const detacher = (subs: (() => void)[], restore: () => void) => (): void => {
  for (const s of subs.splice(0)) {
    try {
      s();
    } catch {}
  }
  restore();
};

/**
 * passkey-kit (`PasskeyKit`). Events: `walletCreated` → `smart_wallet_created` (emitted after the deployment was
 * confirmed on-chain, `confirmWalletCreation`); `walletConnected` → `wallet_connect` (`new`: every connect proves
 * fresh possession of the passkey); `walletDisconnected` → `wallet_disconnect`. Wrapped: `createKey` (also used by
 * `createWallet`) → `passkey_used {po: register}`; `connectWallet` → `passkey_used {po: authenticate}` (a rejected one → `wallet_connect_failed`,
 * `passkeyFailReason`); `sign`,
 * `signAuthEntry`, `signAdmin` → `sign_*` (`auth_entry`) and `passkey_used {po: sign}`. For submission through
 * `PasskeyServer.send`, use `attachPasskeyServer`.
 */
export function attachPasskeyKit(kit: PasskeyKitLike, opts: AdapterOptions = {}): () => void {
  if (!kit?.events || typeof kit.events.on !== "function")
    throw new TypeError("scf: not a PasskeyKit");
  const st = walletState("passkey", {
    ...opts,
    networkPassphrase: kit.networkPassphrase ?? opts.networkPassphrase,
  });
  const restore = patchMethods(kit, {
    createKey: resolved(() => stellarEvent("passkey_used", { po: "register", net: st.net })),
    connectWallet: (f) =>
      function (this: unknown, ...args: unknown[]) {
        return observe(f, this, args, (ok, v) => {
          if (ok) stellarEvent("passkey_used", { po: "authenticate", net: st.net });
          else if (!st.connected) connectFailed(st, passkeyFailReason(v));
        });
      },
    sign: passkeySign(st, "auth_entry"),
    signAuthEntry: passkeySign(st, "auth_entry"),
    signAdmin: passkeySign(st, "auth_entry"),
  });
  let subs: (() => void)[];
  try {
    subs = subscribe(kit.events, {
      walletCreated: () => stellarEvent("smart_wallet_created", { net: st.net, wt: "passkey" }),
      walletConnected: () => {
        st.connected = true;
        stellarEvent("wallet_connect", { wt: "passkey", net: st.net, ck: "new" });
      },
      walletDisconnected: () => {
        st.connected = false;
        stellarEvent("wallet_disconnect", { wt: "passkey", net: st.net });
      },
    });
  } catch (e) {
    restore();
    throw e;
  }
  return detacher(subs, restore);
}

/**
 * passkey-kit's `PasskeyServer` (relayer submission): `send` → `tx_submitted` (`success`/`failed` from the result's
 * `success` boolean; a thrown error → `error`). Returns `detach()`.
 */
export function attachPasskeyServer(server: object, opts: AdapterOptions = {}): () => void {
  const net = networkOf(opts.networkPassphrase);
  return patchMethods(server, {
    send: (f) =>
      function (this: unknown, ...args: unknown[]) {
        return observe(f, this, args, (ok, v) => {
          stellarEvent("tx_submitted", {
            rc: !ok ? "error" : succeeded(v) ? "success" : "failed",
            net,
            wt: "passkey",
          });
        });
      },
  });
}

/**
 * smart-account-kit (`SmartAccountKit`). Events: `credentialCreated` → `passkey_used {po: register}`;
 * `walletConnected` → `wallet_connect` (`restored` while the app's `connectWallet()` call is a silent restore — no
 * `prompt`/`fresh` option —, else `new`; also emitted by `createWallet({autoSubmit: true})` after a successful
 * deployment); `walletDisconnected` → `wallet_disconnect`. Wrapped: `createWallet` → `smart_wallet_created` when its
 * `submitResult.success` is true (without `autoSubmit` the app deploys the wallet itself: call
 * `stellarEvent("smart_wallet_created", {wt: "passkey", net})` after its own submission succeeds);
 * `authenticatePasskey` and `connectWallet({fresh: true})` → `passkey_used {po: authenticate}`; a
 * prompted (`prompt`/`fresh`) `connectWallet` that rejects → `wallet_connect_failed` (`passkeyFailReason`); `sign`, `signAdmin`,
 * `signAuthEntry` → `sign_*` (`auth_entry`); `signAndSubmit`, `signAndSubmitAdmin` (also used by `transfer` and
 * `executeAndSubmit`) → `sign_*` (`tx_submit`) and `tx_submitted` (`success`/`failed`); every approved signature →
 * `passkey_used {po: sign}`.
 */
export function attachSmartAccountKit(
  kit: SmartAccountKitLike,
  opts: AdapterOptions = {},
): () => void {
  if (!kit?.events || typeof kit.events.on !== "function")
    throw new TypeError("scf: not a SmartAccountKit");
  const st = walletState("passkey", {
    ...opts,
    networkPassphrase: kit.networkPassphrase ?? opts.networkPassphrase,
  });
  let silent = 0;
  const submitted = (v: unknown): void => {
    stellarEvent("tx_submitted", {
      rc: succeeded(v) ? "success" : "failed",
      net: st.net,
      wt: "passkey",
    });
  };
  const restore = patchMethods(kit, {
    createWallet: resolved((v) => {
      const r = (v as { submitResult?: unknown } | null)?.submitResult;
      if (succeeded(r)) stellarEvent("smart_wallet_created", { net: st.net, wt: "passkey" });
    }),
    authenticatePasskey: resolved(() =>
      stellarEvent("passkey_used", { po: "authenticate", net: st.net }),
    ),
    connectWallet: (f) =>
      function (this: unknown, ...args: unknown[]) {
        const o = args[0] as { prompt?: unknown; fresh?: unknown } | undefined;
        const quiet = !o?.prompt && !o?.fresh;
        if (quiet) silent++;
        return observe(f, this, args, (ok, v) => {
          if (quiet) silent--;
          if (ok && v && o?.fresh)
            stellarEvent("passkey_used", { po: "authenticate", net: st.net });
          // A silent restore that finds nothing is normal; a prompted connect that fails is a connect failure.
          if (!ok && !quiet && !st.connected) connectFailed(st, passkeyFailReason(v));
        });
      },
    sign: passkeySign(st, "auth_entry"),
    signAdmin: passkeySign(st, "auth_entry"),
    signAuthEntry: passkeySign(st, "auth_entry"),
    signAndSubmit: passkeySign(st, "tx_submit", submitted),
    signAndSubmitAdmin: passkeySign(st, "tx_submit", submitted),
  });
  let subs: (() => void)[];
  try {
    subs = subscribe(kit.events, {
      credentialCreated: () => stellarEvent("passkey_used", { po: "register", net: st.net }),
      walletConnected: () => {
        st.connected = true;
        stellarEvent("wallet_connect", {
          wt: "passkey",
          net: st.net,
          ck: silent > 0 ? "restored" : "new",
        });
      },
      walletDisconnected: () => {
        st.connected = false;
        stellarEvent("wallet_disconnect", { wt: "passkey", net: st.net });
      },
    });
  } catch (e) {
    restore();
    throw e;
  }
  return detacher(subs, restore);
}
