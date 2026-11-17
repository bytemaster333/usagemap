// SPDX-License-Identifier: Apache-2.0
// The verification ladder of a tenant (ADR-0015; data-model §8.5; C-19): level and evidence, registry matches, and the
// L2 proof of a Stellar account.
//
// L2 (C-19): an **account** signature (SEP-53 message signature here; the challenge names the tenant and the purpose,
// so a sign-in signature cannot be replayed as a link proof) by a signer that meets the account's medium threshold;
// the account's `home_domain` is a verified domain of the tenant (valid `domain` evidence); and that domain's
// `stellar.toml` (SEP-1, fetched under the domain verifier's SSRF rules) lists the account in `ACCOUNTS`. The network
// is the deployment's (C-114). On success the `stellar_account` evidence is written (or renewed) and audited, and the
// edge snapshot is rebuilt (the level travels to the gateway).

import { SEP10_TTL_S, type Sep10 } from "../auth/sep10.ts";
import {
  decodeAccountId,
  type HorizonClient,
  NO_FEE_NOTICE,
  verifySep53,
} from "../auth/stellar.ts";
import type { StellarNetwork } from "../config.ts";
import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { randomBase62, sha256 } from "../util/ids.ts";
import type { TextFetcher } from "./verifier.ts";

const CHALLENGE_TTL_MS = 10 * 60_000;

