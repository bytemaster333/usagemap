// SPDX-License-Identifier: Apache-2.0
// Behavioural mocks of the wallet libraries the adapters wrap — never a real wallet. Each mirrors the upstream API
// shape and event timing read in source (Stellar Wallets Kit v2.8.0 `src/sdk/kit.ts`, v1.9.5; passkey-kit 0.20.0;
// smart-account-kit 0.10.0; the Wallets Kit's wallet modules for Freighter, Albedo, xBull, LOBSTR, Hana, HOT, D'CENT),
// and every result, argument and error carries canary addresses, hashes, XDR and text.

import { CANARY } from "./canary.ts";

export const PUBLIC = "Public Global Stellar Network ; September 2015";
export const TESTNET = "Test SDF Network ; September 2015";

type Cb = (e: { eventType: string; payload: Record<string, unknown> }) => void;
export type Behaviour = (...args: unknown[]) => Promise<unknown>;

export const approve =
  (value: unknown = { signedTxXdr: CANARY.XDR, signerAddress: CANARY.G }): Behaviour =>
  () =>
    Promise.resolve(value);
export const reject =
  (code?: number): Behaviour =>
  () =>
    Promise.reject(
      code === undefined
        ? new Error(CANARY.MESSAGE)
        : { code, message: CANARY.MESSAGE, ext: [CANARY.G] },
    );
export const never: Behaviour = () => new Promise(() => {});

/**
 * A Wallets Kit 2.x wallet module (`ModuleInterface`, e.g. `src/sdk/modules/hana.module.ts` at v2.8.0): a class
 * instance with a private field, so a wrapper must call it with the module itself as `this`. Every result carries
 * canaries. `signAndSubmitTransaction` exists only on modules that support it (WalletConnect, in 2.8.0).
 */
