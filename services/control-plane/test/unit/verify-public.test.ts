// SPDX-License-Identifier: Apache-2.0
// "Verify this number" (2026-11-19): badges (wording C4, small-count floors, XML escaping, Shields endpoint shape),
// verifier keys (snapshot key as a Stellar strkey of the same bytes) and the SEP-1 stellar.toml rendering.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeAccountId, encodeAccountId } from "../../src/auth/stellar.ts";
import { SnapshotKeys } from "../../src/programme/keys.ts";
import { parseSealNetwork, sealNetworkView } from "../../src/programme/seal-network.ts";
import {
  BADGE_FLOORS,
  type BadgeDoc,
  badgeSvg,
  badgeText,
  compactCount,
  flooredCount,
  shieldsEndpoint,
} from "../../src/verify-public/badge.ts";
import { apexDomain } from "../../src/verify-public/handlers.ts";
import { stellarToml, tomlString, verifierKeys } from "../../src/verify-public/stellar-toml.ts";

const doc = (visitors: number, requests = 0, assurance: string | null = null): BadgeDoc => ({
  project: { slug: "alder", name: 'Alder <Remit> & "Co"' },
  window: { end: "2026-11-19T00:00:00Z", days: 30 },
  web: { verified: { visitors_sum: visitors } },
  api: { requests, assurance_level: assurance },
});

describe("badges", () => {
  it("formats counts compactly and never rounds up", () => {
    expect(compactCount(1234)).toBe("1,234");
    expect(compactCount(9999)).toBe("9,999");
    expect(compactCount(12_399)).toBe("12.3k");
    expect(compactCount(48_178)).toBe("48.1k");
    expect(compactCount(1_299_999)).toBe("1.2M");
    expect(() => compactCount(-1)).toThrow();
  });

  it("applies the small-count floors", () => {
    expect(flooredCount(0, "visitors")).toBe("< 100");
    expect(flooredCount(99, "visitors")).toBe("< 100");
    expect(flooredCount(100, "visitors")).toBe("100");
    expect(flooredCount(999, "api")).toBe("< 1,000");
    expect(BADGE_FLOORS).toEqual({ visitors: 100, api: 1000 });
  });

  it("says who measured and never implies an endorsement (C4)", () => {
    for (const t of [badgeText(doc(5000), "visitors"), badgeText(doc(5000, 50_000, "A2"), "api")]) {
      expect(t.label).toBe("measured by UsageMap");
      expect(t.title).toMatch(/not an endorsement/);
      expect(`${t.label} ${t.message}`).not.toMatch(/SCF|SDF|verified by|certified|approved/i);
    }
    expect(badgeText(doc(5000, 50_000, "A2"), "api").message).toBe(
      "50k API requests (self-attested) / 30d",
    );
    expect(badgeText(doc(5000), "api")).toMatchObject({
      message: "API: not reported",
      reported: false,
    });
  });

  it("escapes the project name in the SVG", () => {
    const svg = badgeSvg(doc(48_178), "visitors");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain("Alder &lt;Remit&gt; &amp; &quot;Co&quot;");
    expect(svg).not.toContain("<Remit>");
    expect(svg).toContain("48.1k verified visitors / 30d");
    expect(svg).not.toMatch(/<script|on[a-z]+=/i);
  });

  it("serves the Shields endpoint shape", () => {
    expect(shieldsEndpoint(doc(42), "visitors")).toEqual({
      schemaVersion: 1,
      label: "measured by UsageMap",
      message: "< 100 verified visitors / 30d",
      color: "1f5fae",
      cacheSeconds: 3600,
    });
  });
});

describe("verifier keys and stellar.toml", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const keys = new SnapshotKeys({
    snapshotPublicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    snapshotKid: "snap-1",
    snapshotKeyNotBefore: undefined,
    retiredSnapshotKeys: [],
  });
  const seal = parseSealNetwork(() => undefined);
  const SEAL = "GA5KH6OZTG6LVLVYWOE4XYTZKEDYSYBATLGLFLERCGWFNP7WS3I3K7JY";
  const build = (sep10: { home_domain: string; signing_key: string } | null) =>
    verifierKeys({
      now: Date.parse("2026-11-19T12:00:00.123Z"),
      portalOrigin: "https://app.usagemap.dev",
      jwks: keys.jwks(),
      encodeKey: encodeAccountId,
      network: sealNetworkView(seal),
      accounts: [SEAL],
      latest: { day: "2026-11-18", ledger: 5808323, tx_hash: "38".repeat(32), explorer_url: null },
      sep10,
    });

  it("gives the snapshot key as JWK x and as a strkey of the same 32 bytes", () => {
    const k = build(null);
    const key = k.snapshot_signing.keys[0];
    expect(key?.current).toBe(true);
    expect(decodeAccountId(key?.stellar_public_key as string)).toEqual(
      Buffer.from(key?.x as string, "base64url"),
    );
    expect(k.generated_at).toBe("2026-11-19T12:00:00Z");
    expect(k.seal.accounts).toEqual([SEAL]);
    expect(k.links.stellar_toml).toBe("https://app.usagemap.dev/public/v1/stellar.toml");
  });

  it("renders SEP-1: VERSION, NETWORK_PASSPHRASE, ACCOUNTS, the extension table", () => {
    const k = build({ home_domain: "app.usagemap.dev", signing_key: SEAL });
    const toml = stellarToml(k, { domain: "usagemap.dev", description: "x" });
    expect(toml).toContain('VERSION = "2.7.0"');
    expect(toml).toContain('NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"');
    expect(toml).toContain(`ACCOUNTS = ["${SEAL}"]`);
    expect(toml).toContain('ORG_URL = "https://usagemap.dev"');
    expect(toml).toContain("[USAGEMAP_VERIFY]");
    expect(toml).toContain(
      `SNAPSHOT_SIGNING_KEYS = ["${k.snapshot_signing.keys[0]?.stellar_public_key}"]`,
    );
    expect(toml).toContain("SEAL_DURABLE = false");
    // the SEP-10 key belongs to its home domain only
    expect(toml).not.toContain("SIGNING_KEY =");
    expect(stellarToml(k, { domain: "app.usagemap.dev", description: "x" })).toContain(
      `SIGNING_KEY = "${SEAL}"`,
    );
    expect(Buffer.byteLength(toml)).toBeLessThan(100 * 1024);
    // every key = value line is TOML-shaped
    for (const line of toml
      .split("\n")
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("[")))
      expect(line).toMatch(/^[A-Z0-9_]+ = (".*"|\[.*\]|true|false)$/);
  });

  it("escapes TOML strings and derives the apex domain", () => {
    expect(tomlString('a "b"\\\n')).toBe('"a \\"b\\"\\\\\\n"');
    expect(apexDomain("https://app.usagemap.dev")).toBe("usagemap.dev");
    expect(apexDomain("http://localhost:8080")).toBe("localhost");
  });
});
