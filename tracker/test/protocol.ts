// SPDX-License-Identifier: Apache-2.0
// Gateway side of protocol v1 (wire-formats §a, §b) for tests: JSON Schemas copied verbatim from the contract into
// test/fixtures, token issue per §b.1 with a real §b.2 proof-of-work target, and stateless proof verification.
// No test-runner imports, so both vitest and Playwright use it.

import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

const schema = (name: string): object => {
  const s = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", `${name}.schema.json`), "utf8"),
  ) as Record<string, unknown>;
  delete s.$id; // placeholder host in the contract (`<domain-a>`) is not a valid URI
  return s;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
export const validateChallengeRequest = ajv.compile(schema("challenge-request"));
export const validateChallengeResponse = ajv.compile(schema("challenge-response"));
export const validateEventBatch = ajv.compile(schema("event-batch"));

export const HOST_A = "https://a.ingest.test";
export const HOST_B = "https://b.ingest.test";
export const SITE = "Q4mZ8bS1pTn0aR7cLx2VwE";

const b64u = (b: Buffer): string => b.toString("base64url");

export interface Issued {
  token: string;
  nonce: Buffer;
  cost: number;
  max: number;
  pfx: string;
  secret: number;
}

const dk = (nonce: Buffer, c: number, cost: number): Buffer => {
  const ctr = Buffer.alloc(4);
  ctr.writeUInt32BE(c);
  return pbkdf2Sync(
    Buffer.concat([Buffer.from("scf-pow-v1"), nonce, ctr]),
    nonce,
    cost,
    32,
    "sha256",
  );
};

/** Token per §b.1 (MAC is random here — the tracker treats the token as opaque except for the nonce). */
export function issue(cost = 1, max = 16): Issued {
  const nonce = randomBytes(16);
  const secret = Math.floor(Math.random() * max);
  const pfx = dk(nonce, secret, cost).subarray(0, 4).toString("hex");
  const t = Buffer.alloc(92);
  t[0] = 1;
  t.writeUInt32BE(Math.floor(Date.now() / 3.6e6), 1);
  createHash("sha256").update(SITE).digest().copy(t, 5, 0, 16);
  t.writeUIntBE(Date.now(), 21, 6);
  nonce.copy(t, 27);
  randomBytes(8).copy(t, 43);
  t.writeUInt16BE(cost, 51);
  t.writeUInt16BE(max, 53);
  Buffer.from(pfx, "hex").copy(t, 55);
  randomBytes(32).copy(t, 60);
  return { token: b64u(t), nonce, cost, max, pfx, secret };
}

/** Gateway-side verification (§b.3): one PBKDF2 for the submitted counter. */
export const verifyProof = (iss: Issued, c: number): boolean =>
  c >= 0 && c < iss.max && dk(iss.nonce, c, iss.cost).subarray(0, 4).toString("hex") === iss.pfx;
