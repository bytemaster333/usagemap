// SPDX-License-Identifier: Apache-2.0
// Stellar event schema v1 (`scf-stellar-events/1`, wire-formats §a.3.1, C-136, C-137): the closed vocabulary shared
// by every wallet adapter, the allow-list serialiser, and the transparent call wrappers.
//
// Privacy rule (ADR-0029, C-45, C-136): every value that leaves the browser is a member of a closed list below. The
// adapters never read an address, transaction hash, XDR, amount, memo, signature, passphrase (beyond mapping it to a
// network in memory) or error text: wallet results are inspected only for the presence of a non-empty address (a
// boolean), a SEP-43 numeric `code`, an RPC/Horizon status, or a `success` boolean.
//
// The adapters do not bundle the tracker: they find the running instance (classic script or npm `init()`) through
// `Symbol.for("scf.tracker")` and call its `stellar()` method, which re-checks the shape. Without a running tracker,
// or while tracking is blocked (GPC, DNT, opt-out, no consent), nothing is sent.

/** Event names of schema v1. */
export const EVENTS = [
  "wallet_modal_opened",
  "wallet_modal_closed",
  "wallet_selected",
  "wallet_connect",
  "wallet_disconnect",
  "sign_requested",
  "sign_approved",
  "sign_rejected",
  "tx_submitted",
  "smart_wallet_created",
  "passkey_used",
  // schema v1 minor additions (tracker 1.2.0, C-136 versioning rule: gateway + storage first)
  "wallet_connect_failed",
  "walletconnect_session",
  "walletconnect_request",
] as const;
export type StellarEventName = (typeof EVENTS)[number];

/** Wallet type `wt`: Stellar Wallets Kit module ids mapped to canonical names, plus passkey / injected / unknown. */
export const WALLET_TYPES = [
  "freighter",
  "albedo",
  "xbull",
  "lobstr",
  "hana",
  "hot",
  "rabet",
  "walletconnect",
  "ledger",
  "trezor",
  "fordefi",
  "klever",
  "onekey",
  "bitget",
  "cactuslink",
  "dcent",
  "scopuly",
  "metamask",
  "ghostsig",
  "passkey",
  "privy",
  "injected_other",
  "unknown",
] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

export const NETWORKS = ["mainnet", "testnet", "futurenet", "local", "unknown"] as const;
export type Network = (typeof NETWORKS)[number];
export type ConnectKind = "new" | "restored";
export type SignKind = "tx" | "auth_entry" | "message" | "tx_submit";
export type ErrorClass =
  | "user_rejected"
  | "invalid_request"
  | "external_service"
  | "internal"
  | "timeout"
  | "unsupported"
  | "unknown";
export type ResultClass = "success" | "failed" | "pending" | "try_again_later" | "error";
export type Duration = "lt5s" | "5_30s" | "gt30s";
export type ModalOutcome = "connected" | "dismissed" | "error";
export type PasskeyOp = "register" | "authenticate" | "sign";
/** Why an explicit connect did not produce a usable connection (`wallet_connect_failed`). */
export type FailReason =
  | "user_rejected"
  | "wallet_not_installed"
  | "wallet_locked"
  | "network_mismatch"
  | "timeout"
  | "error_other";
/** Whether the page runs inside a wallet's in-app browser (from documented injected sentinels only). */
export type WalletContext =
  | "none"
  | "varial_inapp"
  | "dcent_inapp"
  | "scopuly_inapp"
  | "other_inapp"
  | "unknown";
/** WalletConnect session proposal / request state. */
export type WcState = "proposed" | "approved" | "rejected";
/** WalletConnect Stellar namespace method (`stellar_signXDR` …), as a closed enum. */
export type WcMethod = "sign_xdr" | "sign_submit_xdr" | "sign_message" | "sign_auth_entry";

export interface StellarFields {
  wt?: WalletType;
  net?: Network;
  ck?: ConnectKind;
  sk?: SignKind;
  ec?: ErrorClass;
  rc?: ResultClass;
  dur?: Duration;
  out?: ModalOutcome;
  po?: PasskeyOp;
  fr?: FailReason;
  wc?: WalletContext;
  ws?: WcState;
  wm?: WcMethod;
}

