// SPDX-License-Identifier: Apache-2.0
// WebAuthn glue between the control plane's JSON options/responses (the WebAuthn Level 3 JSON forms, base64url
// binary fields — as produced and consumed by the server's WebAuthn library) and the browser's binary API. Passkeys
// are never a first factor here (ADR-0014): they complete an SCF operator's sign-in (C-09), give a step-up, and give
// a member's recent authentication (C-87, C-114).

type Json = Record<string, unknown>;

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function str(o: Json, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new Error(`WebAuthn options: ${k} missing`);
  return v;
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((d: Json) => {
    const out: PublicKeyCredentialDescriptor = {
      type: "public-key",
      id: b64urlToBytes(str(d, "id")),
    };
    if (Array.isArray(d.transports)) out.transports = d.transports as AuthenticatorTransport[];
    return out;
  });
}

export function creationOptionsFromJson(o: Json): PublicKeyCredentialCreationOptions {
  const user = o.user as Json;
  const opts: PublicKeyCredentialCreationOptions = {
    ...(o as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64urlToBytes(str(o, "challenge")),
    user: {
      id: b64urlToBytes(str(user, "id")),
      name: str(user, "name"),
      displayName: typeof user.displayName === "string" ? user.displayName : str(user, "name"),
    },
  };
  const exclude = descriptors(o.excludeCredentials);
  if (exclude) opts.excludeCredentials = exclude;
  else delete opts.excludeCredentials;
  return opts;
}

export function requestOptionsFromJson(o: Json): PublicKeyCredentialRequestOptions {
  const opts: PublicKeyCredentialRequestOptions = {
    ...(o as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64urlToBytes(str(o, "challenge")),
  };
  const allow = descriptors(o.allowCredentials);
  if (allow) opts.allowCredentials = allow;
  else delete opts.allowCredentials;
  return opts;
}

export function registrationToJson(c: PublicKeyCredential): Json {
  const r = c.response as AuthenticatorAttestationResponse;
  const response: Json = {
    clientDataJSON: bytesToB64url(r.clientDataJSON),
    attestationObject: bytesToB64url(r.attestationObject),
  };
  if (typeof r.getTransports === "function") response.transports = r.getTransports();
  return {
    id: c.id,
    rawId: bytesToB64url(c.rawId),
    type: c.type,
    response,
    clientExtensionResults: c.getClientExtensionResults(),
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
  };
}

export function assertionToJson(c: PublicKeyCredential): Json {
  const r = c.response as AuthenticatorAssertionResponse;
  const response: Json = {
    clientDataJSON: bytesToB64url(r.clientDataJSON),
    authenticatorData: bytesToB64url(r.authenticatorData),
    signature: bytesToB64url(r.signature),
  };
  if (r.userHandle) response.userHandle = bytesToB64url(r.userHandle);
  return {
    id: c.id,
    rawId: bytesToB64url(c.rawId),
    type: c.type,
    response,
    clientExtensionResults: c.getClientExtensionResults(),
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
  };
}

export function webauthnAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/** Runs a registration ceremony with server options; resolves to the JSON body for `.../registration/verify`. */
export async function createPasskey(options: Json, label?: string): Promise<Json> {
  const cred = (await navigator.credentials.create({
    publicKey: creationOptionsFromJson(options),
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const body = registrationToJson(cred);
  if (label) body.label = label;
  return body;
}

/** Runs an assertion ceremony with server options; resolves to the JSON body for `.../assertion/verify`. */
export async function getPasskeyAssertion(options: Json): Promise<Json> {
  const cred = (await navigator.credentials.get({
    publicKey: requestOptionsFromJson(options),
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was used.");
  return assertionToJson(cred);
}

/** Human message for the DOMExceptions a ceremony ends with. */
export function webauthnErrorMessage(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
    if (e.name === "InvalidStateError")
      return "This passkey is already registered for your account.";
    if (e.name === "SecurityError") return "Passkeys are not allowed on this address.";
  }
  return e instanceof Error ? e.message : "The passkey operation failed.";
}
