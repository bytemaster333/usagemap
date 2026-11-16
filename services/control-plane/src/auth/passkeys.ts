// SPDX-License-Identifier: Apache-2.0
// Passkeys (WebAuthn) as an added factor: mandatory second factor for SCF operators at every sign-in (C-09), SCF-operator
// step-up (valid 10 minutes), and the recent authentication of members who registered one (C-87). Never a first factor.
// Challenges are single use, valid 5 minutes, stored as SHA-256 only.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { sha256 } from "../util/ids.ts";
import { type SessionStore, sessionCookie, sessionView } from "./sessions.ts";

type Transport = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

interface CredentialRow extends Record<string, unknown> {
  credential_id: Buffer;
  public_key: Buffer;
  sign_count: string;
  transports: string[];
}

/** Reads `challenge` from the response's clientDataJSON without trusting anything else in it. */
function challengeOf(response: unknown): string {
  const cd = (response as { response?: { clientDataJSON?: unknown } })?.response?.clientDataJSON;
  if (typeof cd !== "string")
    throw new ApiError("validation_failed", "malformed WebAuthn response");
  try {
    const parsed = JSON.parse(Buffer.from(cd, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    if (typeof parsed.challenge !== "string") throw new Error("no challenge");
    return parsed.challenge;
  } catch {
    throw new ApiError("validation_failed", "malformed WebAuthn response");
  }
}

export function passkeyView(r: {
  credential_id: Buffer;
  label: string | null;
  created_at: Date;
  last_used_at: Date | null;
  backup_eligible: boolean;
}): Record<string, unknown> {
  return {
    credential_id: r.credential_id.toString("base64url"),
    label: r.label,
    created_at: r.created_at.toISOString(),
    last_used_at: r.last_used_at?.toISOString() ?? null,
    backup_eligible: r.backup_eligible,
  };
}

export function passkeyHandlers(deps: {
  rpId: string;
  rpName: string;
  origin: string;
  sessions: SessionStore;
}) {
  async function storeChallenge(
    ctx: Parameters<Handler>[0],
    kind: "webauthn_registration" | "webauthn_assertion",
    challenge: string,
  ) {
    await ctx.tx((tx) =>
      tx.query(
        `INSERT INTO scf.auth_challenges (kind, secret_hash, user_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '5 minutes')`,
        [kind, sha256(challenge), ctx.session?.userId],
      ),
    );
  }

  async function consumeChallenge(
    ctx: Parameters<Handler>[0],
    kind: "webauthn_registration" | "webauthn_assertion",
    challenge: string,
  ): Promise<void> {
    const row = await ctx.tx((tx) =>
      tx.maybeOne(
        `UPDATE scf.auth_challenges SET consumed_at = now()
          WHERE secret_hash = $1 AND kind = $2 AND user_id = $3 AND consumed_at IS NULL AND expires_at > now()
          RETURNING challenge_id`,
        [sha256(challenge), kind, ctx.session?.userId],
      ),
    );
    if (!row) throw new ApiError("validation_failed", "unknown or expired WebAuthn challenge");
  }

  async function credentials(ctx: Parameters<Handler>[0]): Promise<CredentialRow[]> {
    return ctx.tx((tx) =>
      tx.query<CredentialRow>(
        `SELECT credential_id, public_key, sign_count::text, transports FROM scf.passkey_credentials
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [ctx.session?.userId],
      ),
    );
  }

  const authPasskeyRegistrationOptions: Handler = async (ctx) => {
    const s = ctx.session;
    if (!s) throw new ApiError("unauthenticated");
    const user = await ctx.tx((tx) =>
      tx.one<{ display_name: string }>(`SELECT display_name FROM scf.users WHERE user_id = $1`, [
        s.userId,
      ]),
    );
    const existing = await credentials(ctx);
    const options = await generateRegistrationOptions({
      rpName: deps.rpName,
      rpID: deps.rpId,
      userName: user.display_name,
      userID: Buffer.from(s.userId.replace(/-/g, ""), "hex"),
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id.toString("base64url"),
        transports: c.transports as Transport[],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      timeout: 300_000,
    });
    await storeChallenge(ctx, "webauthn_registration", options.challenge);
    return { status: 200, body: options };
  };

  const authPasskeyRegistrationVerify: Handler = async (ctx) => {
    const s = ctx.session;
    if (!s) throw new ApiError("unauthenticated");
    const challenge = challengeOf(ctx.body);
    await consumeChallenge(ctx, "webauthn_registration", challenge);
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      result = await verifyRegistrationResponse({
        response: ctx.body as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge: challenge,
        expectedOrigin: deps.origin,
        expectedRPID: deps.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new ApiError("validation_failed", "WebAuthn registration could not be verified");
    }
    if (!result.verified)
      throw new ApiError("validation_failed", "WebAuthn registration could not be verified");
    const info = result.registrationInfo;
    const label =
      typeof (ctx.body as { label?: unknown }).label === "string"
        ? String((ctx.body as { label: string }).label).slice(0, 64)
        : null;
    const row = await ctx.tx(async (tx) => {
      const r = await tx.one<{
        credential_id: Buffer;
        label: string | null;
        created_at: Date;
        last_used_at: Date | null;
        backup_eligible: boolean;
      }>(
        `INSERT INTO scf.passkey_credentials (credential_id, user_id, public_key, sign_count, aaguid, transports,
                                              backup_eligible, backup_state, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING credential_id, label, created_at, last_used_at, backup_eligible`,
        [
          Buffer.from(info.credential.id, "base64url"),
          s.userId,
          Buffer.from(info.credential.publicKey),
          info.credential.counter,
          info.aaguid,
          info.credential.transports ?? [],
          info.credentialDeviceType === "multiDevice",
          info.credentialBackedUp,
          label,
        ],
      );
      await tx.audit({ action: "auth.passkey_added", targetType: "user", targetId: s.userId });
      return r;
    });
    return { status: 201, body: passkeyView(row) };
  };

  const authPasskeyAssertionOptions: Handler = async (ctx) => {
    const creds = await credentials(ctx);
    if (creds.length === 0) throw new ApiError("conflict", "no passkey registered");
    const options = await generateAuthenticationOptions({
      rpID: deps.rpId,
      allowCredentials: creds.map((c) => ({
        id: c.credential_id.toString("base64url"),
        transports: c.transports as Transport[],
      })),
      userVerification: "required",
      timeout: 300_000,
    });
    await storeChallenge(ctx, "webauthn_assertion", options.challenge);
    return { status: 200, body: options };
  };

  const authPasskeyAssertionVerify: Handler = async (ctx) => {
    const s = ctx.session;
    if (!s) throw new ApiError("unauthenticated");
    const challenge = challengeOf(ctx.body);
    await consumeChallenge(ctx, "webauthn_assertion", challenge);
    const id = (ctx.body as { id?: unknown }).id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,1400}$/.test(id)) {
      throw new ApiError("validation_failed", "malformed WebAuthn response");
    }
    const cred = (await credentials(ctx)).find((c) => c.credential_id.toString("base64url") === id);
    if (!cred) throw new ApiError("unauthenticated", "unknown passkey");
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      result = await verifyAuthenticationResponse({
        response: ctx.body as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
        expectedChallenge: challenge,
        expectedOrigin: deps.origin,
        expectedRPID: deps.rpId,
        credential: {
          id,
          publicKey: new Uint8Array(cred.public_key),
          counter: Number(cred.sign_count),
          transports: cred.transports as Transport[],
        },
        requireUserVerification: true,
      });
    } catch {
      throw new ApiError("unauthenticated", "passkey assertion could not be verified");
    }
    if (!result.verified)
      throw new ApiError("unauthenticated", "passkey assertion could not be verified");
    const now = new Date();
    const out = await ctx.tx(async (tx) => {
      await tx.query(
        `UPDATE scf.passkey_credentials SET sign_count = $2, last_used_at = now() WHERE credential_id = $1`,
        [cred.credential_id, result.authenticationInfo.newCounter],
      );
      const rotated = await deps.sessions.rotate(tx, s, {
        passkeyVerifiedAt: s.passkeyVerifiedAt ?? now,
        stepUpAt: now,
        reauthenticatedAt: now,
        reauthMethod: "passkey",
      });
      const action = s.platformRole ? "auth.step_up" : "auth.reauthenticated";
      await tx.audit({
        action,
        targetType: "user",
        targetId: s.userId,
        details: { method: "passkey" },
      });
      return rotated;
    });
    return {
      status: 200,
      body: sessionView(out.session),
      headers: { "set-cookie": sessionCookie(out.token, out.session), "cache-control": "no-store" },
    };
  };

  return {
    authPasskeyRegistrationOptions,
    authPasskeyRegistrationVerify,
    authPasskeyAssertionOptions,
    authPasskeyAssertionVerify,
  };
}