/** Closed list per wire key (schema `$defs/stellar`). */
export const ENUMS: Record<keyof StellarFields, readonly string[]> = {
  wt: WALLET_TYPES,
  net: NETWORKS,
  ck: ["new", "restored"],
  sk: ["tx", "auth_entry", "message", "tx_submit"],
  ec: [
    "user_rejected",
    "invalid_request",
    "external_service",
    "internal",
    "timeout",
    "unsupported",
    "unknown",
  ],
  rc: ["success", "failed", "pending", "try_again_later", "error"],
  dur: ["lt5s", "5_30s", "gt30s"],
  out: ["connected", "dismissed", "error"],
  po: ["register", "authenticate", "sign"],
  fr: [
    "user_rejected",
    "wallet_not_installed",
    "wallet_locked",
    "network_mismatch",
    "timeout",
    "error_other",
  ],
  wc: ["none", "varial_inapp", "dcent_inapp", "scopuly_inapp", "other_inapp", "unknown"],
  ws: ["proposed", "approved", "rejected"],
  wm: ["sign_xdr", "sign_submit_xdr", "sign_message", "sign_auth_entry"],
};

/**
 * Field placement per event (§a.3.1 table). Fields not listed for an event are never sent (the gateway would strip
 * and count them, `drop/profile_field_stripped`).
 */
export const PLACEMENT: Record<StellarEventName, readonly (keyof StellarFields)[]> = {
  wallet_modal_opened: [],
  wallet_modal_closed: ["out", "wt"],
  wallet_selected: ["wt"],
  wallet_connect: ["wt", "net", "ck", "wc"],
  wallet_disconnect: ["wt", "net"],
  sign_requested: ["wt", "net", "sk"],
  sign_approved: ["wt", "net", "sk", "dur"],
  sign_rejected: ["wt", "net", "sk", "dur", "ec"],
  tx_submitted: ["rc", "net", "wt"],
  smart_wallet_created: ["net", "wt"],
  passkey_used: ["po", "net"],
  wallet_connect_failed: ["wt", "net", "fr", "wc"],
  walletconnect_session: ["ws", "net", "wc"],
  walletconnect_request: ["wm", "net", "ws"],
};

/**
 * Wallet-id alias map, versioned with the tracker (§a.3.1). Keys are lower-cased. The Wallets Kit's own ids are not
 * all lower-case snake case: 2.8.0 uses `varial` (Freighter, renamed from `freighter`), `BitgetWallet`, `LEDGER`,
 * `TREZOR`, `wallet_connect` and `hot-wallet` (source at tag v2.8.0, `src/sdk/modules/*.module.ts`).
 */
const ALIASES: Record<string, WalletType> = {
  varial: "freighter",
  wallet_connect: "walletconnect",
  "wallet-connect": "walletconnect",
  hot_wallet: "hot",
  "hot-wallet": "hot",
  hotwallet: "hot",
  bitgetwallet: "bitget",
  bitkeep: "bitget",
  "d'cent": "dcent",
};

/** Canonical wallet type for a kit module id or wallet name; anything outside the alias map is `unknown`. */
export function walletType(id: unknown): WalletType {
  if (typeof id !== "string") return "unknown";
  const k = id.toLowerCase();
  const a = ALIASES[k];
  if (a) return a;
  return (WALLET_TYPES as readonly string[]).includes(k) ? (k as WalletType) : "unknown";
}

/** Network passphrases (verified 2026-11-16, `references/stellar-facts-check-2026-11-16.md` F3). */
const PASSPHRASES: Record<string, Network> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "local",
};

/**
 * Wallet network names that some wallet APIs use instead of a passphrase (Freighter `getNetwork().network`:
 * `PUBLIC`/`TESTNET`/`FUTURENET`/`STANDALONE`; Albedo intents: `public`/`testnet`). Same closed result.
 */
