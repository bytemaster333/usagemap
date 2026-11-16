// SPDX-License-Identifier: Apache-2.0
// Pure parts of the programme outputs: RFC 8785 canonical JSON, the snapshot JWKS and signature check, calendar-month
// starts of a period, the health document's rules (wire-formats §i.2, C-119) and the SEP-10 verifier.

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { Keypair, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { passphraseOf, Sep10 } from "../../src/auth/sep10.ts";
import { parseIngestHosts, parseRetiredKeys } from "../../src/config.ts";
import { monthStarts } from "../../src/programme/figures.ts";
import { healthDocument } from "../../src/programme/health.ts";
import { canonicalize } from "../../src/programme/jcs.ts";
import { SnapshotKeys, verifySnapshot } from "../../src/programme/keys.ts";
import { TractionSigningKey } from "../../src/programme/signer.ts";

describe("JCS (RFC 8785)", () => {
  it("sorts members by UTF-16 code units, drops whitespace, serialises numbers the ECMAScript way", () => {
    // RFC 8785 §3.2.3 sorting example (subset) and §3.2.2.3 numbers
    expect(
      canonicalize({ "€": "Euro Sign", "\r": "Carriage Return", "1": "One", "\u0080": "Control" }),
    ).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","€":"Euro Sign"}');
    expect(canonicalize({ b: [1, 2.5, 1e21, -0, 0.000001], a: { z: null, y: true } })).toBe(
      '{"a":{"y":true,"z":null},"b":[1,2.5,1e+21,0,0.000001]}',
    );
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
  });
});

describe("snapshot keys", () => {
  const pem = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicPem = createPublicKey(pem).export({ format: "pem", type: "spki" }).toString();
  const signer = new TractionSigningKey(pem, "snap-2026-11");
  const retiredX = Buffer.alloc(32, 7).toString("base64url");
  const keys = new SnapshotKeys({
    snapshotPublicKeyPem: publicPem,
    snapshotKid: "snap-2026-11",
    snapshotKeyNotBefore: "2026-11-01T00:00:00Z",
    retiredSnapshotKeys: parseRetiredKeys(
      JSON.stringify([
        {
          kid: "snap-2026-10",
          x: retiredX,
          not_before: "2026-10-01T00:00:00Z",
          not_after: "2026-11-01T00:00:00Z",
        },
      ]),
    ),
  });

  it("publishes the current and retired keys as a JWKS; the jobs service's key signs JCS(snapshot)", () => {
    expect(keys.configured).toBe(true);
    expect(signer.publicX()).toBe(keys.jwks().keys[0]?.x);
    const jwks = keys.jwks();
    expect(jwks.keys.map((k) => [k.kid, k.not_after])).toEqual([
      ["snap-2026-11", null],
      ["snap-2026-10", "2026-11-01T00:00:00Z"],
    ]);
    const snapshot = { issued_at: "2026-11-12T10:00:00Z", b: 1, a: [2] };
    const s = signer.sign(snapshot);
    const signed = {
      snapshot,
      signature: { alg: "Ed25519", kid: s.kid, sig: s.signature.toString("base64url") },
    };
    expect(verifySnapshot(jwks, signed)).toBe(true);
    // the key must cover issued_at
    expect(
      verifySnapshot(jwks, {
        ...signed,
        snapshot: { ...snapshot, issued_at: "2026-10-15T00:00:00Z" },
      }),
    ).toBe(false);
    expect(
      verifySnapshot(jwks, { ...signed, signature: { ...signed.signature, kid: "snap-2026-10" } }),
    ).toBe(false);
  });

  it("the control plane's key set is public only: no current key without SCF_SNAPSHOT_PUBLIC_KEY", () => {
    const none = new SnapshotKeys({
      snapshotPublicKeyPem: undefined,
      snapshotKid: "k",
      snapshotKeyNotBefore: undefined,
      retiredSnapshotKeys: [],
    });
    expect(none.configured).toBe(false);
    expect(none.jwks()).toEqual({ keys: [] });
    expect("sign" in keys).toBe(false);
  });

  it("rejects malformed retired keys and non-Ed25519 keys", () => {
    expect(() =>
      parseRetiredKeys('[{"kid":"x","x":"short","not_after":"2026-01-01T00:00:00Z"}]'),
    ).toThrow();
    expect(() => parseRetiredKeys(`[{"kid":"x","x":"${retiredX}"}]`)).toThrow(/not_after/);
    const rsaPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsa = rsaPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(
      () =>
        new TractionSigningKey(
          rsaPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          "k",
        ),
    ).toThrow(/Ed25519/);
    expect(
      () =>
        new SnapshotKeys({
          snapshotPublicKeyPem: rsa,
          snapshotKid: "k",
          snapshotKeyNotBefore: undefined,
          retiredSnapshotKeys: [],
        }),
    ).toThrow(/Ed25519/);
  });
});

describe("monthStarts", () => {
  it("lists the first instant of each calendar month of the period, the first clipped to the start", () => {
    const d = (s: string) => Date.parse(s);
    expect(
      monthStarts(d("2026-08-15T00:00:00Z"), d("2026-11-01T00:00:00Z")).map((m) =>
        new Date(m).toISOString(),
      ),
    ).toEqual(["2026-08-15T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    expect(monthStarts(d("2026-12-01T00:00:00Z"), d("2027-01-02T00:00:00Z"))).toHaveLength(2);
  });
});

describe("health document (§i.2, C-119)", () => {
  const cfg = {
    ingestHosts: parseIngestHosts("i.a.example=e-a1|e-a2,i.b.example=e-b1"),
    nodeStaleSeconds: 300,
    backlogDegraded: 100,
    statusPageUrl: undefined,
  };
  const now = Date.parse("2026-11-12T10:00:00Z");
  const node = (n: string, ageS: number, queued = 0) => ({
    node: n,
    last: now - ageS * 1000,
    queued,
  });

  it("ok with every node fresh; degraded with one node down; down with none; worst component wins", () => {
    const fresh = [node("e-a1", 10), node("e-a2", 10), node("e-b1", 10)];
    expect(healthDocument(cfg, "1.0.0", now, { ok: true, nodes: fresh }).status).toBe("ok");
    const one = healthDocument(cfg, "1.0.0", now, {
      ok: true,
      nodes: [node("e-a1", 10), node("e-a2", 400), node("e-b1", 10)],
    });
    expect(one).toMatchObject({
      status: "degraded",
      components: { web_ingest: "degraded", otlp_ingest: "degraded" },
    });
    const none = healthDocument(cfg, "1.0.0", now, {
      ok: true,
      nodes: fresh.map((n) => ({ ...n, last: now - 4000_000 })),
    });
    expect(none).toMatchObject({
      status: "down",
      components: { web_ingest: "down", processing: "down" },
    });
    const backlog = healthDocument(cfg, "1.0.0", now, {
      ok: true,
      nodes: [node("e-a1", 10, 500), node("e-b1", 10)],
    });
    expect(backlog.components).toMatchObject({ processing: "degraded" });
    expect(healthDocument(cfg, "1.0.0", now, { ok: false, nodes: [] })).toMatchObject({
      status: "down",
      components: { dashboards: "down" },
    });
  });

  it("parses the ingest-host configuration strictly", () => {
    expect(() => parseIngestHosts("i.example=Bad_Node")).toThrow();
    expect(parseIngestHosts(undefined)).toEqual([]);
  });
});

describe("SEP-10 verifier", () => {
  const sep10 = new Sep10({
    seed: Keypair.random().secret(),
    network: "testnet",
    homeDomain: "portal.test",
    webAuthDomain: "portal.test",
  });
  const sign = (xdr: string, ...k: Keypair[]) => {
    const tx = TransactionBuilder.fromXDR(xdr, passphraseOf("testnet"));
    for (const x of k) tx.sign(x);
    return tx.toXDR();
  };
  const a = Keypair.random();
  const b = Keypair.random();
  const info = (threshold: number) => ({
    weight: 1,
    mediumThreshold: threshold,
    homeDomain: null,
    exists: true,
    signers: [
      { key: a.publicKey(), weight: 1 },
      { key: b.publicKey(), weight: 2 },
    ],
  });

  it("accepts the issued challenge signed to the medium threshold and nothing else", () => {
    const c = sep10.challenge(a.publicKey());
    expect(sep10.verify(sign(c.xdr, a, b), a.publicKey(), c.hash, info(3))).toEqual({ weight: 3 });
    expect(() => sep10.verify(sign(c.xdr, a), a.publicKey(), c.hash, info(3))).toThrow();
    expect(() => sep10.verify(sign(c.xdr, a, b), b.publicKey(), c.hash, info(1))).toThrow(); // another account
    const other = sep10.challenge(a.publicKey());
    expect(() => sep10.verify(sign(other.xdr, a), a.publicKey(), c.hash, info(1))).toThrow(); // not the issued one
    const foreign = WebAuth.buildChallengeTx(
      Keypair.random(),
      a.publicKey(),
      "portal.test",
      600,
      passphraseOf("testnet"),
      "portal.test",
    );
    expect(() => sep10.verify(sign(foreign, a), a.publicKey(), c.hash, info(1))).toThrow();
    expect(
      () => new Sep10({ seed: "nope", network: "public", homeDomain: "x", webAuthDomain: "x" }),
    ).toThrow();
  });
});
