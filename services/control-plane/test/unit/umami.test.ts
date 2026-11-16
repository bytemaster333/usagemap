// SPDX-License-Identifier: Apache-2.0
// Credentials encryption and the derived tenant password of job umami_reconcile (data-model §8.7, C-85).

import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCredsKeys } from "../../src/config.ts";
import { decryptCredential, encryptCredential } from "../../src/umami/credentials.ts";
import { derivePassword } from "../../src/umami/reconcile.ts";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");
const keys = parseCredsKeys(`1:${k1},2:${k2}`, undefined);
if (!keys) throw new Error("keys");

describe("Umami credentials", () => {
  it("round-trips under the current key version and binds tenant and field (AAD)", () => {
    const t = randomUUID();
    const { ciphertext, keyVersion } = encryptCredential(keys, t, "api_key", "umami_abc");
    expect(keyVersion).toBe(2);
    expect(ciphertext.includes(Buffer.from("umami_abc"))).toBe(false);
    expect(decryptCredential(keys, 2, t, "api_key", ciphertext)).toBe("umami_abc");
    expect(() => decryptCredential(keys, 2, randomUUID(), "api_key", ciphertext)).toThrow();
    expect(() => decryptCredential(keys, 2, t, "password", ciphertext)).toThrow();
    expect(() => decryptCredential(keys, 1, t, "api_key", ciphertext)).toThrow();
    const tampered = Buffer.from(ciphertext);
    tampered[14] = (tampered[14] as number) ^ 1;
    expect(() => decryptCredential(keys, 2, t, "api_key", tampered)).toThrow();
  });

  it("parses key lists and refuses bad ones", () => {
    expect(parseCredsKeys(`1:${k1}`, undefined)?.current).toBe(1);
    expect(parseCredsKeys(`1:${k1},2:${k2}`, "1")?.current).toBe(1);
    expect(() => parseCredsKeys("1:short", undefined)).toThrow();
    expect(() => parseCredsKeys(`1:${k1}`, "3")).toThrow();
    expect(parseCredsKeys(undefined, undefined)).toBeUndefined();
  });

  it("derives the tenant password deterministically per key version and tenant (restartable P2)", () => {
    const t = randomUUID();
    const a = derivePassword(keys, 2, t);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(derivePassword(keys, 2, t)).toBe(a);
    expect(derivePassword(keys, 2, t.toUpperCase())).toBe(a);
    expect(derivePassword(keys, 1, t)).not.toBe(a);
    expect(derivePassword(keys, 2, randomUUID())).not.toBe(a);
  });
});
