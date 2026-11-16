// SPDX-License-Identifier: Apache-2.0
// Per-tenant Umami credentials (data-model §8.7, wire-formats §j.1, C-85). The API key and the tenant user's password
// are stored AES-256-GCM-encrypted under K_umami_creds[key_version], which is held outside the database (C-40):
//   ciphertext = nonce(12) ‖ ciphertext ‖ tag(16);  AAD = tenant_id (16 bytes) ‖ ASCII field name
// so a ciphertext cannot be moved to another tenant or swapped between the two fields. Plaintext exists in memory only
// for the duration of one call and is never logged.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { UmamiCredsKeys } from "../config.ts";
import type { Tx } from "../db/database.ts";

export type CredentialField = "api_key" | "password";

function aad(tenantId: string, field: CredentialField): Buffer {
  const hex = tenantId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("tenant id must be a UUID");
  return Buffer.concat([Buffer.from(hex, "hex"), Buffer.from(field, "ascii")]);
}

export function encryptCredential(
  keys: UmamiCredsKeys,
  tenantId: string,
  field: CredentialField,
  plaintext: string,
): { ciphertext: Buffer; keyVersion: number } {
  const key = keys.keys.get(keys.current);
  if (!key) throw new Error("no current Umami credentials key");
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad(tenantId, field));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext: Buffer.concat([nonce, body, c.getAuthTag()]), keyVersion: keys.current };
}

export function decryptCredential(
  keys: UmamiCredsKeys,
  keyVersion: number,
  tenantId: string,
  field: CredentialField,
  ciphertext: Buffer,
): string {
  const key = keys.keys.get(keyVersion);
  if (!key) throw new Error(`Umami credentials key version ${keyVersion} is not configured`);
  if (ciphertext.length < 12 + 16 + 1) throw new Error("credential ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(0, 12));
  d.setAAD(aad(tenantId, field));
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([
    d.update(ciphertext.subarray(12, ciphertext.length - 16)),
    d.final(),
  ]).toString("utf8");
}

/**
 * The tenant's view-only API key for live reads (§j.3), decrypted; null when the tenant is not provisioned yet (the
 * caller then answers from the rollups). Runs under the tenant's own context (RLS: scf_app may SELECT its row only).
 */
export async function tenantApiKey(
  tx: Tx,
  keys: UmamiCredsKeys | undefined,
  tenantId: string,
): Promise<string | null> {
  if (!keys) return null;
  const row = await tx.maybeOne<{ api_key_ciphertext: Buffer; key_version: number }>(
    `SELECT api_key_ciphertext, key_version FROM scf.umami_credentials WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!row) return null;
  return decryptCredential(
    keys,
    Number(row.key_version),
    tenantId,
    "api_key",
    row.api_key_ciphertext,
  );
}