const NETWORK_NAMES: Record<string, Network> = {
  public: "mainnet",
  pubnet: "mainnet",
  mainnet: "mainnet",
  testnet: "testnet",
  futurenet: "futurenet",
  standalone: "local",
  local: "local",
};

/** In-memory mapping of a passphrase (or a wallet's network name) to the closed `net` list; never sent itself. */
export function networkOf(p: unknown): Network {
  if (typeof p !== "string") return "unknown";
  return PASSPHRASES[p] ?? NETWORK_NAMES[p.toLowerCase()] ?? "unknown";
}

/**
 * SEP-43 error class from an error's `code` only (SEP-43 v1.2.1: -1 internal, -2 external service, -3 invalid
 * request, -4 user rejected). WalletConnect's `USER_REJECTED` code `5000` and Privy's closed error code
 * `exited_auth_flow` are rejections by the user too. The message, `ext` and any other field are never read.
 */
export function errorClass(e: unknown): ErrorClass {
  if (e === TIMEOUT) return "timeout";
  if (e === UNSUPPORTED) return "unsupported";
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  switch (code) {
    case -4:
    case 5000:
    case "exited_auth_flow":
      return "user_rejected";
    case -3:
      return "invalid_request";
    case -2:
      return "external_service";
    case -1:
      return "internal";
    default:
      return "unknown";
  }
}

/**
 * Connect-failure reason (`fr`) of an explicit connect: the adapter's own timeout → `timeout`; SEP-43 code `-4` or
 * WalletConnect's `USER_REJECTED` code `5000` → `user_rejected`; a wallet the adapter saw report itself unavailable
 * (`isConnected` / `isAvailable` false) → `wallet_not_installed`; anything else → `error_other`. `wallet_locked`
 * (an answer without error and without address) and `network_mismatch` are decided by `connectCall`. Only the numeric
 * `code` is read, never the message.
 */
export function failReason(e: unknown, st?: WalletState): FailReason {
  if (e === TIMEOUT) return "timeout";
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  if (code === -4 || code === 5000) return "user_rejected";
  if (st?.installed === false) return "wallet_not_installed";
  return "error_other";
}

/**
 * Wallet context `wc`: whether the page runs inside a wallet's in-app browser. Reads exactly four documented
 * sentinel properties and nothing else — `window.stellar.provider` / `.platform` (injected by Varial (formerly
 * Freighter) Mobile and D'CENT; Stellar Wallets Kit 2.8.0 `varial.module`, `dcent.module`) and
 * `window.scopuly.platform` (`scopuly.module`) — compared with fixed strings. Never a version, never the User-Agent.
 * A sentinel whose `platform` is not a string → `unknown`; a desktop extension (`platform` other than `mobile`) or
 * no sentinel → `none`.
 */
export function walletContext(): WalletContext {
  try {
    const g = globalThis as { stellar?: unknown; scopuly?: unknown };
    const s = g.stellar;
    if (s !== null && typeof s === "object") {
      const { provider, platform } = s as { provider?: unknown; platform?: unknown };
      if (typeof platform !== "string") return "unknown";
      if (platform === "mobile") {
        return provider === "freighter" || provider === "varial"
          ? "varial_inapp"
          : provider === "dcent"
            ? "dcent_inapp"
            : "other_inapp";
      }
    }
    const sc = g.scopuly;
    if (sc !== null && typeof sc === "object") {
      const platform = (sc as { platform?: unknown }).platform;
      if (typeof platform !== "string") return "unknown";
      if (platform === "mobile") return "scopuly_inapp";
    }
    return "none";
  } catch {
    return "unknown";
  }
}

/** Sentinels for a call that did not answer within the adapter's timeout, and a method the wallet does not offer. */
export const TIMEOUT: unique symbol = Symbol("scf.timeout");
export const UNSUPPORTED: unique symbol = Symbol("scf.unsupported");

/** Duration bucket of a sign call. */
export const duration = (ms: number): Duration =>
  ms < 5e3 ? "lt5s" : ms <= 3e4 ? "5_30s" : "gt30s";

