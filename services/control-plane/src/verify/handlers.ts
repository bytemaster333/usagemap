// SPDX-License-Identifier: Apache-2.0
// Domain verification operations (ADR-0015 L1, data-model §8.4). The request never touches the network: starting a
// verification issues a token and instructions; asking for a check only makes the row due and wakes the
// `domain_verification` worker (worker.ts), which runs the SSRF-safe verifier (verifier.ts).

import { randomBytes } from "node:crypto";
import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";

export interface VerificationDeps {
  /** Wakes the domain_verification worker (in-process) after a check was queued. */
  wake?: () => void;
}

type Method = "dns_txt" | "well_known" | "meta_tag";

export interface VerificationRow extends Record<string, unknown> {
  verification_id: string;
  method: Method;
  status: string;
  token: string;
  expires_at: Date;
  last_checked_at: Date | null;
  last_result_code: string | null;
  host: string;
}

/** Validity of a pending token (data-model §8.4). */
export const PENDING_DAYS = 7;
/** First automatic check after a start: time to publish the proof. */
const FIRST_CHECK_MINUTES = 5;

export function instructions(method: Method, host: string, token: string): Record<string, string> {
  switch (method) {
    case "dns_txt":
      return { dns_name: `_scf-verify.${host}`, dns_value: `scf-verify=${token}` };
    case "well_known":
      return { url: `https://${host}/.well-known/scf-verify.txt`, file_body: token };
    case "meta_tag":
      return { meta_tag: `<meta name="scf-site-verification" content="${token}">` };
  }
}

export function verificationView(r: VerificationRow): Record<string, unknown> {
  return {
    verification_id: r.verification_id,
    method: r.method,
    status: r.status,
    token: r.token,
    instructions: instructions(r.method, r.host, r.token),
    expires_at: r.expires_at.toISOString(),
    last_checked_at: r.last_checked_at?.toISOString() ?? null,
    last_result_code: r.last_result_code,
  };
}

const COLUMNS = `v.verification_id, v.method::text AS method, v.status::text AS status, v.token, v.expires_at,
  v.last_checked_at, v.last_result_code, d.host`;

/** The domain of this tenant and site (tenant row locked); 404 for a foreign, unknown or mismatched id (C-87). */
async function ownDomain(
  tx: Tx,
  tenantId: string,
  siteId: string,
  domainId: string,
): Promise<{ host: string; site_status: string }> {
  // scf_app has no UPDATE privilege on site_domains (migration 0067), so it cannot lock the row: the tenant row
  // serialises this tenant's verification starts and domain removals instead.
  await tx.query(`SELECT 1 FROM scf.tenants WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
  const d = await tx.maybeOne<{ host: string; site_status: string }>(
    `SELECT d.host, s.status AS site_status
       FROM scf.site_domains d JOIN scf.sites s ON s.tenant_id = d.tenant_id AND s.site_id = d.site_id
      WHERE d.tenant_id = $1 AND d.site_id = $2 AND d.domain_id = $3`,
    [tenantId, siteId, domainId],
  );
  if (!d) throw new ApiError("not_found");
  return d;
}

export function verificationHandlers(deps: VerificationDeps): Record<string, Handler> {
  const startDomainVerification: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const domainId = ctx.params.domainId as string;
    const method = (ctx.body as { method: Method }).method;
    const row = await ctx.tx(async (tx) => {
      const d = await ownDomain(tx, tenantId, siteId, domainId);
      // An archived site takes no ingest and needs no proof; the contract has no 409 here, so this is a 400.
      if (d.site_status !== "active") {
        throw new ApiError("validation_failed", "the site is archived", {
          errors: [{ pointer: "", detail: "the site is archived" }],
        });
      }
      // A new start supersedes earlier pending tokens of this domain (one live proof request at a time); a verified
      // verification keeps running its periodic re-checks.
      await tx.query(
        `UPDATE scf.domain_verifications SET status = 'expired', next_check_at = NULL
          WHERE tenant_id = $1 AND domain_id = $2 AND status = 'pending'`,
        [tenantId, domainId],
      );
      const token = randomBytes(16).toString("base64url");
      const r = await tx.one<VerificationRow>(
        `WITH v AS (
           INSERT INTO scf.domain_verifications (tenant_id, domain_id, method, token, expires_at, next_check_at)
           VALUES ($1, $2, $3::scf.domain_method, $4, now() + make_interval(days => $5),
                   now() + make_interval(mins => $6))
           RETURNING *)
         SELECT ${COLUMNS} FROM v JOIN scf.site_domains d ON d.tenant_id = v.tenant_id AND d.domain_id = v.domain_id`,
        [tenantId, domainId, method, token, PENDING_DAYS, FIRST_CHECK_MINUTES],
      );
      await tx.audit({
        action: "domain.verification_started",
        targetType: "domain",
        targetId: domainId,
        details: { verification_id: r.verification_id, method },
      });
      return r;
    });
    return { status: 201, body: verificationView(row) };
  };

  const checkDomainVerification: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const domainId = ctx.params.domainId as string;
    const verificationId = ctx.params.verificationId as string;
    const row = await ctx.tx(async (tx) => {
      await ownDomain(tx, tenantId, siteId, domainId);
      const r = await tx.maybeOne<VerificationRow>(
        `UPDATE scf.domain_verifications v
            SET next_check_at = CASE WHEN v.status IN ('pending', 'verified') THEN now() ELSE v.next_check_at END
           FROM scf.site_domains d
          WHERE v.tenant_id = $1 AND v.domain_id = $2 AND v.verification_id = $3
            AND d.tenant_id = v.tenant_id AND d.domain_id = v.domain_id
          RETURNING ${COLUMNS}`,
        [tenantId, domainId, verificationId],
      );
      if (!r) throw new ApiError("not_found");
      await tx.audit({
        action: "domain.verification_checked",
        targetType: "domain",
        targetId: domainId,
        details: { verification_id: verificationId, status: r.status },
      });
      await tx.query(`SELECT pg_notify('scf_verify', '')`);
      return r;
    });
    deps.wake?.();
    return { status: 202, body: verificationView(row) };
  };

  return { startDomainVerification, checkDomainVerification };
}
