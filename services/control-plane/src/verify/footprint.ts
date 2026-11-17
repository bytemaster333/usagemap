// SPDX-License-Identifier: Apache-2.0
// The Registered Footprint of a tenant (C-135 plan A5, C-136 (7), C-137 (5), (9); data-model §12.1): the PROJECT-OWNED
// Stellar identifiers it declares — never end-user addresses. Contracts stay in `declared_contracts` (on-chain
// correlation keeps working unchanged; `declared` is shown as `claimed`, the stored network `public` as `mainnet`);
// issuing accounts, app accounts and WASM hashes live in `footprint_items`. The API shows both as one list.
//
// Scope (C-137): only contracts can be declared through the API. Declaring another kind answers 422; the challenge
// and verification paths of those kinds are implemented for rows that exist (they are counted nowhere yet).
//
// Verification: a contract (and a WASM hash) by `deployer_admin_match`, an account by `sep1_accounts` — both checked by
// job contract_verification (next_check_at = now, within 5 minutes: 202) — or by `signed_challenge`: a SEP-53
// signature over a one-time platform message by signers meeting the account's medium threshold (the L2 signer rule,
// data-model §8.5), decided at once (200). Only the challenge's SEP-53 digest is stored, never the message.

import { createPublicKey, randomBytes, verify } from "node:crypto";
import { declareContractRow } from "../api/services.ts";
import {
  decodeAccountId,
  type HorizonClient,
  NO_FEE_NOTICE,
  sep53Digest,
} from "../auth/stellar.ts";
import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";

const CHALLENGE_TTL_MS = 15 * 60_000;

type Kind = "contract" | "issuing_account" | "app_account" | "wasm_hash";
type Method = "sep1_accounts" | "signed_challenge" | "deployer_admin_match";

interface ItemRow extends Record<string, unknown> {
  item_id: string;
  kind: Kind;
  subject: string;
  network: "mainnet" | "testnet";
  label: string | null;
  status: "claimed" | "verified" | "rejected";
  verification_method: Method | null;
  verified_at: Date | null;
  rejected_reason: string | null;
  last_checked_at: Date | null;
  conflict_since: Date | null;
  created_at: Date;
}

/** Both sources as one list, removed items left out (the API's single vocabulary, C-137). */
const ITEMS_SQL = `
  SELECT c.contract_ref::text AS item_id, 'contract' AS kind, c.contract_id AS subject,
         CASE c.network WHEN 'public' THEN 'mainnet' ELSE c.network END AS network, c.label,
         CASE c.status WHEN 'declared' THEN 'claimed' ELSE c.status END AS status,
         CASE WHEN c.status = 'verified' THEN COALESCE(c.verification_method, 'deployer_admin_match') END
           AS verification_method,
         c.verified_at, c.rejected_reason, c.last_checked_at, c.conflict_since, c.created_at
    FROM scf.declared_contracts c WHERE c.tenant_id = $1 AND c.removed_at IS NULL
  UNION ALL
  SELECT f.item_id::text, f.kind, f.subject, f.network, f.label, f.status, f.verification_method, f.verified_at,
         f.rejected_reason, f.last_checked_at, f.conflict_since, f.created_at
    FROM scf.footprint_items f WHERE f.tenant_id = $1 AND f.removed_at IS NULL`;

export function footprintView(r: ItemRow): Record<string, unknown> {
  return {
    item_id: r.item_id,
    kind: r.kind,
    subject: r.subject,
    network: r.network,
    label: r.label,
    status: r.status,
    verification_method: r.verification_method,
    verified_at: r.verified_at?.toISOString() ?? null,
    rejected_reason: r.rejected_reason,
    last_checked_at: r.last_checked_at?.toISOString() ?? null,
    conflict_since: r.conflict_since?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  };
}

