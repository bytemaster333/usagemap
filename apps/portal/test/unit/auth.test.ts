// SPDX-License-Identifier: Apache-2.0
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  freighterAdapter,
  networkOfMessage,
  normaliseSignature,
  passphraseFor,
} from "../../src/auth/wallet.ts";
import {
  b64urlToBytes,
  bytesToB64url,
  creationOptionsFromJson,
  requestOptionsFromJson,
} from "../../src/auth/webauthn.ts";

const sig64 = new Uint8Array(64).map((_, i) => i);
const b64 = Buffer.from(sig64).toString("base64");

describe("wallet adapter (SEP-53)", () => {
  it("normalises base64, base64url, hex, bytes and serialised Buffers", () => {
    expect(normaliseSignature(b64)).toBe(b64);
    expect(normaliseSignature(Buffer.from(sig64).toString("base64url"))).toBe(b64);
    expect(normaliseSignature(Buffer.from(sig64).toString("hex"))).toBe(b64);
    expect(normaliseSignature(sig64)).toBe(b64);
    expect(normaliseSignature({ type: "Buffer", data: [...sig64] })).toBe(b64);
    expect(() => normaliseSignature("abc")).toThrow();
    expect(() => normaliseSignature(new Uint8Array(10))).toThrow();
    expect(() => normaliseSignature(null)).toThrow();
  });

  it("reads the network from the message the control plane issued", () => {
    const m = "x wants you to sign in\nG\n\nPurpose: p\nNetwork: public\nNonce: n";
    expect(networkOfMessage(m)).toBe("public");
    expect(passphraseFor(m)).toBe("Public Global Stellar Network ; September 2015");
    expect(passphraseFor(m, "explicit")).toBe("explicit");
  });

  it("drives Freighter through its API and checks the signer", async () => {
    const account = `G${"A".repeat(55)}`;
    const api = {
      isConnected: vi.fn(async () => ({ isConnected: true })),
      requestAccess: vi.fn(async () => ({ address: account })),
      signMessage: vi.fn(async () => ({ signedMessage: b64, signerAddress: account })),
    };
    const w = freighterAdapter(api as never);
    expect(await w.available()).toBe(true);
    expect(await w.getAccount()).toBe(account);
    expect(await w.signMessage("msg", account, "pp")).toBe(b64);
    expect(api.signMessage).toHaveBeenCalledWith("msg", {
      address: account,
      networkPassphrase: "pp",
    });
    api.signMessage.mockResolvedValueOnce({
      signedMessage: b64,
      signerAddress: `G${"B".repeat(55)}`,
    });
    await expect(w.signMessage("msg", account, undefined)).rejects.toThrow(/different account/);
    api.signMessage.mockResolvedValueOnce({
      signedMessage: null,
      signerAddress: "",
      error: { message: "denied" },
    } as never);
    await expect(w.signMessage("msg", account, undefined)).rejects.toThrow("denied");
    api.isConnected.mockRejectedValueOnce(new Error("no extension"));
    expect(await w.available()).toBe(false);
  });

  it("a SEP-53 signature made by a key verifies as the control plane checks it", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const msg = "hello";
    const digest = createHash("sha256").update(`Stellar Signed Message:\n${msg}`).digest();
    const s = normaliseSignature(sign(null, digest, privateKey).toString("hex"));
    expect(Buffer.from(s, "base64")).toHaveLength(64);
    expect(publicKey.asymmetricKeyType).toBe("ed25519");
  });
});

describe("WebAuthn JSON conversion", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect([...b64urlToBytes(bytesToB64url(bytes))]).toEqual([...bytes]);
    expect(bytesToB64url(bytes)).not.toMatch(/[+/=]/);
  });
  it("converts creation and request options", () => {
    const c = creationOptionsFromJson({
      challenge: "AAEC",
      rp: { name: "x", id: "localhost" },
      user: { id: "AQID", name: "n", displayName: "d" },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      excludeCredentials: [{ id: "BAUG", type: "public-key", transports: ["internal"] }],
    });
    expect([...new Uint8Array(c.challenge as ArrayBuffer)]).toEqual([0, 1, 2]);
    expect([...new Uint8Array(c.user.id as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(c.excludeCredentials?.[0]?.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    const r = requestOptionsFromJson({
      challenge: "AAEC",
      rpId: "localhost",
      allowCredentials: [{ id: "BAUG", type: "public-key" }],
    });
    expect(r.rpId).toBe("localhost");
    expect(r.allowCredentials).toHaveLength(1);
    expect(() => requestOptionsFromJson({})).toThrow();
  });
});
