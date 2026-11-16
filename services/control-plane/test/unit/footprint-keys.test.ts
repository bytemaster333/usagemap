// SPDX-License-Identifier: Apache-2.0
// Footprint registration keys `scfa_reg_…` (migration 0081): key grammar, the derived pepper set, the operation's
// authorisation metadata and its rate limits. The HTTP behaviour against PostgreSQL is in
// test/integration/footprint-keys.test.ts.
import { describe, expect, it } from "vitest";
import { OpenApi } from "../../src/http/openapi.ts";
import {
  FOOTPRINT_KEY_LIMITS,
  footprintKeyIdOf,
  limitsFor,
  READ_ONLY_ALLOWED,
} from "../../src/http/pipeline.ts";
import { RateLimiter } from "../../src/http/ratelimit.ts";
import {
  footprintPepperSet,
  hashSecret,
  KEY_RE,
  mintKey,
  parseKey,
  verifySecret,
} from "../../src/keys/keys.ts";

const pub = { peppers: new Map([[1, Buffer.alloc(32, 9)]]), current: 1 };

describe("scfa_reg_ keys", () => {
  it("mint and parse in the shared grammar, and never parse as another kind", () => {
    const k = mintKey("reg", pub);
    expect(k.key).toMatch(KEY_RE);
    expect(k.key).toMatch(/^scfa_reg_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/);
    expect(parseKey(k.key, "reg")).toEqual({
      ok: true,
      key: { kind: "reg", id: k.id, secret: k.secret },
    });
    expect(parseKey(k.key, "pub")).toEqual({ ok: false, reason: "format" });
    expect(parseKey(k.key.replace("scfa_reg_", "scfa_pub_"), "pub")).toEqual({
      ok: false,
      reason: "checksum",
    });
  });

  it("derive their pepper from the share-key pepper when SCF_PEPPER_REG is unset, independent of it", () => {
    expect(footprintPepperSet({ ing: undefined, op: undefined, pub: undefined })).toBeUndefined();
    const derived = footprintPepperSet({ ing: undefined, op: undefined, pub });
    expect(derived?.current).toBe(1);
    const p = derived?.peppers.get(1) as Buffer;
    expect(p.length).toBe(32);
    expect(p.equals(pub.peppers.get(1) as Buffer)).toBe(false);
    // stable: the same pepper on every instance and restart
    expect(footprintPepperSet({ ing: undefined, op: undefined, pub })?.peppers.get(1)).toEqual(p);
    const k = mintKey("reg", derived as NonNullable<typeof derived>);
    expect(verifySecret(derived, 1, k.secret, k.hash)).toBe(true);
    // a hash under the share-key pepper never verifies
    expect(
      verifySecret(derived, 1, k.secret, hashSecret(pub.peppers.get(1) as Buffer, k.secret)),
    ).toBe(false);
    const explicit = { peppers: new Map([[3, Buffer.alloc(32, 1)]]), current: 3 };
    expect(footprintPepperSet({ ing: undefined, op: undefined, pub, reg: explicit })).toBe(
      explicit,
    );
  });
});

describe("registerFootprintContract metadata and limits", () => {
  const api = new OpenApi();
  const op = api.get("registerFootprintContract");

  it("is a footprint_key operation without session, CSRF or tenant role", () => {
    expect(op.roles).toEqual(["footprint_key"]);
    expect(op.csrf).toBe(false);
    expect(op.method).toBe("post");
    expect(op.path).toBe("/v1/tenants/{tenantId}/footprint/register");
    expect(op.auditActions).toEqual(["footprint.item_added"]);
    for (const id of ["listFootprintKeys", "createFootprintKey", "revokeFootprintKey"])
      expect(api.get(id).roles).toEqual(["tenant:admin"]);
    expect(api.get("createFootprintKey").recentAuth).toBe(true);
    expect(api.get("revokeFootprintKey").recentAuth).toBe(true);
    expect(READ_ONLY_ALLOWED.has("revokeFootprintKey")).toBe(true);
    expect(READ_ONLY_ALLOWED.has("registerFootprintContract")).toBe(false);
  });

  it("reads the key id from a well-formed bearer value only", () => {
    const k = mintKey("reg", pub);
    expect(footprintKeyIdOf(`Bearer ${k.key}`)).toBe(k.id);
    expect(footprintKeyIdOf(k.key)).toBeUndefined();
    expect(footprintKeyIdOf(`Bearer ${mintKey("pub", pub).key}`)).toBeUndefined();
    expect(footprintKeyIdOf(undefined)).toBeUndefined();
  });

  it("limits per subnet and per key (minute and day)", () => {
    const keys = (ls: { key: string; limit: number; windowMs: number }[]) =>
      Object.fromEntries(ls.map((l) => [l.key, [l.limit, l.windowMs]]));
    expect(keys(limitsFor(op, null, "203.0.113.0/24", 60, "Abcdefghijk1"))).toEqual({
      "p:203.0.113.0/24": [600, 60_000],
      "fk:203.0.113.0/24": [FOOTPRINT_KEY_LIMITS.perSubnetMin, 60_000],
      "fkm:Abcdefghijk1": [FOOTPRINT_KEY_LIMITS.perKeyMin, 60_000],
      "fkd:Abcdefghijk1": [FOOTPRINT_KEY_LIMITS.perKeyDay, 86_400_000],
    });
    expect(Object.keys(keys(limitsFor(op, null, "203.0.113.0/24")))).toEqual([
      "p:203.0.113.0/24",
      "fk:203.0.113.0/24",
    ]);
    // other operations never get the footprint buckets
    expect(
      limitsFor(api.get("addFootprintItem"), null, "x", 60, "Abcdefghijk1").some((l) =>
        l.key.startsWith("fk"),
      ),
    ).toBe(false);
    const rl = new RateLimiter(() => 0);
    const v = Array.from({ length: FOOTPRINT_KEY_LIMITS.perKeyMin + 1 }, (_, i) =>
      rl.hit(limitsFor(op, null, `198.51.${i}.0/24`, 60, "Abcdefghijk1")),
    );
    expect(v[FOOTPRINT_KEY_LIMITS.perKeyMin - 1]?.allowed).toBe(true);
    expect(v[FOOTPRINT_KEY_LIMITS.perKeyMin]?.allowed).toBe(false);
  });
});