async function loadItem(tx: Tx, tenantId: string, itemId: string): Promise<ItemRow> {
  const r = await tx.maybeOne<ItemRow>(
    `SELECT * FROM (${ITEMS_SQL}) x WHERE x.item_id = $2::text`,
    [tenantId, itemId],
  );
  if (!r) throw new ApiError("not_found");
  return r;
}

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

const ACCOUNT_KINDS = new Set<Kind>(["issuing_account", "app_account"]);
const METHODS_BY_KIND: Record<Kind, readonly Method[]> = {
  contract: ["deployer_admin_match"],
  wasm_hash: ["deployer_admin_match"],
  issuing_account: ["sep1_accounts", "signed_challenge"],
  app_account: ["sep1_accounts", "signed_challenge"],
};

/** The one-time message an account signs (SEP-53; names the platform, the project, the account and a nonce). */
export function footprintChallengeMessage(p: {
  domain: string;
  slug: string;
  tenantId: string;
  account: string;
  network: string;
  nonce: string;
  expiresAt: Date;
}): string {
  return [
    `${p.domain} asks you to prove that this Stellar account belongs to your project:`,
    p.account,
    "",
    `Purpose: register the account in the footprint of ${p.slug} (${p.tenantId}) on UsageMap`,
    NO_FEE_NOTICE,
    `Network: ${p.network}`,
    `Nonce: ${p.nonce}`,
    `Expiration Time: ${p.expiresAt.toISOString()}`,
  ].join("\n");
}

function ed25519Verify(account: string, digest: Buffer, signatureB64: string): boolean {
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: decodeAccountId(account).toString("base64url") },
      format: "jwk",
    });
    return verify(null, digest, key, sig);
  } catch {
    return false;
  }
}

/**
 * Declares one contract (status `claimed`) and audits `footprint.item_added`; shared by addFootprintItem (a member's
 * session) and registerFootprintContract (a footprint registration key, keys/footprint-keys.ts, which adds `via`).
 * Returns the item as the API shows it. `409` when the contract is already declared.
 */
export async function addContractItem(
  tx: Tx,
  tenantId: string,
  createdBy: string | undefined,
  c: { subject: string; mainnet: boolean; label?: string; service_id?: string },
  auditExtra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const ref = await declareContractRow(tx, tenantId, createdBy, {
    contract_id: c.subject,
    network: c.mainnet ? "public" : "testnet",
    ...(c.label !== undefined ? { label: c.label } : {}),
    ...(c.service_id !== undefined ? { service_id: c.service_id } : {}),
  });
  await tx.audit({
    action: "footprint.item_added",
    targetType: "declared_contract",
    targetId: ref,
    details: {
      kind: "contract",
      network: c.mainnet ? "mainnet" : "testnet",
      with_service: c.service_id !== undefined,
      ...auditExtra,
    },
  });
  return footprintView(await loadItem(tx, tenantId, ref));
}

export interface FootprintDeps {
  homeDomain: string;
  horizon: HorizonClient;
  now?: () => number;
}