export class MockKitModule {
  #address: string = CANARY.G;
  moduleType = "HOT_WALLET";
  productName = "Wallet";
  productUrl = "https://example.org";
  productIcon = "";
  productId: string;
  constructor(productId: string) {
    this.productId = productId;
    if (productId === "wallet_connect")
      this.signAndSubmitTransaction = approve({ status: "success", hash: CANARY.HASH });
  }
  signTransaction: Behaviour = approve();
  signAuthEntry: Behaviour = approve({ signedAuthEntry: CANARY.XDR, signerAddress: CANARY.G });
  signMessage: Behaviour = approve({
    signedMessage: CANARY.SIGNED_MESSAGE,
    signerAddress: CANARY.G,
  });
  signAndSubmitTransaction?: Behaviour;
  async isAvailable() {
    return true;
  }
  async getAddress() {
    return { address: this.#address };
  }
  async getNetwork() {
    return { network: "TESTNET", networkPassphrase: TESTNET };
  }
  disconnects = 0;
  async disconnect() {
    this.disconnects++;
  }
}

export interface KitV2Options {
  /** a kit without the static `selectedModule` accessor (not a released 2.x shape: exercises the fallback) */
  noAccessor?: boolean;
}

/**
 * Stellar Wallets Kit v2 (static class, module-level state), as in `src/sdk/kit.ts` at v2.0.0–v2.8.0:
 * - `init({modules})` stores the module list; `setWallet(id)` selects one of them (unknown ids throw);
 * - every wallet method delegates at call time through the static getter `StellarWalletsKit.selectedModule` (the
 *   class name, not `this`, so a method reference copied off the class still reaches the getter), which throws
 *   `{code: -3}` while no wallet is selected;
 * - the auth modal's wallet list calls the active module's `getAddress()` directly (`auth-options.page.ts`), not
 *   through the getter; `disconnect()` calls the active module's `disconnect()`, resets id and address (firing
 *   those effects) and then emits `DISCONNECT`;
 * - `on(STATE_UPDATE)` fires synchronously on subscription (the network signal is always set), `on(WALLET_SELECTED)`
 *   only when an id was restored.
 * Without `init`, a module is created for any id on first selection (test convenience).
 */
export function makeKitV2(
  restored?: { id: string; address: string; network?: string },
  opts: KitV2Options = {},
) {
  let address: string | undefined = restored?.address;
  let network = restored?.network ?? PUBLIC;
  let selected: string | undefined = restored?.id;
  let modules: MockKitModule[] | undefined;
  const created = new Map<string, MockKitModule>();
  const state = new Set<() => void>();
  const selCbs = new Set<() => void>();
  const disc = new Set<Cb>();
  let modal: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined;
  const fireState = () => {
    for (const f of [...state]) f();
  };
  const fireSel = () => {
    for (const f of [...selCbs]) f();
  };
  /** the kit's `activeModule` signal: the module of the selected id, from the list given to `init` */
  const active = (): MockKitModule | undefined => {
    if (selected === undefined) return undefined;
    if (modules) return modules.find((m) => m.productId === selected);
    let m = created.get(selected);
    if (!m) {
      m = new MockKitModule(selected);
      created.set(selected, m);
    }
    return m;
  };
  const selectedModule = (): MockKitModule => {
    const m = active();
    if (!m) throw { code: -3, message: "Please set the wallet first" };
    return m;
  };
  const sel = (): MockKitModule =>
    opts.noAccessor ? selectedModule() : (Kit as { selectedModule: MockKitModule }).selectedModule;
  const withNet = (o?: { networkPassphrase?: string }) => ({
    ...o,
    networkPassphrase: o?.networkPassphrase || network,
  });
  // biome-ignore lint/complexity/noStaticOnlyClass: mirrors the kit's static class
  class StellarWalletsKit {
    static calls: string[] = [];
    static init(p: { modules: MockKitModule[]; selectedWalletId?: string; network?: string }) {
      modules = p.modules;
      if (p.selectedWalletId) StellarWalletsKit.setWallet(p.selectedWalletId);
      if (p.network) StellarWalletsKit.setNetwork(p.network);
    }
    /** the module the kit calls (`selectedModule`); tests replace its behaviours */
    static get module(): MockKitModule {
      return selectedModule();
    }
    static on(type: string, cb: Cb): () => void {
      if (type === "STATE_UPDATE") {
        let ca: string | undefined;
        let cn: string | undefined;
        const run = () => {
          if (address !== ca || network !== cn) {
            ca = address;
            cn = network;
            cb({ eventType: type, payload: { address, networkPassphrase: network } });
          }
        };
        run();
        state.add(run);
        return () => state.delete(run);
      }
      if (type === "WALLET_SELECTED") {
        let c: string | undefined;
        const run = () => {
          if (selected !== c) {
            c = selected;
            cb({ eventType: type, payload: { id: selected } });
          }
        };
        run();
        selCbs.add(run);
        return () => selCbs.delete(run);
      }
      if (type === "DISCONNECT") {
        disc.add(cb);
        return () => disc.delete(cb);
      }
      throw new Error(`${type} event type is not supported`);
    }
    static setWallet(id: string) {
      if (modules && !modules.some((m) => m.productId === id))
        throw new Error(`Wallet id "${id}" is not and existing module`);
      selected = id;
      fireSel();
    }
    static setNetwork(n: string) {
      network = n;
      fireState();
    }
    static authModal(): Promise<{ address: string }> {
      StellarWalletsKit.calls.push("authModal");
      return new Promise((resolve, rej) => {
        modal = { resolve: resolve as (v: unknown) => void, reject: rej };
      });
    }
    /**
     * test control: the user picks a wallet in the modal; like the kit's page, the module's `getAddress()` is called
     * directly (not through `selectedModule`), then the address is stored and the modal resolves.
     */
    static pick(id: string) {
      StellarWalletsKit.setWallet(id);
      const m = active() as MockKitModule;
      void m.getAddress().then(
        (r) => {
          address = r.address;
          fireState();
          modal?.resolve({ address: r.address });
          modal = undefined;
        },
        (e: unknown) => {
          modal?.reject(e);
          modal = undefined;
        },
      );
    }
    /** test control: the user closes the modal */
    static closeModal() {
      modal?.reject({ code: -1, message: "The user closed the modal." });
      modal = undefined;
    }
    static async fetchAddress() {
      const { address: a } = await sel().getAddress();
      address = a;
      fireState();
      return { address: a };
    }
    static signTransaction(
      xdr: string,
      o?: { networkPassphrase?: string; submit?: boolean; address?: string },
    ) {
      StellarWalletsKit.calls.push("signTransaction");
      return sel().signTransaction(xdr, withNet(o));
    }
    static signAuthEntry(entry: string, o?: { networkPassphrase?: string }) {
      return sel().signAuthEntry(entry, withNet(o));
    }
    static signMessage(msg: string, o?: { networkPassphrase?: string }) {
      return sel().signMessage(msg, withNet(o));
    }
    static signAndSubmitTransaction(xdr: string, o?: { networkPassphrase?: string }) {
      const m = sel();
      if (!m.signAndSubmitTransaction)
        throw { code: -3, message: `The selected module "${m.productName}" does not support it.` };
      return m.signAndSubmitTransaction(xdr, withNet(o));
    }
    static async getAddress() {
      if (!address) throw { code: -1, message: "No wallet has been connected." };
      return { address };
    }
    static getNetwork() {
      return sel().getNetwork();
    }
    static async disconnect() {
      void active()?.disconnect();
      selected = undefined;
      fireSel();
      address = undefined;
      fireState();
      for (const cb of [...disc]) cb({ eventType: "DISCONNECT", payload: {} });
    }
  }
  // the kit's `static get selectedModule()`: an own accessor of the class (configurable, like any class accessor)
  if (!opts.noAccessor)
    Object.defineProperty(StellarWalletsKit, "selectedModule", {
      get: selectedModule,
      configurable: true,
    });
  const Kit = StellarWalletsKit as typeof StellarWalletsKit & {
    readonly selectedModule: MockKitModule;
  };
  return Kit;
}

/** Stellar Wallets Kit v1 instance (≤ 1.9.5): no event API; `openModal` callbacks; instance methods. */
export function makeKitV1(selectedWalletId?: string) {
  let selected = selectedWalletId;
  let onSelected: ((o: unknown) => void) | undefined;
  let onClosed: ((e: unknown) => void) | undefined;
  class Kit {
    calls: string[] = [];
    module = {
      signTransaction: approve() as Behaviour,
    };
    setWallet(id: string) {
      selected = id;
    }
    async openModal(params: {
      onWalletSelected: (o: unknown) => void;
      onClosed?: (e: unknown) => void;
    }) {
      this.calls.push("openModal");
      onSelected = params.onWalletSelected;
      onClosed = params.onClosed;
    }
    /** test control */
    pick(id: string) {
      onSelected?.({
        id,
        name: "Wallet",
        icon: "x",
        isAvailable: true,
        url: "https://example.org",
      });
    }
    close() {
      onClosed?.(new Error("Modal closed"));
    }
    async getAddress() {
      if (!selected) throw { code: -3, message: "Please set the wallet first" };
      return { address: CANARY.G };
    }
    signTransaction(xdr: string, opts?: { networkPassphrase?: string }) {
      return this.module.signTransaction(xdr, opts);
    }
    async getNetwork() {
      return { network: "TESTNET", networkPassphrase: TESTNET };
    }
    async disconnect() {
      selected = undefined;
    }
  }
  return new Kit();
}

/** `@stellar/freighter-api` (v6 namespace shape): resolves `{…, error}` instead of rejecting. */
export function makeFreighter() {
  const api = {
    allowed: false,
    isConnected: async () => ({ isConnected: true }),
    requestAccess: async () => {
      api.allowed = true;
      return { address: CANARY.G };
    },
    getAddress: async () => (api.allowed ? { address: CANARY.G } : { address: "" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: TESTNET }),
    signTransaction: (async () => ({
      signedTxXdr: CANARY.XDR,
      signerAddress: CANARY.G,
    })) as Behaviour,
    signAuthEntry: async (_entry: string, _opts?: object) => ({
      signedAuthEntry: CANARY.XDR,
      signerAddress: CANARY.G,
    }),
    signMessage: async (_message: string, _opts?: object) => ({
      signedMessage: CANARY.SIGNED_MESSAGE,
      signerAddress: CANARY.G,
    }),
  };
  return api;
}

/** passkey-kit 0.20.0 `PasskeyKit`: `events` emitter; `createWallet` calls `this.createKey`. */
export function makePasskeyKit(networkPassphrase = TESTNET) {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const events = {
    on(e: string, l: (d: unknown) => void) {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)?.add(l);
      return () => listeners.get(e)?.delete(l);
    },
    emit(e: string, d: unknown) {
      for (const l of listeners.get(e) ?? []) l(d);
    },
    count: (e: string) => listeners.get(e)?.size ?? 0,
  };
  class PasskeyKit {
    readonly networkPassphrase = networkPassphrase;
    readonly events = events;
    signBehaviour: Behaviour = approve(CANARY.XDR);
    async createKey(_app: string, _user: string) {
      return { keyId: CANARY.HASH, publicKey: new Uint8Array(65) };
    }
    async createWallet(app: string, user: string) {
      const k = await this.createKey(app, user);
      return { ...k, contractId: CANARY.C, signedTx: CANARY.XDR };
    }
    async confirmWalletCreation() {
      this.events.emit("walletCreated", { contractId: CANARY.C, keyId: CANARY.HASH });
      return { contractId: CANARY.C, creationTransactionHash: CANARY.HASH };
    }
    async connectWallet() {
      this.events.emit("walletConnected", { contractId: CANARY.C, keyId: CANARY.HASH });
      return { contractId: CANARY.C, keyIdBase64: CANARY.HASH };
    }
    disconnect() {
      this.events.emit("walletDisconnected", { contractId: CANARY.C });
    }
    sign(txn: unknown) {
      return this.signBehaviour(txn);
    }
    signAuthEntry(entry: unknown) {
      return this.signBehaviour(entry);
    }
  }
  return new PasskeyKit();
}

