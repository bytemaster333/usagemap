// SPDX-License-Identifier: Apache-2.0
// The verdict each web reason code implies (wire-formats §h.2, closed list): used by the installation check and by the
// filtered-traffic figures of the public metrics document.

export const REASON_VERDICT: Record<string, "suspect" | "rejected"> = {
  ua_bot: "rejected",
  origin_mismatch: "rejected",
  fetch_impossible: "rejected",
  challenge_missing: "rejected",
  challenge_invalid: "rejected",
  challenge_expired: "rejected",
  proof_invalid: "rejected",
  token_flood: "rejected",
  tenant_pending: "rejected",
  tenant_suspended: "rejected",
  proof_missing: "suspect",
  challenge_unverifiable: "suspect",
  ctx_moved: "suspect",
  domain_unverified: "suspect",
  automation_flag: "suspect",
  hidden_or_prerender: "suspect",
  net_datacenter: "suspect",
  multiplicity_high: "suspect",
  transport_mismatch: "suspect",
  header_inconsistent: "suspect",
  origin_missing: "suspect",
  rate_anomaly: "suspect",
};