/** RPC `sendTransaction` status → result class (§a.3.1); `PENDING`/`DUPLICATE` are polled, so `pending` here. */
export function rpcSendClass(status: unknown): ResultClass {
  switch (status) {
    case "PENDING":
    case "DUPLICATE":
      return "pending";
    case "TRY_AGAIN_LATER":
      return "try_again_later";
    default:
      return "error";
  }
}

/** RPC `getTransaction` status after a poll: `SUCCESS` → success, `FAILED` → failed, otherwise still pending. */
export function rpcPollClass(status: unknown): ResultClass | undefined {
  return status === "SUCCESS" ? "success" : status === "FAILED" ? "failed" : undefined;
}

/**
 * Horizon `submitTransaction` failure → result class: `504` → pending; `400` with `tx_failed` or an `op_*` result
 * code → failed; anything else → error. Reads only the problem document's `status` and its result-code strings
 * (closed Horizon codes), never the envelope, hash or result XDR.
 */
export function horizonErrorClass(e: unknown): ResultClass {
  const o = e as {
    response?: {
      status?: unknown;
      extras?: unknown;
      data?: { status?: unknown; extras?: unknown };
    };
  } | null;
  const r = o?.response;
  const status = r?.status ?? r?.data?.status;
  const extras = (r?.extras ?? r?.data?.extras) as
    | { result_codes?: { transaction?: unknown; operations?: unknown } }
    | undefined;
  if (status === 504) return "pending";
  const codes = extras?.result_codes;
  if (status === 400 && codes) {
    if (codes.transaction === "tx_failed") return "failed";
    if (
      Array.isArray(codes.operations) &&
      codes.operations.some(
        (c) => typeof c === "string" && c.startsWith("op_") && c !== "op_success",
      )
    ) {
      return "failed";
    }
  }
  return "error";
}

// ---- sending ----

interface TrackerLike {
  stellar?: (name: string, fields?: Record<string, string>) => boolean;
}

/** Test and debugging seam: every serialised event, before it is handed to the tracker. */
let observer: ((name: StellarEventName, fields: Record<string, string>) => void) | undefined;
export function observeStellarEvents(
  fn: ((name: StellarEventName, fields: Record<string, string>) => void) | undefined,
): void {
  observer = fn;
}

/**
 * Allow-list serialiser: keeps only the fields placed on this event, and only closed-list values; then hands the
 * event to the running tracker. Returns whether the tracker took it.
 */
export function stellarEvent(name: StellarEventName, fields: StellarFields = {}): boolean {
  const place = PLACEMENT[name];
  if (!place) return false;
  if (place.includes("wc") && fields.wc === undefined) fields = { ...fields, wc: walletContext() };
  const out: Record<string, string> = {};
  for (const k of place) {
    const v = fields[k];
    if (typeof v === "string" && ENUMS[k].includes(v)) out[k] = v;
  }
  // `wt` on wallet_modal_closed only when connected (§a.3.1).
  if (name === "wallet_modal_closed" && out.out !== "connected") delete out.wt;
  observer?.(name, out);
  const t =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as Record<symbol, TrackerLike | undefined>)[Symbol.for("scf.tracker")];
  return t?.stellar?.(name, out) ?? false;
}

// ---- transparent call wrappers ----

