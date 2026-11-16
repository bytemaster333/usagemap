// SPDX-License-Identifier: Apache-2.0
// Passkey as a FIRST factor (usernameless, discoverable credential). PLANNED CONTRACT, not in the control plane yet
// (changes ADR-0014): POST /v1/auth/passkey/login/options (no session) returns
// usernameless request options; POST /v1/auth/passkey/login/verify returns a full Session for the credential's user.
// An unknown credential gets the same neutral 401 as a wrong signature. With `as: "operator"` the session is complete
// only for platform_role operator/operator_admin with two or more passkeys.
//
// SWAP: when `authPasskeyLoginOptions` / `authPasskeyLoginVerify` exist in @usagemap/api-types, replace the two
// `post()` calls below with `api.call(...)` and delete `post()` and `PasskeyLoginUnavailable`. Nothing else changes.

import type { Session } from "./session.ts";
import { assertionToJson, requestOptionsFromJson } from "./webauthn.ts";

/** The control plane does not offer passkey login yet (404/405/501 from the planned endpoints). */
export class PasskeyLoginUnavailable extends Error {
  constructor() {
    super("Passkey sign-in is not switched on yet.");
  }
}

/** A neutral refusal: never says whether the account exists. */
export class PasskeyLoginRefused extends Error {
  constructor() {
    super("That passkey could not sign you in.");
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-SCF-Request": "1" },
    body: JSON.stringify(body ?? {}),
  });
  if (r.status === 404 || r.status === 405 || r.status === 501) throw new PasskeyLoginUnavailable();
  if (r.status === 401 || r.status === 403) throw new PasskeyLoginRefused();
  if (!r.ok) throw new Error(`Sign-in failed (${r.status}). Try again.`);
  return r.json();
}

export async function passkeyLogin(as: "project" | "operator"): Promise<Session> {
  const options = (await post("/v1/auth/passkey/login/options", { as })) as Record<string, unknown>;
  const cred = (await navigator.credentials.get({
    publicKey: requestOptionsFromJson(options as never),
  })) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyLoginRefused();
  return (await post("/v1/auth/passkey/login/verify", { as, ...assertionToJson(cred) })) as Session;
}
