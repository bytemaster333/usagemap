// SPDX-License-Identifier: Apache-2.0
// The traction-snapshot keys as the control plane knows them (C-47, C-81; wire-formats §i.3): PUBLIC keys only,
// published as a JWKS at `/.well-known/scf-snapshot-keys.json` together with earlier keys that are still needed to
// verify old snapshots. The private key is held by the jobs service, which signs; it is separate
// from every pepper and from the edge-snapshot key, and it is a handover item.

import { createPublicKey, verify } from "node:crypto";
import type { ProgrammeConfig, SnapshotPublicKey } from "../config.ts";
import { canonicalize } from "./jcs.ts";

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  kid: string;
  x: string;
  use: "sig";
  not_before?: string;
  not_after: string | null;
}

export class SnapshotKeys {
  readonly kid: string;
  readonly #current: boolean;
  readonly #jwks: Jwk[];

  constructor(
    cfg: Pick<
      ProgrammeConfig,
      "snapshotPublicKeyPem" | "snapshotKid" | "snapshotKeyNotBefore" | "retiredSnapshotKeys"
    >,
  ) {
    this.kid = cfg.snapshotKid;
    const published: SnapshotPublicKey[] = [];
    if (cfg.snapshotPublicKeyPem) {
      const key = createPublicKey(cfg.snapshotPublicKeyPem);
      if (key.asymmetricKeyType !== "ed25519")
        throw new Error("the traction-snapshot public key must be Ed25519");
      published.push({
        kid: cfg.snapshotKid,
        x: key.export({ format: "jwk" }).x as string,
        ...(cfg.snapshotKeyNotBefore ? { not_before: cfg.snapshotKeyNotBefore } : {}),
        not_after: null,
      });
    }
    this.#current = published.length > 0;
    for (const r of cfg.retiredSnapshotKeys) {
      if (published.some((p) => p.kid === r.kid))
        throw new Error(`snapshot key id ${r.kid} is published twice`);
      published.push(r);
    }
    this.#jwks = published.map((p) => ({
      kty: "OKP",
      crv: "Ed25519",
      kid: p.kid,
      x: p.x,
      use: "sig",
      ...(p.not_before ? { not_before: p.not_before } : {}),
      not_after: p.not_after,
    }));
  }

  /** A current key is published, so the jobs service is expected to sign new snapshots. */
  get configured(): boolean {
    return this.#current;
  }

  /** `{keys: […]}` (wire-formats §i.3 step 1). */
  jwks(): { keys: Jwk[] } {
    return { keys: this.#jwks.map((k) => ({ ...k })) };
  }
}

/** A verifier's check (wire-formats §i.3 steps 2–3), used by the tests and usable by anyone. */
export function verifySnapshot(
  jwks: { keys: Array<{ kid: string; x: string; not_before?: string; not_after?: string | null }> },
  signed: {
    snapshot: { issued_at?: unknown };
    signature: { alg: string; kid: string; sig: string };
  },
): boolean {
  if (signed.signature.alg !== "Ed25519") return false;
  const issued = Date.parse(String(signed.snapshot.issued_at));
  const k = jwks.keys.find(
    (j) =>
      j.kid === signed.signature.kid &&
      (!j.not_before || Date.parse(j.not_before) <= issued) &&
      (!j.not_after || Date.parse(j.not_after) > issued),
  );
  if (!k) return false;
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
  return verify(
    null,
    Buffer.from(canonicalize(signed.snapshot), "utf8"),
    pub,
    Buffer.from(signed.signature.sig, "base64url"),
  );
}
