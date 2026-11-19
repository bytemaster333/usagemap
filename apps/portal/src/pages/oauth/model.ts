// SPDX-License-Identifier: Apache-2.0
// URL state of the MCP OAuth consent page (/oauth/consent?request=<id>): the pending authorization request the
// control plane's authorization endpoint redirected the browser to. Anything that is not a UUID is ignored.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConsentSearch {
  request?: string;
}

export function parseConsentSearch(s: Record<string, unknown>): ConsentSearch {
  return typeof s.request === "string" && UUID.test(s.request) ? { request: s.request } : {};
}

/** The choice on the consent page: one tenant, or the SCF-operator view. */
export type Choice = { tenantId: string } | { operator: true } | null;

export function approveBody(c: Exclude<Choice, null>): { tenant_id: string } | { operator: true } {
  return "operator" in c ? { operator: true } : { tenant_id: c.tenantId };
}

/** Only an http(s) URL is ever navigated to (the control plane builds it from a registered redirect URI). */
export function safeRedirect(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
