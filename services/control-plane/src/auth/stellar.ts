// SPDX-License-Identifier: Apache-2.0
// Stellar wallet sign-in by SEP-53 message signature (ADR-0014). The signature is Ed25519 over
// SHA-256("Stellar Signed Message:\n" ‖ message); the signer must be the account's own key with a weight that meets the
// account's medium threshold, read from Horizon (an unfunded account has only its master key, weight 1, thresholds 0).
// SEP-10 (challenge transaction, for hardware wallets and multisig; sep10.ts) is offered when the deployment has a SEP-10
// signing key (SCF_SEP10_SIGNING_SEED); its signatures must reach the account's medium threshold.
// One network per deployment (C-114, `SCF_STELLAR_NETWORK`): the client cannot choose it, so an account whose master
// key is disabled on the public network cannot sign in through an unfunded twin on the test network.

import { createHash, createPublicKey, verify } from "node:crypto";
import type { StellarNetwork } from "../config.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { randomBase62, sha256 } from "../util/ids.ts";
import { SEP10_TTL_S, type Sep10 } from "./sep10.ts";
import { type SessionStore, sessionCookie, sessionView } from "./sessions.ts";
import { completeSignIn, resolveUser } from "./signin.ts";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const VERSION_ACCOUNT_ID = 6 << 3;
const SEP53_PREFIX = "Stellar Signed Message:\n";
const CHALLENGE_TTL_MS = 10 * 60_000;

function crc16xmodem(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("invalid base32");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base32Encode(b: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes a `G…` account id (SEP-23 StrKey) to its 32-byte Ed25519 public key; throws on a bad checksum. */
export function decodeAccountId(g: string): Buffer {
  if (!/^G[A-Z2-7]{55}$/.test(g)) throw new Error("not an account id");
  const raw = base32Decode(g);
  if (raw.length !== 35 || raw[0] !== VERSION_ACCOUNT_ID) throw new Error("not an account id");
  const body = raw.subarray(0, 33);
  const crc = raw.readUInt16LE(33);
  if (crc16xmodem(body) !== crc) throw new Error("bad checksum");
  return Buffer.from(raw.subarray(1, 33));
}

/** Encodes a 32-byte Ed25519 public key as a `G…` account id. */
export function encodeAccountId(pub: Buffer): string {
  if (pub.length !== 32) throw new Error("key must be 32 bytes");
  const body = Buffer.concat([Buffer.from([VERSION_ACCOUNT_ID]), pub]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16xmodem(body));
  return base32Encode(Buffer.concat([body, crc]));
}

/** The SEP-53 digest: SHA-256 of the prefixed message. */
export function sep53Digest(message: string): Buffer {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, "utf8")]))
    .digest();
}

export function verifySep53(account: string, message: string, signatureB64: string): boolean {
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: decodeAccountId(account).toString("base64url") },
    format: "jwk",
  });
  return verify(null, sep53Digest(message), key, sig);
}

export interface SignerWeight {
  /** weight of the account's own key (master key or listed signer) */
  weight: number;
  mediumThreshold: number;
}

export interface AccountInfo extends SignerWeight {
  /** `home_domain` of the account; null when unset or the account is unfunded */
  homeDomain: string | null;
  /** every signer with its weight (an unfunded account: only its master key, weight 1) */
  signers: Array<{ key: string; weight: number }>;
  /** false for an account that does not exist on the ledger */
  exists: boolean;
}

export interface HorizonClient {
  signerWeight(network: StellarNetwork, account: string): Promise<SignerWeight>;
  /** The account's signers, thresholds and home domain (L2 proof, SEP-10 multisig). */
  accountInfo(network: StellarNetwork, account: string): Promise<AccountInfo>;
}