export function footprintHandlers(deps: FootprintDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  const listFootprint: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const rows = await ctx.tx((tx) =>
      tx.query<ItemRow>(`SELECT * FROM (${ITEMS_SQL}) x ORDER BY x.created_at, x.item_id`, [
        tenantId,
      ]),
    );
    return { status: 200, body: rows.map(footprintView) };
  };

  const addFootprintItem: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const b = ctx.body as {
      kind: Kind;
      subject: string;
      network: "mainnet" | "testnet" | "public";
      label?: string;
      service_id?: string;
    };
    // C-138: `mainnet`/`testnet` like every response; `public` is the deprecated alias of `mainnet`. A declared
    // contract keeps the stored vocabulary of scf.declared_contracts (`public`), which on-chain correlation reads.
    const mainnet = b.network !== "testnet";
    if (b.kind !== "contract")
      // C-137: accounts and WASM hashes are not accepted through the API and not counted yet.
      throw new ApiError(
        "unprocessable",
        "only contracts can be registered now; accounts and WASM hashes are not supported yet",
        { errors: [{ pointer: "/kind", detail: "kind must be contract" }] },
      );
    if (!/^C[A-Z2-7]{55}$/.test(b.subject)) throw bad("/subject", "a contract id starts with C");
    const body = await ctx.tx((tx) =>
      addContractItem(tx, tenantId, ctx.session?.userId, {
        subject: b.subject,
        mainnet,
        ...(b.label !== undefined ? { label: b.label } : {}),
        ...(b.service_id !== undefined ? { service_id: b.service_id } : {}),
      }),
    );
    return { status: 201, body };
  };

  const removeFootprintItem: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const itemId = ctx.params.itemId as string;
    await ctx.tx(async (tx) => {
      const item = await loadItem(tx, tenantId, itemId);
      if (item.kind === "contract")
        await tx.query(
          `UPDATE scf.declared_contracts SET removed_at = now()
            WHERE tenant_id = $1 AND contract_ref = $2 AND removed_at IS NULL`,
          [tenantId, itemId],
        );
      // the retention rule deletes a removed item 30 days later (C-137)
      else
        await tx.query(
          `UPDATE scf.footprint_items SET removed_at = now(), challenge_hash = NULL, challenge_expires_at = NULL,
                  next_check_at = NULL
            WHERE tenant_id = $1 AND item_id = $2 AND removed_at IS NULL`,
          [tenantId, itemId],
        );
      await tx.audit({
        action: "footprint.item_removed",
        targetType: item.kind === "contract" ? "declared_contract" : "footprint_item",
        targetId: itemId,
        details: { kind: item.kind, network: item.network },
      });
    });
    return { status: 204 };
  };

  const createFootprintChallenge: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const itemId = ctx.params.itemId as string;
    const now = clock();
    const expiresAt = new Date(now + CHALLENGE_TTL_MS);
    const body = await ctx.tx(async (tx) => {
      const item = await loadItem(tx, tenantId, itemId);
      if (!ACCOUNT_KINDS.has(item.kind))
        throw bad(
          "/",
          "a signing challenge exists for accounts only (contracts and WASM hashes are checked on the ledger)",
        );
      const t = await tx.one<{ slug: string }>(
        `SELECT slug FROM scf.tenants WHERE tenant_id = $1`,
        [tenantId],
      );
      const message = footprintChallengeMessage({
        domain: deps.homeDomain,
        slug: t.slug,
        tenantId,
        account: item.subject,
        network: item.network,
        nonce: randomBytes(16).toString("hex"),
        expiresAt,
      });
      // Only the SEP-53 digest (SHA-256 of the prefixed message, what the account signs) is stored.
      await tx.query(
        `UPDATE scf.footprint_items SET challenge_hash = $3, challenge_expires_at = $4
          WHERE tenant_id = $1 AND item_id = $2`,
        [tenantId, itemId, sep53Digest(message), expiresAt],
      );
      await tx.audit({
        action: "footprint.verification_requested",
        targetType: "footprint_item",
        targetId: itemId,
        details: { kind: item.kind, method: "signed_challenge" },
      });
      return { item_id: itemId, message, expires_at: expiresAt.toISOString() };
    });
    return { status: 200, body, headers: { "cache-control": "no-store" } };
  };

  const verifyFootprintItem: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const itemId = ctx.params.itemId as string;
    const b = ctx.body as { method: Method; signature?: string };
    const item = await ctx.tx((tx) => loadItem(tx, tenantId, itemId));
    if (!METHODS_BY_KIND[item.kind].includes(b.method))
      throw bad("/method", `${b.method} does not apply to ${item.kind}`);
    if (item.status === "rejected" && item.rejected_reason === "claimed_by_other_tenant")
      // C-137 (5): the job never undoes an operator's decision, so a check request would only queue work.
      throw bad(
        "/",
        "an SCF operator rejected this item as claimed by another tenant; it is not checked again",
      );
    if (b.method !== "signed_challenge") {
      if (b.signature !== undefined)
        throw bad("/signature", "signature is for signed_challenge only");
      // Queued for job contract_verification (within 5 minutes).
      const body = await ctx.tx(async (tx) => {
        if (item.kind === "contract")
          await tx.query(
            `UPDATE scf.declared_contracts SET next_check_at = now() WHERE tenant_id = $1 AND contract_ref = $2`,
            [tenantId, itemId],
          );
        else
          await tx.query(
            `UPDATE scf.footprint_items SET next_check_at = now() WHERE tenant_id = $1 AND item_id = $2`,
            [tenantId, itemId],
          );
        await tx.audit({
          action: "footprint.verification_requested",
          targetType: item.kind === "contract" ? "declared_contract" : "footprint_item",
          targetId: itemId,
          details: { kind: item.kind, method: b.method },
        });
        return footprintView(await loadItem(tx, tenantId, itemId));
      });
      return { status: 202, body };
    }
    if (!b.signature) throw bad("/signature", "signature required for signed_challenge");
    const ch = await ctx.tx((tx) =>
      tx.maybeOne<{ hash: Buffer | null; expired: boolean }>(
        `SELECT challenge_hash AS hash, challenge_expires_at <= now() AS expired FROM scf.footprint_items
          WHERE tenant_id = $1 AND item_id = $2`,
        [tenantId, itemId],
      ),
    );
    if (!ch?.hash) throw bad("/method", "request a challenge first (createFootprintChallenge)");
    let reason: "signature_invalid" | "challenge_expired" | null = null;
    let details: Record<string, unknown> = {};
    if (ch.expired) reason = "challenge_expired";
    else if (!ed25519Verify(item.subject, ch.hash, b.signature)) reason = "signature_invalid";
    else {
      // L2 signer rule (data-model §8.5): the signing key meets the account's medium threshold on its network.
      const info = await deps.horizon.accountInfo(
        item.network === "mainnet" ? "public" : "testnet",
        item.subject,
      );
      if (!info.exists || info.weight <= 0 || info.weight < info.mediumThreshold)
        reason = "signature_invalid";
      details = { signer_weight: info.weight, medium_threshold: info.mediumThreshold };
    }
    const body = await ctx.tx(async (tx) => {
      // single use: the challenge is consumed whatever the outcome
      const done = await tx.query(
        reason
          ? `UPDATE scf.footprint_items
                SET status = 'rejected', rejected_reason = $3, verification_method = NULL, verified_at = NULL,
                    conflict_since = NULL, last_checked_at = now(), challenge_hash = NULL, challenge_expires_at = NULL
              WHERE tenant_id = $1 AND item_id = $2 AND challenge_hash = $4 RETURNING item_id`
          : `UPDATE scf.footprint_items
                SET status = 'verified', rejected_reason = NULL, verification_method = 'signed_challenge',
                    verified_at = now(), last_checked_at = now(), challenge_hash = NULL, challenge_expires_at = NULL
              WHERE tenant_id = $1 AND item_id = $2 AND challenge_hash = $4 AND $3::text IS NULL RETURNING item_id`,
        [tenantId, itemId, reason, ch.hash],
      );
      if (done.length === 0) throw new ApiError("conflict", "the challenge was used concurrently");
      await tx.audit({
        action: reason ? "footprint.item_rejected" : "footprint.item_verified",
        targetType: "footprint_item",
        targetId: itemId,
        details: reason
          ? { kind: item.kind, reason }
          : { kind: item.kind, method: "signed_challenge", ...details },
      });
      return footprintView(await loadItem(tx, tenantId, itemId));
    });
    return { status: 200, body };
  };

  return {
    listFootprint,
    addFootprintItem,
    removeFootprintItem,
    createFootprintChallenge,
    verifyFootprintItem,
  };
}