export interface AdapterOptions {
  /**
   * The network passphrase (or Freighter/Albedo network name) the app uses, when the wallet call does not carry one.
   * Mapped to `mainnet`/`testnet`/`futurenet`/`local`/`unknown` in memory; never sent.
   */
  networkPassphrase?: string | undefined;
  /** Milliseconds after which an unanswered sign call is reported as `sign_rejected` with `ec: timeout` (120 s). */
  timeoutMs?: number | undefined;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

type AnyFn = (...args: unknown[]) => unknown;

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null &&
  (typeof v === "object" || typeof v === "function") &&
  typeof (v as { then?: unknown }).then === "function";

/**
 * Run `fn` (synchronously, with the caller's `this` and arguments — no `await` before delegating, so a wallet
 * pop-up still opens inside the user gesture) and observe how it settles. Returns exactly what `fn` returns: the same
 * value or promise, the same rejection, the same thrown error.
 */
export function observe(
  fn: AnyFn,
  self: unknown,
  args: unknown[],
  settled: (ok: boolean, valueOrError: unknown) => void,
): unknown {
  let r: unknown;
  try {
    r = fn.apply(self, args);
  } catch (e) {
    settled(false, e);
    throw e;
  }
  if (isThenable(r)) {
    r.then(
      (v) => settled(true, v),
      (e) => settled(false, e),
    );
  } else {
    settled(true, r);
  }
  return r;
}

/**
 * The error a wallet returned instead of throwing (Freighter API ≥ 2, D'CENT and Cactus Link resolve with
 * `{ …, error }`). Only its presence matters here; `errorClass` then reads its numeric `code`.
 */
export function returnedError(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "error" in v) {
    const e = (v as { error?: unknown }).error;
    if (e) return e;
  }
  return undefined;
}

/**
 * Whether a connect/getAddress result carries an address, as a boolean: a non-empty string, or an object with a
 * non-empty `address`, `publicKey` or `pubkey` string and no returned error. The address itself is never kept.
 */
export function hasAddress(v: unknown): boolean {
  if (typeof v === "string") return v.length > 0;
  if (v === null || typeof v !== "object" || returnedError(v)) return false;
  const o = v as { address?: unknown; publicKey?: unknown; pubkey?: unknown };
  return [o.address, o.publicKey, o.pubkey].some((a) => typeof a === "string" && a.length > 0);
}

/** Per-wallet state shared by the wrappers of one wallet: type, last known network, connected flag. */
export interface WalletState {
  wt: () => WalletType;
  /** last known network: the app's, then whatever the wallet reports */
  net: Network;
  /** the network the app said it uses (`networkPassphrase` option), fixed */
  appNet: Network;
  /** the network the wallet itself last reported (`getNetwork`), in memory */
  walletNet: Network;
  /** whether the wallet reported itself available (`isConnected` / `isAvailable`); undefined = not asked */
  installed?: boolean | undefined;
  connected: boolean;
  timeoutMs: number;
}

export function walletState(
  wt: WalletType | (() => WalletType),
  opts: AdapterOptions = {},
): WalletState {
  const net = networkOf(opts.networkPassphrase);
  return {
    wt: typeof wt === "function" ? wt : () => wt,
    net,
    appNet: net,
    walletNet: "unknown",
    connected: false,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** The network a call is for: its own passphrase/network argument if it has one, else the wallet's last known. */
export const callNetwork = (st: WalletState, p: unknown): Network => {
  const n = networkOf(p);
  return n === "unknown" ? st.net : n;
};

export interface SignHooks {
  /** extra events after the signature was approved (e.g. `tx_submitted` for sign-and-submit) */
  approved?: (value: unknown, net: Network) => void;
  /** extra events after the call failed */
  rejected?: (error: unknown, net: Network) => void;
  /**
   * The call resolves a result object whose `error` describes a later step, not the signature (smart-account-kit's
   * `signAndSubmit` resolves `{success: false, error}` when the signed transaction failed on submission).
   */
  resultErrorIsNotRejection?: boolean;
}

/**
 * Wrap one sign call: `sign_requested` now, then exactly one of `sign_approved` / `sign_rejected` (SEP-43 class, or
 * `timeout` when the wallet has not answered within `timeoutMs`; a late answer is then ignored).
 */
export function signCall(
  st: WalletState,
  fn: AnyFn,
  kind: (args: unknown[]) => SignKind,
  network: (args: unknown[]) => unknown,
  hooks: SignHooks = {},
): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const sk = kind(args);
    const net = callNetwork(st, network(args));
    const wt = st.wt();
    stellarEvent("sign_requested", { wt, net, sk });
    const t0 = Date.now();
    let done = false;
    const finish = (ok: boolean, x: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const dur = duration(Date.now() - t0);
      const err = ok ? (hooks.resultErrorIsNotRejection ? undefined : returnedError(x)) : x;
      if (ok && err === undefined) {
        stellarEvent("sign_approved", { wt, net, sk, dur });
        hooks.approved?.(x, net);
      } else {
        stellarEvent("sign_rejected", { wt, net, sk, dur, ec: errorClass(err) });
        hooks.rejected?.(err, net);
      }
    };
    const timer = setTimeout(() => finish(false, TIMEOUT), st.timeoutMs);
    return observe(fn, this, args, finish);
  };
}

