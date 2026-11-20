// SPDX-License-Identifier: Apache-2.0
// Checks a stellar.toml against SEP-1 (stellar-protocol ecosystem/sep-0001.md, version 2.7.0, read 2026-11-19)
// before the site publishes it at /.well-known/stellar.toml: at most 100 KB, valid TOML (src/toml.ts), the general
// fields with their types (URLs https, keys valid StrKeys with a correct checksum), and a [DOCUMENTATION] table whose
// ORG_URL is on the domain that serves the file. A file that fails is not published: the build fails.

import { parseToml, type TomlTable, type TomlValue } from "./toml.ts";

/** "The stellar.toml can have a maximum file size of 100KB" (SEP-1). */
export const SEP1_MAX_BYTES = 100 * 1024;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** A Stellar StrKey of the given kind ("G" account, "C" contract): base32, version byte, 32 bytes, CRC16 checksum. */
export function isStrKey(s: string, kind: "G" | "C"): boolean {
  if (!/^[A-Z2-7]{56}$/.test(s) || s[0] !== kind) return false;
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    acc = (acc << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length !== 35 || (acc & ((1 << bits) - 1)) !== 0) return false;
  const version = kind === "G" ? 6 << 3 : 2 << 3;
  if (out[0] !== version) return false;
  const payload = Uint8Array.from(out.slice(0, 33));
  const crc = crc16xmodem(payload);
  return out[33] === (crc & 0xff) && out[34] === crc >> 8;
}

const URL_FIELDS = [
  "FEDERATION_SERVER",
  "AUTH_SERVER",
  "TRANSFER_SERVER",
  "TRANSFER_SERVER_SEP0024",
  "KYC_SERVER",
  "WEB_AUTH_ENDPOINT",
  "WEB_AUTH_FOR_CONTRACTS_ENDPOINT",
  "DIRECT_PAYMENT_SERVER",
  "ANCHOR_QUOTE_SERVER",
  "HORIZON_URL",
] as const;

const KEY_FIELDS = ["SIGNING_KEY", "URI_REQUEST_SIGNING_KEY"] as const;

export const NETWORKS = [
  "Public Global Stellar Network ; September 2015",
  "Test SDF Network ; September 2015",
] as const;

const isHttps = (v: TomlValue | undefined): boolean => {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

export interface Sep1Result {
  doc: TomlTable | undefined;
  problems: string[];
}

/** Validates a stellar.toml served from `domain` ("usagemap.dev"). */
export function checkStellarToml(src: string, domain: string): Sep1Result {
  const problems: string[] = [];
  const bytes = Buffer.byteLength(src);
  if (bytes > SEP1_MAX_BYTES) problems.push(`${bytes} bytes, over SEP-1's 100 KB`);
  let doc: TomlTable;
  try {
    doc = parseToml(src);
  } catch (e) {
    return { doc: undefined, problems: [...problems, `not valid TOML: ${(e as Error).message}`] };
  }
  if (typeof doc.VERSION !== "string" || !/^\d+\.\d+\.\d+$/.test(doc.VERSION))
    problems.push('VERSION must be the SEP-1 version as a string (e.g. "2.7.0")');
  if (!NETWORKS.includes(doc.NETWORK_PASSPHRASE as (typeof NETWORKS)[number]))
    problems.push("NETWORK_PASSPHRASE must be the public or the test network passphrase");
  for (const f of URL_FIELDS) {
    if (doc[f] !== undefined && !isHttps(doc[f])) problems.push(`${f} must be an https URL`);
  }
  for (const f of KEY_FIELDS) {
    if (doc[f] !== undefined && !(typeof doc[f] === "string" && isStrKey(doc[f], "G")))
      problems.push(`${f} must be a Stellar public key (G…)`);
  }
  if (doc.WEB_AUTH_CONTRACT_ID !== undefined) {
    const v = doc.WEB_AUTH_CONTRACT_ID;
    if (!(typeof v === "string" && isStrKey(v, "C")))
      problems.push("WEB_AUTH_CONTRACT_ID must be a contract ID (C…)");
  }
  if (doc.ACCOUNTS !== undefined) {
    const a = doc.ACCOUNTS;
    if (!Array.isArray(a) || a.length === 0) problems.push("ACCOUNTS must be a non-empty list");
    else {
      for (const k of a)
        if (!(typeof k === "string" && isStrKey(k, "G")))
          problems.push(`ACCOUNTS: ${String(k)} is not a G… key`);
      if (new Set(a as string[]).size !== a.length) problems.push("ACCOUNTS lists a key twice");
    }
  }
  const d = doc.DOCUMENTATION;
  if (d === undefined || Array.isArray(d) || typeof d !== "object") {
    problems.push("[DOCUMENTATION] is missing");
  } else {
    const named = (v: TomlValue | undefined) => typeof v === "string" && v.trim() !== "";
    if (!named(d.ORG_NAME) && !named(d.ORG_DBA))
      problems.push("DOCUMENTATION needs ORG_NAME or ORG_DBA (who publishes the file)");
    if (!isHttps(d.ORG_URL)) problems.push("DOCUMENTATION.ORG_URL must be an https URL");
    else {
      const host = new URL(d.ORG_URL as string).host;
      if (host !== domain && !host.endsWith(`.${domain}`))
        problems.push(
          `DOCUMENTATION.ORG_URL must be on ${domain} (SEP-1: same domain as the file)`,
        );
    }
    for (const f of [
      "ORG_LOGO",
      "ORG_PHYSICAL_ADDRESS_ATTESTATION",
      "ORG_PHONE_NUMBER_ATTESTATION",
    ]) {
      if (d[f] !== undefined && !isHttps(d[f]))
        problems.push(`DOCUMENTATION.${f} must be an https URL`);
    }
  }
  return { doc, problems };
}