/** The account ids in the top-level `ACCOUNTS` array of a stellar.toml (SEP-1); tables after it are ignored. */
export function tomlAccounts(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // comments: `#` outside a string (account ids and the keys we read contain no `#`)
    let line = "";
    let quote: string | null = null;
    for (const ch of raw) {
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#") break;
      line += ch;
    }
    if (/^\s*\[/.test(line)) break; // first table header ends the top level
    lines.push(line);
  }
  const top = lines.join("\n");
  const m = /(?:^|\n)\s*ACCOUNTS\s*=\s*\[([^\]]*)\]/.exec(top);
  if (!m) return [];
  return [...(m[1] as string).matchAll(/["'](G[A-Z2-7]{55})["']/g)].map((x) => x[1] as string);
}

export function linkMessage(p: {
  domain: string;
  account: string;
  tenantId: string;
  slug: string;
  network: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  return [
    `${p.domain} asks you to prove control of your Stellar account:`,
    p.account,
    "",
    `Purpose: link this account to the project ${p.slug} (${p.tenantId}) on UsageMap`,
    NO_FEE_NOTICE,
    `Network: ${p.network}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expiration Time: ${p.expiresAt.toISOString()}`,
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------ views

interface EvidenceRow extends Record<string, unknown> {
  evidence_id: string;
  kind: string;
  subject: string;
  status: string;
  verified_at: Date;
  last_checked_at: Date | null;
  details: Record<string, unknown>;
}

export const EVIDENCE_COLS = `evidence_id::text AS evidence_id, kind::text AS kind, subject, status::text AS status,
  verified_at, last_checked_at, details`;

export function evidenceView(r: EvidenceRow): Record<string, unknown> {
  // The approving SCF operator's account id is not shown to the tenant.
  const { operator_user_id: _o, ...details } = r.details ?? {};
  return {
    evidence_id: r.evidence_id,
    kind: r.kind,
    subject: r.subject,
    status: r.status,
    verified_at: r.verified_at.toISOString(),
    last_checked_at: r.last_checked_at?.toISOString() ?? null,
    details,
  };
}

export async function registryLinks(tx: Tx, tenantId: string): Promise<Record<string, unknown>[]> {
  const rows = await tx.query<{
    registry_project_id: string;
    source: string;
    name: string;
    scf_awarded: boolean | null;
    source_as_of: string | null;
    match_basis: string[];
    status: string;
  }>(
    `SELECT l.registry_project_id::text AS registry_project_id, p.source, p.name, p.scf_awarded,
            p.source_as_of::text AS source_as_of, l.match_basis, l.status
       FROM scf.tenant_registry_links l JOIN scf.registry_projects p ON p.registry_project_id = l.registry_project_id
      WHERE l.tenant_id = $1 ORDER BY l.created_at, l.registry_project_id`,
    [tenantId],
  );
  return rows.map((r) => ({ ...r }));
}

export async function verificationStatus(
  tx: Tx,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const lvl = await tx.one<{ l: number }>(`SELECT scf.verification_level($1)::int AS l`, [
    tenantId,
  ]);
  const ev = await tx.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLS} FROM scf.verification_evidence WHERE tenant_id = $1 ORDER BY verified_at, evidence_id`,
    [tenantId],
  );
  const valid = (k: string) => ev.some((e) => e.kind === k && e.status === "valid");
  const next: string[] = [];
  if (!valid("domain")) next.push("verify_domain");
  if (!valid("stellar_account")) next.push("link_stellar_account");
  if (!valid("registry_match")) next.push("await_registry_match");
  if (!valid("operator_approval")) next.push("await_operator_approval");
  return {
    level: `L${lvl.l}`,
    evidence: ev.map(evidenceView),
    registry_links: await registryLinks(tx, tenantId),
    next_steps: next,
  };
}

// ------------------------------------------------------------------------------------------------ handlers

export interface LadderDeps {
  homeDomain: string;
  network: StellarNetwork;
  horizon: HorizonClient;
  /** SEP-10 (hardware wallets, multisig); undefined when the deployment has no SEP-10 signing key. */
  sep10?: Sep10 | undefined;
  /** HTTPS fetcher for `stellar.toml` (the domain verifier's SSRF rules). */
  fetcher: TextFetcher;
  now?: () => number;
}

function failed(detail: string): ApiError {
  return new ApiError("unprocessable", detail);
}

interface LinkPayload {
  method: "sep53" | "sep10";
  network: StellarNetwork;
  message?: string;
}

export function ladderHandlers(deps: LadderDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  const getVerification: Handler = async (ctx) => ({
    status: 200,
    body: await ctx.tx((tx) => verificationStatus(tx, ctx.tenant?.id as string)),
  });

  const listRegistryCandidates: Handler = async (ctx) => ({
    status: 200,
    body: await ctx.tx((tx) => registryLinks(tx, ctx.tenant?.id as string)),
  });

  const verificationStellarChallenge: Handler = async (ctx) => {
    const b = ctx.body as { account: string; method?: "sep53" | "sep10" };
    try {
      decodeAccountId(b.account);
    } catch {
      throw new ApiError("validation_failed", undefined, {
        errors: [{ pointer: "/account", detail: "invalid account id" }],
      });
    }
    const tenantId = ctx.tenant?.id as string;
    if (b.method === "sep10") {
      const sep10 = deps.sep10;
      if (!sep10)
        throw new ApiError(
          "unavailable",
          "SEP-10 is not configured on this deployment; use sep53",
          {
            retryAfter: 3600,
          },
        );
      const c = sep10.challenge(b.account);
      const issued = new Date(clock());
      const expires = new Date(issued.getTime() + SEP10_TTL_S * 1000);
      const payload: LinkPayload = { method: "sep10", network: deps.network };
      const r = await ctx.tx((tx) =>
        tx.one<{ challenge_id: string }>(
          `INSERT INTO scf.auth_challenges (kind, secret_hash, user_id, tenant_id, subject, payload, created_at, expires_at)
           VALUES ('stellar_link_sep10', $1, $2, $3, $4, $5, $6, $7) RETURNING challenge_id::text AS challenge_id`,
          [
            c.hash,
            ctx.session?.userId,
            tenantId,
            b.account,
            JSON.stringify(payload),
            issued,
            expires,
          ],
        ),
      );
      return {
        status: 201,
        body: {
          challenge_id: r.challenge_id,
          method: "sep10",
          transaction_xdr: c.xdr,
          network_passphrase: sep10.networkPassphrase,
          expires_at: expires.toISOString(),
        },
        headers: { "cache-control": "no-store" },
      };
    }
    const nonce = randomBase62(22);
    const issuedAt = new Date(clock());
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const row = await ctx.tx(async (tx) => {
      const t = await tx.one<{ slug: string }>(
        `SELECT slug FROM scf.tenants WHERE tenant_id = $1`,
        [tenantId],
      );
      const message = linkMessage({
        domain: deps.homeDomain,
        account: b.account,
        tenantId,
        slug: t.slug,
        network: deps.network,
        nonce,
        issuedAt,
        expiresAt,
      });
      const payload: LinkPayload = { method: "sep53", network: deps.network, message };
      const r = await tx.one<{ challenge_id: string }>(
        `INSERT INTO scf.auth_challenges (kind, secret_hash, user_id, tenant_id, subject, payload, created_at, expires_at)
         VALUES ('stellar_link_sep53', $1, $2, $3, $4, $5, $6, $7) RETURNING challenge_id::text AS challenge_id`,
        [
          sha256(nonce),
          ctx.session?.userId,
          tenantId,
          b.account,
          JSON.stringify(payload),
          issuedAt,
          expiresAt,
        ],
      );
      return { id: r.challenge_id, message };
    });
    return {
      status: 201,
      body: {
        challenge_id: row.id,
        method: "sep53",
        message: row.message,
        network_passphrase:
          deps.network === "public"
            ? "Public Global Stellar Network ; September 2015"
            : "Test SDF Network ; September 2015",
        expires_at: expiresAt.toISOString(),
      },
      headers: { "cache-control": "no-store" },
    };
  };

  const verificationStellarVerify: Handler = async (ctx) => {
    const b = ctx.body as {
      challenge_id: string;
      signature?: string;
      signed_transaction_xdr?: string;
    };
    const isSep10 = typeof b.signed_transaction_xdr === "string";
    if (!b.signature && !isSep10)
      throw new ApiError("validation_failed", undefined, {
        errors: [
          {
            pointer: "/signature",
            detail: "signature (sep53) or signed_transaction_xdr (sep10) required",
          },
        ],
      });
    const tenantId = ctx.tenant?.id as string;
    // Single use, bound to this tenant and this member: consumed whatever the outcome (its own transaction).
    const ch = await ctx.tx((tx) =>
      tx.maybeOne<{ subject: string; payload: LinkPayload; secret_hash: Buffer }>(
        `UPDATE scf.auth_challenges SET consumed_at = now()
          WHERE challenge_id = $1 AND kind = $4 AND tenant_id = $2 AND user_id = $3
            AND consumed_at IS NULL AND expires_at > now()
          RETURNING subject, payload, secret_hash`,
        [
          b.challenge_id,
          tenantId,
          ctx.session?.userId,
          isSep10 ? "stellar_link_sep10" : "stellar_link_sep53",
        ],
      ),
    );
    if (!ch) throw new ApiError("not_found");
    const account = ch.subject;
    if (ch.payload.network !== deps.network)
      throw failed("the challenge was issued for another network");
    const info = await deps.horizon.accountInfo(deps.network, account);
    let weight = info.weight;
    if (isSep10) {
      if (!deps.sep10) throw failed("SEP-10 is not configured on this deployment");
      try {
        weight = deps.sep10.verify(
          b.signed_transaction_xdr as string,
          account,
          ch.secret_hash,
          info,
        ).weight;
      } catch {
        throw failed(
          "the signed challenge is not valid or does not meet the account's medium threshold",
        );
      }
    } else {
      if (!verifySep53(account, ch.payload.message ?? "", b.signature as string))
        throw failed("the signature is not valid for this challenge");
      if (info.weight <= 0 || info.weight < info.mediumThreshold)
        throw failed("the signing key does not meet the account's medium threshold");
    }
    const method = isSep10 ? "sep10" : "sep53";
    const home = info.homeDomain?.toLowerCase().replace(/\.$/, "") ?? null;
    if (!home) throw failed("the account has no home_domain");
    const domainOk = await ctx.tx((tx) =>
      tx.maybeOne(
        `SELECT 1 FROM scf.verification_evidence
          WHERE tenant_id = $1 AND kind = 'domain' AND status = 'valid' AND lower(subject) = $2`,
        [tenantId, home],
      ),
    );
    if (!domainOk)
      throw failed("the account's home_domain is not a verified domain of this project");
    const toml = await deps.fetcher.fetchText(home, "/.well-known/stellar.toml");
    if (toml.kind !== "ok") throw failed(`stellar.toml could not be read (${toml.code})`);
    if (!tomlAccounts(toml.body).includes(account))
      throw failed("the home domain's stellar.toml does not list the account in ACCOUNTS");
    const tomlUrl = `https://${home}/.well-known/stellar.toml`;
    const body = await ctx.tx(async (tx) => {
      const tomb = await tx.one<{ t: boolean }>(
        `SELECT scf.is_tombstoned('stellar_account', $1) AS t`,
        [account],
      );
      if (tomb.t) throw failed("this account belonged to a removed project and cannot be linked");
      await tx.audit({
        action: "verification.stellar_account_linked",
        targetType: "stellar_account",
        details: {
          method,
          home_domain: home,
          signer_weight: weight,
          medium_threshold: info.mediumThreshold,
        },
      });
      await tx.query(
        `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, created_by)
         VALUES ($1, 'stellar_account', $2, $3, $4)
         ON CONFLICT (tenant_id, kind, subject) DO UPDATE
           SET status = 'valid', details = EXCLUDED.details, verified_at = now(), last_checked_at = now(),
               lapsed_at = NULL, revoked_at = NULL, revoked_by = NULL`,
        [
          tenantId,
          account,
          JSON.stringify({
            method,
            signer_weight: weight,
            medium_threshold: info.mediumThreshold,
            home_domain: home,
            toml_url: tomlUrl,
            network: deps.network,
          }),
          ctx.session?.userId,
        ],
      );
      await tx.notify("scf_edge");
      return verificationStatus(tx, tenantId);
    });
    return { status: 200, body };
  };

  return {
    getVerification,
    listRegistryCandidates,
    verificationStellarChallenge,
    verificationStellarVerify,
  };
}
