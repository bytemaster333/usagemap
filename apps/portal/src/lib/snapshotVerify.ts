// SPDX-License-Identifier: Apache-2.0
// Checks a signed traction snapshot the way wire-formats §i.3 tells anyone to: pick the JWKS key whose `kid`
// equals `signature.kid` and whose validity covers `snapshot.issued_at`, then verify the Ed25519 signature over the
// RFC 8785 canonical form of `snapshot`. Runs entirely in the browser (WebCrypto); the server's own `status` field is
// reported separately, because a revoked snapshot still verifies cryptographically.

import { canonicalize } from "./jcs.ts";

export interface SnapshotJwk {
  kty: "OKP";
  crv: "Ed25519";
  kid: string;
  x: string;
  use?: "sig";
  not_before?: string;
  not_after?: string | null;
}

export interface SignedDocument {
  snapshot: { issued_at: string } & Record<string, unknown>;
  signature: { alg: string; kid: string; sig: string };
}

export type VerifyOutcome =
  | { ok: true; kid: string }
  | {
      ok: false;
      reason:
        | "unsupported_alg"
        | "no_key"
        | "key_not_valid_at_issue"
        | "malformed"
        | "bad_signature";
    };

/** Base64url (no padding) → bytes; throws on anything else. */
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The key that signed: same `kid`, and `issued_at` inside [not_before, not_after). */
export function selectKey(
  keys: readonly SnapshotJwk[],
  kid: string,
  issuedAt: string,
): SnapshotJwk | "no_key" | "key_not_valid_at_issue" {
  const k = keys.find((x) => x.kid === kid && x.kty === "OKP" && x.crv === "Ed25519");
  if (!k) return "no_key";
  const t = Date.parse(issuedAt);
  if (Number.isNaN(t)) return "key_not_valid_at_issue";
  if (k.not_before && t < Date.parse(k.not_before)) return "key_not_valid_at_issue";
  if (k.not_after && t >= Date.parse(k.not_after)) return "key_not_valid_at_issue";
  return k;
}

export async function verifySignedSnapshot(
  doc: SignedDocument,
  keys: readonly SnapshotJwk[],
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<VerifyOutcome> {
  if (doc.signature.alg !== "Ed25519") return { ok: false, reason: "unsupported_alg" };
  const k = selectKey(keys, doc.signature.kid, doc.snapshot.issued_at);
  if (typeof k === "string") return { ok: false, reason: k };
  let pub: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    pub = fromBase64Url(k.x);
    sig = fromBase64Url(doc.signature.sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (pub.length !== 32 || sig.length !== 64) return { ok: false, reason: "malformed" };
  const key = await subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  const data = new TextEncoder().encode(canonicalize(doc.snapshot));
  const ok = await subtle.verify({ name: "Ed25519" }, key, sig, data);
  return ok ? { ok: true, kid: k.kid } : { ok: false, reason: "bad_signature" };
}
