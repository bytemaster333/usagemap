// SPDX-License-Identifier: Apache-2.0
// Stellar wallet sign-in through SEP-53 message signing (ADR-0014), and SEP-10 challenge transactions for hardware
// wallets and multisig accounts (C-15, C-19: offered when the deployment has a SEP-10 signing key). The portal talks to wallets only through this
// small adapter interface, so adding a wallet is one object and the sign-in page does not change:
//   - Freighter, through its official messaging library (@stellar/freighter-api, Apache-2.0; window.postMessage to
//     the extension — no script, frame or network origin is added to the CSP);
//   - "any wallet" by hand: the member signs the shown message in a wallet or tool of their choice that implements
//     SEP-53 and pastes the signature. This path is also what the browser tests drive with a test key.
// The control plane verifies Ed25519 over SHA-256("Stellar Signed Message:\n" ‖ message) and checks the key's weight
// on the deployment's one network (C-114); the portal never chooses the network.

import freighter from "@stellar/freighter-api";

export const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export const NETWORK_PASSPHRASES: Record<string, string> = {
  public: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

export interface WalletAdapter {
  readonly id: string;
  readonly name: string;
  /** Whether the wallet can be reached from this page (extension installed, …). */
  available(): Promise<boolean>;
  /** Asks the wallet for the account to sign in with (may prompt the person). */
  getAccount(): Promise<string>;
  /** Signs a SEP-53 message with the given account; resolves to the base64 Ed25519 signature (64 bytes). */
  signMessage(
    message: string,
    account: string,
    networkPassphrase: string | undefined,
  ): Promise<string>;
  /** SEP-10: signs the server-signed challenge transaction; resolves to the signed transaction envelope (base64 XDR). */
  signTransaction?(xdr: string, account: string, networkPassphrase: string): Promise<string>;
}

export type StellarMethod = "sep53" | "sep10";

/** A base64 transaction envelope as pasted from a wallet or tool: whitespace removed, shape checked. */
export function normaliseXdr(x: string): string {
  const t = x.replace(/\s+/g, "");
  if (t.length < 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 !== 0)
    throw new Error("Paste the signed transaction as base64 XDR (the whole envelope).");
  return t;
}

/** The `Network:` line of a SEP-53 sign-in message (the network the control plane signs in against). */
export function networkOfMessage(message: string): string | undefined {
  const m = /^Network: (\S+)$/m.exec(message);
  return m?.[1];
}

export function passphraseFor(message: string, explicit?: string | null): string | undefined {
  if (explicit) return explicit;
  const n = networkOfMessage(message);
  return n ? NETWORK_PASSPHRASES[n] : undefined;
}

function bytesToBase64(bytes: ArrayLike<number>): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

function base64Length(s: string): number | null {
  try {
    return atob(s).length;
  } catch {
    return null;
  }
}

/**
 * Normalises what wallets return for a signature to base64 of the 64 signature bytes: base64 or base64url text, 128
 * hex digits, a byte array, or a serialised Node `Buffer` (`{type: "Buffer", data: [...]}`). Throws otherwise.
 */
export function normaliseSignature(sig: unknown): string {
  if (typeof sig === "string") {
    const t = sig.trim();
    if (/^[0-9a-fA-F]{128}$/.test(t)) {
      const bytes: number[] = [];
      for (let i = 0; i < 128; i += 2) bytes.push(Number.parseInt(t.slice(i, i + 2), 16));
      return bytesToBase64(bytes);
    }
    const b64 = t.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(padded) && base64Length(padded) === 64) return padded;
    throw new Error("The signature must be 64 bytes, as base64 or hex.");
  }
  if (sig instanceof Uint8Array || Array.isArray(sig)) {
    if (sig.length !== 64) throw new Error("The wallet returned a signature of the wrong length.");
    return bytesToBase64(sig);
  }
  if (sig && typeof sig === "object" && (sig as { type?: unknown }).type === "Buffer") {
    return normaliseSignature((sig as { data?: unknown }).data);
  }
  throw new Error("The wallet returned no signature.");
}

type FreighterApi = Pick<
  typeof freighter,
  "isConnected" | "requestAccess" | "signMessage" | "signTransaction"
>;

export function freighterAdapter(api: FreighterApi = freighter): WalletAdapter {
  return {
    id: "freighter",
    name: "Freighter",
    async available() {
      try {
        const r = await api.isConnected();
        return !r.error && r.isConnected === true;
      } catch {
        return false;
      }
    },
    async getAccount() {
      const r = await api.requestAccess();
      if (r.error || !r.address)
        throw new Error(r.error?.message ?? "Freighter did not share an account.");
      if (!ACCOUNT_RE.test(r.address)) throw new Error("Freighter returned an invalid account.");
      return r.address;
    },
    async signMessage(message, account, networkPassphrase) {
      const opts: { address: string; networkPassphrase?: string } = { address: account };
      if (networkPassphrase) opts.networkPassphrase = networkPassphrase;
      const r = await api.signMessage(message, opts);
      if (r.error) throw new Error(r.error.message ?? "Freighter refused to sign.");
      if (r.signerAddress && r.signerAddress !== account)
        throw new Error("Freighter signed with a different account.");
      return normaliseSignature(r.signedMessage);
    },
    async signTransaction(xdr, account, networkPassphrase) {
      const r = await api.signTransaction(xdr, { address: account, networkPassphrase });
      if (r.error) throw new Error(r.error.message ?? "Freighter refused to sign.");
      if (r.signerAddress && r.signerAddress !== account)
        throw new Error("Freighter signed with a different account.");
      if (!r.signedTxXdr) throw new Error("Freighter returned no signed transaction.");
      return normaliseXdr(r.signedTxXdr);
    },
  };
}

export const WALLETS: WalletAdapter[] = [freighterAdapter()];
