// SPDX-License-Identifier: Apache-2.0
// SEP-10 web authentication (ADR-0014, C-15, C-19): a server-signed challenge transaction (sequence 0, a `manage_data`
// operation `<home domain> auth` with a random nonce, `web_auth_domain`, a 10-minute time bound) that the client signs
// with the account's keys — hardware wallets and multisig accounts, which cannot sign a SEP-53 message. Built and
// checked with the official `@stellar/stellar-sdk` WebAuth module (Apache-2.0). The signatures must reach the
// account's **medium** threshold with its current signers from Horizon; an account that does not exist yet has only
// its master key (weight 1). The server key is the service domain's SEP-10 signing key (`SCF_SEP10_SIGNING_SEED`,
// published as SIGNING_KEY in the service domain's stellar.toml; a handover item, C-15). It is never logged.

import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../config.ts";
import type { AccountInfo } from "./stellar.ts";

export const SEP10_TTL_S = 600;

export function passphraseOf(network: StellarNetwork): string {
  return network === "public" ? Networks.PUBLIC : Networks.TESTNET;
}

export class Sep10 {
  readonly #server: Keypair;
  readonly #passphrase: string;
  readonly #homeDomain: string;
  readonly #webAuthDomain: string;

  constructor(opts: {
    seed: string;
    network: StellarNetwork;
    homeDomain: string;
    webAuthDomain: string;
  }) {
    if (!/^S[A-Z2-7]{55}$/.test(opts.seed))
      throw new Error("SCF_SEP10_SIGNING_SEED is not a Stellar secret seed");
    this.#server = Keypair.fromSecret(opts.seed);
    this.#passphrase = passphraseOf(opts.network);
    this.#homeDomain = opts.homeDomain;
    this.#webAuthDomain = opts.webAuthDomain;
  }

  get serverAccount(): string {
    return this.#server.publicKey();
  }

  get networkPassphrase(): string {
    return this.#passphrase;
  }

  /** A fresh server-signed challenge for `account`, and the hash that binds the signed answer to it. */
  challenge(account: string): { xdr: string; hash: Buffer } {
    const xdr = WebAuth.buildChallengeTx(
      this.#server,
      account,
      this.#homeDomain,
      SEP10_TTL_S,
      this.#passphrase,
      this.#webAuthDomain,
    );
    return { xdr, hash: this.#hash(xdr) };
  }

  #hash(xdr: string): Buffer {
    return Buffer.from(TransactionBuilder.fromXDR(xdr, this.#passphrase).hash());
  }

  /**
   * Checks a signed answer: the very transaction we issued (same hash), for `account`, server signature and time
   * bounds valid (readChallengeTx), and the client signatures reaching the account's medium threshold (at least 1).
   * Returns the signer weight reached; throws on any failure.
   */
  verify(
    signedXdr: string,
    account: string,
    issuedHash: Buffer,
    info: AccountInfo,
  ): { weight: number } {
    const read = WebAuth.readChallengeTx(
      signedXdr,
      this.#server.publicKey(),
      this.#passphrase,
      this.#homeDomain,
      this.#webAuthDomain,
    );
    if (read.clientAccountID !== account) throw new Error("challenge for another account");
    if (!Buffer.from(read.tx.hash()).equals(issuedHash))
      throw new Error("not the issued challenge");
    const threshold = Math.max(1, info.mediumThreshold);
    const signers = info.signers.map((s) => ({
      key: s.key,
      weight: s.weight,
      type: "ed25519_public_key",
    }));
    const used = WebAuth.verifyChallengeTxThreshold(
      signedXdr,
      this.#server.publicKey(),
      this.#passphrase,
      threshold,
      signers as never,
      this.#homeDomain,
      this.#webAuthDomain,
    );
    const weight = info.signers
      .filter((s) => used.includes(s.key))
      .reduce((a, s) => a + s.weight, 0);
    return { weight };
  }
}
