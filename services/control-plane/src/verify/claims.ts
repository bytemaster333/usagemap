// SPDX-License-Identifier: Apache-2.0
// Host claims held by a tenant's domain declarations (data-model §8.4, §12; C-19).

import type { Tx } from "../db/database.ts";

/**
 * Lets go of the host claim a declaration holds when it stops being verified (lapse) or goes away (removal): the claim
 * moves to another VERIFIED declaration of the same host by the same tenant, or is released — it never stays with an
 * unverified, lapsed or disputed declaration, where it would block the host's rightful owner.
 * Returns whether the tenant still has the host verified elsewhere. Callers: scf_app and scf_jobs, under the tenant.
 */
export async function releaseClaim(
  tx: Tx,
  tenantId: string,
  domainId: string,
  host: string,
): Promise<boolean> {
  const other = await tx.maybeOne(
    `SELECT 1 FROM scf.site_domains
      WHERE tenant_id = $1 AND host = $2 AND domain_id <> $3 AND state = 'verified' LIMIT 1`,
    [tenantId, host, domainId],
  );
  if (other)
    // scf.release_domain_claim prefers a verified declaration when it moves the claim.
    await tx.query(`SELECT scf.release_domain_claim($1::uuid, $2::uuid)`, [tenantId, domainId]);
  else await tx.query(`SELECT scf.release_host($1, $2::uuid)`, [host, tenantId]);
  return other !== undefined;
}
