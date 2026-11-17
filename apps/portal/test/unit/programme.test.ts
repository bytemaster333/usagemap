// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
// Programme outputs in the portal: RFC 8785 canonicalisation, the in-browser snapshot check (key selection by kid and
// validity, Ed25519 over JCS; wire-formats §i.3) and the tracker upgrade state (tracker.intentional-upgrade).

import { generateKeyPairSync, sign } from "node:crypto";
import type { ControlPlane } from "@usagemap/api-types";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/lib/jcs.ts";
import {
  fromBase64Url,
  type SnapshotJwk,
  selectKey,
  verifySignedSnapshot,
} from "../../src/lib/snapshotVerify.ts";
import { compareSemver, latestActive, upgradeState } from "../../src/lib/trackerVersions.ts";

describe("JCS (RFC 8785)", () => {
  it("sorts members by UTF-16 code units, drops whitespace and serialises numbers like ECMAScript", () => {
    // Same vector as the control plane's signer test (services/control-plane/test/unit/programme.test.ts).
    expect(canonicalize({ b: [1, 2.5, 1e21, 0, 0.000001], a: { z: null, y: true } })).toBe(
      '{"a":{"y":true,"z":null},"b":[1,2.5,1e+21,0,0.000001]}',
    );
    // RFC 8785 §3.2.3: "€" (€) sorts after "\r" and before the surrogate pair of U+1F600.
    expect(canonicalize({ "😀": 1, "€": 2, "\r": 3, "1": 4 })).toBe('{"\\r":3,"1":4,"€":2,"😀":1}');
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize('a "b')).toBe('"a \\"b"');
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize(Number.NaN)).toThrow(/finite/);
    expect(() => canonicalize(() => 1)).toThrow(/not a JSON value/);
  });
});

function keyPair(kid: string, notBefore?: string, notAfter?: string | null) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const jwk: SnapshotJwk = {
    kty: "OKP",
    crv: "Ed25519",
    kid,
    x,
    use: "sig",
    ...(notBefore ? { not_before: notBefore } : {}),
    ...(notAfter !== undefined ? { not_after: notAfter } : {}),
  };
  const signDoc = (snapshot: { issued_at: string } & Record<string, unknown>) => ({
    snapshot,
    signature: {
      alg: "Ed25519",
      kid,
      sig: sign(null, Buffer.from(canonicalize(snapshot)), privateKey).toString("base64url"),
    },
  });
  return { jwk, signDoc };
}

const SNAP = {
  schema: "scf-analytics/traction-snapshot/1",
  snapshot_id: "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12",
  issued_at: "2026-11-12T10:00:00Z",
  project: { slug: "example", name: "Example", verification_level: "L3" },
  web: { verified: { pageviews: 48213, visitors_sum: 9118 } },
};

describe("snapshot verification (wire-formats §i.3)", () => {
  it("accepts a genuine signature and reports the key", async () => {
    const k = keyPair("snap-1", "2026-01-01T00:00:00Z", null);
    const r = await verifySignedSnapshot(k.signDoc({ ...SNAP }), [k.jwk]);
    expect(r).toEqual({ ok: true, kid: "snap-1" });
  });

  it("verifies regardless of member order (the signature is over the canonical form)", async () => {
    const k = keyPair("snap-1");
    const doc = k.signDoc({ ...SNAP });
    const reordered = JSON.parse(
      JSON.stringify({ web: doc.snapshot.web, ...doc.snapshot }),
    ) as typeof doc.snapshot;
    expect((await verifySignedSnapshot({ ...doc, snapshot: reordered }, [k.jwk])).ok).toBe(true);
  });

  it("rejects any change to the snapshot", async () => {
    const k = keyPair("snap-1");
    const doc = k.signDoc(structuredClone(SNAP));
    (doc.snapshot.web as { verified: { pageviews: number } }).verified.pageviews += 1;
    expect(await verifySignedSnapshot(doc, [k.jwk])).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature by another key with the same kid", async () => {
    const real = keyPair("snap-1");
    const forger = keyPair("snap-1");
    expect(await verifySignedSnapshot(forger.signDoc({ ...SNAP }), [real.jwk])).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("selects the key by kid and validity at issue time", () => {
    const old = keyPair("snap-old", "2025-01-01T00:00:00Z", "2026-06-01T00:00:00Z").jwk;
    const cur = keyPair("snap-cur", "2026-06-01T00:00:00Z", null).jwk;
    expect(selectKey([old, cur], "snap-cur", SNAP.issued_at)).toBe(cur);
    expect(selectKey([old, cur], "snap-old", "2026-03-01T00:00:00Z")).toBe(old);
    expect(selectKey([old, cur], "snap-old", SNAP.issued_at)).toBe("key_not_valid_at_issue");
    expect(selectKey([old, cur], "snap-cur", "2026-05-31T23:59:59Z")).toBe(
      "key_not_valid_at_issue",
    );
    expect(selectKey([old, cur], "nope", SNAP.issued_at)).toBe("no_key");
  });

  it("refuses unsupported algorithms and malformed values without throwing", async () => {
    const k = keyPair("snap-1");
    const doc = k.signDoc({ ...SNAP });
    expect(
      await verifySignedSnapshot({ ...doc, signature: { ...doc.signature, alg: "RS256" } }, [
        k.jwk,
      ]),
    ).toEqual({ ok: false, reason: "unsupported_alg" });
    expect(
      await verifySignedSnapshot({ ...doc, signature: { ...doc.signature, sig: "AAAA" } }, [k.jwk]),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      await verifySignedSnapshot({ ...doc, signature: { ...doc.signature, sig: "not+b64url/" } }, [
        k.jwk,
      ]),
    ).toEqual({ ok: false, reason: "malformed" });
    expect([...fromBase64Url("AQID")]).toEqual([1, 2, 3]);
  });
});

const release = (
  version: string,
  status: "active" | "withdrawn" = "active",
  advisory_url: string | null = null,
): ControlPlane.TrackerVersion => ({
  version,
  status,
  released_at: "2026-11-12T00:00:00Z",
  files: [],
  advisory_url,
});

describe("tracker upgrade state (tracker.intentional-upgrade)", () => {
  const two = [release("1.0.0"), release("1.10.0"), release("1.9.0")];

  it("compares versions numerically, not as text", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(latestActive(two)).toBe("1.10.0");
    expect(latestActive([release("2.0.0", "withdrawn"), release("1.0.0")])).toBe("1.0.0");
    expect(latestActive([])).toBeNull();
  });

  it("states current, update available, withdrawn, unknown and not reported", () => {
    expect(upgradeState("1.10.0", two)).toEqual({
      kind: "current",
      seen: "1.10.0",
      latest: "1.10.0",
    });
    expect(upgradeState("1.0.0", two)).toEqual({
      kind: "update_available",
      seen: "1.0.0",
      latest: "1.10.0",
    });
    expect(
      upgradeState("1.0.0", [
        release("1.0.0", "withdrawn", "https://example.org/advisory"),
        release("1.1.0"),
      ]),
    ).toEqual({
      kind: "withdrawn",
      seen: "1.0.0",
      latest: "1.1.0",
      advisory: "https://example.org/advisory",
    });
    expect(upgradeState("0.9.0", two)).toEqual({
      kind: "unknown",
      seen: "0.9.0",
      latest: "1.10.0",
    });
    expect(upgradeState(null, two)).toEqual({ kind: "not_reported", latest: "1.10.0" });
  });
});