let failures = 0;
/** How many `wallet_connect_failed` events adapters have reported on this page (lets one adapter avoid a second
 * report of the same failure seen through another path). */
export const connectFailureCount = (): number => failures;

/** `wallet_connect_failed` for this wallet: the app's network when it named one, else the last known. */
export function connectFailed(st: WalletState, fr: FailReason): void {
  failures++;
  stellarEvent("wallet_connect_failed", {
    wt: st.wt(),
    net: st.appNet !== "unknown" ? st.appNet : st.net,
    fr,
  });
}

/** Both networks known and different: the wallet is on another network than the app. */
const mismatch = (st: WalletState): boolean =>
  st.appNet !== "unknown" && st.walletNet !== "unknown" && st.appNet !== st.walletNet;

/**
 * Wrap a call that yields an address: `wallet_connect` (once until the next disconnect) when the result carries a
 * non-empty address. `ck` is `new` for an explicit access request and `restored` for a silent read of an already
 * authorised session (decided per method by the adapter).
 *
 * An explicit (`new`) call made while not connected has exactly one outcome: `wallet_connect`, or
 * `wallet_connect_failed` with `fr` — `failReason` of the error (thrown, rejected or returned as `{error}`),
 * `wallet_locked` when the wallet answered without an error but without an address, `network_mismatch` when the
 * wallet's own reported network differs from the app's `networkPassphrase` (the connection is then not counted), or
 * `timeout` when it has not answered within `timeoutMs` (a late answer is then ignored). A silent `restored` read
 * that yields nothing is normal and reports nothing.
 */
export function connectCall(
  st: WalletState,
  fn: AnyFn,
  ck: ConnectKind | ((args: unknown[]) => ConnectKind),
  onConnect?: () => void,
): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const kind = typeof ck === "function" ? ck(args) : ck;
    const explicit = kind === "new" && !st.connected;
    let done = false;
    const finish = (ok: boolean, v: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const err = ok ? returnedError(v) : v;
      if (ok && err === undefined && hasAddress(v)) {
        if (st.connected) return;
        if (explicit && mismatch(st)) {
          connectFailed(st, "network_mismatch");
          return;
        }
        st.connected = true;
        stellarEvent("wallet_connect", { wt: st.wt(), net: st.net, ck: kind });
        onConnect?.();
        return;
      }
      if (explicit && !st.connected)
        connectFailed(st, ok && err === undefined ? "wallet_locked" : failReason(err, st));
    };
    const timer = explicit ? setTimeout(() => finish(false, TIMEOUT), st.timeoutMs) : undefined;
    return observe(fn, this, args, finish);
  };
}

/** Wrap a disconnect call: `wallet_disconnect` when a connection was seen. */
export function disconnectCall(st: WalletState, fn: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    if (st.connected) {
      st.connected = false;
      stellarEvent("wallet_disconnect", { wt: st.wt(), net: st.net });
    }
    return fn.apply(this, args);
  };
}

/** Wrap a get-network call: remember the network it reports (passphrase or name), in memory only. Sends nothing. */
export function networkCall(st: WalletState, fn: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    return observe(fn, this, args, (ok, v) => {
      if (!ok || v === null || typeof v !== "object" || returnedError(v)) return;
      const o = v as { networkPassphrase?: unknown; network?: unknown };
      const n = networkOf(o.networkPassphrase);
      st.net = st.walletNet = n !== "unknown" ? n : networkOf(o.network);
    });
  };
}

