// SPDX-License-Identifier: Apache-2.0
// A minimal software WebAuthn authenticator (ES256, attestation "none") for the passkey tests: it produces exactly the
// browser JSON that @simplewebauthn/browser would send.

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

type Cbor = number | string | Buffer | Map<number | string, Cbor> | Cbor[];

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}

const b64u = (b: Buffer) => b.toString("base64url");

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #key: KeyObject;
  readonly #pub: { x: Buffer; y: Buffer };
  #counter = 0;

  readonly rpId: string;
  readonly origin: string;

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.#pub = {
      x: Buffer.from(jwk.x as string, "base64url"),
      y: Buffer.from(jwk.y as string, "base64url"),
    };
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  #clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }

  #rpHash(): Buffer {
    return createHash("sha256").update(this.rpId).digest();
  }

  /** navigator.credentials.create() for the given options JSON. */
  register(options: { challenge: string }): Record<string, unknown> {
    const cose = new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, this.#pub.x],
      [-3, this.#pub.y],
    ]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    const flags = 0x01 | 0x04 | 0x40; // UP, UV, AT
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([
      this.#rpHash(),
      Buffer.from([flags]),
      counter,
      Buffer.alloc(16),
      len,
      this.credentialId,
      cbor(cose),
    ]);
    const att = cbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.#clientData("webauthn.create", options.challenge)),
        attestationObject: b64u(att),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() for the given options JSON. */
  assert(options: { challenge: string }): Record<string, unknown> {
    this.#counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const authData = Buffer.concat([this.#rpHash(), Buffer.from([0x01 | 0x04]), counter]);
    const clientData = this.#clientData("webauthn.get", options.challenge);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
      this.#key,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