/** Horizon of the deployment's one network (`network` must be that network; anything else is a programming error). */
export function httpHorizonClient(
  horizon: { network: StellarNetwork; url: string },
  timeoutMs = 5000,
): HorizonClient {
  const unavailable = () =>
    new ApiError("unavailable", "the Stellar network could not be reached", { retryAfter: 10 });
  async function accountInfo(network: StellarNetwork, account: string): Promise<AccountInfo> {
    if (network !== horizon.network) throw new Error("Horizon client of another network");
    let res: Response;
    try {
      res = await fetch(`${horizon.url.replace(/\/$/, "")}/accounts/${account}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable();
    }
    // Unfunded account: only the master key exists, weight 1, all thresholds 0.
    if (res.status === 404)
      return {
        weight: 1,
        mediumThreshold: 0,
        homeDomain: null,
        signers: [{ key: account, weight: 1 }],
        exists: false,
      };
    if (!res.ok) throw unavailable();
    const body = (await res.json()) as {
      thresholds?: { med_threshold?: number };
      signers?: Array<{ key?: string; weight?: number; type?: string }>;
      home_domain?: string;
    };
    const signers = (body.signers ?? [])
      .filter(
        (s) =>
          typeof s.key === "string" && (s.type ?? "ed25519_public_key") === "ed25519_public_key",
      )
      .map((s) => ({ key: s.key as string, weight: Number(s.weight ?? 0) }));
    const own = signers.find((s) => s.key === account);
    return {
      weight: own?.weight ?? 0,
      mediumThreshold: body.thresholds?.med_threshold ?? 0,
      homeDomain:
        typeof body.home_domain === "string" && body.home_domain !== "" ? body.home_domain : null,
      signers,
      exists: true,
    };
  }
  return {
    accountInfo,
    async signerWeight(network, account) {
      const a = await accountInfo(network, account);
      return { weight: a.weight, mediumThreshold: a.mediumThreshold };
    },
  };
}

/** The text a wallet signs (OpenAPI `StellarChallenge.message`: domain, account, purpose, nonce, time, network). */
/**
 * Shown in every SEP-53 message we ask a wallet to sign, directly after the Purpose line: a signed message is not a
 * transaction, is never submitted to the network and costs nothing.
 */
export const NO_FEE_NOTICE = "Signing this message does not send a transaction or cost a fee.";

export function sep53Message(p: {
  domain: string;
  account: string;
  network: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  return [
    `${p.domain} wants you to sign in with your Stellar account:`,
    p.account,
    "",
    "Purpose: sign in to UsageMap",
    NO_FEE_NOTICE,
    `Network: ${p.network}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expiration Time: ${p.expiresAt.toISOString()}`,
  ].join("\n");
}

interface ChallengePayload {
  method: "sep53" | "sep10";
  network: StellarNetwork;
  message?: string;
}

export function stellarHandlers(deps: {
  homeDomain: string;
  network: StellarNetwork;
  horizon: HorizonClient;
  sessions: SessionStore;
  sep10?: Sep10 | undefined;
}) {
  const authStellarChallenge: Handler = async (ctx) => {
    const body = ctx.body as { account: string; method?: "sep53" | "sep10" };
    const method = body.method ?? "sep53";
    try {
      decodeAccountId(body.account);
    } catch {
      throw new ApiError("validation_failed", undefined, {
        errors: [{ pointer: "/account", detail: "invalid account id" }],
      });
    }
    const network = deps.network;
    if (method === "sep10") {
      const sep10 = deps.sep10;
      if (!sep10)
        throw new ApiError(
          "unavailable",
          "SEP-10 is not configured on this deployment; use sep53",
          {
            retryAfter: 3600,
          },
        );
      const c = sep10.challenge(body.account);
      const issued = new Date();
      const expires = new Date(issued.getTime() + SEP10_TTL_S * 1000);
      const payload: ChallengePayload = { method: "sep10", network };
      const r = await ctx.tx((tx) =>
        tx.one<{ challenge_id: string }>(
          `INSERT INTO scf.auth_challenges (kind, secret_hash, subject, payload, created_at, expires_at)
           VALUES ('stellar_sep10', $1, $2, $3, $4, $5) RETURNING challenge_id`,
          [c.hash, body.account, JSON.stringify(payload), issued, expires],
        ),
      );
      return {
        status: 201,
        body: {
          challenge_id: r.challenge_id,
          method: "sep10",
          transaction_xdr: c.xdr,
          network_passphrase: sep10.networkPassphrase,
          expires_at: expires.toISOString(),
        },
        headers: { "cache-control": "no-store" },
      };
    }
    const nonce = randomBase62(22);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const message = sep53Message({
      domain: deps.homeDomain,
      account: body.account,
      network,
      nonce,
      issuedAt,
      expiresAt,
    });
    const payload: ChallengePayload = { method: "sep53", network, message };
    const row = await ctx.tx((tx) =>
      tx.one<{ challenge_id: string }>(
        `INSERT INTO scf.auth_challenges (kind, secret_hash, subject, payload, created_at, expires_at)
         VALUES ('stellar_sep53', $1, $2, $3, $4, $5) RETURNING challenge_id`,
        [sha256(nonce), body.account, JSON.stringify(payload), issuedAt, expiresAt],
      ),
    );
    return {
      status: 201,
      body: {
        challenge_id: row.challenge_id,
        method: "sep53",
        message,
        expires_at: expiresAt.toISOString(),
      },
    };
  };

  const authStellarVerify: Handler = async (ctx) => {
    const body = ctx.body as {
      challenge_id: string;
      signature?: string;
      signed_transaction_xdr?: string;
    };
    const isSep10 = typeof body.signed_transaction_xdr === "string";
    if (!body.signature && !isSep10) {
      throw new ApiError("validation_failed", undefined, {
        errors: [
          {
            pointer: "/signature",
            detail: "signature (sep53) or signed_transaction_xdr (sep10) required",
          },
        ],
      });
    }
    // Single use: consumed whatever the outcome.
    const ch = await ctx.tx((tx) =>
      tx.maybeOne<{ subject: string; payload: ChallengePayload; secret_hash: Buffer }>(
        `UPDATE scf.auth_challenges SET consumed_at = now()
          WHERE challenge_id = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > now()
          RETURNING subject, payload, secret_hash`,
        [body.challenge_id, isSep10 ? "stellar_sep10" : "stellar_sep53"],
      ),
    );
    // A challenge issued for another network (before a configuration change) is not valid here.
    if (!ch || ch.payload.network !== deps.network)
      throw new ApiError("unauthenticated", "signature not valid for this challenge");
    if (isSep10) {
      const sep10 = deps.sep10;
      if (!sep10) throw new ApiError("unauthenticated", "signature not valid for this challenge");
      const info = await deps.horizon.accountInfo(deps.network, ch.subject);
      try {
        sep10.verify(body.signed_transaction_xdr as string, ch.subject, ch.secret_hash, info);
      } catch {
        throw new ApiError(
          "unauthenticated",
          "the signed challenge is not valid or does not meet the account's medium threshold",
        );
      }
    } else {
      if (!verifySep53(ch.subject, ch.payload.message ?? "", body.signature as string))
        throw new ApiError("unauthenticated", "signature not valid for this challenge");
      const w = await deps.horizon.signerWeight(deps.network, ch.subject);
      if (w.weight <= 0 || w.weight < w.mediumThreshold) {
        throw new ApiError(
          "unauthenticated",
          "the key does not meet the account's medium threshold",
        );
      }
    }
    const account = ch.subject;
    const out = await ctx.tx(
      async (tx) => {
        const { userId } = await resolveUser(tx, {
          provider: "stellar",
          subject: account,
          handle: null,
          providerCreatedAt: null,
          displayName: `${account.slice(0, 4)}…${account.slice(-4)}`,
        });
        return completeSignIn(
          tx,
          deps.sessions,
          userId,
          isSep10 ? "stellar_sep10" : "stellar_sep53",
          ctx.session,
          {
            network: deps.network,
          },
        );
      },
      { tenantId: null, actorKind: "anonymous", actorId: null },
    );
    return {
      status: 200,
      body: sessionView(out.session),
      headers: { "set-cookie": sessionCookie(out.token, out.session), "cache-control": "no-store" },
    };
  };

  return { authStellarChallenge, authStellarVerify };
}