/**
 * Wrap an availability probe (Freighter `isConnected` → `{isConnected}`, a kit module's `isAvailable` → boolean):
 * remember in memory whether the wallet is there, so a later failed connect can say `wallet_not_installed`.
 */
export function availabilityCall(st: WalletState, fn: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    return observe(fn, this, args, (ok, v) => {
      if (!ok) return;
      const a =
        typeof v === "boolean"
          ? v
          : v !== null && typeof v === "object" && !returnedError(v)
            ? (v as { isConnected?: unknown }).isConnected
            : undefined;
      if (typeof a === "boolean") st.installed = a;
    });
  };
}

/** `opts.networkPassphrase` / `opts.network` of an options-object argument (never anything else of it). */
export const optNetwork = (o: unknown): unknown =>
  o !== null && typeof o === "object"
    ? ((o as { networkPassphrase?: unknown }).networkPassphrase ??
      (o as { network?: unknown }).network)
    : undefined;

/** `opts.submit === true` of an options-object argument (SEP-43 `signTransaction`, Albedo `tx`). */
export const optSubmit = (o: unknown): boolean =>
  o !== null && typeof o === "object" && (o as { submit?: unknown }).submit === true;

// ---- wrapping objects ----

export type Wrappers = Record<string, (orig: AnyFn) => AnyFn>;

/**
 * A view of `target` in which the listed methods are wrapped: the target itself is never modified (wallet
 * providers and ES module namespaces stay untouched — ADR-0029 rejects patching a wallet's signing object). Every
 * other property reads through; functions are bound to the target so private fields and `this` keep working.
 * The proxy's own target is an empty stand-in, so frozen objects (whose properties a proxy of them could not
 * replace) can be wrapped too; keys, descriptors and the prototype are those of `target`.
 */
export function wrappedView<T extends object>(target: T, wrappers: Wrappers): T {
  const made = new Map<PropertyKey, { orig: unknown; fn: unknown }>();
  const read = (key: PropertyKey): unknown => {
    const v = Reflect.get(target, key, target);
    if (typeof v !== "function") return v;
    const hit = made.get(key);
    if (hit && hit.orig === v) return hit.fn;
    const w = typeof key === "string" ? wrappers[key] : undefined;
    const bound = (v as AnyFn).bind(target) as AnyFn;
    const fn = w ? w(bound) : bound;
    made.set(key, { orig: v, fn });
    return fn;
  };
  return new Proxy({} as T, {
    get: (_, key) => read(key),
    has: (_, key) => Reflect.has(target, key),
    ownKeys: () => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (_, key) => {
      const d = Reflect.getOwnPropertyDescriptor(target, key);
      if (!d) return undefined;
      return "value" in d
        ? { ...d, value: read(key), configurable: true }
        : { ...d, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    set: (_, key, v) => Reflect.set(target, key, v),
  });
}

const PATCHED = Symbol.for("scf.adapter");

/**
 * Wrap methods of `target` in place (own properties, so a prototype method is shadowed and an own one replaced),
 * for objects the app hands to an adapter that must also catch calls made through references the app keeps — the
 * Wallets Kit class, the passkey kits, a Horizon or RPC server. Wrapped once (a second attach is refused);
 * the returned function restores everything exactly.
 */
export function patchMethods(target: object, wrappers: Wrappers): () => void {
  const t = target as Record<string | symbol, unknown>;
  if (t[PATCHED]) throw new Error("scf: an adapter is already attached to this object");
  const restore: (() => void)[] = [];
  for (const key of Object.keys(wrappers)) {
    const orig = t[key];
    if (typeof orig !== "function") continue;
    const own = Object.hasOwn(t, key);
    const wrapped = (wrappers[key] as (o: AnyFn) => AnyFn)(orig as AnyFn);
    t[key] = function (this: unknown, ...args: unknown[]) {
      return wrapped.apply(this, args);
    };
    restore.push(() => {
      if (own) t[key] = orig;
      else delete t[key];
    });
  }
  Object.defineProperty(t, PATCHED, { value: true, configurable: true });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const r of restore) r();
    delete t[PATCHED];
  };
}
