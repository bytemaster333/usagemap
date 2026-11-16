// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  checksum,
  KEY_RE,
  mintKey,
  newSecret,
  parseKey,
  parsePepperSet,
  verifySecret,
} from "../../src/keys/keys.ts";

const set = { peppers: new Map([[1, Buffer.alloc(32, 7)]]), current: 1 };

describe("key formats (wire-formats §k)", () => {
  it("mints keys in the documented grammar with the documented regex", () => {
    for (const kind of ["op", "ing", "pub"] as const) {
      const k = mintKey(kind, set);
      expect(k.key).toMatch(KEY_RE);
      expect(k.key).toMatch(/\bscfa_(op|ing|pub)_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}\b/);
      expect(k.key.startsWith(`scfa_${kind}_${k.id}_${k.secret}`)).toBe(true);
      expect(k.display).toBe(`scfa_${kind}_${k.id}_…${k.secret.slice(-4)}`);
      expect(k.last4).toBe(k.secret.slice(-4));
      expect(k.pepperVersion).toBe(1);
      // stored hash = HMAC-SHA-256(pepper, secret) — the same computation the gateway does (TokenFor)
      expect(
        k.hash.equals(createHmac("sha256", Buffer.alloc(32, 7)).update(k.secret).digest()),
      ).toBe(true);
    }
  });

  it("secrets carry 160 random bits as 27 zero-padded base62 characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = newSecret();
      expect(s).toMatch(/^[0-9A-Za-z]{27}$/);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
  });

  it("the checksum is CRC-32 (IEEE) of the ASCII prefix in base62, 6 characters", () => {
    const id = "AAAAAAAAAAAA";
    const secret = "0".repeat(27);
    const n = crc32(Buffer.from(`scfa_ing_${id}_${secret}`)) >>> 0;
    let v = BigInt(n);
    let s = "";
    const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    while (v > 0n) {
      s = A[Number(v % 62n)] + s;
      v /= 62n;
    }
    expect(checksum("ing", id, secret)).toBe(s.padStart(6, "0"));
  });

  it("parses keys offline: wrong kind or grammar = format, a changed character = checksum", () => {
    const k = mintKey("op", set);
    const p = parseKey(k.key, "op");
    expect(p.ok && p.key.id === k.id && p.key.secret === k.secret).toBe(true);
    expect(parseKey(k.key, "ing")).toEqual({ ok: false, reason: "format" });
    expect(parseKey(`${k.key}x`)).toEqual({ ok: false, reason: "format" });
    const flipped = k.key.slice(0, 25) + (k.key[25] === "a" ? "b" : "a") + k.key.slice(26);
    expect(parseKey(flipped)).toEqual({ ok: false, reason: "checksum" });
  });

  it("verifies secrets in constant time under the row's pepper version only", () => {
    const k = mintKey("ing", set);
    expect(verifySecret(set, 1, k.secret, k.hash)).toBe(true);
    expect(verifySecret(set, 2, k.secret, k.hash)).toBe(false);
    expect(verifySecret(set, 1, newSecret(), k.hash)).toBe(false);
    expect(verifySecret(undefined, 1, k.secret, k.hash)).toBe(false);
  });

  it("parses pepper sets with rotation overlap and refuses short or unknown versions", () => {
    const a = Buffer.alloc(32, 1).toString("base64");
    const b = Buffer.alloc(48, 2).toString("base64");
    const s = parsePepperSet("SCF_PEPPER_OP", `1:${a},2:${b}`, undefined);
    expect(s?.current).toBe(2);
    expect(parsePepperSet("SCF_PEPPER_OP", `1:${a},2:${b}`, "1")?.current).toBe(1);
    expect(parsePepperSet("SCF_PEPPER_OP", undefined, undefined)).toBeUndefined();
    expect(() =>
      parsePepperSet("SCF_PEPPER_OP", `1:${Buffer.alloc(16).toString("base64")}`, undefined),
    ).toThrow();
    expect(() => parsePepperSet("SCF_PEPPER_OP", `1:${a}`, "3")).toThrow();
  });
});