/** smart-account-kit 0.10.0 `SmartAccountKit`: submission methods resolve `{success, hash | error}`. */
export function makeSmartAccountKit(networkPassphrase = TESTNET) {
  const base = makePasskeyKit(networkPassphrase);
  const events = base.events;
  let stored = false;
  class SmartAccountKit {
    readonly networkPassphrase = networkPassphrase;
    readonly events = events;
    submitResult: unknown = { success: true, hash: CANARY.HASH, ledger: 1 };
    async createWallet(_app: string, _user: string, opts?: { autoSubmit?: boolean }) {
      events.emit("credentialCreated", {
        credential: { credentialId: CANARY.HASH, contractId: CANARY.C },
      });
      const submitResult = opts?.autoSubmit ? this.submitResult : undefined;
      if ((submitResult as { success?: boolean } | undefined)?.success) {
        stored = true;
        events.emit("walletConnected", { contractId: CANARY.C, credentialId: CANARY.HASH });
      }
      return { credentialId: CANARY.HASH, contractId: CANARY.C, submitResult };
    }
    async authenticatePasskey() {
      return { credentialId: CANARY.HASH, rawResponse: { id: CANARY.HASH } };
    }
    async connectWallet(o?: { prompt?: boolean; fresh?: boolean }) {
      if (!stored && !o?.prompt && !o?.fresh) return null;
      stored = true;
      events.emit("walletConnected", { contractId: CANARY.C, credentialId: CANARY.HASH });
      return { contractId: CANARY.C, credentialId: CANARY.HASH };
    }
    async disconnect() {
      stored = false;
      events.emit("walletDisconnected", { contractId: CANARY.C });
    }
    async sign(tx: unknown) {
      return tx;
    }
    async signAndSubmit(_tx: unknown) {
      return this.submitResult;
    }
    async transfer() {
      return this.signAndSubmit(CANARY.XDR);
    }
    /** test control: a session restored from storage */
    remember() {
      stored = true;
    }
  }
  return new SmartAccountKit();
}
