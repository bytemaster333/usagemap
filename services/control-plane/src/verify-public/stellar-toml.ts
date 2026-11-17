// SPDX-License-Identifier: Apache-2.0
// Keys for verifiers ("verify this number", 2026-11-19): everything a reader needs to check a published number without
// trusting our servers, from one place —
//   - the traction-snapshot signing keys (Ed25519; as JWK `x` and as the same 32 bytes in Stellar strkey form, so a
//     Stellar tool can show and compare them);
//   - the daily seal's network and the sealing account(s) that sealed days on it (public data from scf.seal_days);
//   - the SEP-10 signing key and its home domain, when the deployment has one;
//   - where the snapshot JWKS, the seal days and the sealed audit-anchor documents are served.
// `verifierKeys` is the JSON document (`GET /public/v1/verifier-keys`); `stellarToml` renders the same keys as a
// SEP-1 `stellar.toml` for the product's apex domain (`GET /public/v1/stellar.toml`, which the landing site copies to
// `https://<domain>/.well-known/stellar.toml`). SEP-1 v2.7.0 has no field for a non-account signing key: the snapshot
// keys go into a clearly named extension table `[USAGEMAP_VERIFY]` that SEP-1 clients ignore; the seal account goes
// into ACCOUNTS (accounts the domain controls). Nothing here says the numbers are genuine or endorsed (C4).

import type { Jwk } from "../programme/keys.ts";
import type { SealNetworkView } from "../programme/seal-network.ts";

export const VERIFIER_KEYS_SCHEMA = "usagemap/verifier-keys/1";
export const SEP1_VERSION = "2.7.0";

export interface VerifierKeys {
  schema: typeof VERIFIER_KEYS_SCHEMA;
  generated_at: string;
  snapshot_signing: {
    alg: "Ed25519";
    jwks_url: string;
    keys: Array<{
      kid: string;
      x: string;
      stellar_public_key: string;
      not_before: string | null;
      not_after: string | null;
      current: boolean;
    }>;
  };
  seal: {
    network: SealNetworkView;
    /** accounts that sealed days on this network, oldest first use first */
    accounts: string[];
    seals_url: string;
    audit_anchor_url_template: string;
    latest_confirmed: {
      day: string;
      ledger: number;
      tx_hash: string;
      explorer_url: string | null;
    } | null;
  };
  sep10: { home_domain: string; signing_key: string } | null;
  links: { self: string; stellar_toml: string; verify_page: string };
  statement: string;
}

export const VERIFIER_STATEMENT =
  "Keys to check that a published number is exactly what UsageMap signed and sealed. They show tamper-evidence, not that the numbers are genuine, and imply no endorsement by SCF, SDF or anyone else.";

/** TOML basic string (escapes per TOML 1.0: backslash, quote, control characters). */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

const list = (xs: readonly string[]) => `[${xs.map(tomlString).join(", ")}]`;

export function verifierKeys(o: {
  now: number;
  portalOrigin: string;
  jwks: { keys: Jwk[] };
  encodeKey: (raw: Buffer) => string;
  network: SealNetworkView;
  accounts: readonly string[];
  latest: VerifierKeys["seal"]["latest_confirmed"];
  sep10: VerifierKeys["sep10"];
}): VerifierKeys {
  return {
    schema: VERIFIER_KEYS_SCHEMA,
    generated_at: new Date(o.now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    snapshot_signing: {
      alg: "Ed25519",
      jwks_url: `${o.portalOrigin}/.well-known/scf-snapshot-keys.json`,
      keys: o.jwks.keys.map((k) => ({
        kid: k.kid,
        x: k.x,
        stellar_public_key: o.encodeKey(Buffer.from(k.x, "base64url")),
        not_before: k.not_before ?? null,
        not_after: k.not_after,
        current: k.not_after === null,
      })),
    },
    seal: {
      network: o.network,
      accounts: [...o.accounts],
      seals_url: `${o.portalOrigin}/public/v1/seals`,
      audit_anchor_url_template: `${o.portalOrigin}/public/v1/audit-anchors/{day}`,
      latest_confirmed: o.latest,
    },
    sep10: o.sep10,
    links: {
      self: `${o.portalOrigin}/public/v1/verifier-keys`,
      stellar_toml: `${o.portalOrigin}/public/v1/stellar.toml`,
      verify_page: `${o.portalOrigin}/verify`,
    },
    statement: VERIFIER_STATEMENT,
  };
}

/** The SEP-1 file for `domain` (the product's apex), from the verifier keys. */
export function stellarToml(k: VerifierKeys, o: { domain: string; description: string }): string {
  const lines: string[] = [
    "# stellar.toml (SEP-1) — generated from the live configuration by UsageMap's control plane",
    `# (${k.links.stellar_toml}, ${k.generated_at}).`,
    "# It lists the keys a reader needs to verify published numbers. Tamper-evidence only: it does not show that",
    "# the numbers are genuine and implies no endorsement by SCF, SDF or anyone else.",
    "",
    `VERSION = ${tomlString(SEP1_VERSION)}`,
    `NETWORK_PASSPHRASE = ${tomlString(k.seal.network.passphrase)}`,
  ];
  if (k.seal.accounts.length > 0) {
    lines.push(
      `# The daily-seal account(s) on Stellar ${k.seal.network.name}: one MEMO_HASH transaction per UTC day.`,
    );
    lines.push(`ACCOUNTS = ${list(k.seal.accounts)}`);
  }
  if (k.sep10 && k.sep10.home_domain === o.domain) {
    lines.push(`SIGNING_KEY = ${tomlString(k.sep10.signing_key)}`);
  }
  lines.push(
    "",
    "[DOCUMENTATION]",
    `ORG_DBA = ${tomlString("UsageMap")}`,
    `ORG_URL = ${tomlString(`https://${o.domain}`)}`,
    `ORG_DESCRIPTION = ${tomlString(o.description)}`,
    "",
    "# Extension (not part of SEP-1; SEP-1 clients ignore it): how to verify a UsageMap number.",
    "[USAGEMAP_VERIFY]",
    `VERIFIER_KEYS = ${tomlString(k.links.self)}`,
    `VERIFY_PAGE = ${tomlString(k.links.verify_page)}`,
    `SNAPSHOT_KEYS_JWKS = ${tomlString(k.snapshot_signing.jwks_url)}`,
    `SNAPSHOT_SIGNING_ALG = ${tomlString(k.snapshot_signing.alg)}`,
    `# Ed25519 public keys of the traction-snapshot signer, as Stellar strkeys (same 32 bytes as the JWK "x").`,
    `SNAPSHOT_SIGNING_KEYS = ${list(k.snapshot_signing.keys.map((x) => x.stellar_public_key))}`,
    `SNAPSHOT_SIGNING_KIDS = ${list(k.snapshot_signing.keys.map((x) => x.kid))}`,
    `SEAL_NETWORK = ${tomlString(k.seal.network.name)}`,
    `SEAL_DURABLE = ${k.seal.network.durable ? "true" : "false"}`,
    `SEAL_DAYS = ${tomlString(k.seal.seals_url)}`,
    `AUDIT_ANCHORS = ${tomlString(k.seal.audit_anchor_url_template)}`,
    `SEAL_HORIZON = ${tomlString(k.seal.network.lookup.horizon)}`,
  );
  if (k.seal.network.notice) lines.push(`SEAL_NOTICE = ${tomlString(k.seal.network.notice)}`);
  return `${lines.join("\n")}\n`;
}
